/** @type {import('jest').Config} */
const shared = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/helpers/load-test-env.ts'],
  clearMocks: true,
  transform: {
    // Tests emit classic CommonJS so `import()` becomes `require()`: the generated Prisma client
    // loads its query compiler with dynamic imports, which Jest's VM rejects without
    // --experimental-vm-modules. Type checking is done separately by `npm run typecheck`.
    '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs', moduleResolution: 'node10', ignoreDeprecations: '6.0' } }],
  },
  // The generated Prisma client uses ".js" suffixes on relative imports of ".ts" files.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    { ...shared, displayName: 'unit', testMatch: ['<rootDir>/tests/unit/**/*.test.ts'] },
    {
      ...shared,
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      // Recreates the "test" schema and applies the real migrations once per run.
      globalSetup: '<rootDir>/tests/helpers/global-setup.ts',
    },
  ],
  // Integration tests share one database schema and truncate it between tests.
  maxWorkers: 1,
};
