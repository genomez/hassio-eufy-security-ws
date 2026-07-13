import { rootP2PLogger } from "../logging";
import { P2PQueueMessage } from "../p2p/interfaces";
import { CommandType, ErrorCode, InternalP2PCommandType } from "../p2p/types";
import { buildPortalPacket, parsePortalPacket, PortalCommandRequest, PortalCommandResponse } from "./rtcPacket";

let segmenCounter = 1;

function nextSegmen(): number {
  segmenCounter = (segmenCounter + 1) & 0xff;
  if (segmenCounter === 0) {
    segmenCounter = 1;
  }
  return segmenCounter;
}

/** Map legacy P2P queue message → portal WebRTC packet (security.eufy.com format). */
export function portalPacketFromP2PMessage(
  message: P2PQueueMessage,
  adminUserId: string
): Buffer | undefined {
  const channel = message.p2pCommand.channel ?? 0;
  const segmen = nextSegmen();

  if (message.p2pCommandType === InternalP2PCommandType.WithStringPayload) {
    const raw = message.p2pCommand.value as string;
    if (message.p2pCommand.commandType === CommandType.CMD_SET_PAYLOAD) {
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return undefined;
      }
      const nestedCmd = Number(json.cmd ?? 0);
      const req: PortalCommandRequest = {
        commandID: CommandType.CMD_SET_PAYLOAD,
        channelID: channel,
        cmd: nestedCmd,
        segmen,
        payload: {
          account_id: json.account_id ?? adminUserId,
          cmd: nestedCmd,
          mValue3: json.mValue3 ?? 0,
          payload: json.payload ?? {},
        },
      };
      return buildPortalPacket(req);
    }
    if (message.p2pCommand.commandType === CommandType.CMD_DOORBELL_SET_PAYLOAD) {
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return undefined;
      }
      const nestedCmd = Number(json.commandType ?? 0);
      const req: PortalCommandRequest = {
        commandID: CommandType.CMD_DOORBELL_SET_PAYLOAD,
        channelID: channel,
        cmd: nestedCmd,
        segmen,
        payload: {
          account_id: adminUserId,
          cmd: nestedCmd,
          commandType: nestedCmd,
          ...(json.data !== undefined ? { data: json.data } : {}),
          ...Object.fromEntries(
            Object.entries(json).filter(([k]) => k !== "commandType" && k !== "data" && k !== "cmd")
          ),
        },
      };
      return buildPortalPacket(req);
    }
  }

  if (message.p2pCommandType === InternalP2PCommandType.WithInt) {
    const req: PortalCommandRequest = {
      commandID: message.p2pCommand.commandType,
      channelID: channel,
      segmen,
      payload: {
        value: message.p2pCommand.value,
        account_id: message.p2pCommand.strValue ?? adminUserId,
      },
    };
    return buildPortalPacket(req);
  }

  if (message.p2pCommandType === InternalP2PCommandType.WithIntString) {
    const req: PortalCommandRequest = {
      commandID: message.p2pCommand.commandType,
      channelID: channel,
      segmen,
      payload: {
        value: message.p2pCommand.value,
        value1: message.p2pCommand.valueSub ?? 0,
        account_id: message.p2pCommand.strValue ?? adminUserId,
      },
    };
    return buildPortalPacket(req);
  }

  if (message.p2pCommandType === InternalP2PCommandType.WithoutData) {
    const req: PortalCommandRequest = {
      commandID: message.p2pCommand.commandType,
      channelID: channel,
      segmen,
      payload: { account_id: adminUserId },
    };
    return buildPortalPacket(req);
  }

  rootP2PLogger.warn("RtcCommandBridge unsupported P2P message type", {
    commandType: message.p2pCommand.commandType,
    p2pCommandType: message.p2pCommandType,
  });
  return undefined;
}

export interface RtcCommandTransport {
  isActive(): boolean;
  isCommandChannelReady?(): boolean;
  send(buffer: Buffer): void;
  adminUserId: string;
}

export interface PendingRtcCommand {
  commandType: number;
  nestedCommandType?: number;
  channel: number;
  resolve: (returnCode: number, parsed?: PortalCommandResponse) => void;
  timer: NodeJS.Timeout;
}

/** Track pending RTC commands by segmen until hub responds. */
export class RtcCommandPending {
  private pending = new Map<number, PendingRtcCommand>();

  public track(
    segmen: number,
    commandType: number,
    channel: number,
    nestedCommandType: number | undefined,
    timeoutMs: number,
    onResult: (returnCode: number, parsed?: PortalCommandResponse) => void
  ): void {
    const timer = setTimeout(() => {
      this.pending.delete(segmen);
      onResult(ErrorCode.ERROR_COMMAND_TIMEOUT);
    }, timeoutMs);
    this.pending.set(segmen, {
      commandType,
      nestedCommandType,
      channel,
      resolve: onResult,
      timer,
    });
  }

  public handleIncoming(buf: Buffer, linkType = 1): boolean {
    const parsed = parsePortalPacket(buf, linkType) ?? parsePortalPacket(buf, linkType === 1 ? 3 : 1);
    if (!parsed) {
      return false;
    }
    const pending = this.pending.get(parsed.segmen);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pending.delete(parsed.segmen);
    const rc =
      parsed.errCode === 0 || parsed.errCode === undefined
        ? ErrorCode.ERROR_PPCS_SUCCESSFUL
        : parsed.errCode;
    rootP2PLogger.info("RtcCommandBridge command ack", {
      commandType: pending.commandType,
      nestedCommandType: pending.nestedCommandType,
      segmen: parsed.segmen,
      linkType,
      returnCode: rc,
      responseData: parsed.data,
    });
    pending.resolve(rc, parsed);
    return true;
  }

  public clear(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
    }
    this.pending.clear();
  }
}
