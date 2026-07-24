import { rootHTTPLogger, rootP2PLogger } from "../logging";
import { parseJSON } from "../utils";
import { PushMessage } from "../push/models";
import { CommandResult, StorageInfoBodyHB3, StorageInfoHB3 } from "../p2p/models";
import { CommandType, ErrorCode } from "../p2p/types";
import { parsePortalHeader, parsePortalPacket } from "./rtcPacket";
import { dispatchPortalDatabaseInbound, StationDatabaseInboundSession } from "./stationDatabaseInbound";
import { RtcInboundDiagEntry } from "./rtcInboundDiagnostics";

/** Minimal session surface for RTC inbound dispatch. */
export interface RtcInboundSession {
  getStationSn(): string;
  getP2pDid(): string | undefined;
  emit(event: "command", result: CommandResult): boolean;
  emit(event: "push notification", message: PushMessage): boolean;
  emit(event: "floodlight manual switch", channel: number, enabled: boolean): boolean;
  emit(event: "hub notify update"): boolean;
  emit(event: "storage info hb3", channel: number, storageInfo: StorageInfoBodyHB3): boolean;
  /** Optional hook: hub returned a successful command-channel ack (e.g. CMD_PING). */
  notifyRtcPollAck?(commandID: number, errCode: number): void;
  recordRtcInboundDiagnostic?(entry: RtcInboundDiagEntry): void;
}

function recordDiag(session: RtcInboundSession, entry: RtcInboundDiagEntry): void {
  session.recordRtcInboundDiagnostic?.(entry);
}

function isSuccessfulPortalAck(errCode: number | undefined): boolean {
  return errCode === undefined || errCode === 0;
}

function notifyRtcPollAck(session: RtcInboundSession, commandID: number, errCode: number | undefined): void {
  if (!isSuccessfulPortalAck(errCode)) {
    return;
  }
  session.notifyRtcPollAck?.(commandID, errCode ?? 0);
}

/**
 * Dispatch portal frames that are not matched as pending command acks.
 * linkType mirrors security.eufy.com SCTP channel mapping (1=cmd, 3=notify).
 */
export function dispatchRtcInbound(session: RtcInboundSession, buf: Buffer, linkType: number): void {
  if (buf.length >= 16 && buf.subarray(0, 4).toString("ascii") === "XZYH") {
    dispatchPortalRtcInbound(session, buf, linkType);
    return;
  }

  // notify / download WebRTC data channels may send raw JSON (not XZYH-wrapped).
  if (linkType === 3 || linkType === 2) {
    const text = buf.toString("utf8").replace(/\0+$/, "");
    const parsed = parseJSON(text, rootP2PLogger);
    if (typeof parsed === "object" && parsed !== null) {
      rootHTTPLogger.info("RtcInbound raw channel JSON", {
        stationSN: session.getStationSn(),
        linkType,
        cmd: (parsed as { cmd?: number }).cmd,
        bytes: buf.length,
      });
      handleNotifyJson(session, 0, parsed);
      if (
        dispatchPortalDatabaseInbound(
          session as unknown as StationDatabaseInboundSession,
          session.getP2pDid(),
          undefined,
          parsed,
          (parsed as { cmd?: number }).cmd
        )
      ) {
        return;
      }
      recordDiag(session, {
        kind: "raw_json",
        linkType,
        commandID: (parsed as { cmd?: number }).cmd,
        bytes: buf.length,
      });
      return;
    }
  }

  rootP2PLogger.debug("RtcInbound ignoring non-portal frame", {
    bytes: buf.length,
    linkType,
    prefix: buf.subarray(0, Math.min(8, buf.length)).toString("hex"),
  });
}

function dispatchPortalRtcInbound(session: RtcInboundSession, buf: Buffer, linkType: number): void {
  const header = parsePortalHeader(buf);

  // Portal special case: floodlight manual switch binary ack (commandID 1400, 20-byte packet).
  // Only trust command-channel responses; notify channel (linkType 3) 20-byte frames are echoes.
  if (header.commandID === CommandType.CMD_SET_FLOODLIGHT_MANUAL_SWITCH && buf.length === 20) {
    if (linkType !== 1 || header.isResponse !== 1) {
      rootP2PLogger.debug("RtcInbound floodlight 20-byte ignored", {
        stationSN: session.getStationSn(),
        channel: header.channelID,
        linkType,
        isResponse: header.isResponse,
      });
      return;
    }
    const body = buf.subarray(16);
    const enabled = body.length >= 4 && body.readUInt32LE(0) === 1;
    rootP2PLogger.info("RtcInbound floodlight manual switch", {
      stationSN: session.getStationSn(),
      channel: header.channelID,
      enabled,
    });
    session.emit("floodlight manual switch", header.channelID, enabled);
    return;
  }

  const parsed = parsePortalPacket(buf, linkType) ?? parsePortalPacket(buf, linkType === 1 ? 3 : 1);
  if (!parsed) {
    recordDiag(session, {
      kind: "unhandled_portal",
      linkType,
      commandID: header.commandID,
      bytes: buf.length,
      detail: "parsePortalPacket failed",
    });
    rootP2PLogger.debug("RtcInbound unhandled portal frame", {
      stationSN: session.getStationSn(),
      linkType,
      commandID: header.commandID,
      segmen: header.segmen,
      isResponse: header.isResponse,
      bytes: buf.length,
    });
    return;
  }

  if (linkType === 1 && header.isResponse === 1) {
    if (handleLateCommandResponse(session, header.channelID, parsed)) {
      return;
    }
    if (
      dispatchPortalDatabaseInbound(
        session as unknown as StationDatabaseInboundSession,
        session.getP2pDid(),
        parsed,
        undefined,
        header.commandID
      )
    ) {
      return;
    }
    if (isSuccessfulPortalAck(parsed.errCode)) {
      notifyRtcPollAck(session, parsed.commandID, parsed.errCode);
      const kind = parsed.commandID === CommandType.CMD_PING ? "ping_ack" : "cmd_ack";
      recordDiag(session, {
        kind,
        linkType,
        commandID: parsed.commandID,
        errCode: parsed.errCode,
      });
      if (parsed.commandID === CommandType.CMD_PING) {
        rootP2PLogger.debug("RtcInbound ping ack", {
          stationSN: session.getStationSn(),
          channel: header.channelID,
          segmen: parsed.segmen,
        });
      } else if (parsed.commandID === CommandType.CMD_CAMERA_INFO) {
        rootP2PLogger.debug("RtcInbound camera info ack", {
          stationSN: session.getStationSn(),
          channel: header.channelID,
          segmen: parsed.segmen,
        });
      } else {
        rootP2PLogger.debug("RtcInbound command ack", {
          stationSN: session.getStationSn(),
          commandID: parsed.commandID,
          channel: header.channelID,
          segmen: parsed.segmen,
        });
      }
      return;
    }
    recordDiag(session, {
      kind: "unmatched",
      linkType,
      commandID: parsed.commandID,
      errCode: parsed.errCode,
    });
    rootP2PLogger.info("RtcInbound unmatched command response", {
      stationSN: session.getStationSn(),
      commandID: parsed.commandID,
      channel: header.channelID,
      segmen: parsed.segmen,
      errCode: parsed.errCode,
    });
    return;
  }

  if (
    header.commandID === CommandType.CMD_DATABASE ||
    header.commandID === CommandType.CMD_DATABASE_IMAGE
  ) {
    if (
      dispatchPortalDatabaseInbound(
        session as unknown as StationDatabaseInboundSession,
        session.getP2pDid(),
        parsed,
        undefined,
        header.commandID
      )
    ) {
      return;
    }
  }

  if (linkType === 3 || (typeof parsed.data === "object" && parsed.data !== null && "cmd" in parsed.data)) {
    handleNotifyJson(session, header.channelID, parsed.data);
  }
}

/** Sync floodlight HA state from a hub command ack body. */
export function applyFloodlightStateFromAck(
  session: RtcInboundSession,
  channel: number,
  parsed: ReturnType<typeof parsePortalPacket>
): boolean {
  return handleLateCommandResponse(session, channel, parsed);
}

/** Handle hub acks that arrive after optimistic guard-mode completion (or duplicate responses). */
function handleLateCommandResponse(
  session: RtcInboundSession,
  channel: number,
  parsed: ReturnType<typeof parsePortalPacket>
): boolean {
  if (!parsed || parsed.errCode !== 0) {
    return false;
  }

  if (parsed.commandID === CommandType.CMD_DOORBELL_SET_PAYLOAD) {
    const nested = parsed.data as {
      commandType?: number;
      cmd?: number;
      data?: { value?: number };
    } | undefined;
    const nestedCmd = nested?.commandType ?? nested?.cmd;
    if (nestedCmd === CommandType.CMD_SET_FLOODLIGHT_MANUAL_SWITCH) {
      const value = nested?.data?.value;
      if (value !== undefined) {
        const enabled = value === 1;
        rootP2PLogger.info("RtcInbound late floodlight ack (1700)", {
          stationSN: session.getStationSn(),
          channel,
          enabled,
          segmen: parsed.segmen,
        });
        // Reconnect-stale ON filtering is applied in EufySecurity.onFloodlightManualSwitch.
        session.emit("floodlight manual switch", channel, enabled);
        return true;
      }
    }
  }

  if (parsed.commandID === CommandType.CMD_SET_FLOODLIGHT_MANUAL_SWITCH) {
    const body = parsed.data as { value?: number } | undefined;
    if (body?.value !== undefined) {
      const enabled = body.value === 1;
      rootP2PLogger.info("RtcInbound late floodlight ack (1400)", {
        stationSN: session.getStationSn(),
        channel,
        enabled,
        segmen: parsed.segmen,
      });
      session.emit("floodlight manual switch", channel, enabled);
      return true;
    }
  }

  return false;
}

function handleNotifyJson(session: RtcInboundSession, channel: number, data: unknown): void {
  if (typeof data !== "object" || data === null || !("cmd" in data)) {
    return;
  }
  const json = data as { cmd?: number; payload?: unknown };
  const cmd = Number(json.cmd ?? 0);
  if (!cmd) {
    return;
  }

  if (cmd === CommandType.CMD_DATABASE || cmd === CommandType.CMD_DATABASE_IMAGE) {
    if (
      dispatchPortalDatabaseInbound(
        session as unknown as StationDatabaseInboundSession,
        session.getP2pDid(),
        undefined,
        json.payload ?? json,
        cmd
      )
    ) {
      return;
    }
  }

  if (cmd === CommandType.CMD_HUB_NOTIFY_UPDATE) {
    rootP2PLogger.info("RtcInbound hub notify update", { stationSN: session.getStationSn() });
    session.emit("hub notify update");
    return;
  }

  if (cmd === CommandType.CMD_STATION_PUSH_NOTIFY || cmd === CommandType.CMD_STATION_PUSH_NOTIFY_ALT) {
    const outerPayload = json.payload as { payload?: string; station_sn?: string } | undefined;
    if (typeof outerPayload?.payload === "string") {
      const innerPayload = parseJSON(
        Buffer.from(outerPayload.payload, "base64").toString("utf8"),
        rootP2PLogger
      ) as PushMessage;
      if (innerPayload !== undefined) {
        rootP2PLogger.info("RtcInbound station push notification", {
          stationSN: session.getStationSn(),
          event_type: innerPayload.event_type,
          device_sn: innerPayload.device_sn,
        });
        session.emit("push notification", {
          ...innerPayload,
          type: innerPayload.type ?? innerPayload.msg_type,
          station_sn: innerPayload.station_sn ?? outerPayload.station_sn ?? session.getStationSn(),
          person_name:
            innerPayload.person_name ?? (innerPayload as PushMessage & { nick_name?: string }).nick_name,
        } as PushMessage);
      }
    }
    return;
  }

  if (cmd === CommandType.CMD_CAMERA_PUSH_NOTIFY) {
    const innerPayload = parseJSON(
      typeof json.payload === "string" ? json.payload : JSON.stringify(json.payload),
      rootP2PLogger
    ) as PushMessage;
    if (innerPayload !== undefined) {
      rootP2PLogger.info("RtcInbound camera push notification", {
        stationSN: session.getStationSn(),
        event_type: innerPayload.event_type,
        device_sn: innerPayload.device_sn,
      });
      session.emit("push notification", {
        ...innerPayload,
        type: innerPayload.msg_type,
        station_sn: session.getStationSn(),
        person_name:
          innerPayload.person_name ?? (innerPayload as PushMessage & { nick_name?: string }).nick_name,
      } as PushMessage);
    }
    return;
  }

  // Nested command notify with return code (e.g. 1700/1400 floodlight result).
  // Emit ON and OFF; EufySecurity applies a short post-reconnect grace so stale ON
  // bursts after RTC connect do not flip HA until hub truth can be polled.
  if (cmd === CommandType.CMD_SET_FLOODLIGHT_MANUAL_SWITCH) {
    const payload = json.payload as { data?: { value?: number } } | undefined;
    const value = payload?.data?.value;
    if (value !== undefined) {
      const enabled = value === 1;
      rootP2PLogger.info("RtcInbound floodlight notify payload", {
        stationSN: session.getStationSn(),
        channel,
        enabled,
      });
      session.emit("floodlight manual switch", channel, enabled);
    }
    return;
  }

  // HB3 / T9000 storage info — arrives as CMD_NOTIFY_PAYLOAD (1351) on notify SCTP
  // after an empty CMD_SET_PAYLOAD ack for nested 1307 (same shape as classic P2P).
  if (cmd === CommandType.CMD_STORAGE_INFO_HB3) {
    const payload = json.payload as StorageInfoHB3 | StorageInfoBodyHB3 | undefined;
    const body =
      payload && typeof payload === "object" && "emmc_info" in payload
        ? (payload as StorageInfoBodyHB3)
        : (payload as StorageInfoHB3 | undefined)?.body;
    if (body && (body.emmc_info !== undefined || body.hdd_info !== undefined)) {
      rootP2PLogger.info("RtcInbound storage info HB3", {
        stationSN: session.getStationSn(),
        channel,
        hasEmmc: body.emmc_info !== undefined,
        hasHdd: body.hdd_info !== undefined,
        emmcUsedPercent: body.emmc_info?.data_used_percent,
        hddUsedPercent: (body.hdd_info as { data_used_percent?: number } | undefined)?.data_used_percent,
      });
      session.emit("storage info hb3", channel, body);
    } else {
      rootP2PLogger.warn("RtcInbound storage info HB3 missing body", {
        stationSN: session.getStationSn(),
        channel,
        payloadKeys:
          payload && typeof payload === "object" ? Object.keys(payload as object).slice(0, 20) : typeof payload,
      });
    }
    return;
  }

  rootP2PLogger.debug("RtcInbound notify cmd not handled", {
    stationSN: session.getStationSn(),
    cmd,
    channel,
  });
}

/** Do not optimistically ack guard mode — HA must reflect hub state, not assume success. */
export function shouldOptimisticRtcPropertySuccess(_nestedCommandType?: number): boolean {
  return false;
}

export function optimisticRtcReturnCode(): number {
  return ErrorCode.ERROR_PPCS_SUCCESSFUL;
}
