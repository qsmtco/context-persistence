/**
 * Integration Tests for Hook Handlers
 * Tests hook behavior with mocked state and context
 */

// Mock state module BEFORE requiring hooks
const mockCache = new Map();
jest.mock('../lib/state', () => ({
  readState: jest.fn(),
  writeState: jest.fn().mockResolvedValue({ success: true }),
  getCacheStats: jest.fn().mockImplementation(() => ({
    size: mockCache.size,
    max: 100,
    ttl: 300,
    keys: Array.from(mockCache.keys())
  })),
  getCache: jest.fn().mockReturnValue(mockCache),
  truncateAnchor: jest.fn().mockImplementation((anchor) => anchor),
  getConfig: jest.fn().mockReturnValue({}),
  configureCache: jest.fn()
}));

// Import hooks
const preCompaction = require('../hooks/preCompaction');
const postCompaction = require('../hooks/postCompaction');
const sessionStart = require('../hooks/sessionStart');
const shutdown = require('../hooks/shutdown');

const state = require('../lib/state');

// Mock context creator
function createMockContext(overrides = {}) {
  return {
    log: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    },
    session: {
      addSystemMessage: jest.fn().mockResolvedValue(undefined)
    },
    tools: {
      cached_memory_search: jest.fn().mockResolvedValue([{ result: 'ok' }])
    },
    ...overrides
  };
}

describe('Hook: preCompaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('should read state and call writeState with empty object when state exists', async () => {
    jest.spyOn(state, 'readState').mockResolvedValue({ version: '2.1', project: 'P', task: 'T' });
    jest.spyOn(state, 'writeState').mockResolvedValue({ success: true });

    const ctx = createMockContext();
    const result = await preCompaction(ctx);

    expect(state.readState).toHaveBeenCalledTimes(1);
    expect(state.writeState).toHaveBeenCalledWith({});
    expect(ctx.log.info).toHaveBeenCalledWith(expect.stringContaining('state saved'));
    expect(result.ok).toBe(true);
    expect(result.action).toBe('saved');
  });

  it('should skip when no state file', async () => {
    jest.spyOn(state, 'readState').mockResolvedValue(null);
    jest.spyOn(state, 'writeState'); // mock to allow assertion .not.toHaveBeenCalled()
    const ctx = createMockContext();

    const result = await preCompaction(ctx);

    expect(state.writeState).not.toHaveBeenCalled();
    expect(ctx.log.debug).toHaveBeenCalledWith(expect.stringContaining('no state'));
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe('no_state');
  });

  it('should catch write errors and return ok:false', async () => {
    jest.spyOn(state, 'readState').mockResolvedValue({});
    jest.spyOn(state, 'writeState').mockRejectedValue(new Error('Disk full'));

    const ctx = createMockContext();
    const result = await preCompaction(ctx);

    expect(ctx.log.error).toHaveBeenCalledWith(
      expect.stringContaining('pre-compaction failed'),
      expect.any(Error)
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Disk full');
  });
});

describe('Hook: postCompaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('should inject anchor using context_anchor when available', async () => {
    const mockState = {
      version: '2.1',
      project: 'MyProject',
      task: 'Design system',
      status: 'in-progress',
      next_steps: ['Step A', 'Step B', 'Step C'],
      context_anchor: 'Existing anchor for project'
    };
    jest.spyOn(state, 'readState').mockResolvedValue(mockState);

    const ctx = createMockContext();
    // Also spy on the state object to see what's being read
    const result = await postCompaction(ctx);
    console.log('Result:', JSON.stringify(result));
    console.log('readState called with:', state.readState.mock.calls);

    expect(ctx.session.addSystemMessage).toHaveBeenCalledWith(
      expect.stringMatching(/^\[State Anchor\] Existing anchor for project/)
    );
    expect(result.ok).toBe(true);
    expect(result.action).toBe('injected');
  });

  it('should fallback to conversation_summary if context_anchor missing', async () => {
    jest.spyOn(state, 'readState').mockResolvedValue({
      version: '2.1',
      project: 'MyProject',
      task: 'Design system',
      status: 'in-progress',
      next_steps: ['Step A', 'Step B', 'Step C'],
      conversation_summary: 'Fallback summary text'
    });

    const ctx = createMockContext();
    await postCompaction(ctx);

    expect(ctx.session.addSystemMessage).toHaveBeenCalledWith(
      expect.stringMatching(/^\[State Anchor\] Fallback summary text/)
    );
  });

  it('should generate anchor via summarization when no existing and agent.tools available', async () => {
    jest.spyOn(state, 'readState').mockResolvedValue({
      version: '2.1',
      project: 'MyProject',
      task: 'Design system',
      status: 'in-progress',
      next_steps: []
    });
    jest.spyOn(state, 'getConfig').mockReturnValue({});
    // Mock summarization tool
    const mockSummarize = jest.fn().mockResolvedValue({
      anchor: 'Generated summary by LLM'
    });
    // Temporarily replace tools module's function
    const tools = require('../tools');
    const originalSummarize = tools.context_persistence_summarize;
    tools.context_persistence_summarize = mockSummarize;

    const ctx = createMockContext({
      agent: { tools: { context_persistence_summarize: mockSummarize } }
    });
    await postCompaction(ctx);

    expect(mockSummarize).toHaveBeenCalled();
    expect(ctx.session.addSystemMessage).toHaveBeenCalledWith(
      expect.stringMatching(/^\[State Anchor\] Generated summary by LLM/)
    );

    // Restore
    tools.context_persistence_summarize = originalSummarize;
  });

  it('should handle empty state by skipping', async () => {
    jest.spyOn(state, 'readState').mockResolvedValue({
      project: '',
      task: ''
    });

    const ctx = createMockContext();
    const result = await postCompaction(ctx);

    expect(ctx.session.addSystemMessage).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe('empty_state');
  });

  it('should handle session without injection method', async () => {
    jest.spyOn(state, 'readState').mockResolvedValue({
      project: 'P',
      task: 'T'
    });

    const ctx = createMockContext({
      session: {} // no addSystemMessage
    });
    const result = await postCompaction(ctx);

    expect(ctx.log.warn).toHaveBeenCalledWith(expect.stringContaining('session object has no message injection method'));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('session_api_mismatch');
  });

  it('should log error on unexpected failure', async () => {
    jest.spyOn(state, 'readState').mockRejectedValue(new Error('Read error'));
    const ctx = createMockContext();

    await postCompaction(ctx);
    expect(ctx.log.error).toHaveBeenCalledWith(
      expect.stringContaining('post-compaction error'),
      expect.any(Error)
    );
  });
});

describe('Hook: sessionStart', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('should inject resume message using state anchor or fallback', async () => {
    jest.spyOn(state, 'readState').mockResolvedValue({
      project: 'MyProject',
      task: 'Implement feature X',
      status: 'active',
      next_steps: ['Write tests', 'Review'],
      context_anchor: 'Earlier work summary'
    });
    jest.spyOn(state, 'getConfig').mockReturnValue({ enablePrefetch: false });

    const ctx = createMockContext();
    const result = await sessionStart(ctx);

    expect(ctx.session.addSystemMessage).toHaveBeenCalledWith(
      '[Resume] Earlier work summary'
    );
    expect(ctx.log.info).toHaveBeenCalledWith(expect.stringContaining('state injected'));
    expect(result.ok).toBe(true);
  });

  it('should skip injection if no state file', async () => {
    jest.spyOn(state, 'readState').mockResolvedValue(null);
    jest.spyOn(state, 'getConfig').mockReturnValue({});
    const ctx = createMockContext();

    const result = await sessionStart(ctx);

    expect(ctx.session.addSystemMessage).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe('no_state_file');
  });

  it('should skip if state stale >24h', async () => {
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    jest.spyOn(state, 'readState').mockResolvedValue({
      updated: staleTime
    });
    jest.spyOn(state, 'getConfig').mockReturnValue({});

    const ctx = createMockContext();
    const result = await sessionStart(ctx);

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe('stale_state');
    expect(result.ageHours).toBeGreaterThan(24);
  });

  it('should perform prefetch when configured', async () => {
    jest.spyOn(state, 'readState').mockResolvedValue({ project: 'P', context_anchor: 'A' });
    jest.spyOn(state, 'getConfig').mockReturnValue({
      enablePrefetch: true,
      prefetchQueries: ['query1', 'query2']
    });

    const mockPrefetch = jest.fn().mockResolvedValue({ prefetched: [{ ok: true }, { ok: true }] });
    const ctx = createMockContext({
      tools: { cached_memory_search: mockPrefetch }
    });

    const result = await sessionStart(ctx);

    expect(mockPrefetch).toHaveBeenCalledTimes(2); // once per query
    expect(mockPrefetch).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.any(String) })
    );
    // Check that one of the log.info calls contains 'prefetch complete'
    const infoCalls = ctx.log.info.mock.calls.map(c => c.join(' ')).join('\n');
    expect(infoCalls).toContain('prefetch complete');
    expect(result.ok).toBe(true);
  });

  it('should skip prefetch if tool missing', async () => {
    // Provide state with data so it doesn't skip due to empty state
    jest.spyOn(state, 'readState').mockResolvedValue({ project: 'P', context_anchor: 'A' });
    jest.spyOn(state, 'getConfig').mockReturnValue({
      enablePrefetch: true,
      prefetchQueries: ['q1']
    });

    // Override tools to NOT have cached_memory_search
    const ctx = createMockContext({
      tools: {}  // empty tools - no cached_memory_search
    });
    const result = await sessionStart(ctx);

    // Check that one of the warn calls contains the expected message
    const warnCalls = ctx.log.warn.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warnCalls).toContain('cached_memory_search tool not available');
  });

  it('should handle state errors without throwing', async () => {
    jest.spyOn(state, 'readState').mockRejectedValue(new Error('Read error'));
    jest.spyOn(state, 'getConfig').mockReturnValue({});
    const ctx = createMockContext();

    await expect(sessionStart(ctx)).resolves.not.toThrow();
    // Check error was logged
    const errorCalls = ctx.log.error.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errorCalls).toContain('session-start error');
  });
});

describe('Hook: shutdown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('should log cache statistics on shutdown', async () => {
    // Configure cache to known state
    state.configureCache({ max: 100, ttlMs: 300000 });
    const cache = state.getCache();
    // Add dummy entries to affect size and keys
    cache.set(JSON.stringify({ query: 'test1' }), { results: [], cachedAt: Date.now() });
    cache.set(JSON.stringify({ query: 'test2' }), { results: [], cachedAt: Date.now() });

    const ctx = createMockContext();
    await shutdown(ctx);

    // Debug: show info calls and stats
    console.log('info calls:', ctx.log.info.mock.calls);
    // Check that one of the info calls contains the stats
    const infoCalls = ctx.log.info.mock.calls.map(c => c.join(' ')).join('\n');
    console.log('infoCalls string:', infoCalls);
    expect(infoCalls).toContain('shutdown: cache statistics');
    expect(infoCalls).toContain('Size: 2/100 entries');
  });

  it('should handle empty cache gracefully', async () => {
    // Ensure cache is empty
    state.configureCache({ max: 100, ttlMs: 300000 });
    const cache = state.getCache();
    if (cache && typeof cache.clear === 'function') {
      cache.clear();
    }

    const ctx = createMockContext();
    await shutdown(ctx);

    // Check that one of the info calls contains the stats
    const infoCalls = ctx.log.info.mock.calls.map(c => c.join(' ')).join('\n');
    expect(infoCalls).toContain('shutdown: cache statistics');
    expect(infoCalls).toContain('Size: 0/100 entries');
  });

  it('should not throw if logging fails', async () => {
    const ctx = createMockContext();
    ctx.log.info = jest.fn().mockImplementation(() => {
      throw new Error('Log failed');
    });

    await expect(shutdown(ctx)).resolves.not.toThrow();
  });
});
