import { createHash, createHmac, randomUUID } from "crypto";
import { EventEmitter } from "events";

import { rootHTTPLogger } from "../logging";
import {
  DEFAULT_RTC_WS_PATH,
  DEFAULT_SMART_HOST,
  RtcInnerMessage,
  RtcSignalingOptions,
  RtcWsEnvelope,
} from "./types";

export interface RtcSignalingEvents {
  message: (inner: RtcInnerMessage, envelope: RtcWsEnvelope) => void;
  open: () => void;
  close: (code: number, reason: string) => void;
  error: (err: Error) => void;
}

function base64urlJson(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * T9000 RTC signaling WebSocket (security-smart.eufylife.com).
 * Phase 1: sign → subprotocol auth → sendAuth → receive envelopes.
 */
export class RtcSignalingClient extends EventEmitter {
  private ws?: WebSocket;
  private sign?: string;
  private readonly opts: Required<
    Pick<RtcSignalingOptions, "smartHost" | "source" | "connectTimeoutMs" | "region">
  > &
    RtcSignalingOptions;

  constructor(options: RtcSignalingOptions) {
    super();
    this.opts = {
      smartHost: DEFAULT_SMART_HOST,
      source: "WEB",
      connectTimeoutMs: 15000,
      region: "US",
      ...options,
    };
  }

  public static gtokenFromUserId(userId: string): string {
    return createHash("md5").update(userId).digest("hex");
  }

  public getWsUrl(): string {
    return `wss://${this.opts.smartHost ?? DEFAULT_SMART_HOST}${DEFAULT_RTC_WS_PATH}`;
  }

  /** GET /v1/smart/nvr/ws/sign */
  public async fetchSign(): Promise<string> {
    const host = this.opts.smartHost ?? DEFAULT_SMART_HOST;
    const url = `https://${host}/v1/smart/nvr/ws/sign`;
    const res = await fetch(url, {
      headers: {
        "X-Auth-Token": this.opts.authToken,
        GToken: this.opts.gtoken,
        "App-Name": "eufy_mega",
        "Model-Type": "WEB",
        Country: this.opts.region,
        Language: "en",
      },
    });
    const body = (await res.json()) as { code?: number; data?: string; msg?: string };
    if (!res.ok || body.code !== 0 || !body.data) {
      throw new Error(`RtcSignaling fetchSign failed: HTTP ${res.status} ${body.msg ?? ""}`);
    }
    this.sign = body.data;
    return body.data;
  }

  public async connect(): Promise<void> {
    if (this.ws) {
      return;
    }
    const sign = this.sign ?? (await this.fetchSign());
    const subprotoPayload = {
      region: this.opts.region,
      type: "NVR",
      sn: this.opts.stationSn,
      token: this.opts.authToken,
      gtoken: this.opts.gtoken,
      sign,
      appName: "eufy_mega",
      modelType: "WEB",
    };
    const subproto = base64urlJson(subprotoPayload);
    const url = this.getWsUrl();

    rootHTTPLogger.info("RtcSignaling connecting", { url, stationSn: this.opts.stationSn });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`RtcSignaling connect timeout after ${this.opts.connectTimeoutMs}ms`));
      }, this.opts.connectTimeoutMs);

      const ws = new WebSocket(url, ["v1", subproto]);
      this.ws = ws;

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        this.sendAuth(sign);
        rootHTTPLogger.info("RtcSignaling open");
        this.emit("open");
        resolve();
      });

      ws.addEventListener("message", (ev: MessageEvent) => {
        void this.handleWireMessage(ev.data);
      });

      ws.addEventListener("close", (ev: CloseEvent) => {
        clearTimeout(timer);
        this.ws = undefined;
        rootHTTPLogger.info("RtcSignaling close", {
          code: ev.code,
          reason: ev.reason || undefined,
          stationSn: this.opts.stationSn,
        });
        this.emit("close", ev.code, ev.reason ?? "");
      });

      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("RtcSignaling WebSocket error"));
      });
    });
  }

  /** Re-send auth to keep signaling WS alive (hub closes idle sessions ~83s). */
  public sendKeepalive(): void {
    if (!this.sign) {
      return;
    }
    this.sendAuth(this.sign);
  }

  /** action:1 auth — matches web portal sendAuth(). */
  public sendAuth(sign?: string): void {
    const s = sign ?? this.sign;
    if (!s) {
      throw new Error("RtcSignaling sendAuth: no sign");
    }
    const inner = {
      code: 200,
      action: 1,
      data: s,
      sn: this.opts.stationSn,
      source: this.opts.source,
      ts: Math.floor(Date.now() / 1000),
    };
    this.sendEnvelope("0", inner);
  }

  /** Portal account field: HmacSHA256(channelId+adminUserId+ts, authToken). */
  public static sessionAccount(
    channelId: number,
    adminUserId: string,
    ts: number,
    authToken: string
  ): string {
    const message = `${channelId}${adminUserId}${ts}`;
    return createHmac("sha256", authToken).update(message).digest("hex");
  }

  /** action:3 scall/call — starts WebRTC negotiation. */
  public sendCall(channelId = 0): void {
    this.sendSession("scall", {}, channelId);
  }

  /** action:3 ack after scall status 200. */
  public sendAck(channelId = 0): void {
    this.sendSession("ack", {}, channelId);
  }

  /** action:3 info — SDP answer (portal: channelId 0, payload { sdp }). */
  public sendInfoSdp(sdpJson: string, channelId = 0): void {
    this.sendSession("info", { sdp: sdpJson }, channelId);
  }

  /** action:3 info — trickle ICE (portal: channelId 1, payload { candidate }). */
  public sendInfoCandidate(candidate: string, channelId = 1): void {
    this.sendSession("info", { candidate }, channelId);
  }

  /** action:3 info — end-of-candidates on trickle channel (portal channelId 1). */
  public sendInfoEndOfCandidates(channelId = 1): void {
    this.sendSession("info", { candidate: "" }, channelId);
  }

  /** action:3 info — legacy scall CANDIDATE format (channel 0). */
  public sendInfoCandidateScall(candidate: string, channelId = 0): void {
    this.sendSession("info", { format: "CANDIDATE", value: candidate }, channelId);
  }

  /** action:3 info — legacy end-of-candidates on scall channel. */
  public sendInfoEndOfCandidatesScall(channelId = 0): void {
    this.sendSession("info", { format: "CANDIDATE", value: "" }, channelId);
  }

  /** action:3 session message (scall, call, info, …). */
  public sendSession(dataType: string, payload: Record<string, unknown> = {}, channelId = 0): void {
    const ts = Math.floor(Date.now() / 1000);
    const adminUserId = this.opts.adminUserId ?? "";
    const inner = {
      code: 200,
      action: 3,
      sessionId: this.sign,
      sn: this.opts.stationSn,
      channelId,
      isResponse: 0,
      dataType,
      source: this.opts.source,
      ts,
      data: JSON.stringify({
        timestamp: ts,
        account: RtcSignalingClient.sessionAccount(channelId, adminUserId, ts, this.opts.authToken),
        ...payload,
      }),
    };
    const msgid = `${this.opts.authToken}_${randomUUID().replace(/-/g, "")}`;
    if (process.env.RTC_VERBOSE === "1" || process.env.RTC_VERBOSE === "true") {
      rootHTTPLogger.info("RtcSignaling sendSession", {
        dataType,
        channelId,
        payloadKeys: Object.keys(payload),
        sdpLen: typeof payload.sdp === "string" ? payload.sdp.length : undefined,
        candidate: typeof payload.candidate === "string" ? payload.candidate.slice(0, 48) : undefined,
      });
    }
    this.sendEnvelope(msgid, inner);
  }

  public sendHangup(channelId = 0): void {
    this.sendSession("hangup", {}, channelId);
  }

  public close(): void {
    this.ws?.close();
    this.ws = undefined;
  }

  private sendEnvelope(msgid: string, inner: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("RtcSignaling not connected");
    }
    const envelope: RtcWsEnvelope = {
      msgid,
      data: JSON.stringify(inner),
    };
    this.ws.send(JSON.stringify(envelope));
  }

  private async handleWireMessage(raw: unknown): Promise<void> {
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (raw instanceof Blob) {
      text = await raw.text();
    } else if (raw instanceof ArrayBuffer) {
      text = Buffer.from(raw).toString("utf8");
    } else if (Buffer.isBuffer(raw)) {
      text = raw.toString("utf8");
    } else {
      return;
    }

    let envelope: RtcWsEnvelope;
    try {
      envelope = JSON.parse(text) as RtcWsEnvelope;
    } catch {
      return;
    }
    if (!envelope.data) {
      return;
    }

    let inner: RtcInnerMessage;
    try {
      inner = JSON.parse(envelope.data) as RtcInnerMessage;
    } catch {
      return;
    }

    rootHTTPLogger.debug("RtcSignaling message", {
      dataType: inner.dataType,
      action: inner.action,
      isResponse: inner.isResponse,
    });
    this.emit("message", inner, envelope);
  }
}
