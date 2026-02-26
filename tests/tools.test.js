/**
 * Unit Tests for tools/index.js
 */

const fs = require('fs');

// Mock the state module
jest.mock('../lib/state', () => ({
  readState: jest.fn(),
  writeState: jest.fn(),
  discoverFromSessions: jest.fn(),
  getCache: jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
    clear: jest.fn(),
    size: jest.fn().mockReturnValue(0),
    keys: jest.fn().mockReturnValue([])
  })),
  configureCache: jest.fn(),
  getCacheStats: jest.fn().mockReturnValue({ size: 0, max: 100, ttl: 300000 }),
  getConfig: jest.fn().mockReturnValue({}),
  setConfig: jest.fn(),
  getStateFilePath: jest.fn(),
  validate: jest.fn(),
  parseFile: jest.fn(),
  SCHEMA: {},
  truncateAnchor: jest.fn(),
  isCacheValid: jest.fn().mockReturnValue(true),
  normalizeCacheKey: jest.fn().mockImplementation(args => {
    return {
      query: (args.query || '').trim(),
      limit: Number(args.limit) || 10,
      minScore: Number(args.minScore) || 0.3,
      sources: Array.isArray(args.sources) ? [...args.sources].sort() : ['memory', 'sessions']
    };
  })
}));

const state = require('../lib/state');
const tools = require('../tools/index');

describe('Tools - context_persistence_read', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state.readState.mockReset();
  });

  it('should return state object when file exists', async () => {
    state.readState.mockResolvedValue({
      version: '2.1',
      project: 'P',
      task: 'T',
      status: 'active',
      last_action: 'A',
      next_steps: [],
      body: 'Body'
    });

    const ctx = { log: { debug: jest.fn() } };
    const result = await tools.context_persistence_read(ctx, {});

    expect(result).toEqual({
      version: '2.1',
      project: 'P',
      task: 'T',
      status: 'active',
      last_action: 'A',
      next_steps: [],
      body: 'Body'
    });
  });

  it('should throw if state file does not exist', async () => {
    state.readState.mockResolvedValue(null);
    const ctx = {};
    await expect(tools.context_persistence_read(ctx, {})).rejects.toThrow(/CONTEXT_PERSISTENCE.md does not exist/);
  });

  it('should not modify state', async () => {
    state.readState.mockResolvedValue({ version: '2.1' });
    const ctx = { log: { debug: jest.fn() } };
    await tools.context_persistence_read(ctx, {});
    expect(state.readState).toHaveBeenCalledTimes(1);
  });
});

describe('Tools - context_persistence_write', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state.readState.mockReset();
    state.writeState.mockReset();
  });

  it('should update single field', async () => {
    state.readState.mockResolvedValue({
      version: '2.1',
      project: 'Old',
      task: 'OldTask',
      status: 'active',
      last_action: 'A',
      next_steps: [],
      body: 'OldBody'
    });
    state.writeState.mockResolvedValue({ success: true, updated: '2026-02-25T19:00:00.000Z', path: '/tmp/CONTEXT_PERSISTENCE.md' });

    const ctx = {};
    const result = await tools.context_persistence_write(ctx, { project: 'NewProject' });

    expect(state.writeState).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'NewProject' }),
      expect.objectContaining({ validate: true })
    );
    expect(result.success).toBe(true);
    expect(result.fields).toContain('project');
  });

  it('should update multiple fields', async () => {
    state.readState.mockResolvedValue({ version: '2.1', project: 'P', task: 'T', status: 'active', last_action: 'A', next_steps: [] });
    state.writeState.mockResolvedValue({ success: true });

    const ctx = {};
    await tools.context_persistence_write(ctx, {
      project: 'NewProject',
      task: 'NewTask',
      status: 'blocked',
      next_steps: ['a', 'b']
    });

    expect(state.writeState).toHaveBeenCalledWith(
      expect.objectContaining({
        project: 'NewProject',
        task: 'NewTask',
        status: 'blocked',
        next_steps: ['a', 'b']
      }),
      expect.any(Object));
  });

  it('should reject invalid field type for body', async () => {
    state.readState.mockResolvedValue({ version: '2.1' });
    const ctx = {};
    await expect(tools.context_persistence_write(ctx, { body: 123 }))
      .rejects.toThrow(/field "body" must be a string/);
  });

  it('should reject empty update object', async () => {
    const ctx = {};
    await expect(tools.context_persistence_write(ctx, {})).rejects.toThrow(/requires at least one field/);
    await expect(tools.context_persistence_write(ctx, null)).rejects.toThrow(/requires at least one field/);
  });

  it('should propagate writeState errors', async () => {
    state.readState.mockResolvedValue({ version: '2.1' });
    state.writeState.mockRejectedValueOnce(new Error('Disk full'));
    const ctx = {};
    await expect(tools.context_persistence_write(ctx, { status: 'active' })).rejects.toThrow('Disk full');
  });

  it('should return updated timestamp and path', async () => {
    state.readState.mockResolvedValue({ version: '2.1' });
    state.writeState.mockResolvedValueOnce({
      success: true,
      updated: '2026-02-25T20:00:00.000Z',
      path: '/custom/path/CONTEXT_PERSISTENCE.md'
    });

    const result = await tools.context_persistence_write({}, { project: 'P' });
    expect(result.updated).toBe('2026-02-25T20:00:00.000Z');
    expect(result.path).toBe('/custom/path/CONTEXT_PERSISTENCE.md');
  });
});

describe('Tools - context_persistence_discover', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state.discoverFromSessions.mockReset();
    state.writeState.mockReset();
  });

  it('should call discoverFromSessions with default parameters', async () => {
    state.discoverFromSessions.mockResolvedValue({
      project: 'DiscoveredProject',
      task: 'DiscoveredTask',
      status: 'active',
      next_steps: [],
      body: 'Discovered body',
      updated: new Date().toISOString()
    });
    state.writeState.mockResolvedValue({ success: true, updated: new Date().toISOString(), path: '/tmp' });

    const ctx = {
      tools: { memory_search: jest.fn() },
      log: { debug: jest.fn() }
    };

    await tools.context_persistence_discover(ctx, {});

    expect(state.discoverFromSessions).toHaveBeenCalledWith(
      ctx.tools.memory_search,
      expect.objectContaining({
        limit: 10,
        minScore: 0.3,
        query: expect.stringContaining('project|task')
      })
    );
  });

  it('should pass custom args to discoverFromSessions', async () => {
    state.discoverFromSessions.mockResolvedValue({});
    state.writeState.mockResolvedValue({ success: true, updated: new Date().toISOString(), path: '/tmp' });

    const ctx = {
      tools: { memory_search: jest.fn() },
      log: {}
    };

    await tools.context_persistence_discover(ctx, {
      limit: 20,
      minScore: 0.5,
      query: 'custom query'
    });

    expect(state.discoverFromSessions).toHaveBeenCalledWith(
      ctx.tools.memory_search,
      { limit: 20, minScore: 0.5, query: 'custom query' }
    );
  });

  it('should throw if memory_search not available', async () => {
    const ctx = {
      tools: {},
      log: {}
    };

    await expect(tools.context_persistence_discover(ctx, {}))
      .rejects.toThrow(/memory_search tool not available/);
  });

  it('should include _meta in result', async () => {
    state.discoverFromSessions.mockResolvedValue({
      project: 'P',
      task: 'T',
      body: 'B',
      updated: new Date().toISOString()
    });
    state.writeState.mockResolvedValue({ success: true });

    const ctx = {
      tools: { memory_search: jest.fn() },
      log: {}
    };

    const result = await tools.context_persistence_discover(ctx, { limit: 5 });
    expect(result).toHaveProperty('_meta');
    expect(result._meta.action).toBe('discovered');
    expect(result._meta.limit).toBe(5);
    expect(result._meta.written).toBe(true);
  });
});

describe('Tools - cached_memory_search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state.getCache.mockReset();
    state.normalizeCacheKey.mockImplementation(args => ({
      query: (args.query || '').trim(),
      limit: Number(args.limit) || 10,
      minScore: Number(args.minScore) || 0.3,
      sources: Array.isArray(args.sources) ? [...args.sources].sort() : ['memory', 'sessions']
    }));
    state.isCacheValid.mockReturnValue(true);
  });

  it('should throw if query argument missing', async () => {
    const ctx = { tools: { memory_search: jest.fn() }, log: {} };
    await expect(tools.cached_memory_search(ctx, {})).rejects.toThrow(/requires a "query"/);
  });

  it('should call memory_search on cache miss', async () => {
    const mockCache = {
      get: jest.fn().mockReturnValue(null),
      set: jest.fn(),
      delete: jest.fn()
    };
    state.getCache.mockReturnValue(mockCache);

    const mockMemorySearch = jest.fn().mockResolvedValue([
      { source: 'memory/test.md', content: 'result', file: '/workspace/memory/test.md', mtime: Date.now() }
    ]);
    const ctx = {
      tools: { memory_search: mockMemorySearch },
      log: { debug: jest.fn() }
    };

    const result = await tools.cached_memory_search(ctx, { query: 'test' });

    expect(mockMemorySearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'test' }), expect.any(Object));
    expect(mockCache.set).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('should return cached result on hit', async () => {
    const cachedEntry = {
      results: [{ source: 'cached.md', content: 'cached result' }],
      cachedAt: Date.now()
    };
    const mockCache = {
      get: jest.fn().mockReturnValue(cachedEntry),
      set: jest.fn(),
      delete: jest.fn()
    };
    state.getCache.mockReturnValue(mockCache);

    const mockMemorySearch = jest.fn();
    const ctx = {
      tools: { memory_search: mockMemorySearch },
      log: { debug: jest.fn() }
    };

    const result = await tools.cached_memory_search(ctx, { query: 'test' });

    expect(mockMemorySearch).not.toHaveBeenCalled();
    expect(result).toEqual(cachedEntry.results);
  });

  it('should validate cache entry using isCacheValid', async () => {
    const mockCache = {
      get: jest.fn(),
      set: jest.fn(),
      delete: jest.fn()
    };
    state.getCache.mockReturnValue(mockCache);

    // Return a stale entry (isCacheValid will return false for this test)
    mockCache.get.mockReturnValue({
      results: [{ file: '/some/file.md' }],
      cachedAt: Date.now()
    });

    // Override isCacheValid to return false for this test
    state.isCacheValid.mockReturnValueOnce(false);

    const mockMemorySearch = jest.fn().mockResolvedValue([{ source: 'new.md' }]);
    const ctx = {
      tools: { memory_search: mockMemorySearch },
      log: {}
    };

    await tools.cached_memory_search(ctx, { query: 'test' });

    expect(mockMemorySearch).toHaveBeenCalled();
    expect(mockCache.delete).toHaveBeenCalled();
  });

  it('should pass through memory_search errors', async () => {
    const mockCache = { get: jest.fn().mockReturnValue(null), set: jest.fn() };
    state.getCache.mockReturnValue(mockCache);

    const mockMemorySearch = jest.fn().mockRejectedValue(new Error('search failed'));
    const ctx = {
      tools: { memory_search: mockMemorySearch },
      log: {}
    };

    await expect(tools.cached_memory_search(ctx, { query: 'test' }))
      .rejects.toThrow('search failed');
  });

  it('should handle cache disabled (getCache returns null)', async () => {
    state.getCache.mockReturnValue(null);

    const mockMemorySearch = jest.fn().mockResolvedValue([{ result: 'direct' }]);
    const ctx = {
      tools: { memory_search: mockMemorySearch },
      log: {}
    };

    const result = await tools.cached_memory_search(ctx, { query: 'test' });

    expect(mockMemorySearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'test' }), expect.any(Object));
    expect(result).toEqual([{ result: 'direct' }]);
  });

  it('should enrich results with _cachedMtime', async () => {
    state.getCache.mockReturnValue({
      get: jest.fn().mockReturnValue(null),
      set: jest.fn()
    });

    const mockMemorySearch = jest.fn().mockResolvedValue([
      { file: '/workspace/memory/a.md' },
      { file: '/workspace/memory/b.md' }
    ]);
    const ctx = {
      tools: { memory_search: mockMemorySearch },
      log: {}
    };

    // Mock fs.statSync to return a known mtimeMs
    const statSyncSpy = jest.spyOn(fs, 'statSync').mockReturnValue({ mtimeMs: 200000 });

    await tools.cached_memory_search(ctx, { query: 'test' });

    const setArg = state.getCache().set.mock.calls[0][1];
    expect(setArg.results.length).toBe(2);
    expect(setArg.results[1]._cachedMtime).toBe(200000);

    statSyncSpy.mockRestore();
  });
});

describe('Tools - context_persistence_summarize', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state.readState.mockReset();
    state.writeState.mockReset();
    state.getCacheStats.mockReset();
  });

  it('should call LLM tool with correct prompt', async () => {
    state.readState.mockResolvedValue({
      version: '2.1',
      project: 'MyProject',
      task: 'Implement feature',
      status: 'active',
      next_steps: ['Write tests', 'Review'],
      conversation_summary: 'Recent progress...',
      body: 'Detailed notes...'
    });
    // Disable cache to force direct memory_search
    state.getCache.mockReturnValue(null);

    const mockLLM = jest.fn().mockResolvedValue({
      content: 'Generated anchor text'
    });

    const mockMemorySearch = jest.fn().mockResolvedValue([
      { content: 'Snippet 1' },
      { content: 'Snippet 2' }
    ]);

    const ctx = {
      tools: {
        memory_search: mockMemorySearch,
        chat_completion: mockLLM
      },
      log: { warn: jest.fn() }
    };

    const result = await tools.context_persistence_summarize(ctx, {});

    expect(mockLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('MyProject'),
        prompt: expect.stringContaining('Implement feature'),
        max_tokens: 2000,
        temperature: 0.5
      }),
      expect.any(Object));

    expect(result.anchor).toBe('Generated anchor text');
    expect(result.generated_at).toBeDefined();
    expect(result.snippet_count).toBe(2);
  });

  it('should write anchor to state if writeToState is true', async () => {
    state.readState.mockResolvedValue({
      version: '2.1',
      project: 'P',
      task: 'T',
      status: 'active',
      next_steps: []
    });
    state.getCache.mockReturnValue(null);

    const mockLLM = jest.fn().mockResolvedValue({ content: 'Anchor text' });
    const mockMemorySearch = jest.fn().mockResolvedValue([{ content: 'snippet' }]);
    const ctx = {
      tools: {
        memory_search: mockMemorySearch,
        chat_completion: mockLLM
      },
      log: {}
    };

    await tools.context_persistence_summarize(ctx, { writeToState: true });

    expect(state.writeState).toHaveBeenCalledWith(
      expect.objectContaining({ context_anchor: 'Anchor text' }),
      expect.objectContaining({ validate: false })
    );
  });

  it('should skip writing to state if writeToState is false', async () => {
    state.readState.mockResolvedValue({
      version: '2.1',
      project: 'P',
      task: 'T',
      status: 'active',
      next_steps: []
    });
    state.getCache.mockReturnValue(null);

    const mockLLM = jest.fn().mockResolvedValue({ content: 'Anchor text' });
    const mockMemorySearch = jest.fn().mockResolvedValue([{ content: 'snippet' }]);
    const ctx = {
      tools: {
        memory_search: mockMemorySearch,
        chat_completion: mockLLM
      },
      log: {}
    };

    await tools.context_persistence_summarize(ctx, { writeToState: false });

    expect(state.writeState).not.toHaveBeenCalled();
  });

  it('should handle different LLM response formats', async () => {
    state.readState.mockResolvedValue({
      version: '2.1',
      project: 'P',
      task: 'T',
      status: 'active',
      next_steps: []
    });
    state.getCache.mockReturnValue(null);

    const cases = [
      { response: 'Plain string', expected: 'Plain string' },
      { response: { text: 'Object with text' }, expected: 'Object with text' },
      { response: { content: 'Object with content' }, expected: 'Object with content' },
      { response: { message: { content: 'Nested message' } }, expected: 'Nested message' },
      { response: { choices: [{ message: { content: 'OpenAI style' } }] }, expected: 'OpenAI style' }
    ];

    let caseIndex = 0;
    const mockLLM = jest.fn().mockImplementation(async () => cases[caseIndex++].response);
    const mockMemorySearch = jest.fn().mockResolvedValue([]);
    const ctx = {
      tools: { memory_search: mockMemorySearch, chat_completion: mockLLM },
      log: {}
    };

    for (const testCase of cases) {
      const result = await tools.context_persistence_summarize(ctx, {});
      expect(result.anchor).toBe(testCase.expected);
    }
  });

  it('should throw if no LLM tool available', async () => {
    state.readState.mockResolvedValue({
      version: '2.1',
      project: 'P',
      task: 'T',
      status: 'active',
      next_steps: []
    });
    state.getCache.mockReturnValue(null);

    const mockMemorySearch = jest.fn().mockResolvedValue([]);
    const ctx = {
      tools: {
        memory_search: mockMemorySearch
        // No LLM tools
      },
      log: {}
    };

    await expect(tools.context_persistence_summarize(ctx, {}))
      .rejects.toThrow(/No LLM tool available/);
  });

  it('should throw if state file does not exist', async () => {
    state.readState.mockResolvedValue(null);
    const ctx = {
      tools: { chat_completion: jest.fn() },
      log: {}
    };

    await expect(tools.context_persistence_summarize(ctx, {}))
      .rejects.toThrow(/CONTEXT_PERSISTENCE.md does not exist/);
  });

  it('should handle LLM timeout (10s limit)', async () => {
    // This test simulates an LLM call that exceeds the internal timeout.
    // Global jest timeout is 20s, so a 12s delay in the LLM will cause the tool to timeout around 10s.
    state.readState.mockResolvedValue({
      version: '2.1',
      project: 'P',
      task: 'T',
      status: 'active',
      next_steps: []
    });
    state.getCache.mockReturnValue(null);

    const slowLLM = jest.fn().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 12000));
      return { content: 'Slow response' };
    });

    const mockMemorySearch = jest.fn().mockResolvedValue([]);
    const ctx = {
      tools: {
        memory_search: mockMemorySearch,
        chat_completion: slowLLM
      },
      log: { warn: jest.fn() }
    };

    await expect(tools.context_persistence_summarize(ctx, {})).rejects.toThrow(/timeout/);
  });

  it('should handle empty or short anchor gracefully', async () => {
    state.readState.mockResolvedValue({
      version: '2.1',
      project: 'P',
      task: 'T',
      status: 'active',
      next_steps: []
    });
    state.getCache.mockReturnValue(null);

    const mockLLM = jest.fn().mockResolvedValue({ content: '   ' });
    const mockMemorySearch = jest.fn().mockResolvedValue([]);
    const ctx = {
      tools: { memory_search: mockMemorySearch, chat_completion: mockLLM },
      log: { warn: jest.fn() }
    };

    const result = await tools.context_persistence_summarize(ctx, {});
    expect(result.anchor).toBe('');
  });

  it('should use custom maxTokens parameter', async () => {
    state.readState.mockResolvedValue({
      version: '2.1',
      project: 'P',
      task: 'T',
      status: 'active',
      next_steps: []
    });
    state.getCache.mockReturnValue(null);

    const mockLLM = jest.fn().mockResolvedValue({ content: 'Summary' });
    const mockMemorySearch = jest.fn().mockResolvedValue([{ content: 'snippet' }]);
    const ctx = {
      tools: { memory_search: mockMemorySearch, chat_completion: mockLLM },
      log: {}
    };

    await tools.context_persistence_summarize(ctx, { maxTokens: 1000 });

    expect(mockLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 1000
      }),
      expect.any(Object));
  });
});

describe('Tools - context_persistence_prefetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should call cached_memory_search for each query', async () => {
    const mockMemorySearch = jest.fn()
      .mockResolvedValueOnce([{ query: 'q1', ok: true }])
      .mockResolvedValueOnce([{ query: 'q2', ok: true }]);
    // Disable cache to force direct memory_search
    state.getCache.mockReturnValue(null);

    const ctx = {
      tools: { memory_search: mockMemorySearch },
      log: { debug: jest.fn() }
    };

    const result = await tools.context_persistence_prefetch(ctx, {
      queries: ['q1', 'q2']
    });

    expect(mockMemorySearch).toHaveBeenCalledTimes(2);
    expect(mockMemorySearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'q1', limit: 5, minScore: 0.3 }),
      expect.any(Object)
    );
    expect(mockMemorySearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'q2', limit: 5, minScore: 0.3 }),
      expect.any(Object)
    );
    expect(result.prefetched).toHaveLength(2);
    expect(result.prefetched[0].ok).toBe(true);
    expect(result.prefetched[1].ok).toBe(true);
  });

  it('should handle prefetch failures gracefully', async () => {
    const mockMemorySearch = jest.fn()
      .mockResolvedValueOnce([{}])  // good succeeds
      .mockRejectedValueOnce(new Error('failed')) // bad fails
      .mockResolvedValueOnce([{}]); // good2 succeeds
    state.getCache.mockReturnValue(null);

    const ctx = {
      tools: { memory_search: mockMemorySearch },
      log: { debug: jest.fn() }
    };

    const result = await tools.context_persistence_prefetch(ctx, {
      queries: ['good', 'bad', 'good2']
    });

    expect(result.prefetched).toHaveLength(3);
    expect(result.prefetched[0].ok).toBe(true);
    expect(result.prefetched[1].ok).toBe(false);
    expect(result.prefetched[1].error).toBe('failed');
    expect(result.prefetched[2].ok).toBe(true);
  });

  it('should return empty array if queries omitted', async () => {
    const ctx = {
      tools: { cached_memory_search: jest.fn() },
      log: {}
    };

    const result = await tools.context_persistence_prefetch(ctx, {});
    expect(result.prefetched).toEqual([]);
  });

  it('should throw if queries is not an array', async () => {
    const ctx = {
      tools: { cached_memory_search: jest.fn() },
      log: {}
    };

    await expect(tools.context_persistence_prefetch(ctx, { queries: 'not array' }))
      .rejects.toThrow(/queries.*array/);
  });

  it('should execute queries in parallel', async () => {
    const mockMemorySearch = jest.fn()
      .mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return [{}];
      });
    state.getCache.mockReturnValue(null);

    const ctx = {
      tools: { memory_search: mockMemorySearch },
      log: {}
    };

    const start = Date.now();
    await tools.context_persistence_prefetch(ctx, {
      queries: ['q1', 'q2', 'q3']
    });
    const duration = Date.now() - start;

    // Should be ~max delay (50ms), not sum (150ms)
    expect(duration).toBeLessThan(200);
    expect(mockMemorySearch).toHaveBeenCalledTimes(3);
  });
});

describe('Tools Schemas', () => {
  it('should define schemas for all six tools', () => {
    const schemas = tools.schemas;

    expect(schemas).toHaveProperty('context_persistence_read');
    expect(schemas).toHaveProperty('context_persistence_write');
    expect(schemas).toHaveProperty('context_persistence_discover');
    expect(schemas).toHaveProperty('cached_memory_search');
    expect(schemas).toHaveProperty('context_persistence_summarize');
    expect(schemas).toHaveProperty('context_persistence_prefetch');
  });

  it('each schema should have name, description, parameters', () => {
    const schemas = tools.schemas;

    for (const [name, schema] of Object.entries(schemas)) {
      expect(schema.name).toBe(name);
      expect(typeof schema.description).toBe('string');
      expect(schema.parameters).toBeDefined();
      expect(schema.parameters.type).toBe('object');
      expect(schema.parameters.properties).toBeDefined();
    }
  });

  it('cached_memory_search schema should require query', () => {
    const schema = tools.schemas.cached_memory_search;
    expect(schema.parameters.required).toContain('query');
  });

  it('context_persistence_write should have additionalProperties false', () => {
    const schema = tools.schemas.context_persistence_write;
    expect(schema.parameters.additionalProperties).toBe(false);
    expect(schema.parameters.minProperties).toBe(1);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});
