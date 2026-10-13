import { EventEmitter } from "events";

import { RtcTurnConfig } from "../rtcPeer";
import { connectAndWaitForTurn } from "../turnHarvestWait";

class FakeTurnHarvestSession extends EventEmitter {
  constructor(private readonly connectImpl: () => Promise<void>) {
    super();
  }

  public connect(): Promise<void> {
    return this.connectImpl();
  }
}

const turnConfig: RtcTurnConfig = {
  turn_addr: "192.0.2.10",
  turn_port: 3478,
  turn_user: "user",
  turn_password: "password",
};

describe("connectAndWaitForTurn", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("cleans up the timeout when connect fails before TURN arrives", async () => {
    const session = new FakeTurnHarvestSession(async () => {
      throw new Error("fetchSign failed");
    });

    await expect(connectAndWaitForTurn(session, 15_000)).rejects.toThrow("fetchSign failed");

    expect(jest.getTimerCount()).toBe(0);
    expect(session.listenerCount("turn")).toBe(0);
    expect(session.listenerCount("error")).toBe(0);
    jest.runOnlyPendingTimers();
  });

  it("resolves with TURN credentials and removes its listeners", async () => {
    const session = new FakeTurnHarvestSession(async () => {
      session.emit("turn", turnConfig);
    });

    await expect(connectAndWaitForTurn(session, 15_000)).resolves.toEqual(turnConfig);

    expect(jest.getTimerCount()).toBe(0);
    expect(session.listenerCount("turn")).toBe(0);
    expect(session.listenerCount("error")).toBe(0);
  });

  it("rejects a TURN timeout without leaving timers or listeners", async () => {
    const session = new FakeTurnHarvestSession(async () => undefined);
    const result = connectAndWaitForTurn(session, 15_000);

    jest.advanceTimersByTime(15_000);

    await expect(result).rejects.toThrow("turn harvest timeout");
    expect(jest.getTimerCount()).toBe(0);
    expect(session.listenerCount("turn")).toBe(0);
    expect(session.listenerCount("error")).toBe(0);
  });
});
