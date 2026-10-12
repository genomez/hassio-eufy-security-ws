import { cleanupServiceFixtures, deferred, logger, sdkFixture, serviceFixture, tick, wsFixture } from './fixture-loader';

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { cleanupServiceFixtures(); });

describe('real PushNotificationService event wiring', () => {
  test('connect and close listeners observe updated flags synchronously', async () => {
    const { service, client } = await serviceFixture();
    const seen: any[] = [];
    service.on('connect', () => seen.push([service.isConnected(), service.connecting]));
    service.on('close', () => seen.push([service.isConnected(), service.connecting]));
    client.emit('connect');
    client.emit('close');
    expect(seen).toEqual([[true, false], [false, false]]);
    service.close();
  });

  test('failed credentials close listeners observe false flags', async () => {
    const { service, client } = await serviceFixture();
    service.close();
    service.connected = true;
    service.connecting = true;
    service.credentials = undefined;
    service.createPushCredentials = jest.fn(async () => undefined);
    const seen: any[] = [];
    service.on('close', () => seen.push([service.isConnected(), service.connecting]));
    await service._open(false, true);
    expect(seen).toEqual([[false, false]]);
    expect(client.connect).toHaveBeenCalledTimes(1);
  });
});

describe('real SDK _initializeInternals transport and backend wiring', () => {
  test('connect publishes immediately before deferred registration, matching synchronous getter', async () => {
    const register = deferred<boolean>();
    const f = await sdkFixture({ legacyRegister: () => register.promise });
    const work = f.dispatch('connect');
    expect(f.events).toEqual([{ event: 'connect', connected: true }]);
    expect(f.sdk.isPushConnected()).toBe(true);
    expect(f.api.registerPushToken).toHaveBeenCalledTimes(1);
    expect(f.api.checkPushToken).not.toHaveBeenCalled();
    register.resolve(true);
    await Promise.all(work);
    await tick();
    expect(f.events).toHaveLength(1);
    expect(f.order).toEqual(['legacy-register', 'legacy-check', 'mega-register']);
  });

  test.each([
    [false, false, 0], [false, true, 0], [true, false, 0],
    [true, true, 10003], [false, false, 10003],
  ])('legacy register=%s check=%s Mega code=%s never substitutes a transport edge', async (registered, checked, code) => {
    const mega = { hasValidSession: jest.fn(() => true), registerPushToken: jest.fn(async () => ({ code, msg: 'synthetic result' })) };
    const f = await sdkFixture({ legacyRegister: async () => registered, legacyCheck: async () => checked, mega });
    await Promise.all(f.dispatch('connect'));
    await tick();
    expect(f.events).toEqual([{ event: 'connect', connected: true }]);
    expect(f.sdk.isPushConnected()).toBe(true);
    expect(f.api.registerPushToken).toHaveBeenCalledTimes(1);
    expect(f.api.checkPushToken).toHaveBeenCalledTimes(1);
    expect(mega.registerPushToken).toHaveBeenCalledTimes(1);
    f.dispatch('close');
    expect(f.events).toEqual([{ event: 'connect', connected: true }, { event: 'close', connected: false }]);
  });

  test('unknown Mega session retains no forced login and transport status', async () => {
    const mega = { hasValidSession: jest.fn(() => false), registerPushToken: jest.fn() };
    const f = await sdkFixture({ legacyRegister: async () => false, legacyCheck: async () => false, mega });
    await Promise.all(f.dispatch('connect'));
    await tick();
    expect(mega.registerPushToken).not.toHaveBeenCalled();
    expect(f.events).toEqual([{ event: 'connect', connected: true }]);
  });

  test('unexpected legacy exception is contained and preserves prior sequence stop', async () => {
    const f = await sdkFixture({ legacyRegister: async () => { throw new Error('synthetic backend failure'); } });
    await expect(Promise.all(f.dispatch('connect'))).resolves.toBeDefined();
    await tick();
    expect(f.events).toEqual([{ event: 'connect', connected: true }]);
    expect(f.api.checkPushToken).not.toHaveBeenCalled();
    expect(f.mega.registerPushToken).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Push backend registration sequence failed', { reason: 'unexpected_error' });
  });

  test('unexpected legacy verification exception is contained without inventing backend success', async () => {
    const f = await sdkFixture({ legacyCheck: async () => { throw new Error('synthetic backend failure'); } });
    await expect(Promise.all(f.dispatch('connect'))).resolves.toBeDefined();
    await tick();
    expect(f.api.registerPushToken).toHaveBeenCalledTimes(1);
    expect(f.api.checkPushToken).toHaveBeenCalledTimes(1);
    expect(f.mega.registerPushToken).not.toHaveBeenCalled();
    expect(f.events).toEqual([{ event: 'connect', connected: true }]);
  });

  test.each(['connect', 'close'] as const)('late legacy completion after %s cannot change current published state', async (next) => {
    const old = deferred<boolean>();
    let count = 0;
    const f = await sdkFixture({ legacyRegister: () => ++count === 1 ? old.promise : Promise.resolve(true) });
    const first = f.dispatch('connect');
    f.dispatch('close');
    if (next === 'connect') f.dispatch('connect');
    await tick();
    const expected = next === 'connect'
      ? [{ event: 'connect', connected: true }, { event: 'close', connected: false }, { event: 'connect', connected: true }]
      : [{ event: 'connect', connected: true }, { event: 'close', connected: false }];
    expect(f.events).toEqual(expected);
    const eventCount = f.events.length;
    old.resolve(false);
    await Promise.all(first);
    await tick();
    expect(f.events).toHaveLength(eventCount);
    expect(f.sdk.isPushConnected()).toBe(next === 'connect');
    expect(f.api.registerPushToken).toHaveBeenCalledTimes(next === 'connect' ? 2 : 1);
    expect(f.api.checkPushToken).toHaveBeenCalledTimes(next === 'connect' ? 2 : 1);
    expect(f.mega.registerPushToken).toHaveBeenCalledTimes(next === 'connect' ? 2 : 1);
  });

  test('late Mega completion after actual SDK close does not publish connected', async () => {
    const completion = deferred<any>();
    const mega = { hasValidSession: jest.fn(() => true), registerPushToken: jest.fn(() => completion.promise) };
    const f = await sdkFixture({ mega });
    const first = f.dispatch('connect');
    await tick();
    expect(mega.registerPushToken).toHaveBeenCalledTimes(1);
    f.sdk.close();
    expect(f.sdk.isPushConnected()).toBe(false);
    completion.resolve({ code: 0 });
    await Promise.all(first);
    await tick();
    expect(f.events).toEqual([{ event: 'connect', connected: true }, { event: 'close', connected: false }]);
    expect(f.api.registerPushToken).toHaveBeenCalledTimes(1);
  });

  test('duplicate underlying edges are deduplicated without extra cloud calls beyond original input sequence', async () => {
    const f = await sdkFixture();
    await Promise.all(f.dispatch('connect'));
    await Promise.all(f.dispatch('connect'));
    await tick();
    f.dispatch('close');
    f.dispatch('close');
    expect(f.events).toEqual([{ event: 'connect', connected: true }, { event: 'close', connected: false }]);
    expect(f.api.registerPushToken).toHaveBeenCalledTimes(2);
    expect(f.api.checkPushToken).toHaveBeenCalledTimes(2);
    expect(f.mega.registerPushToken).toHaveBeenCalledTimes(2);
  });

  test('synchronous public connect listener can close SDK before new backend work begins', async () => {
    const f = await sdkFixture();
    f.sdk.on('push connect', () => f.sdk.close());
    f.dispatch('connect');
    await tick();
    expect(f.events).toEqual([{ event: 'connect', connected: true }, { event: 'close', connected: false }]);
    expect(f.api.registerPushToken).not.toHaveBeenCalled();
    expect(f.api.checkPushToken).not.toHaveBeenCalled();
    expect(f.mega.registerPushToken).not.toHaveBeenCalled();
  });
});

describe('unchanged real WebSocket getters, snapshots and event forwarding', () => {
  test.each([1, 8, 9, 21])('schema %s agrees with modern and legacy queries in each event listener', async schemaVersion => {
    const register = deferred<boolean>();
    const f = await sdkFixture({ legacyRegister: () => register.promise });
    const { dumpDriver, DriverMessageHandler, EventForwarder, DriverCommand } = await wsFixture();
    const forwarded: any[] = [];
    const snapshots: any[] = [];
    const queries: Promise<any>[] = [];
    const client: any = { schemaVersion, receiveEvents: true, isConnected: true, sendEvent: (event: any) => {
      forwarded.push(event);
      snapshots.push(dumpDriver(f.sdk, schemaVersion));
      for (const command of [DriverCommand.isPushConnected, DriverCommand.isPushConnectedLegacy]) queries.push(DriverMessageHandler.handle({ command }, f.sdk, client, {}, logger));
    } };
    new EventForwarder({ driver: f.sdk, clients: [client] }, logger).start();
    const work = f.dispatch('connect');
    f.dispatch('close');
    expect(forwarded).toEqual([{ source: 'driver', event: 'push connected' }, { source: 'driver', event: 'push disconnected' }]);
    expect(snapshots.map(s => s.pushConnected)).toEqual([true, false]);
    expect(await Promise.all(queries)).toEqual([{ connected: true }, { connected: true }, { connected: false }, { connected: false }]);
    expect(Object.keys(snapshots[0]).sort()).toEqual((schemaVersion <= 8 ? ['version', 'connected', 'pushConnected'] : ['version', 'connected', 'pushConnected', 'mqttConnected']).sort());
    register.resolve(true);
    await Promise.all(work);
    await tick();
    expect(forwarded).toHaveLength(2);
  });
});
