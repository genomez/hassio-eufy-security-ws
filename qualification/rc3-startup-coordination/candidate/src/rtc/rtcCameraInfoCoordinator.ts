export type RtcCameraInfoReason =
  | "startup-catchup"
  | "startup-sdk"
  | "startup-floodlight"
  | "manual"
  | "guard"
  | "post-command"
  | "periodic"
  | "floodlight"
  | "hub-notify";

export interface RtcCameraInfoToken {
  readonly generation: number;
  readonly id: number;
}

export interface RtcCameraInfoSnapshot {
  generation: number;
  pendingCount: number;
  waitingForReady: number;
  queuedCount: number;
  trailingCount: number;
  elapsedMs: number;
}

export interface RtcCameraInfoDiagnostic extends RtcCameraInfoSnapshot {
  event:
    | "requested"
    | "startup-coalesced"
    | "trailing-retained"
    | "queued"
    | "sent"
    | "ack"
    | "timeout"
    | "reset"
    | "payload"
    | "send-error";
  reason?: RtcCameraInfoReason;
  returnCode?: number;
}

export interface RtcCameraInfoCoordinatorHooks {
  now: () => number;
  isReady: () => boolean;
  send: (token: RtcCameraInfoToken) => void;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (timer: unknown) => void;
  timeoutMs: number;
  readinessRetryMs?: number;
  onRelease?: (token: RtcCameraInfoToken) => void;
  onDiagnostic?: (diagnostic: RtcCameraInfoDiagnostic) => void;
}

interface PendingCameraInfo {
  token: RtcCameraInfoToken;
  reason: RtcCameraInfoReason;
  startedAt: number;
  queued: boolean;
  sent: boolean;
  deadline?: unknown;
  readinessTimer?: unknown;
}

/** One station's identical RTC reads; ACK completion never asserts property freshness. */
export class RtcCameraInfoCoordinator {
  private generation = 0;
  private nextId = 0;
  private pending?: PendingCameraInfo;
  private trailing?: RtcCameraInfoReason;
  private readonly startupCohorts = new Set<number>();

  public constructor(private readonly hooks: RtcCameraInfoCoordinatorHooks) {
    if (!Number.isFinite(hooks.timeoutMs) || hooks.timeoutMs <= 0) {
      throw new Error("Camera-info timeout must be finite and positive");
    }
    if (
      hooks.readinessRetryMs !== undefined &&
      (!Number.isFinite(hooks.readinessRetryMs) || hooks.readinessRetryMs <= 0)
    ) {
      throw new Error("Camera-info readiness retry must be finite and positive");
    }
  }

  public request(reason: RtcCameraInfoReason = "manual", startupDelayMs = 0): void {
    reason = this.normalizeReason(reason);
    if (
      (reason === "startup-catchup" || reason === "startup-sdk" || reason === "startup-floodlight") &&
      startupDelayMs !== 0 && startupDelayMs !== 2000 && startupDelayMs !== 5000 && startupDelayMs !== 15000
    ) {
      reason = "manual";
    }
    if (reason === "startup-catchup" || reason === "startup-sdk" || reason === "startup-floodlight") {
      if (this.startupCohorts.has(startupDelayMs)) {
        this.diagnose("startup-coalesced", reason);
        return;
      }
      this.startupCohorts.add(startupDelayMs);
      if (this.pending) {
        this.trailing ??= reason;
        this.diagnose("trailing-retained", reason);
        return;
      }
    } else if (this.pending) {
      this.trailing = reason;
      this.diagnose("trailing-retained", reason);
      return;
    }
    this.start(reason);
  }

  /** Called synchronously where the RTC transport installs its ACK timer and sends. */
  public markSent(token: RtcCameraInfoToken, ackTimeoutMs?: number): void {
    const pending = this.pending;
    if (pending?.token !== token || pending.sent) {
      return;
    }
    pending.sent = true;
    pending.startedAt = this.hooks.now();
    const deadlineMs =
      ackTimeoutMs !== undefined && Number.isFinite(ackTimeoutMs) && ackTimeoutMs > 0 && ackTimeoutMs <= 2_147_483_647
        ? Math.min(ackTimeoutMs + 1000, 2_147_483_647)
        : this.hooks.timeoutMs;
    this.armDeadline(pending, deadlineMs);
    this.diagnose("sent", pending.reason);
  }

  public complete(token: RtcCameraInfoToken, returnCode: number): void {
    if (this.pending?.token !== token) {
      return;
    }
    this.diagnose("ack", this.pending.reason, returnCode);
    this.release(token);
  }

  /** Payloads are not request-correlated, so they must not release a newer read. */
  public notePayload(): void {
    this.diagnose("payload");
  }

  public reset(): void {
    this.generation++;
    this.trailing = undefined;
    this.startupCohorts.clear();
    const token = this.pending?.token;
    if (token) {
      this.release(token);
    }
    this.diagnose("reset");
  }

  public snapshot(): RtcCameraInfoSnapshot {
    return {
      generation: this.generation,
      pendingCount: this.pending ? 1 : 0,
      waitingForReady: this.pending && !this.pending.queued ? 1 : 0,
      queuedCount: this.pending?.queued && !this.pending.sent ? 1 : 0,
      trailingCount: this.trailing ? 1 : 0,
      elapsedMs: this.pending ? Math.max(0, this.hooks.now() - this.pending.startedAt) : 0,
    };
  }

  private start(reason: RtcCameraInfoReason): void {
    const pending: PendingCameraInfo = {
      token: Object.freeze({ generation: this.generation, id: ++this.nextId }),
      reason,
      startedAt: this.hooks.now(),
      queued: false,
      sent: false,
    };
    this.pending = pending;
    this.armDeadline(pending);
    this.diagnose("requested", reason);
    this.trySend(pending);
  }

  private armDeadline(pending: PendingCameraInfo, timeoutMs = this.hooks.timeoutMs): void {
    if (pending.deadline !== undefined) {
      this.hooks.cancel(pending.deadline);
    }
    pending.deadline = this.hooks.schedule(() => {
      if (this.pending !== pending) {
        return;
      }
      this.diagnose("timeout", pending.reason);
      this.release(pending.token);
    }, timeoutMs);
  }

  private trySend(pending: PendingCameraInfo): void {
    if (this.pending !== pending) {
      return;
    }
    if (!this.hooks.isReady()) {
      pending.readinessTimer = this.hooks.schedule(() => {
        pending.readinessTimer = undefined;
        this.trySend(pending);
      }, this.hooks.readinessRetryMs ?? 100);
      return;
    }
    pending.queued = true;
    this.diagnose("queued", pending.reason);
    try {
      this.hooks.send(pending.token);
    } catch {
      this.diagnose("send-error", pending.reason);
      this.release(pending.token);
    }
  }

  private release(token: RtcCameraInfoToken): void {
    const pending = this.pending;
    if (pending?.token !== token) {
      return;
    }
    if (pending.deadline !== undefined) this.hooks.cancel(pending.deadline);
    if (pending.readinessTimer !== undefined) this.hooks.cancel(pending.readinessTimer);
    this.pending = undefined;
    this.hooks.onRelease?.(token);
    const trailing = this.trailing;
    this.trailing = undefined;
    if (trailing) this.start(trailing);
  }

  private diagnose(event: RtcCameraInfoDiagnostic["event"], reason?: RtcCameraInfoReason, returnCode?: number): void {
    this.hooks.onDiagnostic?.({ ...this.snapshot(), event, reason, returnCode });
  }

  private normalizeReason(reason: RtcCameraInfoReason): RtcCameraInfoReason {
    switch (reason) {
      case "startup-catchup":
      case "startup-sdk":
      case "startup-floodlight":
      case "guard":
      case "post-command":
      case "periodic":
      case "floodlight":
      case "hub-notify":
        return reason;
      default:
        return "manual";
    }
  }
}
