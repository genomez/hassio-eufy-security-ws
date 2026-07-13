import { EventEmitter } from "events";

import { rootHTTPLogger } from "../logging";
import { RtcPeerConnection, RtcPeerOptions, RtcTurnConfig } from "./rtcPeer";
import { RtcSignalingClient } from "./rtcSignaling";
import { scallJsonToSdpOffer } from "./rtcSdp";
import { RtcSignalingOptions } from "./types";

export interface RtcSessionOptions extends RtcSignalingOptions {
  /** NVR/camera channel for scall (0 = hub-level). */
  channelId?: number;
  /** admin_user_id for WS account field. */
  adminUserId?: string;
  connectTimeoutMs?: number;
}

export interface RtcSessionEvents {
  connected: () => void;
  turn: (turn: RtcTurnConfig) => void;
  error: (err: Error) => void;
  close: () => void;
  commandData: (data: Buffer, linkType?: number) => void;
}

interface ScallCallPayload {
  status?: number;
  turn?: RtcTurnConfig;
}

interface InfoPayload {
  format?: string;
  value?: string;
  candidate?: string;
  sdp?: string;
}

/**
 * Full T9000 RTC session: sign → WS auth → scall → WebRTC answer → data channels.
 */
export class RtcSession extends EventEmitter {
  private readonly signaling: RtcSignalingClient;
  private readonly peer = new RtcPeerConnection();
  private readonly channelId: number;
  private turn?: RtcTurnConfig;
  private authOk = false;
  private connected = false;
  private connectedAt?: number;
  private closed = false;
  private sdpHandled = false;
  private messageChain: Promise<void> = Promise.resolve();
  private signalingKeepaliveTimer?: NodeJS.Timeout;
  private readonly signalingKeepaliveMs = 25_000;

  constructor(private readonly opts: RtcSessionOptions) {
    super();
    this.channelId = opts.channelId ?? 0;
    this.signaling = new RtcSignalingClient({
      ...opts,
      adminUserId: opts.adminUserId,
    });

    this.signaling.on("message", (inner) => {
      this.messageChain = this.messageChain
        .then(() => this.handleSignalingMessage(inner))
        .catch((err) => {
          const error = err instanceof Error ? err : new Error(String(err));
          rootHTTPLogger.error("RtcSession message handler error", { error: error.message });
          this.emit("error", error);
        });
    });
    this.signaling.on("close", (code, reason) => {
      const uptimeMs = this.connectedAt ? Date.now() - this.connectedAt : undefined;
      rootHTTPLogger.info("RtcSession signaling closed", { code, reason: reason || undefined, uptimeMs });
      this.stopSignalingKeepalive();
      this.emit("close");
    });
    this.signaling.on("error", (err) => this.emit("error", err));

    this.peer.on("iceCandidate", (candidate) => {
      // Portal: SDP answer on channelId 0, trickle ICE on channelId 1.
      this.signaling.sendInfoCandidate(candidate, 1);
    });
    this.peer.on("iceGatheringComplete", () => {
      rootHTTPLogger.info("RtcSession ICE gathering complete — sending end-of-candidates");
      this.signaling.sendInfoEndOfCandidates(1);
    });
    this.peer.on("commandChannelOpen", () => {
      if (!this.connected) {
        this.connected = true;
        this.connectedAt = Date.now();
        rootHTTPLogger.info("RtcSession connected — WebrtcDataChannel open");
        this.startSignalingKeepalive();
        this.emit("connected");
      }
    });
    this.peer.on("error", (err) => this.emit("error", err));
    this.peer.on("data", (label, data, linkType) => {
      if (label === "WebrtcDataChannel") {
        this.emit("commandData", data, linkType ?? 1);
      }
    });
  }

  public async connect(): Promise<void> {
    await this.signaling.fetchSign();
    await this.signaling.connect();
    await this.waitForAuth();
    rootHTTPLogger.info("RtcSession auth ok — sending scall", { channelId: this.channelId });
    this.signaling.sendCall(this.channelId);
  }

  public isCommandChannelReady(): boolean {
    return this.peer.isCommandChannelReady();
  }

  public sendCommand(data: Buffer): boolean {
    return this.peer.sendCommand(data);
  }

  public close(): void {
    this.closed = true;
    this.connected = false;
    this.stopSignalingKeepalive();
    try {
      this.signaling.sendHangup(this.channelId);
    } catch {
      /* ignore */
    }
    this.signaling.close();
    this.peer.close();
  }

  private waitForAuth(timeoutMs = 15000): Promise<void> {
    if (this.authOk) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("RtcSession auth timeout")), timeoutMs);
      const onMsg = (inner: { action?: number; code?: number }) => {
        if (inner.action === 1 && inner.code === 200) {
          this.authOk = true;
          clearTimeout(timer);
          this.signaling.off("message", onMsg);
          resolve();
        }
      };
      this.signaling.on("message", onMsg);
    });
  }

  private rtc408Retries = 0;

  private async handleSignalingMessage(inner: {
    action?: number;
    dataType?: string;
    data?: string;
    code?: number;
  }): Promise<void> {
    if (!inner.data) {
      if (inner.action === 1 && inner.code === 200) {
        this.authOk = true;
      }
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(inner.data) as Record<string, unknown>;
    } catch {
      return;
    }

    const dataType = inner.dataType;
    if (dataType !== "scall" && dataType !== "call") {
      rootHTTPLogger.info("RtcSession signaling message", {
        dataType,
        format: payload.format,
        hasValue: Boolean(payload.value ?? payload.sdp),
      });
    }

    if (dataType === "hangup") {
      const uptimeMs = this.connectedAt ? Date.now() - this.connectedAt : undefined;
      rootHTTPLogger.warn("RtcSession hub hangup", { uptimeMs, channelId: (inner as { channelId?: number }).channelId });
      return;
    }

    if (dataType === "scall" || dataType === "call") {
      await this.handleCallResponse(payload as ScallCallPayload);
    } else if (dataType === "info") {
      await this.handleInfoResponse(payload as InfoPayload);
    }
  }

  private async handleCallResponse(payload: ScallCallPayload): Promise<void> {
    if (this.closed) {
      return;
    }
    const status = payload.status;
    rootHTTPLogger.info("RtcSession scall response", { status, hasTurn: !!payload.turn });

    if (status === 100 && payload.turn) {
      this.rtc408Retries = 0;
      this.turn = payload.turn;
      this.emit("turn", payload.turn);
      await this.peer.initWithTurn(payload.turn, this.resolvePeerOptions());
    } else if (status === 200) {
      this.signaling.sendAck(this.channelId);
    } else if (status === 486 || status === 408) {
      this.rtc408Retries++;
      rootHTTPLogger.warn("RtcSession scall retry", { status, retries: this.rtc408Retries });
      if (this.closed) {
        return;
      }
      try {
        this.signaling.sendHangup(this.channelId);
      } catch {
        /* ignore */
      }
      this.peer.close();
      this.sdpHandled = false;
      this.turn = undefined;
      this.connected = false;
      const waitMs = Math.min(5000 + this.rtc408Retries * 5000, 30000);
      await new Promise((r) => setTimeout(r, waitMs));
      if (this.closed) {
        return;
      }
      if (this.rtc408Retries >= 3) {
        this.emit("error", new Error(`RtcSession scall ${status} after ${this.rtc408Retries} retries`));
        return;
      }
      this.signaling.sendCall(this.channelId);
    }
  }

  private resolvePeerOptions(): RtcPeerOptions {
    const envPolicy = process.env.RTC_ICE_POLICY?.toLowerCase();
    const iceTransportPolicy =
      this.opts.iceTransportPolicy ??
      (envPolicy === "all" ? "all" : envPolicy === "relay" ? "relay" : "all");
    const envSetup = process.env.RTC_DTLS_SETUP?.toLowerCase();
    const dtlsSetup =
      this.opts.dtlsSetup ??
      (envSetup === "active" ? "active" : envSetup === "passive" ? "passive" : "passive");
    return { iceTransportPolicy, dtlsSetup };
  }

  private async handleInfoResponse(payload: InfoPayload): Promise<void> {
    if (payload.format === "CANDIDATE") {
      if (!payload.value) {
        rootHTTPLogger.debug("RtcSession remote end-of-candidates");
        return;
      }
      await this.peer.addRemoteCandidate(payload.value);
      return;
    }

    if (payload.candidate !== undefined) {
      if (!payload.candidate) {
        rootHTTPLogger.debug("RtcSession remote end-of-candidates (candidate channel)");
        return;
      }
      await this.peer.addRemoteCandidate(payload.candidate);
      return;
    }

    const sdpPayload = payload.value ?? payload.sdp;
    if (!sdpPayload) {
      return;
    }

    if (payload.format === "SDP" || payload.sdp) {
      if (this.sdpHandled) {
        return;
      }
      this.sdpHandled = true;
      let sdpOffer: string;
      try {
        const json = JSON.parse(sdpPayload);
        sdpOffer = scallJsonToSdpOffer(json);
      } catch {
        sdpOffer = sdpPayload;
      }

      rootHTTPLogger.info("RtcSession received SDP offer", { len: sdpOffer.length });
      if (!this.turn) {
        rootHTTPLogger.warn("RtcSession SDP before TURN — waiting");
      }

      const answerSdp = await this.peer.handleRemoteOffer(sdpOffer);
      let sendSdp = answerSdp;
      if (process.env.RTC_DELAY_SDP_UNTIL_GATHERING === "1") {
        try {
          await this.peer.waitForIceGatheringComplete();
          sendSdp = this.peer.getLocalAnswerSdp() ?? answerSdp;
          rootHTTPLogger.info("RtcSession SDP answer refreshed after ICE gathering", {
            candidates: (sendSdp.match(/a=candidate:/g) ?? []).length,
          });
        } catch (err) {
          rootHTTPLogger.warn("RtcSession ICE gathering wait failed — sending initial answer", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const scallJson = this.peer.getCommandChannelScallJson(sendSdp);
      this.signaling.sendInfoSdp(scallJson, this.channelId);
      rootHTTPLogger.info("RtcSession sent SDP answer");
    }
  }

  private startSignalingKeepalive(): void {
    this.stopSignalingKeepalive();
    const tick = (): void => {
      if (this.closed || !this.connected) {
        return;
      }
      try {
        this.signaling.sendKeepalive();
        rootHTTPLogger.debug("RtcSession signaling keepalive sent");
      } catch (err) {
        rootHTTPLogger.warn("RtcSession signaling keepalive failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.signalingKeepaliveTimer = setTimeout(tick, this.signalingKeepaliveMs);
    };
    this.signalingKeepaliveTimer = setTimeout(tick, this.signalingKeepaliveMs);
  }

  private stopSignalingKeepalive(): void {
    if (this.signalingKeepaliveTimer) {
      clearTimeout(this.signalingKeepaliveTimer);
      this.signalingKeepaliveTimer = undefined;
    }
  }
}
