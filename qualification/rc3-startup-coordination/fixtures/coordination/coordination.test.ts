// @ts-nocheck
const { createLoader } = require('./module-loader.cjs');
const { stationContext } = require('./contexts.cjs');

function coordinatorContext(options = {}) {
  const loader = createLoader();
  const { RtcCameraInfoCoordinator } = loader.load('rtc/rtcCameraInfoCoordinator');
  let ready = options.ready !== false;
  const sent = [], released = [], diagnostics = [];
  let coordinator;
  coordinator = new RtcCameraInfoCoordinator({
    now: () => Date.now(), isReady: () => ready, timeoutMs: 13000,
    schedule: (callback, delay) => setTimeout(callback, delay), cancel: timer => clearTimeout(timer),
    send: token => { sent.push(token); if (options.error) throw Error('synthetic failure');
      if (options.autoSend !== false) coordinator.markSent(token); },
    onRelease: token => released.push(token), onDiagnostic: row => diagnostics.push(row),
  });
  return { coordinator, sent, released, diagnostics, loader, setReady: value => { ready = value; } };
}
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(0); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('Station-scoped camera info coordination', () => {
  test.each([0, 2000, 5000, 15000])('three producers share exact %i ms cohort even after a fast ACK', delay => {
    const c = coordinatorContext();
    c.coordinator.request('startup-catchup', delay);
    c.coordinator.complete(c.sent[0], 0);
    c.coordinator.request('startup-sdk', delay);
    c.coordinator.request('startup-floodlight', delay);
    expect(c.sent).toHaveLength(1);
    expect(c.coordinator.snapshot().pendingCount).toBe(0);
    expect(c.diagnostics.filter(row => row.event === 'startup-coalesced')).toHaveLength(2);
  });
  test('different startup cohorts while pending retain exactly one trailing refresh', () => {
    const c = coordinatorContext();
    c.coordinator.request('startup-catchup', 0);
    c.coordinator.request('startup-sdk', 2000);
    c.coordinator.request('startup-floodlight', 5000);
    expect(c.sent).toHaveLength(1);
    expect(c.coordinator.snapshot().trailingCount).toBe(1);
    c.coordinator.complete(c.sent[0], 0);
    expect(c.sent).toHaveLength(2);
    c.coordinator.complete(c.sent[0], 0);
    expect(c.coordinator.snapshot().pendingCount).toBe(1);
  });
  test.each([NaN, Infinity, -1, 42, 2001])('invalid startup delay %s stays fresh and cannot grow cohort history', delay => {
    const c = coordinatorContext(); c.coordinator.request('startup-sdk', 0);
    c.coordinator.request('startup-catchup', delay); c.coordinator.request('startup-floodlight', delay);
    expect(c.coordinator.snapshot().trailingCount).toBe(1);
    c.coordinator.complete(c.sent[0], 0); expect(c.sent).toHaveLength(2);
    c.coordinator.complete(c.sent[1], 0); c.coordinator.request('startup-sdk', delay);
    expect(c.sent).toHaveLength(3);
    expect(c.diagnostics.at(-1).reason).toBe('manual');
  });
  test.each([2147482648, 2147483647])('actual ACK timeout %i stays within signed 32-bit timer range', timeout => {
    const c = coordinatorContext({ autoSend: false }); c.coordinator.request('manual');
    c.coordinator.markSent(c.sent[0], timeout);
    jest.advanceTimersByTime(2147483646); expect(c.coordinator.snapshot().pendingCount).toBe(1);
    jest.advanceTimersByTime(1); expect(c.coordinator.snapshot().pendingCount).toBe(0);
  });
  test.each(['manual', 'guard', 'post-command', 'periodic', 'floodlight', 'hub-notify'])('%s intent needs a trailing request independent of old ACK', reason => {
    const c = coordinatorContext();
    c.coordinator.request('startup-sdk');
    c.coordinator.request(reason);
    c.coordinator.request(reason);
    if (reason === 'manual') {
      c.coordinator.request('guard'); c.coordinator.request('post-command'); c.coordinator.request('floodlight');
    }
    expect(c.coordinator.snapshot().trailingCount).toBe(1);
    c.coordinator.complete(c.sent[0], 0);
    expect(c.sent).toHaveLength(2);
    expect(c.diagnostics.filter(row => row.event === 'sent').at(-1).reason).toBe(reason === 'manual' ? 'floodlight' : reason);
    expect(c.coordinator.snapshot().pendingCount).toBe(1);
    c.coordinator.complete(c.sent[0], -1);
    expect(c.coordinator.snapshot().pendingCount).toBe(1);
    c.coordinator.complete(c.sent[1], 0);
    expect(c.coordinator.snapshot().pendingCount).toBe(0);
  });
  test('readiness hold emits no command until channel is ready', () => {
    const c = coordinatorContext({ ready: false });
    c.coordinator.request('manual');
    jest.advanceTimersByTime(1200);
    expect(c.sent).toHaveLength(0);
    expect(c.coordinator.snapshot().waitingForReady).toBe(1);
    c.setReady(true); jest.advanceTimersByTime(100);
    expect(c.sent).toHaveLength(1);
    expect(c.coordinator.snapshot().waitingForReady).toBe(0);
  });
  test('bounded readiness expiry cancels its intent and permits a fresh request', () => {
    const c = coordinatorContext({ ready: false });
    c.coordinator.request('manual'); jest.advanceTimersByTime(13000);
    expect(c.released).toHaveLength(1);
    expect(c.coordinator.snapshot().pendingCount).toBe(0);
    c.setReady(true); c.coordinator.request('guard');
    expect(c.sent).toHaveLength(1);
  });
  test('queued hold has bounded release without pretending transport sent', () => {
    const c = coordinatorContext({ autoSend: false });
    c.coordinator.request('manual');
    expect(c.coordinator.snapshot().queuedCount).toBe(1);
    expect(c.diagnostics.some(row => row.event === 'sent')).toBe(false);
    jest.advanceTimersByTime(13000);
    expect(c.released).toEqual(c.sent);
  });
  test('actual send rearms ACK timeout from send time with transport timeout', () => {
    const c = coordinatorContext({ autoSend: false });
    c.coordinator.request('manual'); jest.advanceTimersByTime(12000);
    c.coordinator.markSent(c.sent[0], 20000);
    jest.advanceTimersByTime(20999);
    expect(c.coordinator.snapshot().pendingCount).toBe(1);
    jest.advanceTimersByTime(1);
    expect(c.coordinator.snapshot().pendingCount).toBe(0);
  });
  test.each([-1, -109, 0])('ACK code %i releases single flight and survives in bounded diagnostic', code => {
    const c = coordinatorContext(); c.coordinator.request('manual');
    c.coordinator.complete(c.sent[0], code);
    expect(c.coordinator.snapshot().pendingCount).toBe(0);
    expect(c.diagnostics.find(row => row.event === 'ack').returnCode).toBe(code);
  });
  test('send error releases request without network retry', () => {
    const c = coordinatorContext({ error: true }); c.coordinator.request('manual');
    expect(c.sent).toHaveLength(1); expect(c.released).toHaveLength(1);
    expect(c.coordinator.snapshot().pendingCount).toBe(0);
  });
  test('disconnect reset clears old cohorts, trailing intent, and stale callbacks', () => {
    const c = coordinatorContext(); c.coordinator.request('startup-sdk');
    c.coordinator.request('guard'); const old = c.sent[0]; c.coordinator.reset();
    expect(jest.getTimerCount()).toBe(0);
    c.coordinator.request('startup-sdk'); const current = c.sent[1];
    expect(current.generation).toBe(old.generation + 1);
    c.coordinator.markSent(old); c.coordinator.complete(old, 0);
    expect(c.coordinator.snapshot().pendingCount).toBe(1);
    expect(c.coordinator.snapshot().trailingCount).toBe(0);
  });
  test('payload before and after ACK never releases pending newer intent or asserts freshness', () => {
    const c = coordinatorContext(); c.coordinator.request('manual'); c.coordinator.request('guard');
    c.coordinator.notePayload(); expect(c.sent).toHaveLength(1);
    c.coordinator.complete(c.sent[0], 0); c.coordinator.notePayload();
    expect(c.coordinator.snapshot().pendingCount).toBe(1);
    expect(JSON.stringify(c.diagnostics)).not.toMatch(/fresh|property|payloadData/);
  });
});

describe('Actual Station producer, result, payload, and lifecycle methods', () => {
  test('actual getCameraInfo coalesces same delay producers and preserves command format', () => {
    const c = stationContext();
    for (const reason of ['startup-catchup', 'startup-sdk', 'startup-floodlight']) c.station.getCameraInfo(reason, 0);
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].command).toEqual({ commandType: c.CommandType.CMD_CAMERA_INFO, value: 255, channel: 255 });
    c.ack(c.sent[0]); expect(c.station.rtcCameraInfoCoordinator.snapshot().pendingCount).toBe(0);
    expect(c.events.some(row => row[0] === 'command result')).toBe(true);
  });
  test('actual scheduled hub-first producers keep distinct delays and current-mode reconciliation', () => {
    const c = stationContext(); const reconciled = jest.fn(); c.station.syncCurrentModeFromGuardModeIfNeeded = reconciled;
    c.station.runHubFirstPropertySync([0, 2000, 5000], true, 'startup-catchup');
    jest.advanceTimersByTime(0); expect(c.sent).toHaveLength(1); c.ack(c.sent[0]);
    jest.advanceTimersByTime(2000); expect(c.sent).toHaveLength(2); c.ack(c.sent[1]);
    jest.advanceTimersByTime(3000); expect(c.sent).toHaveLength(3);
    expect(reconciled).toHaveBeenCalledTimes(3);
  });
  test('actual negative onCommandResponse releases and cannot fulfill trailing guard intent', () => {
    const c = stationContext(); c.station.getCameraInfo('manual'); c.station.getCameraInfo('guard');
    c.ack(c.sent[0], -1); expect(c.sent).toHaveLength(2);
    c.ack(c.sent[0], 0); expect(c.station.rtcCameraInfoCoordinator.snapshot().pendingCount).toBe(1);
    expect(c.events[0][2].return_code).toBe(-1);
  });
  test('actual payload callback observes without completing read', () => {
    const c = stationContext(); c.station.getCameraInfo('manual');
    c.station.onCameraInfo({ params: [], db_bypass_str: [] });
    expect(c.station.rtcCameraInfoCoordinator.snapshot().pendingCount).toBe(1);
    expect(c.loader.logs.some(row => row.args[0] === 'RTC camera info coordination' && row.args[1].event === 'payload')).toBe(true);
  });
  test('actual readiness hold and exact queued cancellation keep metadata distinct', () => {
    const c = stationContext({ ready: false, autoSend: false }); c.station.getCameraInfo('manual');
    expect(c.sent).toHaveLength(0); c.setReady(true); jest.advanceTimersByTime(100);
    expect(c.sent).toHaveLength(1); jest.advanceTimersByTime(12900);
    expect(c.cancelled).toEqual([c.sent[0].data]); expect(c.observed.size).toBe(0);
    expect(c.station.rtcCameraInfoCoordinator.snapshot().pendingCount).toBe(0);
  });
  test('actual RTC disconnect resets generation; old result after reconnection remains stale', () => {
    const c = stationContext(); c.station.getCameraInfo('startup-sdk'); const old = c.sent[0];
    c.station.getCameraInfo('guard'); c.station.onRtcDisconnect();
    c.station.getCameraInfo('startup-sdk'); expect(c.sent).toHaveLength(2);
    c.ack(old); expect(c.station.rtcCameraInfoCoordinator.snapshot().pendingCount).toBe(1);
    expect(c.cancelled).toContain(old.data);
  });
  test('actual Station close cancels unsent request and coordinator timers', () => {
    const c = stationContext({ autoSend: false }); c.station.getCameraInfo('manual'); c.station.close();
    expect(c.cancelled).toEqual([c.sent[0].data]);
    expect(c.station.rtcCameraInfoCoordinator.snapshot().pendingCount).toBe(0);
    jest.advanceTimersByTime(30000); expect(c.sent).toHaveLength(1);
  });
  test('unrelated station requests run independently without global serialization', () => {
    const first = stationContext(), second = stationContext();
    first.station.getCameraInfo('manual'); second.station.getCameraInfo('manual');
    expect(first.sent).toHaveLength(1); expect(second.sent).toHaveLength(1);
    expect(first.sent[0].data).not.toBe(second.sent[0].data);
  });
  test('legacy station preserves repeated immediate camera-info sends without metadata', () => {
    const c = stationContext({ s1: false }); c.station.getCameraInfo(); c.station.getCameraInfo();
    expect(c.sent).toHaveLength(2); expect(c.sent[0].data).toBeUndefined();
    expect(c.station.rtcCameraInfoCoordinator).toBeUndefined();
  });
});

describe('Actual P2P queue cancellation and actual RTC ACK parser', () => {
  test('cancelQueuedRtcCameraInfo removes only identical unsent camera-info metadata', () => {
    const loader = createLoader(); const { P2PClientProtocol } = loader.load('p2p/session');
    const { CommandType } = loader.load('p2p/types'); const target = {}, other = {};
    const rows = [
      { p2pCommand: { commandType: CommandType.CMD_CAMERA_INFO }, customData: target },
      { p2pCommand: { commandType: CommandType.CMD_CAMERA_INFO }, customData: other },
      { p2pCommand: { commandType: CommandType.CMD_SET_ARMING }, customData: target },
      { p2pCommand: { commandType: CommandType.CMD_CAMERA_INFO } },
    ];
    const session = Object.create(P2PClientProtocol.prototype);
    session.sendQueue = [...rows]; session.rtcCameraInfoSendObservers = new WeakMap();
    const observer = jest.fn(); session.observeRtcCameraInfoSend(target, observer);
    session.cancelQueuedRtcCameraInfo(target);
    expect(session.sendQueue).toEqual(rows.slice(1));
    expect(session.rtcCameraInfoSendObservers.get(target)).toBeUndefined();
    expect(observer).not.toHaveBeenCalled(); expect(loader.denied).toEqual([]);
  });
  test('actual RTC send observer runs at track/send boundary, preserves ACK and unrelated commands', async () => {
    const loader = createLoader(); const { P2PClientProtocol } = loader.load('p2p/session');
    const { CommandType, InternalP2PCommandType } = loader.load('p2p/types');
    const session = Object.create(P2PClientProtocol.prototype); const order = [], target = {};
    Object.assign(session, { sendQueue: [], rtcCameraInfoSendObservers: new WeakMap(),
      rawStation: { station_sn: 'synthetic-station' }, RTC_COMMAND_ACK_TIMEOUT: 19000,
      rtcTransport: { isActive: () => true, adminUserId: 'synthetic-account', send: () => order.push('send') },
      rtcPending: { track: (...args) => { order.push('track'); session.resultCallback = args[5]; } },
      sendQueuedMessage: () => order.push('queue'), emit: (...args) => order.push(args),
    });
    session.observeRtcCameraInfoSend(target, timeout => order.push(['observer', timeout]));
    await session._sendCommandViaRtc({ p2pCommand: { commandType: CommandType.CMD_CAMERA_INFO, value: 255, channel: 255 },
      p2pCommandType: InternalP2PCommandType.WithInt, customData: target });
    expect(order.slice(0, 3)).toEqual(['track', ['observer', 19000], 'send']);
    expect(session.rtcCameraInfoSendObservers.get(target)).toBeUndefined();
    session.resultCallback(-1); expect(order.find(row => Array.isArray(row) && row[0] === 'command')[1].return_code).toBe(-1);
    expect(loader.denied).toEqual([]);
  });
  test('negative ACK preserves code, segment-only acceptance and sanitized header mismatch diagnostics', () => {
    const loader = createLoader(); const { RtcCommandPending } = loader.load('rtc/rtcCommandBridge');
    const { buildPortalHeader } = loader.load('rtc/rtcPacket'); const pending = new RtcCommandPending();
    const result = jest.fn(); pending.track(7, 1103, 255, undefined, 10000, result);
    const rc = Buffer.alloc(4); rc.writeInt32LE(-1);
    const secretBody = Buffer.from(JSON.stringify({ token: 'FAKE_SECRET_ACK_BODY', nested: { password: 'FAKE_SECRET_NESTED' } }));
    const packet = Buffer.concat([buildPortalHeader(9999, rc.length + secretBody.length, 12, 7, 0), rc, secretBody]);
    jest.advanceTimersByTime(70); expect(pending.handleIncoming(packet)).toBe(true);
    expect(result.mock.calls[0][0]).toBe(-1);
    const diagnostic = loader.logs.find(row => row.args[0] === 'RtcCommandBridge command ack').args[1];
    expect(diagnostic).toMatchObject({ expectedCommandID: 1103, actualCommandID: 9999,
      expectedChannelID: 255, actualChannelID: 12, responseFlag: 0, commandMatches: false,
      channelMatches: false, pendingCount: 0, elapsedMs: 70, returnCode: -1 });
    expect(JSON.stringify(loader.logs)).not.toContain('FAKE_SECRET');
    expect(pending.handleIncoming(packet)).toBe(false); pending.clear();
  });
});
