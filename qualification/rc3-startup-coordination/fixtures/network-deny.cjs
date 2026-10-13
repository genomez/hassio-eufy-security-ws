'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const Module = require('node:module');
const attempts = [];
const deny = name => function () {
  attempts.push(name);
  throw new Error('OFFLINE_GUARD:' + name);
};
for (const [name, functions] of Object.entries({
  http: ['request', 'get'], https: ['request', 'get'],
  http2: ['connect', 'createServer', 'createSecureServer'],
  net: ['connect', 'createConnection', 'createServer'], tls: ['connect', 'createServer'],
  dgram: ['createSocket'],
  child_process: ['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync'],
})) {
  const module = require('node:' + name);
  for (const fn of functions) module[fn] = deny(name + '.' + fn);
}
const dns = require('node:dns');
for (const name of Object.keys(dns)) {
  if (/^(lookup|resolve|reverse|getServers|setServers)/.test(name) && typeof dns[name] === 'function') dns[name] = deny('dns.' + name);
}
for (const name of Object.keys(dns.promises)) {
  if (typeof dns.promises[name] === 'function') dns.promises[name] = deny('dns.promises.' + name);
}
dns.Resolver = deny('dns.Resolver');
require('node:net').Socket.prototype.connect = deny('net.Socket.connect');
require('node:net').Server.prototype.listen = deny('net.Server.listen');
global.fetch = deny('fetch');
require('node:worker_threads').Worker = deny('worker_threads.Worker');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'node-datachannel') return {};
  return load.call(this, name, ...args);
};
Module.syncBuiltinESMExports();
process.on('exit', () => {
  const files = [
    '/usr/src/app/client/build/eufysecurity.js',
    '/usr/src/app/client/build/push/service.js',
    '/usr/src/app/client/build/http/megaApi.js',
    '/usr/src/app/client/build/http/megaCrypto.js',
    ...['driver/command.js', 'driver/event.js', 'driver/state.js',
      'driver/message_handler.js', 'forward.js'].map(name => '/usr/src/app/ws/dist/lib/' + name),
  ];
  if (process.env.QUALIFICATION_TEST === 'coordination') {
    files.push(...['http/api', 'http/station', 'p2p/session', 'rtc/rtcCommandBridge',
      'rtc/rtcPacket', 'http/pushRequestDiagnostics', 'rtc/rtcCameraInfoCoordinator']
      .map(name => '/usr/src/app/client/build/' + name + '.js'));
  }
  const moduleHashes = files.map(file => ({ file,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
  fs.writeFileSync('/data/network-guard.json', JSON.stringify({
    schema: 1, processGuardEnabled: true, attemptedApis: attempts,
    nativeRTCStubbed: true, productTranspilation: false, moduleHashes,
  }));
});
