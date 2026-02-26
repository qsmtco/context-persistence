/**
 * Mock agent context for testing
 * @param {object} overrides - Optional overrides for defaults
 */
module.exports = (overrides = {}) => ({
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  },
  session: {
    id: 'session-123',
    addSystemMessage: jest.fn().mockResolvedValue(undefined),
    project: 'default-project',
    task: 'default-task',
    status: 'active',
    last_action: '',
    next_steps: [],
    body: '',
    context_anchor: '',
    conversation_summary: ''
  },
  tools: {
    memory_search: jest.fn().mockResolvedValue([
      {
        source: 'memory/test.md',
        content: 'search result snippet',
        score: 0.95,
        file: '/workspace/memory/test.md',
        mtime: Date.now()
      }
    ]),
    // cached_memory_search will be provided by the plugin itself
    chat_completion: jest.fn().mockResolvedValue({
      content: 'Mock LLM summary response for testing'
    })
  },
  ...overrides // allow test-specific overrides
});
