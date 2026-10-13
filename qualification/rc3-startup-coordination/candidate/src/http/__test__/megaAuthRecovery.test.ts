import { GuardedMegaAuthRecovery, isMegaAuthRecoveryEnabled, MegaAuthRecoveryDependencies } from "../megaAuthRecovery";

describe("Mega auth recovery configuration", () => {
  it("defaults on but accepts an explicit fail-closed disable", () => {
    expect(isMegaAuthRecoveryEnabled(undefined)).toBe(true);
    expect(isMegaAuthRecoveryEnabled("1")).toBe(true);
    expect(isMegaAuthRecoveryEnabled("0")).toBe(false);
    expect(isMegaAuthRecoveryEnabled("false")).toBe(false);
    expect(isMegaAuthRecoveryEnabled("FALSE")).toBe(false);
  });
});

function dependencies(overrides: Partial<MegaAuthRecoveryDependencies> = {}): MegaAuthRecoveryDependencies {
  return {
    isRtcConnected: () => false,
    readLastAttemptAt: () => undefined,
    createPersistenceBackup: () => undefined,
    recordAttemptAt: () => undefined,
    clearMegaSession: () => undefined,
    now: () => 1_000_000,
    ...overrides,
  };
}

describe("GuardedMegaAuthRecovery", () => {
  it("fails closed while any RTC station is connected", async () => {
    const backup = jest.fn();
    const clear = jest.fn();
    const recovery = new GuardedMegaAuthRecovery(
      dependencies({ isRtcConnected: () => true, createPersistenceBackup: backup, clearMegaSession: clear })
    );

    await expect(recovery.run()).resolves.toEqual({ status: "connected_guard" });
    expect(backup).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("fails closed when RTC connection state cannot be checked", async () => {
    const backup = jest.fn();
    const recovery = new GuardedMegaAuthRecovery(
      dependencies({
        isRtcConnected: () => {
          throw new Error("state unavailable");
        },
        createPersistenceBackup: backup,
      })
    );

    await expect(recovery.run()).resolves.toEqual({ status: "failed", failedStage: "check_connection" });
    expect(backup).not.toHaveBeenCalled();
  });

  it("honors the persisted 24-hour cooldown without changing persistence", async () => {
    const backup = jest.fn();
    const clear = jest.fn();
    const recovery = new GuardedMegaAuthRecovery(
      dependencies({
        readLastAttemptAt: () => 500_000,
        createPersistenceBackup: backup,
        clearMegaSession: clear,
      })
    );

    await expect(recovery.run()).resolves.toEqual({
      status: "cooldown",
      attemptedAt: 500_000,
      cooldownUntil: 500_000 + 24 * 60 * 60 * 1000,
    });
    expect(backup).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("backs up, records cooldown, and only then clears the stale session", async () => {
    const order: string[] = [];
    const recovery = new GuardedMegaAuthRecovery(
      dependencies({
        createPersistenceBackup: () => order.push("backup"),
        recordAttemptAt: () => order.push("cooldown"),
        clearMegaSession: () => order.push("clear"),
      })
    );

    await expect(recovery.run()).resolves.toEqual({
      status: "cleared_reauth_required",
      attemptedAt: 1_000_000,
      cooldownUntil: 1_000_000 + 24 * 60 * 60 * 1000,
    });
    expect(order).toEqual(["backup", "cooldown", "clear"]);
  });

  it("does not record or clear when the persistence backup fails", async () => {
    const record = jest.fn();
    const clear = jest.fn();
    const recovery = new GuardedMegaAuthRecovery(
      dependencies({
        createPersistenceBackup: () => {
          throw new Error("backup failed");
        },
        recordAttemptAt: record,
        clearMegaSession: clear,
      })
    );

    await expect(recovery.run()).resolves.toEqual({ status: "failed", failedStage: "backup" });
    expect(record).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent recovery requests", async () => {
    let releaseBackup: (() => void) | undefined;
    let markBackupStarted: (() => void) | undefined;
    const backupStarted = new Promise<void>((resolve) => {
      markBackupStarted = resolve;
    });
    const backup = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseBackup = resolve;
          markBackupStarted?.();
        })
    );
    const clear = jest.fn();
    const recovery = new GuardedMegaAuthRecovery(
      dependencies({ createPersistenceBackup: backup, clearMegaSession: clear })
    );

    const first = recovery.run();
    const second = recovery.run();
    await backupStarted;
    releaseBackup?.();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
