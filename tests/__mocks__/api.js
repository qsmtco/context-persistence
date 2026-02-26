/**
 * Mock OpenClaw API for testing
 */
module.exports = {
  config: {
    cacheMax: 100,
    cacheTTLms: 300000,
    enablePrefetch: false,
    prefetchQueries: [],
    summarizationBudget: {
      maxCallsPerHour: 10,
      enabled: true
    }
  },
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  },
  registerTool: jest.fn(),
  registerHook: jest.fn(),
  registerCli: jest.fn()
};
