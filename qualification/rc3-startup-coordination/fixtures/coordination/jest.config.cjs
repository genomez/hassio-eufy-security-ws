'use strict';
const path = require('node:path');
const toolchain = '/usr/src/app/client/node_modules';
if (process.env.SUBJECT_COMPILED_ROOT !== '/usr/src/app/client/build' ||
    process.env.FIXTURE_TOOLCHAIN_ROOT !== toolchain ||
    process.env.FIXTURE_CACHE_ROOT !== '/data/jest-cache') {
  throw new Error('Hosted compiled fixture paths required');
}
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/*.test.ts'],
  transform: { '^.+\\.tsx?$': [path.join(toolchain, 'ts-jest'), { tsconfig: {
    target: 'ES2022', module: 'CommonJS', esModuleInterop: true, skipLibCheck: true,
  }, diagnostics: false }] },
  cacheDirectory: '/data/jest-cache',
  testTimeout: 15000,
  watchman: false,
  maxWorkers: 1,
};
