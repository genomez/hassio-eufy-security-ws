import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";

jest.mock("../../logging", () => {
  const stub = { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), trace: jest.fn() };
  return new Proxy({}, { get: () => stub });
});

import { EufySecurity } from "../../eufysecurity";

interface RecoveryInternals {
  backupPersistenceBeforeMegaAuthRecovery(): void;
  clearMegaSessionForAuthRecovery(): void;
}

describe("EufySecurity guarded Mega persistence recovery", () => {
  let persistentDir: string;

  beforeEach(() => {
    persistentDir = mkdtempSync(path.join(tmpdir(), "eufy-mega-auth-test3-"));
  });

  afterEach(() => {
    rmSync(persistentDir, { recursive: true, force: true });
  });

  it("backs up persistence and removes only the root Mega session", () => {
    const persistentFile = path.join(persistentDir, "persistent.json");
    const persistentData = {
      country: "FR",
      openudid: "dummy-openudid",
      serial_number: "dummy-serial",
      push_credentials: undefined,
      push_persistentIds: [],
      login_hash: "dummy-login-hash",
      version: "test",
      httpApi: { sentinel: "preserve-http" },
      megaApi: { cloud_token: "dummy-token", user_id: "dummy-user" },
    };
    const originalPersistentData = JSON.parse(JSON.stringify(persistentData));
    writeFileSync(persistentFile, JSON.stringify(persistentData));
    const setMegaRtcCredentials = jest.fn();
    const context = {
      config: { persistentDir },
      persistentFile,
      persistentData,
      megaApi: { sentinel: "stale-instance" },
      api: { setMegaRtcCredentials },
      writePersistentData(): void {
        writeFileSync(persistentFile, JSON.stringify(this.persistentData));
      },
    } as unknown as EufySecurity;
    const internals = EufySecurity.prototype as unknown as RecoveryInternals;

    internals.backupPersistenceBeforeMegaAuthRecovery.call(context);
    internals.clearMegaSessionForAuthRecovery.call(context);

    const files = readdirSync(persistentDir);
    const backups = files.filter((file) => file.startsWith("persistent.json.pre-mega-auth-test3-"));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(persistentDir, backups[0]), "utf8"))).toEqual(originalPersistentData);

    const current = JSON.parse(readFileSync(persistentFile, "utf8")) as Record<string, unknown>;
    expect(current).not.toHaveProperty("megaApi");
    expect(current.httpApi).toEqual({ sentinel: "preserve-http" });
    expect(current.country).toBe("FR");
    expect(setMegaRtcCredentials).toHaveBeenCalledWith(undefined);
  });

  it("refuses to mutate inline persistence because no local backup can be guaranteed", () => {
    const persistentFile = path.join(persistentDir, "persistent.json");
    writeFileSync(persistentFile, JSON.stringify({ megaApi: { cloud_token: "dummy-token" } }));
    const context = {
      config: { persistentDir, persistentData: "{}" },
      persistentFile,
    } as unknown as EufySecurity;
    const internals = EufySecurity.prototype as unknown as RecoveryInternals;

    expect(() => internals.backupPersistenceBeforeMegaAuthRecovery.call(context)).toThrow(
      "file-backed persistence is required"
    );
    expect(readdirSync(persistentDir)).toEqual(["persistent.json"]);
  });
});
