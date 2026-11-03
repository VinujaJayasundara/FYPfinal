/**
 * Jest config for the app's pure-TypeScript sync tests (no React Native runtime).
 * Reuses ts-jest from the core project, so run `npm ci` in ../GhostTracker first.
 *   npx --prefix ../GhostTracker jest -c GhostTrackerApp/jest.sync.config.js
 */
const path = require('path');
const core = path.resolve(__dirname, '../GhostTracker');

module.exports = {
  rootDir: path.resolve(__dirname, '..'),
  testMatch: ['<rootDir>/GhostTrackerApp/src/core/**/*.test.ts'],
  transform: {
    '^.+\.tsx?$': [
      path.join(core, 'node_modules/ts-jest'),
      { diagnostics: false, tsconfig: { esModuleInterop: true, allowJs: true } },
    ],
  },
  moduleDirectories: ['node_modules', path.join(core, 'node_modules')],
  testEnvironment: 'node',
  globals: { __DEV__: false },
};
