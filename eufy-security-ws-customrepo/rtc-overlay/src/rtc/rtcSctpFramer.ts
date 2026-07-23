import { createRequire } from "module";
import { readFileSync } from "fs";
import { join } from "path";

import { rootHTTPLogger } from "../logging";

const nodeRequire = createRequire(__filename);

const PTCS_MAGIC = Buffer.from("PTCS", "ascii");
const XZYH_MAGIC = Buffer.from("XZYH", "ascii");

/** Portal link types (security.eufy.com worker_sctp_send). */
const WrtcLinkTypeCmd = 1;

/** Portal internal SCTP channel ids (not WebRTC stream ids). */
const SEND_DATACHANNEL_ID = 0;
const RECV_DATACHANNEL_ID = 1;

/** Maps WrtcLinkTypeCmd → WEBRTC_P2P_COMMAND_CHANNEL. */
const WEBRTC_P2P_COMMAND_CHANNEL = 0;

interface LibSctpModule {
  _set_mxlog_level(level: number): void;
  _sctp_frame_manager_create(
    isSender: number,
    datachannelId: number,
    recvFrameMaxDelayMs: number,
    maxPacketCount: number,
    maxPacketBytes: number,
    maxFecGroupCount: number
  ): number;
  _sctp_frame_manager_destroy(manager: number): void;
  _sctp_frame_manager_set_send_packet_callback(manager: number, fn: number): void;
  _sctp_frame_manager_set_recv_frame_callback(manager: number, fn: number): void;
  _sctp_frame_manager_push_frame_data(manager: number, frameBuffer: number, sctpChannel: number): number;
  _sctp_frame_manager_push_packet_data(manager: number, packetBuffer: number): number;
  _sctp_frame_manager_get_frame_buffer(manager: number, size: number): number;
  _sctp_frame_buffer_get_data(frameBuffer: number): number;
  _sctp_frame_buffer_set_size(frameBuffer: number, size: number): void;
  _sctp_frame_manager_get_packet_buffer(manager: number, size: number): number;
  _sctp_packet_get_data(packetBuffer: number): number;
  _sctp_frame_manager_on_100ms_timer(manager: number, nowMs: number): void;
  HEAPU8: Uint8Array;
  addFunction(fn: (...args: number[]) => number, signature: string): number;
}

type LibSctpFactory = (opts?: {
  locateFile?: (path: string) => string;
  wasmBinary?: Buffer;
}) => Promise<LibSctpModule> | LibSctpModule;

function libsctpDir(): string {
  return join(__dirname, "libsctp");
}

let libsctpModulePromise: Promise<LibSctpModule> | undefined;

async function loadLibSctpModule(): Promise<LibSctpModule> {
  if (!libsctpModulePromise) {
    libsctpModulePromise = (async () => {
      const dir = libsctpDir();
      const wasmBinary = readFileSync(join(dir, "libsctp_0_0_2.wasm"));
      const factory = nodeRequire(join(dir, "libsctp_0_0_2.js")) as LibSctpFactory;
      const mod = await factory({
        locateFile: (path: string) => join(dir, path),
        wasmBinary,
      });
      return mod;
    })();
  }
  return libsctpModulePromise;
}

function copyToHeap(mod: LibSctpModule, ptr: number, data: Buffer): void {
  for (let i = 0; i < data.length; i++) {
    mod.HEAPU8[ptr + i] = data[i]!;
  }
}

function copyFromHeap(mod: LibSctpModule, ptr: number, size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    out[i] = mod.HEAPU8[ptr + i]!;
  }
  return out;
}

/**
 * Portal-compatible SCTP/PTCS framing for WebrtcDataChannel command packets.
 * Outbound: XZYH portal packet → libsctp send manager → PTCS wire packets.
 * Inbound: PTCS wire packets → libsctp recv manager → reassembled XZYH frames.
 */
export class RtcSctpFramer {
  private mod?: LibSctpModule;
  private sendManager = 0;
  private recvManager = 0;
  private recvTimer?: NodeJS.Timeout;
  private onWireSend?: (packet: Buffer) => void;
  private onFrameRecv?: (frame: Buffer, linkType: number) => void;
  private ready = false;

  public async init(
    onWireSend: (packet: Buffer) => void,
    onFrameRecv: (frame: Buffer, linkType: number) => void
  ): Promise<void> {
    this.onWireSend = onWireSend;
    this.onFrameRecv = onFrameRecv;
    this.mod = await loadLibSctpModule();
    this.mod._set_mxlog_level(5);

    const sendPacketCb = this.mod.addFunction((id: number, data: number, size: number) => {
      const packet = copyFromHeap(this.mod!, data, size);
      rootHTTPLogger.info("RtcSctpFramer wire send", {
        id,
        bytes: packet.length,
        prefix: packet.subarray(0, Math.min(16, packet.length)).toString("hex"),
      });
      this.onWireSend?.(packet);
      return 0;
    }, "iiii");

    const recvFrameCb = this.mod.addFunction((datachannelId: number, sctpChannel: number, data: number, size: number) => {
      const frame = copyFromHeap(this.mod!, data, size);
      const linkType = sctpChannelToLinkType(sctpChannel);
      rootHTTPLogger.info("RtcSctpFramer frame recv", {
        datachannelId,
        sctpChannel,
        linkType,
        bytes: frame.length,
        prefix: frame.subarray(0, Math.min(16, frame.length)).toString("hex"),
      });
      this.onFrameRecv?.(frame, linkType);
      return 0;
    }, "iiiii");

    const recvFrameMaxDelayMs = 15000;
    const maxPacketCount = 5000;
    // Hub soft-TTL ~360s: PTCS padded to maxPacketBytes. 1000 → ~1085B UDP cliffs harder;
    // 800 → ~885B (run.sh default). Bare sometimes soft-recovers; HA often does not — pair with
    // RTC_PROACTIVE_RECONNECT_MS + RTC_HANDOFF rather than relying on same-session hold.
    const maxPacketBytesEnv = Number(process.env.RTC_SCTP_MAX_PACKET_BYTES ?? 800);
    const maxPacketBytes =
      Number.isFinite(maxPacketBytesEnv) && maxPacketBytesEnv > 0 ? Math.floor(maxPacketBytesEnv) : 800;
    const maxFecGroupCount = 10;

    this.sendManager = this.mod._sctp_frame_manager_create(
      1,
      SEND_DATACHANNEL_ID,
      recvFrameMaxDelayMs,
      1000,
      maxPacketBytes,
      maxFecGroupCount
    );
    this.recvManager = this.mod._sctp_frame_manager_create(
      0,
      RECV_DATACHANNEL_ID,
      recvFrameMaxDelayMs,
      maxPacketCount,
      maxPacketBytes,
      maxFecGroupCount
    );

    this.mod._sctp_frame_manager_set_send_packet_callback(this.sendManager, sendPacketCb);
    this.mod._sctp_frame_manager_set_recv_frame_callback(this.recvManager, recvFrameCb);

    this.recvTimer = setInterval(() => {
      if (!this.mod || !this.recvManager) {
        return;
      }
      this.mod._sctp_frame_manager_on_100ms_timer(this.recvManager, Date.now());
    }, 100);

    this.ready = true;
    rootHTTPLogger.info("RtcSctpFramer initialized", { maxPacketBytes, maxFecGroupCount });
  }

  public isReady(): boolean {
    return this.ready;
  }

  /** Send a portal XZYH packet (wrapped through SCTP send manager). */
  public sendFrame(portalPacket: Buffer): void {
    if (!this.mod || !this.sendManager) {
      throw new Error("RtcSctpFramer not initialized");
    }
    const frameSize = portalPacket.length;
    const frameBuffer = this.mod._sctp_frame_manager_get_frame_buffer(this.sendManager, frameSize);
    if (!frameBuffer) {
      throw new Error("RtcSctpFramer get_frame_buffer failed");
    }
    const frameData = this.mod._sctp_frame_buffer_get_data(frameBuffer);
    if (!frameData) {
      throw new Error("RtcSctpFramer frame_buffer_get_data failed");
    }
    copyToHeap(this.mod, frameData, portalPacket);
    this.mod._sctp_frame_buffer_set_size(frameBuffer, frameSize);
    const ret = this.mod._sctp_frame_manager_push_frame_data(
      this.sendManager,
      frameBuffer,
      WEBRTC_P2P_COMMAND_CHANNEL
    );
    if (ret !== 0) {
      throw new Error(`RtcSctpFramer push_frame_data failed: ${ret}`);
    }
  }

  /** Feed raw PTCS packets from WebrtcDataChannel into recv manager. */
  public recvPacket(wirePacket: Buffer): void {
    if (!this.mod || !this.recvManager) {
      return;
    }
    if (wirePacket.length >= 16 && wirePacket.subarray(0, 4).compare(XZYH_MAGIC) === 0) {
      rootHTTPLogger.info("RtcSctpFramer direct portal frame", {
        bytes: wirePacket.length,
        prefix: wirePacket.subarray(0, Math.min(16, wirePacket.length)).toString("hex"),
      });
      this.onFrameRecv?.(wirePacket, 1);
      return;
    }
    if (wirePacket.length < 4 || wirePacket.subarray(0, 4).compare(PTCS_MAGIC) !== 0) {
      rootHTTPLogger.info("RtcSctpFramer ignoring non-PTCS packet", {
        bytes: wirePacket.length,
        prefix: wirePacket.subarray(0, Math.min(8, wirePacket.length)).toString("hex"),
      });
      return;
    }
    const packetSize = wirePacket.length;
    const packetBuffer = this.mod._sctp_frame_manager_get_packet_buffer(this.recvManager, packetSize);
    if (!packetBuffer) {
      rootHTTPLogger.warn("RtcSctpFramer get_packet_buffer failed", { packetSize });
      return;
    }
    const packetData = this.mod._sctp_packet_get_data(packetBuffer);
    copyToHeap(this.mod, packetData, wirePacket);
    const ret = this.mod._sctp_frame_manager_push_packet_data(this.recvManager, packetBuffer);
    if (ret !== 0) {
      rootHTTPLogger.warn("RtcSctpFramer push_packet_data failed", { ret });
    }
  }

  public destroy(): void {
    this.ready = false;
    if (this.recvTimer) {
      clearInterval(this.recvTimer);
      this.recvTimer = undefined;
    }
    if (this.mod) {
      if (this.sendManager) {
        this.mod._sctp_frame_manager_destroy(this.sendManager);
        this.sendManager = 0;
      }
      if (this.recvManager) {
        this.mod._sctp_frame_manager_destroy(this.recvManager);
        this.recvManager = 0;
      }
    }
    this.mod = undefined;
    this.onWireSend = undefined;
    this.onFrameRecv = undefined;
  }
}

function sctpChannelToLinkType(sctpChannel: number): number {
  switch (sctpChannel) {
    case 0:
      return WrtcLinkTypeCmd;
    case 1:
      return 5; // WrtcLinkTypeLive
    case 2:
      return 3; // WrtcLinkTypeNotify
    case 3:
      return 2; // WrtcLinkTypeFile
    case 4:
      return 4; // WrtcLinkTypePlayBack
    case 5:
      return 5; // WrtcLinkTypeLive
    default:
      return 99; // WrtcLinkTypeInner
  }
}
