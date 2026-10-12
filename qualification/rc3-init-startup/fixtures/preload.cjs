'use strict';

// Qualification boundary only: the installed CLI and its startup remain real.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createRequire, syncBuiltinESMExports } = require('node:module');
const traceFile = '/data/qualification-trace.json';
const trace = [];
let blockedOperations = 0;
let exitCode = null;
function persist() {
  const temporary = `${traceFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({schema: 1, trace, blockedOperations, exitCode}));
  fs.renameSync(temporary, traceFile);
}
function mark(name) { trace.push(name); persist(); }
function deny(name) {
  return function () {
    blockedOperations += 1;
    mark('blockedOperation');
    throw new Error(`QUALIFICATION_OPERATION_DENIED:${name}`);
  };
}

const net = require('node:net');
const originalListen = net.Server.prototype.listen;
const originalClose = net.Server.prototype.close;
for (const [moduleName, methods] of Object.entries({
  http: ['request', 'get'], https: ['request', 'get'],
  net: ['connect', 'createConnection'], tls: ['connect', 'createServer'],
  dgram: ['createSocket'],
  child_process: ['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync'],
})) {
  const module = require(`node:${moduleName}`);
  for (const method of methods) module[method] = deny(`${moduleName}.${method}`);
}
net.Socket.prototype.connect = deny('net.Socket.connect');
net.Server.prototype.listen = function (...args) {
  // The unchanged launcher specifies this one local listener. No host port is published.
  if (Number(args[0]) !== 3000 || args[1] !== '0.0.0.0') {
    return deny('net.Server.listen').apply(this, args);
  }
  this.once('listening', () => mark('serverListening'));
  return originalListen.apply(this, args);
};
net.Server.prototype.close = function (...args) {
  this.once('close', () => mark('serverClosed'));
  return originalClose.apply(this, args);
};
const dns = require('node:dns');
for (const name of Object.keys(dns)) {
  if (/^(resolve|reverse|getServers|setServers)/.test(name) && typeof dns[name] === 'function') {
    dns[name] = deny(`dns.${name}`);
  }
}
// net.listen resolves its literal bind address through lookup; no actual resolver runs.
dns.lookup = (host, options, callback) => {
  if (host !== '0.0.0.0') return deny('dns.lookup')();
  const cb = typeof options === 'function' ? options : callback;
  queueMicrotask(() => cb(null, options && options.all ? [{address: host, family: 4}] : host, 4));
};
dns.lookupService = deny('dns.lookupService');
for (const name of Object.keys(dns.promises)) {
  if (typeof dns.promises[name] === 'function') dns.promises[name] = deny(`dns.promises.${name}`);
}
dns.Resolver = deny('dns.Resolver');
global.fetch = deny('fetch');
require('node:worker_threads').Worker = deny('worker_threads.Worker');
syncBuiltinESMExports();

mark('preloadEntered');
assert(fs.statSync('/run/s6/container_environment').isDirectory());
mark('s6EnvironmentPresent');
assert.equal(createHash('sha256').update(fs.readFileSync('/run.sh')).digest('hex'),
  'a578fac58776b26c30ca8f3597758705a09dffbba7584e1ffa19c4424f8212b1');
mark('launcherBytesVerified');
assert.deepEqual(process.argv.slice(1), [
  '/usr/src/app/node_modules/eufy-security-ws/dist/bin/server.js',
  '--host', '0.0.0.0', '--config', '/data/eufy-security-ws-config.json',
]);
mark('actualCliArgvVerified');
for (const [name, expected] of Object.entries({
  RTC_SCTP_MAX_PACKET_BYTES: '800', RTC_HANDOFF: '1',
  RTC_PROACTIVE_RECONNECT_MS: '270000', RTC_CLIENT_OFFER: '0',
  RTC_PROPERTY_REFRESH_MS: '900000', RTC_APP_LIVE_VIEW_TEST: '0',
  RTC_FLOODLIGHT_POLL_INTERVAL_MIN: '2', RTC_FLOODLIGHT_NOTIFY_ON_GRACE_MS: '45000',
})) assert.equal(process.env[name], expected);
mark('rtcDefaultsVerified');

const cliRequire = createRequire('/usr/src/app/node_modules/eufy-security-ws/dist/bin/server.js');
const { EufySecurity } = cliRequire('eufy-security-client');
EufySecurity.initialize = async config => {
  assert.equal(config.username, 'qualification@example.invalid');
  assert.equal(config.password, 'synthetic-only-no-authentication');
  assert.equal(config.country, 'FR');
  assert.equal(config.persistentDir, '/data');
  assert.equal(config.enableEmbeddedPKCS1Support, true);
  assert.equal(config.eventDurationSeconds, 10);
  assert.equal(config.pollingIntervalMinutes, 15);
  assert.equal(config.trustedDeviceName, 'isolated-startup-qualification');
  assert.equal(config.acceptInvitations, undefined);
  assert.equal(config.stationIPAddresses, undefined);
  mark('launcherConfigVerified');
  mark('fakeInitialize');
  const driver = new EventEmitter();
  driver.getStations = async () => [];
  driver.getDevices = async () => [];
  driver.loginMega = async () => { mark('fakeMegaLogin'); return 'ok'; };
  driver.connect = async () => {
    mark('fakeConnect');
    driver.emit('connect');
    // Deferred past server.start() so the unchanged CLI has registered shutdown handlers.
    setImmediate(() => {
      assert(process.listenerCount('SIGTERM') >= 2);
      mark('readyForStop');
    });
  };
  driver.close = () => mark('driverClose');
  return driver;
};
process.prependListener('SIGTERM', () => mark('sigtermObserved'));
process.on('exit', code => { exitCode = code; persist(); });
