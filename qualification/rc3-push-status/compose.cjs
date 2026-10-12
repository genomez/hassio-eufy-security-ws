'use strict';
// Run only in the ephemeral hosted compiler stage, with networking disabled.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');

const root = __dirname;
const expected = JSON.parse(fs.readFileSync(path.join(root, 'EXPECTED_PARENT.json'), 'utf8'));
const parent = '/usr/src/app/client';
const allowedSource = ['src/eufysecurity.ts', 'src/push/service.ts'];
const allowedOutputs = ['eufysecurity.d.ts', 'eufysecurity.js', 'eufysecurity.js.map',
  'push/service.d.ts', 'push/service.js', 'push/service.js.map'];
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
function files(directory) {
  const rows = {};
  function visit(current, relative) {
    for (const entry of fs.readdirSync(current, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && (entry.name === 'build' || entry.name === 'node_modules')) continue;
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      assert(!entry.isSymbolicLink(), `Unexpected source symlink: ${key}`);
      if (entry.isDirectory()) visit(absolute, key);
      else {
        assert(entry.isFile(), `Unexpected source entry: ${key}`);
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
  for (const file of allowedSource) assert.equal(inputs[variant][file], expected.sourceHashes[variant][file]);
}
assert.deepEqual(Object.keys(inputs.baseline).sort(), Object.keys(inputs.candidate).sort(), 'Source file sets differ');
const sourceChanges = Object.keys(inputs.baseline).filter(file => inputs.baseline[file] !== inputs.candidate[file]).sort();
assert.deepEqual(sourceChanges, allowedSource, 'Unexpected candidate source delta');
assert.equal(sha(fs.readFileSync('/run.sh')), expected.launcherSha256, 'Parent launcher changed');
const compilerPackage = require(path.join(parent, 'node_modules/typescript/package.json'));
assert.equal(compilerPackage.version, '5.9.3', 'Unexpected parent TypeScript compiler');
for (const variant of ['baseline', 'candidate']) {
  const directory = path.join(root, variant);
  fs.symlinkSync(path.join(parent, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  execFileSync(process.execPath, [path.join(parent, 'node_modules/typescript/bin/tsc'),
    '-p', path.join(directory, 'tsconfig.build.json'), '--noEmitOnError'],
  {cwd: directory, stdio: 'inherit', timeout: 180000});
}
const baselineBuild = files(path.join(root, 'baseline/build'));
const candidateBuild = files(path.join(root, 'candidate/build'));
assert(Object.keys(baselineBuild).length > 100, 'Unexpectedly small production compile');
assert.deepEqual(Object.keys(baselineBuild).sort(), Object.keys(candidateBuild).sort(), 'Emitted file sets differ');
for (const [file, hash] of Object.entries(baselineBuild)) {
  const reference = path.join(parent, 'build', file);
  assert(fs.statSync(reference).isFile(), `Missing parent emission: ${file}`);
  assert.equal(sha(fs.readFileSync(reference)), hash, `Baseline emission differs from parent: ${file}`);
}
const changedFiles = Object.keys(baselineBuild).filter(file => baselineBuild[file] !== candidateBuild[file]).sort();
assert(changedFiles.length > 0, 'Candidate compiled bytes unchanged');
for (const file of changedFiles) assert(allowedOutputs.includes(file), `Out-of-scope emission: ${file}`);
for (const file of ['eufysecurity.js', 'push/service.js']) assert(changedFiles.includes(file), `Missing product correction: ${file}`);
const delta = {};
for (const file of changedFiles) {
  const absolute = `/usr/src/app/client/build/${file}`;
  const destination = path.join('/delta', absolute);
  fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o755});
  fs.copyFileSync(path.join(root, 'candidate/build', file), destination);
  fs.chmodSync(destination, 0o644);
  delta[absolute] = {baselineSha256: baselineBuild[file], candidateSha256: candidateBuild[file]};
}
const receipt = {passed: true, parentManifest: expected.parentManifest,
  parentConfig: expected.parentConfig, candidateVersion: expected.candidateVersion,
  compilerVersion: compilerPackage.version, sourceChanges, sourceHashes: inputs,
  baselineEmissionsMatchParent: true, productionTypecheckPassed: true,
  emittedFileCount: Object.keys(baselineBuild).length, baselineEmissions: baselineBuild,
  candidateEmissions: candidateBuild, changedFiles: delta,
  launcherSha256: expected.launcherSha256, networkDisabledDuringCompilation: true,
  dependenciesFromParent: true, compilerStageOnly: true};
fs.writeFileSync(path.join(root, 'COMPILATION_COMPARISON.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({passed: true, baselineEmissionCount: receipt.emittedFileCount,
  changedFiles: Object.keys(delta), compilerVersion: receipt.compilerVersion}));
