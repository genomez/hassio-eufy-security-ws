import { EventEmitter } from "events";

import {
  connectAndWaitForRtcSession,
  runWithHandoffTerminalTimeout,
  StationRtcTransport,
} from "../stationRtcTransport";
import { RtcConnectTimeoutError, RtcNegotiationDiagnostic, RtcSession } from "../rtcSession";

class FakeRtcSession extends EventEmitter {
  public readonly close = jest.fn();

  constructor(private readonly connectImpl: () => Promise<void>) {
    super();
  }

  public connect(): Promise<void> {
    return this.connectImpl();
  }

  public createConnectTimeoutError(): RtcConnectTimeoutError {
    const diagnostic: RtcNegotiationDiagnostic = {
      stage: "no_hub_sdp_offer",
      connectionState: "connecting",
      iceConnectionState: "new",
      iceGatheringState: "new",
      signalingState: "stable",
      selectedPairPresent: false,
      commandChannelOpen: false,
      scallAccepted: true,
      peerInitialized: true,
      sdpHandled: false,
      iceGatheringComplete: false,
    };
    return new RtcConnectTimeoutError(diagnostic);
  }
}

const asRtcSession = (session: FakeRtcSession): RtcSession => session as unknown as RtcSession;

describe("connectAndWaitForRtcSession", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("cleans up the timeout when connect rejects before the connected event", async () => {
    const session = new FakeRtcSession(async () => {
      throw new Error("signaling failed");
    });

    await expect(connectAndWaitForRtcSession(asRtcSession(session), 15_000)).rejects.toThrow("signaling failed");

    expect(jest.getTimerCount()).toBe(0);
    expect(session.eventNames()).toEqual([]);
    jest.runOnlyPendingTimers();
  });

  it("rejects a timeout without leaving timers or event listeners", async () => {
    const session = new FakeRtcSession(() => new Promise<void>(() => undefined));
    const result = expect(connectAndWaitForRtcSession(asRtcSession(session), 15_000)).rejects.toThrow(
      "T9000 RTC handoff timeout"
    );

    jest.advanceTimersByTime(15_000);

    await result;
    expect(jest.getTimerCount()).toBe(0);
    expect(session.eventNames()).toEqual([]);
  });

  it("resolves on connected and removes its timeout and listeners", async () => {
    const session = new FakeRtcSession(async () => {
      session.emit("connected");
    });

    await expect(connectAndWaitForRtcSession(asRtcSession(session), 15_000)).resolves.toBeUndefined();

    expect(jest.getTimerCount()).toBe(0);
    expect(session.eventNames()).toEqual([]);
  });
});

describe("StationRtcTransport initial connect classification", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("rejects a connect timeout with the session's sanitized negotiation stage", async () => {
    const session = new FakeRtcSession(async () => undefined);
    const transport = new StationRtcTransport(
      "station",
      "admin",
      { authToken: "test", userId: "user", region: "US" },
      10_000
    );
    const internal = transport as unknown as { createSession: () => RtcSession };
    internal.createSession = () => asRtcSession(session);

    const connection = transport.connect();
    await Promise.resolve();
    const result = expect(connection).rejects.toMatchObject({
      name: "RtcConnectTimeoutError",
      diagnostic: { stage: "no_hub_sdp_offer", selectedPairPresent: false },
    });
    jest.advanceTimersByTime(10_000);

    await result;
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("runWithHandoffTerminalTimeout", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("arms the outer watchdog before invoking a never-settling attempt", async () => {
    const phases: string[] = [];
    const onTimeout = jest.fn();
    const attempt = jest.fn(() => new Promise<void>(() => undefined));
    const result = expect(
      runWithHandoffTerminalTimeout(attempt, 10_000, onTimeout, (phase) => phases.push(phase))
    ).rejects.toThrow("T9000 RTC handoff outer timeout");

    expect(phases.slice(0, 3)).toEqual(["outer_watchdog_armed", "outer_attempt_invoking", "outer_attempt_invoked"]);

    jest.advanceTimersByTime(10_000);

    await result;
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(phases).toContain("outer_watchdog_fired");
    expect(jest.getTimerCount()).toBe(0);
  });

  it("clears the outer watchdog when the attempt settles", async () => {
    const onTimeout = jest.fn();

    await expect(runWithHandoffTerminalTimeout(async () => "connected", 10_000, onTimeout)).resolves.toBe("connected");

    expect(onTimeout).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("rejects and runs cleanup when an external deadline aborts the attempt", async () => {
    const phases: string[] = [];
    const onTimeout = jest.fn();
    const abortController = new AbortController();
    const result = expect(
      runWithHandoffTerminalTimeout(
        () => new Promise<void>(() => undefined),
        45_000,
        onTimeout,
        (phase) => phases.push(phase),
        abortController.signal
      )
    ).rejects.toThrow("station deadline");

    abortController.abort(new Error("station deadline"));

    await result;
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(phases).toContain("outer_external_abort_armed");
    expect(phases).toContain("outer_external_abort_received");
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("StationRtcTransport handoff failure", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("keeps the working session and leaves no timer when replacement connect fails", async () => {
    const oldSession = new FakeRtcSession(async () => undefined);
    const replacement = new FakeRtcSession(async () => {
      throw new Error("replacement signaling failed");
    });
    const transport = new StationRtcTransport(
      "station",
      "admin",
      { authToken: "test", userId: "user", region: "US" },
      10_000
    );
    const internal = transport as unknown as {
      connected: boolean;
      session: RtcSession;
      createSession: () => RtcSession;
    };
    internal.connected = true;
    internal.session = asRtcSession(oldSession);
    internal.createSession = () => asRtcSession(replacement);

    await expect(transport.handoffConnect()).resolves.toBe(false);

    expect(internal.session).toBe(asRtcSession(oldSession));
    expect(oldSession.close).not.toHaveBeenCalled();
    expect(replacement.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    jest.runOnlyPendingTimers();
  });

  it("keeps the working session when the external handoff watchdog fires", async () => {
    const oldSession = new FakeRtcSession(async () => undefined);
    const replacement = new FakeRtcSession(() => new Promise<void>(() => undefined));
    const transport = new StationRtcTransport(
      "station",
      "admin",
      { authToken: "test", userId: "user", region: "US" },
      10_000
    );
    const internal = transport as unknown as {
      connected: boolean;
      handoffInProgress: boolean;
      session: RtcSession;
      createSession: () => RtcSession;
    };
    internal.connected = true;
    internal.session = asRtcSession(oldSession);
    internal.createSession = () => asRtcSession(replacement);

    const handoff = expect(transport.handoffConnect()).resolves.toBe(false);
    jest.advanceTimersByTime(10_000);

    await handoff;
    expect(internal.session).toBe(asRtcSession(oldSession));
    expect(internal.handoffInProgress).toBe(false);
    expect(oldSession.close).not.toHaveBeenCalled();
    expect(replacement.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("keeps the working session when the station-level abort signal fires", async () => {
    const oldSession = new FakeRtcSession(async () => undefined);
    const replacement = new FakeRtcSession(() => new Promise<void>(() => undefined));
    const transport = new StationRtcTransport(
      "station",
      "admin",
      { authToken: "test", userId: "user", region: "US" },
      45_000
    );
    const internal = transport as unknown as {
      connected: boolean;
      handoffInProgress: boolean;
      session: RtcSession;
      createSession: () => RtcSession;
    };
    internal.connected = true;
    internal.session = asRtcSession(oldSession);
    internal.createSession = () => asRtcSession(replacement);
    const abortController = new AbortController();

    const handoff = expect(transport.handoffConnect(abortController.signal)).resolves.toBe(false);
    abortController.abort(new Error("station deadline"));

    await handoff;
    expect(internal.session).toBe(asRtcSession(oldSession));
    expect(internal.handoffInProgress).toBe(false);
    expect(oldSession.close).not.toHaveBeenCalled();
    expect(replacement.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
