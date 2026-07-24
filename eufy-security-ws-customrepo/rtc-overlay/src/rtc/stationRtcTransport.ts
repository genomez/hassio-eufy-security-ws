import { createHash } from "crypto";
import { EventEmitter } from "events";

import { rootHTTPLogger } from "../logging";
import { RtcSession } from "./rtcSession";
import { MegaRtcCredentials } from "./types";

export interface StationRtcTransportEvents {
  connected: () => void;
  close: () => void;
  error: (err: Error) => void;
  /** Fired after a successful make-before-break session swap (no disconnect gap). */
  handoff: (info: { durationMs: number }) => void;
}

/**
 * T9000 WebRTC transport — sign → WS auth → scall → data channel.
 * Replaces legacy TUTK P2P for HomeBase Professional S1.
 */
export class StationRtcTransport extends EventEmitter {
  private session?: RtcSession;
  private connecting = false;
  private connected = false;
  private handoffInProgress = false;
  /** When true, ignore close events from a session we are intentionally retiring. */
  private retiringSession = false;
  private commandDataHandler?: (data: Buffer, linkType?: number) => void;

  constructor(
    private readonly stationSn: string,
    private readonly adminUserId: string,
    private credentials: MegaRtcCredentials,
    // A whole connect attempt (sign → auth → scall → offer/answer → DTLS → data channel) normally
    // completes in <1s; when it fails, DTLS gives up at ~31s. The old 180s default meant a failed
    // attempt blocked reconnect for 3 minutes. Cap at 45s (past the DTLS timeout) so a missed
    // handshake retries promptly. Tunable via RTC_CONNECT_TIMEOUT_MS.
    private readonly connectTimeoutMs = Math.max(
      10000,
      Number(process.env.RTC_CONNECT_TIMEOUT_MS ?? "45000") || 45000
    )
  ) {
    super();
  }

  public updateCredentials(credentials: MegaRtcCredentials): void {
    this.credentials = credentials;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public isConnecting(): boolean {
    return this.connecting || this.handoffInProgress;
  }

  public async connect(): Promise<void> {
    if (this.connected || this.connecting || this.handoffInProgress) {
      return;
    }
    if (!this.credentials.authToken || !this.credentials.userId) {
      throw new Error("T9000 RTC: mega credentials missing");
    }

    this.connecting = true;
    const session = this.createSession();
    this.session = session;
    this.wirePrimarySession(session);

    rootHTTPLogger.info("StationRtcTransport connecting", { stationSn: this.stationSn });

    try {
      await session.connect();
    } catch (err) {
      this.connecting = false;
      this.closeSession();
      throw err;
    }

    if (this.connected) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.connecting = false;
        this.closeSession();
        reject(new Error("T9000 RTC connect timeout"));
      }, this.connectTimeoutMs);

      const onConnected = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        this.connecting = false;
        this.closeSession();
        reject(err);
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        this.off("connected", onConnected);
        this.off("error", onError);
      };

      this.on("connected", onConnected);
      this.on("error", onError);
    });
  }

  /**
   * Make-before-break refresh: open a new WebRTC command session while the current one is
   * still up, then swap. Avoids the ~25s offline gap from hard close + reconnect when the
   * hub's ~337s command-path cliff forces a refresh. Returns false if handoff fails (caller
   * may fall back to hard close).
   */
  public async handoffConnect(): Promise<boolean> {
    if (!this.credentials.authToken || !this.credentials.userId) {
      return false;
    }
    if (!this.connected || !this.session) {
      try {
        await this.connect();
        return this.connected;
      } catch {
        return false;
      }
    }
    if (this.handoffInProgress || this.connecting) {
      rootHTTPLogger.debug("StationRtcTransport handoff skipped — already in progress", {
        stationSn: this.stationSn,
      });
      return false;
    }

    this.handoffInProgress = true;
    const oldSession = this.session;
    const startedAt = Date.now();
    const newSession = this.createSession();

    rootHTTPLogger.info("StationRtcTransport handoff starting — second session while first stays up", {
      stationSn: this.stationSn,
    });

    let settled = false;
    const waitConnected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("T9000 RTC handoff timeout"));
        }
      }, this.connectTimeoutMs);

      newSession.on("connected", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
      newSession.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      newSession.on("close", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("T9000 RTC handoff closed before connect"));
        }
      });
      newSession.on("commandData", (data, linkType) => {
        this.commandDataHandler?.(data, linkType);
      });
    });

    try {
      await newSession.connect();
      await waitConnected;

      // Swap before retiring old so sendCommand uses the new channel immediately.
      this.session = newSession;
      this.wirePrimarySession(newSession);

      this.retiringSession = true;
      try {
        oldSession.removeAllListeners();
        oldSession.close();
      } catch {
        /* ignore */
      }
      this.retiringSession = false;

      const durationMs = Date.now() - startedAt;
      rootHTTPLogger.info("StationRtcTransport handoff complete", {
        stationSn: this.stationSn,
        durationMs,
      });
      this.emit("handoff", { durationMs });
      this.handoffInProgress = false;
      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      rootHTTPLogger.warn("StationRtcTransport handoff failed — keeping existing session", {
        stationSn: this.stationSn,
        error: error.message,
        durationMs: Date.now() - startedAt,
      });
      try {
        newSession.removeAllListeners();
        newSession.close();
      } catch {
        /* ignore */
      }
      // Ensure we still point at the old session if swap never happened.
      if (this.session !== oldSession && this.session !== newSession) {
        this.session = oldSession;
      } else if (this.session === newSession) {
        this.session = oldSession;
        this.wirePrimarySession(oldSession);
      }
      this.handoffInProgress = false;
      this.retiringSession = false;
      return false;
    }
  }

  public isCommandChannelReady(): boolean {
    return this.session?.isCommandChannelReady() ?? false;
  }

  public sendCommand(data: Buffer): boolean {
    return this.session?.sendCommand(data) ?? false;
  }

  public onCommandData(handler: (data: Buffer, linkType?: number) => void): void {
    this.commandDataHandler = handler;
  }

  public close(): void {
    const wasConnected = this.connected;
    this.connecting = false;
    this.handoffInProgress = false;
    this.connected = false;
    this.closeSession();
    // Intentional close() clears connected before the session async "close" handler runs,
    // so emit here to ensure Station.onRtcDisconnect() and HA connected events fire.
    if (wasConnected) {
      this.emit("close");
    }
  }

  private createSession(): RtcSession {
    const gtoken = createHash("md5").update(this.credentials.userId).digest("hex");
    return new RtcSession({
      authToken: this.credentials.authToken,
      gtoken,
      stationSn: this.stationSn,
      adminUserId: this.adminUserId,
      region: this.credentials.region,
    });
  }

  private wirePrimarySession(session: RtcSession): void {
    session.removeAllListeners("connected");
    session.removeAllListeners("close");
    session.removeAllListeners("error");
    session.removeAllListeners("commandData");

    session.on("connected", () => {
      if (this.connected) {
        return;
      }
      this.connecting = false;
      this.connected = true;
      this.emit("connected");
    });
    session.on("close", () => {
      if (this.retiringSession || this.session !== session) {
        return;
      }
      const wasConnected = this.connected;
      this.connected = false;
      this.connecting = false;
      this.handoffInProgress = false;
      if (wasConnected) {
        this.emit("close");
      }
    });
    session.on("error", (err) => this.emit("error", err));
    session.on("commandData", (data, linkType) => {
      this.commandDataHandler?.(data, linkType);
    });
  }

  private closeSession(): void {
    if (this.session) {
      try {
        this.session.close();
      } catch {
        /* ignore */
      }
      this.session = undefined;
    }
  }
}
