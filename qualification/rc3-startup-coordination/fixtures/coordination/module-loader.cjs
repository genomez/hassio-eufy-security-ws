'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const toolchain = '/usr/src/app/client/node_modules';
if (process.env.SUBJECT_COMPILED_ROOT !== '/usr/src/app/client/build' ||
    process.env.FIXTURE_TOOLCHAIN_ROOT !== toolchain) {
  throw new Error('Hosted compiled fixture paths required');
}
const productModules = new Set([
  'http/station', 'http/api', 'http/types', 'http/error', 'error', 'utils',
  'http/pushRequestDiagnostics', 'rtc/rtcCameraInfoCoordinator', 'rtc/rtcCommandBridge',
  'rtc/rtcPacket', 'p2p/session', 'p2p/types', 'p2p/models', 'push/types',
]);
const stubModules = new Set([
  'http/parameter', 'http/utils', 'http/device', 'p2p/utils', 'p2p/talkback', 'p2p/ble', 'p2p/adts',
  'p2p/homebaseS1Grid', 'rtc/rtcInbound', 'rtc/stationDatabaseInbound',
  'rtc/rtcInboundDiagnostics', 'rtc/rtcSession', 'rtc/stationRtcTransport',
  'rtc/rtcSignaling', 'rtc/turnAllocateWake', 'rtc/turnHarvestWait',
  'http/hubAuthoritative', 'http/passportProfileResponse',
]);
function createLoader(options = {}) {
  const root = path.resolve(process.env.SUBJECT_COMPILED_ROOT);
  const logs = [], loaded = [], denied = [], cache = new Map();
  const deny = name => (...args) => {
    denied.push(name);
    throw new Error(`Fixture denied dependency: ${name}`);
  };
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error', 'trace'].map(level =>
    [level, (...args) => logs.push({ level, args })]));
  const loggerExports = new Proxy({}, { get: (_target, name) => name === '__esModule' ? false : logger });
  class HTTPError extends Error { constructor(message, response) { super(message); this.name = 'HTTPError'; this.response = response; } }
  let gotOptions;
  const got = Object.assign(deny('got network'), { extend: config => {
    gotOptions = config;
    const transport = deny('got extended network');
    transport.defaults = { options: { merge: options.mergeDefaults || (() => {}) } };
    return transport;
  } });
  const gotExports = { __esModule: true, default: got, HTTPError };
  const throttleExports = { __esModule: true, default: () => fn => fn };
  const external = {
    'tiny-typed-emitter': { TypedEmitter: EventEmitter },
    'date-and-time': { format: deny('date format'), parse: deny('date parse') },
    'node-schedule': { scheduleJob: deny('scheduleJob') },
    'i18n-iso-countries': { isValid: () => true },
    '@cospired/i18n-iso-languages': { isValid: () => true },
    'dgram': { createSocket: deny('UDP socket') },
    'node-rsa': class { constructor() { deny('RSA constructor')(); } },
    'sweet-collections': { SortedMap: Map },
    'repl': { start: deny('REPL') },
    'got': gotExports, 'p-throttle': throttleExports,
    'fs': { existsSync: () => false },
  };
  const safeBuiltins = new Set(['crypto', 'stream', 'events', 'buffer', 'util', 'assert']);
  const harmlessStub = key => new Proxy({}, { get: (_target, name) => {
    if (name === '__esModule') return false;
    if (key === 'http/hubAuthoritative' && name === 'HUB_FIRST_CLOUD_REFRESH_DELAY_MS') return 500;
    return deny(`${key}.${String(name)}`);
  } });
  const sandbox = {
    Buffer, URL, URLSearchParams, Date, Error, TypeError, RangeError, Map, WeakMap, Set,
    AbortController, AbortSignal, Uint8Array, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console: Object.fromEntries(['log', 'error', 'warn', 'debug', 'info'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
    process: { env: { ...options.env }, platform: process.platform,
      exit: deny('process.exit'), kill: deny('process.kill'), nextTick: deny('process.nextTick') },
  };
  const context = vm.createContext(sandbox);
  function dependency(key, request) {
    const normalized = request.replace(/^node:/, '');
    if (safeBuiltins.has(normalized)) return require(`node:${normalized}`);
    if (external[normalized]) return external[normalized];
    if (!request.startsWith('.')) return deny(`require ${request}`)();
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(key), request)).replace(/\.(js|ts)$/, '');
    if (resolved === 'logging') return loggerExports;
    if (resolved === 'http') return new Proxy({}, { get: (_target, name) =>
      name === 'Station' ? load('http/station').Station : load('http/types')[name] });
    if (productModules.has(resolved)) return load(resolved);
    if (stubModules.has(resolved)) return harmlessStub(resolved);
    return deny(`relative require ${resolved}`)();
  }
  async function dynamicImport(request) {
    const exports = request === 'got' ? gotExports : request === 'p-throttle' ? throttleExports : undefined;
    if (!exports) return deny(`dynamic import ${request}`)();
    if (!vm.SyntheticModule) throw new Error('Hosted fixtures require NODE_OPTIONS=--experimental-vm-modules');
    const module = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
    await module.link(() => { throw new Error('Unexpected synthetic dependency'); });
    await module.evaluate();
    return module;
  }
  function load(key) {
    if (!productModules.has(key)) throw new Error(`Unlisted product module ${key}`);
    if (cache.has(key)) return cache.get(key).exports;
    const filename = path.join(root, `${key}.js`);
    if (!filename.startsWith(root + path.sep)) throw new Error('Module escaped selected root');
    let code = fs.readFileSync(filename, 'utf8');
    const module = { exports: {} };
    cache.set(key, module);
    const script = new vm.Script(`(function(require,module,exports,__filename,__dirname){\n${code}\n})`, {
      filename, importModuleDynamically: dynamicImport,
    });
    script.runInContext(context)(request => dependency(key, request), module, module.exports, filename, path.dirname(filename));
    loaded.push({ key, filename, mode: 'compiled-cjs' });
    return module.exports;
  }
  return { load, logs, loaded, denied, HTTPError, gotOptions: () => gotOptions,
    clearLogs: () => { logs.length = 0; }, mode: 'hosted', root };
}
module.exports = { createLoader, toolchain };
