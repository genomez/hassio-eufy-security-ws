export type MegaAuthRecoveryStatus =
  "cleared_reauth_required" | "connected_guard" | "cooldown" | "not_configured" | "failed";

export interface MegaAuthRecoveryResult {
  status: MegaAuthRecoveryStatus;
  attemptedAt?: number;
  cooldownUntil?: number;
  failedStage?: "check_connection" | "read_cooldown" | "backup" | "record_cooldown" | "clear_session";
}

export function isMegaAuthRecoveryEnabled(value: string | undefined): boolean {
  return value !== "0" && value?.toLowerCase() !== "false";
}

type MaybePromise<T> = T | Promise<T>;

export interface MegaAuthRecoveryDependencies {
  isRtcConnected: () => MaybePromise<boolean>;
  readLastAttemptAt: () => MaybePromise<number | undefined>;
  createPersistenceBackup: () => MaybePromise<void>;
  recordAttemptAt: (attemptedAt: number) => MaybePromise<void>;
  clearMegaSession: () => MaybePromise<void>;
  now?: () => number;
}

/**
 * Fail-closed, single-flight guard for the reporter-only revoked Mega token recovery.
 *
 * This class deliberately does not perform a login. Once the stale root Mega session
 * has been backed up and removed, the host application must run its normal login flow
 * so 2FA/captcha handling remains unchanged.
 */
export class GuardedMegaAuthRecovery {
  private inFlight?: Promise<MegaAuthRecoveryResult>;

  constructor(
    private readonly dependencies: MegaAuthRecoveryDependencies,
    private readonly cooldownMs = 24 * 60 * 60 * 1000
  ) {}

  public async run(): Promise<MegaAuthRecoveryResult> {
    if (this.inFlight) {
      return this.inFlight;
    }

    const operation = this.runOnce();
    this.inFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.inFlight === operation) {
        this.inFlight = undefined;
      }
    }
  }

  private async runOnce(): Promise<MegaAuthRecoveryResult> {
    try {
      if (await this.dependencies.isRtcConnected()) {
        return { status: "connected_guard" };
      }
    } catch {
      return { status: "failed", failedStage: "check_connection" };
    }

    const now = this.dependencies.now?.() ?? Date.now();
    let lastAttemptAt: number | undefined;
    try {
      lastAttemptAt = await this.dependencies.readLastAttemptAt();
    } catch {
      return { status: "failed", failedStage: "read_cooldown" };
    }

    if (lastAttemptAt !== undefined && now - lastAttemptAt < this.cooldownMs) {
      return {
        status: "cooldown",
        attemptedAt: lastAttemptAt,
        cooldownUntil: lastAttemptAt + this.cooldownMs,
      };
    }

    try {
      await this.dependencies.createPersistenceBackup();
    } catch {
      return { status: "failed", failedStage: "backup" };
    }

    try {
      await this.dependencies.recordAttemptAt(now);
    } catch {
      return { status: "failed", failedStage: "record_cooldown" };
    }

    try {
      await this.dependencies.clearMegaSession();
    } catch {
      return {
        status: "failed",
        attemptedAt: now,
        cooldownUntil: now + this.cooldownMs,
        failedStage: "clear_session",
      };
    }

    return {
      status: "cleared_reauth_required",
      attemptedAt: now,
      cooldownUntil: now + this.cooldownMs,
    };
  }
}
