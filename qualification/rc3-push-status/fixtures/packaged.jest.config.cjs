const mode = process.env.QUALIFICATION_TEST;
if (!['push', 'retry'].includes(mode)) throw new Error('Fixture mode required');
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: [mode === 'push' ? '<rootDir>/push-status.synthetic.test.ts' : '<rootDir>/retry-regression.test.ts'],
  transform: {'^.+\\.tsx?$': ['/usr/src/app/client/node_modules/ts-jest', {
    tsconfig: {target: 'ES2022', module: 'CommonJS', esModuleInterop: true},
    diagnostics: false, isolatedModules: true,
  }]},
  cacheDirectory: '/data/jest-cache', testTimeout: 15000, watchman: false,
  moduleDirectories: ['node_modules', '/usr/src/app/client/node_modules'],
  moduleNameMapper: {
    '^subject/src/(.*)$': '/usr/src/app/client/build/$1',
    '^node-datachannel$': '<rootDir>/native-rtc-disabled.cjs',
  },
};
