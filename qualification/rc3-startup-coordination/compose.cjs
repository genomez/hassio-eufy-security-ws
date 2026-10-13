'use strict';
// Execute only in the ephemeral compiler stage with networking disabled.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');

const root = __dirname;
const expected = JSON.parse(fs.readFileSync(path.join(root, 'EXPECTED_PARENT.json'), 'utf8'));
const parent = '/usr/src/app/client';
const modules = ['eufysecurity', 'http/api', 'http/station', 'p2p/session',
  'rtc/rtcCommandBridge', 'rtc/rtcPacket', 'http/pushRequestDiagnostics', 'rtc/rtcCameraInfoCoordinator'];
const addedModules = ['http/pushRequestDiagnostics', 'rtc/rtcCameraInfoCoordinator'];
const allowedSource = modules.map(module => `src/${module}.ts`).sort();
const addedSource = addedModules.map(module => `src/${module}.ts`).sort();
const allowedOutputs = new Set(modules.flatMap(module => ['.d.ts', '.js', '.js.map'].map(suffix => module + suffix)));
const addedOutputs = addedModules.flatMap(module => ['.d.ts', '.js', '.js.map'].map(suffix => module + suffix)).sort();
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
const isSha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
assert.equal(expected.inputSealed, true, 'Source and fixture contract must be frozen before compilation');
assert(/^[0-9a-f]{40}$/.test(expected.sourceCommit || ''), 'Missing frozen source commit');
assert(expected.fixtureReceipts && Object.keys(expected.fixtureReceipts).length === 3, 'Fixture contract is incomplete');

function files(directory) {
  const rows = {};
  function visit(current, relative) {
    for (const entry of fs.readdirSync(current, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      assert(!entry.isSymbolicLink(), `Unexpected symlink: ${key}`);
      if (entry.isDirectory()) visit(absolute, key);
      else {
        assert(entry.isFile(), `Unexpected entry: ${key}`);
        rows[key] = sha(fs.readFileSync(absolute));
      }
    }
  }
  visit(directory, '');
  return rows;
}

const inputs = {};
for (const variant of ['baseline', 'candidate']) {
  const directory = path.join(root, variant);
  assert(!fs.existsSync(path.join(directory, 'build')), 'Compiled outputs must not be supplied as inputs');
  assert(!fs.existsSync(path.join(directory, 'node_modules')), 'Dependencies must come from the exact parent');
  inputs[variant] = files(directory);
  assert(expected.sourceHashes[variant] && Object.keys(expected.sourceHashes[variant]).length > 100);
  assert(Object.values(expected.sourceHashes[variant]).every(isSha), 'Unsealed source digest');
  assert.deepEqual(inputs[variant], expected.sourceHashes[variant], `${variant} source inputs differ from frozen hashes`);
}
const baselineFiles = Object.keys(inputs.baseline).sort();
const candidateFiles = Object.keys(inputs.candidate).sort();
assert.deepEqual(candidateFiles, [...baselineFiles, ...addedSource].sort(), 'Unexpected source file additions/removals');
const sourceChanges = candidateFiles.filter(file => inputs.baseline[file] !== inputs.candidate[file]);
assert.deepEqual(sourceChanges, allowedSource, 'Unexpected candidate source delta');
assert.equal(sha(fs.readFileSync('/run.sh')), expected.launcherSha256, 'Parent launcher changed');
const compilerPackage = require(path.join(parent, 'node_modules/typescript/package.json'));
assert.equal(compilerPackage.version, '5.9.3', 'Unexpected parent TypeScript compiler');
const parentBuild = files(path.join(parent, 'build'));
assert.equal(Object.keys(parentBuild).length, 192, 'Parent production emission inventory changed');
for (const variant of ['baseline', 'candidate']) {
  const directory = path.join(root, variant);
  fs.symlinkSync(path.join(parent, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  execFileSync(process.execPath, [path.join(parent, 'node_modules/typescript/bin/tsc'),
    '-p', path.join(directory, 'tsconfig.build.json'), '--noEmitOnError'],
  {cwd: directory, stdio: 'inherit', timeout: 180000});
}
const baselineBuild = files(path.join(root, 'baseline/build'));
const candidateBuild = files(path.join(root, 'candidate/build'));
assert.equal(Object.keys(baselineBuild).length, expected.baselineEmissionCount);
assert.equal(Object.keys(candidateBuild).length, expected.candidateEmissionCount);
assert.deepEqual(baselineBuild, parentBuild, 'Baseline production emissions differ from exact parent');
assert.deepEqual(Object.keys(candidateBuild).sort(), [...Object.keys(baselineBuild), ...addedOutputs].sort(),
  'Candidate production emissions must retain the baseline plus six helper outputs');
const changedFiles = Object.keys(candidateBuild).filter(file => baselineBuild[file] !== candidateBuild[file]).sort();
assert(changedFiles.length > 0, 'Candidate compiled bytes unchanged');
for (const file of changedFiles) assert(allowedOutputs.has(file), `Out-of-scope emission: ${file}`);
for (const module of modules) assert(changedFiles.includes(`${module}.js`), `Missing approved product correction: ${module}`);
assert(!fs.existsSync('/delta'), 'Compiler delta directory must start absent');
const delta = {};
for (const file of changedFiles) {
  const absolute = `/usr/src/app/client/build/${file}`;
  if (file.endsWith('.js.map')) {
    const map = JSON.parse(fs.readFileSync(path.join(root, 'candidate/build', file), 'utf8'));
    assert(!Object.hasOwn(map, 'sourcesContent'), `Source content leaked into map: ${file}`);
  }
  const destination = path.join('/delta', absolute);
  fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o755});
  fs.copyFileSync(path.join(root, 'candidate/build', file), destination);
  fs.chmodSync(destination, 0o644);
  delta[absolute] = {baselineSha256: baselineBuild[file] || null, candidateSha256: candidateBuild[file]};
}
const receipt = {passed: true, parentManifest: expected.parentManifest,
  parentConfig: expected.parentConfig, candidateVersion: expected.candidateVersion,
  sourceCommit: expected.sourceCommit, compilerVersion: compilerPackage.version,
  sourceChanges, sourceHashes: inputs, baselineEmissionsMatchParent: true,
  productionTypecheckPassed: true, baselineEmissionCount: Object.keys(baselineBuild).length,
  candidateEmissionCount: Object.keys(candidateBuild).length, baselineEmissions: baselineBuild,
  candidateEmissions: candidateBuild, changedFiles: delta, addedFiles: addedOutputs,
  launcherSha256: expected.launcherSha256, networkDisabledDuringCompilation: true,
  dependenciesFromParent: true, compilerStageOnly: true};
fs.writeFileSync(path.join(root, 'COMPILATION_COMPARISON.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({passed: true, baselineEmissionCount: receipt.baselineEmissionCount,
  candidateEmissionCount: receipt.candidateEmissionCount, changedFiles: Object.keys(delta),
  compilerVersion: receipt.compilerVersion}));
