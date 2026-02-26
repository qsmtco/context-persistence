module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverage: false, // will be enabled via --coverage flag
  collectCoverageFrom: [
    'lib/**/*.js',
    'tools/**/*.js',
    '!**/node_modules/**'
  ],
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 85,
      functions: 85,
      lines: 85
    }
  },
  testMatch: [
    '**/tests/**/*.test.js'
  ],
  verbose: true,
  testTimeout: 20000,
  // Allow using .js files with require/module.exports
  transform: {}
};
