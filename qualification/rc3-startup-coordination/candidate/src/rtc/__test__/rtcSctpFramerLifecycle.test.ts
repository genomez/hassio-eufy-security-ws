import { LibSctpModule, RtcSctpFramer } from "../rtcSctpFramer";

interface ModuleTracker {
  activeManagers: number;
  createCalls: number;
  destroyCalls: number;
}

function fakeModule(tracker: ModuleTracker, failReceiveManager = false): LibSctpModule {
  let nextManager = 1;
  let nextCallback = 1;
  return {
    _set_mxlog_level: jest.fn(),
    _sctp_frame_manager_create: jest.fn((isSender: number) => {
      tracker.createCalls += 1;
      if (!isSender && failReceiveManager) {
        return 0;
      }
      tracker.activeManagers += 1;
      return nextManager++;
    }),
    _sctp_frame_manager_destroy: jest.fn(() => {
      tracker.activeManagers -= 1;
      tracker.destroyCalls += 1;
    }),
    _sctp_frame_manager_set_send_packet_callback: jest.fn(),
    _sctp_frame_manager_set_recv_frame_callback: jest.fn(),
    _sctp_frame_manager_push_frame_data: jest.fn(() => 0),
    _sctp_frame_manager_push_packet_data: jest.fn(() => 0),
    _sctp_frame_manager_get_frame_buffer: jest.fn(() => 1),
    _sctp_frame_buffer_get_data: jest.fn(() => 1),
    _sctp_frame_buffer_set_size: jest.fn(),
    _sctp_frame_manager_get_packet_buffer: jest.fn(() => 1),
    _sctp_packet_get_data: jest.fn(() => 1),
    _sctp_frame_manager_on_100ms_timer: jest.fn(),
    HEAPU8: new Uint8Array(1024),
    addFunction: jest.fn(() => nextCallback++),
  };
}

describe("RtcSctpFramer module lifecycle", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("creates an independent module for every framer", async () => {
    const trackers: ModuleTracker[] = [];
    const factory = jest.fn(async () => {
      const tracker = { activeManagers: 0, createCalls: 0, destroyCalls: 0 };
      trackers.push(tracker);
      return fakeModule(tracker);
    });
    const first = new RtcSctpFramer(factory);
    const second = new RtcSctpFramer(factory);

    await first.init(jest.fn(), jest.fn());
    await second.init(jest.fn(), jest.fn());

    expect(factory).toHaveBeenCalledTimes(2);
    expect(trackers).toHaveLength(2);
    expect(trackers.map((tracker) => tracker.activeManagers)).toEqual([2, 2]);

    first.destroy();
    second.destroy();
    expect(trackers.map((tracker) => tracker.activeManagers)).toEqual([0, 0]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("releases all managers and timers across repeated sessions", async () => {
    const tracker = { activeManagers: 0, createCalls: 0, destroyCalls: 0 };
    const factory = jest.fn(async () => fakeModule(tracker));

    for (let i = 0; i < 500; i++) {
      const framer = new RtcSctpFramer(factory);
      await framer.init(jest.fn(), jest.fn());
      framer.destroy();
    }

    expect(factory).toHaveBeenCalledTimes(500);
    expect(tracker.createCalls).toBe(1000);
    expect(tracker.destroyCalls).toBe(1000);
    expect(tracker.activeManagers).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("cleans up a send manager when receive manager creation fails", async () => {
    const tracker = { activeManagers: 0, createCalls: 0, destroyCalls: 0 };
    const framer = new RtcSctpFramer(async () => fakeModule(tracker, true));

    await expect(framer.init(jest.fn(), jest.fn())).rejects.toThrow("receive manager creation failed");

    expect(tracker.createCalls).toBe(2);
    expect(tracker.destroyCalls).toBe(1);
    expect(tracker.activeManagers).toBe(0);
    expect(framer.isReady()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("does not create managers when destroyed while the module is loading", async () => {
    const tracker = { activeManagers: 0, createCalls: 0, destroyCalls: 0 };
    let resolveModule!: (module: LibSctpModule) => void;
    const pendingModule = new Promise<LibSctpModule>((resolve) => {
      resolveModule = resolve;
    });
    const framer = new RtcSctpFramer(() => pendingModule);

    const initializing = framer.init(jest.fn(), jest.fn());
    framer.destroy();
    resolveModule(fakeModule(tracker));

    await expect(initializing).rejects.toThrow("destroyed during initialization");
    expect(tracker.createCalls).toBe(0);
    expect(tracker.destroyCalls).toBe(0);
    expect(framer.isReady()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("destroy is idempotent", async () => {
    const tracker = { activeManagers: 0, createCalls: 0, destroyCalls: 0 };
    const framer = new RtcSctpFramer(async () => fakeModule(tracker));

    await framer.init(jest.fn(), jest.fn());
    framer.destroy();
    framer.destroy();

    expect(tracker.destroyCalls).toBe(2);
    expect(tracker.activeManagers).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });
});
