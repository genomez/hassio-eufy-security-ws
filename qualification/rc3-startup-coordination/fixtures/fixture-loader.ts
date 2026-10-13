import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import EventEmitter from 'node:events';


export const fixtureRoot = __dirname;
export const subjectFile = (name: 'sdk' | 'push') => `/usr/src/app/client/build/${name === 'sdk' ? 'eufysecurity.js' : 'push/service.js'}`;
export const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const serviceFixtures: any[] = [];
export function cleanupServiceFixtures() {
  for (const service of serviceFixtures.splice(0)) {
    service.clearCredentialsTimeout();
    service.resetRetryTimeout();
    service.removeAllListeners();
  }
}

// The exact installed CommonJS bytes execute. Every imported dependency is
// an explicit fixture boundary; no module graph reaches cloud or native RTC code.
export function loadSource(file: string, imports: Record<string, unknown> = {}): any {
  const productExports: any = {};
  const compiled = fs.readFileSync(file, 'utf8');
  const load = (name: string) => {
    if (Object.prototype.hasOwnProperty.call(imports, name)) return imports[name];
    if (['events', 'path', 'util', 'stream'].includes(name)) return require(`node:${name}`);
    if (name === 'tiny-typed-emitter') return { TypedEmitter: EventEmitter };
    if (name === 'fs') return { existsSync: () => true, statSync: () => { throw new Error('fixture persistence disabled'); }, readFileSync: () => { throw new Error('fixture persistence disabled'); }, writeFileSync: () => { throw new Error('fixture persistence disabled'); } };
    if (name === 'typescript-logging') return { LogLevel: { Info: 3 } };
    if (name === './logging' || name === '../logging') return { rootMainLogger: logger, rootPushLogger: logger, InternalLogger: {}, dummyLogger: logger };
    if (name === './utils' || name === '../utils') return { getError: () => ({ fixtureError: true }), removeLastChar: (s: string, char: string) => s.slice(0, s.lastIndexOf(char)), ensureError: (e: unknown) => e instanceof Error ? e : new Error('fixture error') };
    if (name === './error' || name === '../error') return { ensureError: (e: unknown) => e instanceof Error ? e : new Error('fixture error') };
    if (name === '.') return { libVersion: '4.0.0' };
    if (name === './p2p/types') return { P2PConnectionType: { QUICKEST: 1 } };
    if (name.startsWith('./') || name.startsWith('../') || name === 'qs') return {};
    throw new Error(`Unmapped fixture dependency: ${name}`);
  };
  vm.runInNewContext(`(function(require,module,exports,setTimeout,clearTimeout,process){${compiled}\n})`, {}, { filename: file })(load, { exports: productExports }, productExports, setTimeout, clearTimeout, { env: {} });
  return productExports;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function tick() { for (let i = 0; i < 50; i++) await Promise.resolve(); }

export async function sdkFixture(options: { legacyRegister?: () => Promise<boolean>; legacyCheck?: () => Promise<boolean>; mega?: any } = {}) {
  const push: any = new EventEmitter();
  push.connected = false;
  push.isConnected = () => push.connected;
  const order: string[] = [];
  const api: any = new EventEmitter();
  for (const name of ['setLanguage', 'setPhoneModel', 'setOpenUDID', 'setSerialNumber', 'setMegaCloudWakeHandler']) api[name] = jest.fn();
  api.registerPushToken = jest.fn(async () => { order.push('legacy-register'); return options.legacyRegister ? options.legacyRegister() : true; });
  api.checkPushToken = jest.fn(async () => { order.push('legacy-check'); return options.legacyCheck ? options.legacyCheck() : true; });
  const mega = options.mega || { hasValidSession: jest.fn(() => true), registerPushToken: jest.fn(async () => { order.push('mega-register'); return { code: 0 }; }) };
  const { EufySecurity } = loadSource(subjectFile('sdk'), {
    './http/api': { HTTPApi: { initialize: async () => api } },
    './http/eventImageCache': { EventImageCache: class {} },
    './push/service': { PushNotificationService: { initialize: async () => push } },
  });
  const sdk: any = Object.create(EufySecurity.prototype);
  EventEmitter.call(sdk);
  sdk.config = { username: 'synthetic', password: 'synthetic', trustedDeviceName: 'Synthetic Fixture', persistentDir: '/synthetic', persistentData: JSON.stringify({ version: '4.0.0', country: 'US', openudid: 'SYNTHETIC_ID', serial_number: 'SYNTHETIC_SERIAL', push_persistentIds: [], login_hash: '' }) };
  sdk.connected = false;
  sdk.pushCloudRegistered = false;
  sdk.pushCloudChecked = false;
  sdk.publishedPushConnected = false;
  sdk.pushConnectionGeneration = 0;
  for (const name of ['loadDeviceLightState', 'loadSnapshotTimes', 'syncMegaRtcCredentialsToApi', 'configureMegaAuthRecovery', 'savePushCredentials']) sdk[name] = jest.fn();
  sdk.initMQTT = async () => { sdk.mqttService = { isConnected: () => false, close: jest.fn() }; };
  sdk.cameraStationLivestreamTimeout = new Map();
  sdk.refreshEufySecurityP2PTimeout = {};
  sdk.deviceSnoozeTimeout = {};
  sdk.stations = {};
  sdk.devices = {};
  sdk.savePushPersistentIds = jest.fn();
  sdk.getStations = async () => [];
  sdk.getDevices = async () => [];
  push.close = jest.fn(() => { push.connected = false; push.emit('close'); });
  sdk.getMegaApi = async () => { sdk.megaApi = mega; return mega; };
  await sdk._initializeInternals();
  const events: Array<{ event: string; connected: boolean }> = [];
  sdk.on('push connect', () => events.push({ event: 'connect', connected: sdk.isPushConnected() }));
  sdk.on('push close', () => events.push({ event: 'close', connected: sdk.isPushConnected() }));
  const dispatch = (event: 'connect' | 'close') => {
    push.connected = event === 'connect';
    return push.listeners(event).map((listener: any) => listener(event === 'connect' ? 'SYNTHETIC_PUSH_TOKEN' : undefined));
  };
  return { sdk, push, api, mega, events, order, dispatch };
}

export async function serviceFixture(credentialsAvailable = true) {
  const client: any = new EventEmitter();
  client.setPersistentIds = jest.fn();
  client.connect = jest.fn();
  client.close = jest.fn(() => client.emit('close'));
  const { PushNotificationService } = loadSource(subjectFile('push'), { './client': { PushClient: { init: async () => client } } });
  const service: any = Object.create(PushNotificationService.prototype);
  EventEmitter.call(service);
  service.connected = false;
  service.connecting = true;
  service.persistentIds = [];
  service.credentials = undefined;
  service.createPushCredentials = jest.fn(async () => credentialsAvailable ? { fidResponse: { authToken: { expiresAt: Date.now() + 3600000 } }, gcmResponse: { token: 'SYNTHETIC_PUSH_TOKEN' }, checkinResponse: { androidId: 'SYNTHETIC_ID', securityToken: 'SYNTHETIC_TOKEN' } } : undefined);
  serviceFixtures.push(service);
  await service._open(false, true);
  return { service, client };
}

export async function wsFixture() {
  const root = '/usr/src/app/ws/dist/lib';
  const files = ['driver/command.js', 'driver/event.js', 'driver/state.js', 'driver/message_handler.js', 'forward.js'];
  const sources = new Map(files.map(name => [path.join(root, name), fs.readFileSync(path.join(root, name), 'utf8')]));
  const names = new Set<string>(['default']);
  for (const source of sources.values()) {
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
      for (const item of match[1].split(',')) { const name = item.trim().split(/\s+as\s+/)[0]; if (name) names.add(name); }
    }
  }
  const context = vm.createContext({ Buffer, setTimeout, clearTimeout, process: { env: {} } });
  const modules = new Map<string, any>();
  for (const [file, source] of sources) {
    modules.set(file, new (vm as any).SourceTextModule(source, { context, identifier: file }));
  }
  const synthetic = new Map<string, any>();
  const link = (specifier: string, referencing: any) => {
    const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(referencing.identifier), specifier) : specifier;
    if (modules.has(resolved)) return modules.get(resolved);
    if (!synthetic.has(resolved)) {
      const values: any = resolved === 'stream' ? require('node:stream') : {
        UnknownCommandError: class extends Error {}, maxSchemaVersion: 21,
      };
      synthetic.set(resolved, new (vm as any).SyntheticModule([...names], function(this: any) {
        for (const name of names) this.setExport(name, values[name]);
      }, { context, identifier: resolved }));
    }
    return synthetic.get(resolved);
  };
  for (const module of modules.values()) {
    if (module.status === 'unlinked') await module.link(link);
    if (module.status === 'linked') await module.evaluate();
  }
  return {
    DriverCommand: modules.get(path.join(root, 'driver/command.js')).namespace.DriverCommand,
    DriverMessageHandler: modules.get(path.join(root, 'driver/message_handler.js')).namespace.DriverMessageHandler,
    EventForwarder: modules.get(path.join(root, 'forward.js')).namespace.EventForwarder,
    dumpDriver: modules.get(path.join(root, 'driver/state.js')).namespace.dumpDriver,
  };
}
