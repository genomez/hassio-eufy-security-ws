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

type RtcConnectWaitSession = Pick<RtcSession, "connect" | "on" | "off">;
type RtcHandoffPhaseReporter = (phase: string, details?: Record<string, unknown>) => void;

/**
 * Arm the session events and the timeout as one immediately observed promise.
 * This prevents a failed/slow connect() from leaving a separate timeout promise
 * behind to reject later as an unhandled rejection.
 */
export function connectAndWaitForRtcSession(
  session: RtcConnectWaitSession,
  timeoutMs: number,
  reportPhase?: RtcHandoffPhaseReporter
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      session.off("connected", onConnected);
      session.off("error", onError);
      session.off("close", onClose);
    };
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const report = (phase: string): void => {
      try {
        reportPhase?.(phase);
      } catch {
        /* diagnostics must never change the connection lifecycle */
      }
    };
    const onConnected = (): void => {
      report("session_connected");
      finish();
    };
    const onError = (error: unknown): void => {
      report("session_error");
      finish(error instanceof Error ? error : new Error(String(error)));
    };
    const onClose = (): void => {
      report("session_closed_before_connect");
      finish(new Error("T9000 RTC handoff closed before connect"));
    };

    session.on("connected", onConnected);
    session.on("error", onError);
    session.on("close", onClose);
    report("session_listeners_armed");
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        report("session_timeout_fired");
        finish(new Error("T9000 RTC handoff timeout"));
      }, timeoutMs);
      report("session_timeout_armed");
    }

    try {
      report("session_connect_invoking");
      void session
        .connect()
        .then(() => report("session_connect_resolved"))
        .catch((error: unknown) => {
          report("session_connect_rejected");
          finish(error instanceof Error ? error : new Error(String(error)));
        });
      report("session_connect_invoked");
    } catch (error) {
      report("session_connect_threw");
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Arm a terminal watchdog before the replacement connection factory is invoked.
 * The handoff uses this guard outside all session/signaling promises so a stalled
 * inner lifecycle cannot leave handoffConnect() pending forever.
 */
export function runWithHandoffTerminalTimeout<T>(
  attemptFactory: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  reportPhase?: RtcHandoffPhaseReporter,
  externalSignal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let externalAbortHandler: (() => void) | undefined;

    const report = (phase: string): void => {
      try {
        reportPhase?.(phase);
      } catch {
        /* diagnostics must never change the connection lifecycle */
      }
    };
    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (externalAbortHandler !== undefined && externalSignal !== undefined) {
        externalSignal.removeEventListener("abort", externalAbortHandler);
        externalAbortHandler = undefined;
      }
    };
    const succeed = (value: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const terminateAttempt = (phase: string, error: Error): void => {
      if (settled) {
        return;
      }
      report(phase);
      try {
        onTimeout();
      } catch {
        report("outer_watchdog_cleanup_threw");
      }
      fail(error);
    };

    timer = setTimeout(() => {
      terminateAttempt("outer_watchdog_fired", new Error("T9000 RTC handoff outer timeout"));
    }, timeoutMs);
    report("outer_watchdog_armed");

    if (externalSignal !== undefined) {
      externalAbortHandler = () => {
        const reason = externalSignal.reason;
        terminateAttempt(
          "outer_external_abort_received",
          reason instanceof Error ? reason : new Error("T9000 RTC handoff externally aborted")
        );
      };
      externalSignal.addEventListener("abort", externalAbortHandler, { once: true });
      report("outer_external_abort_armed");
      if (externalSignal.aborted) {
        externalAbortHandler();
        return;
      }
    }

    let attempt: Promise<T>;
    try {
      report("outer_attempt_invoking");
      attempt = attemptFactory();
      report("outer_attempt_invoked");
    } catch (error) {
      report("outer_attempt_threw");
      fail(error);
      return;
    }

    void attempt.then(
      (value) => {
        report("outer_attempt_resolved");
        succeed(value);
      },
      (error: unknown) => {
        report("outer_attempt_rejected");
        fail(error);
      }
    );
  });
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
  private handoffSequence = 0;
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
    private readonly connectTimeoutMs = Math.max(10000, Number(process.env.RTC_CONNECT_TIMEOUT_MS ?? "45000") || 45000)
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
  public async handoffConnect(externalSignal?: AbortSignal): Promise<boolean> {
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
    const monotonicStartedAt = performance.now();
    const handoffId = ++this.handoffSequence;
    let newSession: RtcSession | undefined;
    let replacementClosed = false;
    let terminalOutcome: "complete" | "failed" = "failed";
    const heartbeatIntervalMs = 5_000;
    let nextHeartbeatAt = monotonicStartedAt + heartbeatIntervalMs;
    let heartbeatTimer: NodeJS.Timeout | undefined;

    rootHTTPLogger.info("StationRtcTransport handoff starting — second session while first stays up", {
      stationSn: this.stationSn,
      handoffId,
      timeoutMs: this.connectTimeoutMs,
    });

    const reportPhase = (phase: string, details: Record<string, unknown> = {}): void => {
      rootHTTPLogger.info("StationRtcTransport handoff phase", {
        stationSn: this.stationSn,
        handoffId,
        phase,
        elapsedMs: Date.now() - startedAt,
        ...details,
      });
    };
    const closeReplacement = (phase: string): void => {
      if (!newSession || replacementClosed) {
        return;
      }
      replacementClosed = true;
      reportPhase(phase);
      try {
        newSession.close();
      } catch {
        reportPhase(`${phase}_threw`);
      }
    };

    heartbeatTimer = setInterval(() => {
      const monotonicNow = performance.now();
      reportPhase("handoff_heartbeat", {
        monotonicElapsedMs: Math.round(monotonicNow - monotonicStartedAt),
        eventLoopLagMs: Math.max(0, Math.round(monotonicNow - nextHeartbeatAt)),
      });
      nextHeartbeatAt += heartbeatIntervalMs;
    }, heartbeatIntervalMs);
    reportPhase("handoff_heartbeat_armed", { intervalMs: heartbeatIntervalMs });

    try {
      newSession = this.createSession(handoffId);
      reportPhase("replacement_created");
      newSession.on("commandData", (data, linkType) => {
        this.commandDataHandler?.(data, linkType);
      });
      reportPhase("replacement_command_listener_armed");

      await runWithHandoffTerminalTimeout(
        () => connectAndWaitForRtcSession(newSession as RtcSession, 0, reportPhase),
        this.connectTimeoutMs,
        () => closeReplacement("replacement_timeout_close"),
        reportPhase,
        externalSignal
      );
      reportPhase("replacement_connected");

      // Swap before retiring old so sendCommand uses the new channel immediately.
      this.session = newSession;
      this.wirePrimarySession(newSession);
      reportPhase("replacement_adopted");

      this.retiringSession = true;
      try {
        oldSession.removeAllListeners();
        oldSession.close();
      } catch {
        /* ignore */
      }
      this.retiringSession = false;
      reportPhase("original_retired");

      const durationMs = Date.now() - startedAt;
      rootHTTPLogger.info("StationRtcTransport handoff complete", {
        stationSn: this.stationSn,
        handoffId,
        durationMs,
      });
      this.emit("handoff", { durationMs });
      terminalOutcome = "complete";
      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      rootHTTPLogger.warn("StationRtcTransport handoff failed — keeping existing session", {
        stationSn: this.stationSn,
        handoffId,
        error: error.message,
        durationMs: Date.now() - startedAt,
      });
      try {
        newSession?.removeAllListeners();
      } catch {
        /* ignore */
      }
      closeReplacement("replacement_failure_close");
      // Ensure we still point at the old session if swap never happened.
      if (this.session !== oldSession && this.session !== newSession) {
        this.session = oldSession;
      } else if (this.session === newSession) {
        this.session = oldSession;
        this.wirePrimarySession(oldSession);
      }
      return false;
    } finally {
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
        reportPhase("handoff_heartbeat_cleared");
      }
      this.handoffInProgress = false;
      this.retiringSession = false;
      rootHTTPLogger.info("StationRtcTransport handoff finalized", {
        stationSn: this.stationSn,
        handoffId,
        outcome: terminalOutcome,
        durationMs: Date.now() - startedAt,
      });
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

  private createSession(handoffId?: number): RtcSession {
    const gtoken = createHash("md5").update(this.credentials.userId).digest("hex");
    return new RtcSession({
      authToken: this.credentials.authToken,
      gtoken,
      stationSn: this.stationSn,
      adminUserId: this.adminUserId,
      region: this.credentials.region,
      handoffId,
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
