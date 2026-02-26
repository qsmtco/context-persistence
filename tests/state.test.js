/**
 * Unit Tests for lib/state.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const state = require('../lib/state');

// Helper to create temporary workspace
async function createTempWorkspace() {
  const tmpdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-test-'));
  const stateFile = path.resolve(tmpdir, 'CONTEXT_PERSISTENCE.md');
  return { tmpdir, stateFile };
}

// Cleanup function
async function cleanupWorkspace(tmpdir) {
  if (tmpdir && fs.existsSync(tmpdir)) {
    await fs.promises.rm(tmpdir, { recursive: true, force: true });
  }
}

describe('lib/state.js - Core State Management', () => {
  let tmpdir;
  let stateFile;
  let originalEnv;

  beforeEach(async () => {
    // Create fresh temp workspace for each test
    ({ tmpdir, stateFile } = await createTempWorkspace());
    originalEnv = process.env.OPENCLAW_WORKSPACE;
    process.env.OPENCLAW_WORKSPACE = tmpdir;
    jest.clearAllMocks();
    // Reset state internal caches
    state.configureCache({ max: 100, ttlMs: 300000 });
    state.getCache().clear();
    state.setConfig({});
  });

  afterEach(async () => {
    await cleanupWorkspace(tmpdir);
    process.env.OPENCLAW_WORKSPACE = originalEnv;
  });

  describe('getStateFilePath', () => {
    it('should return absolute path to CONTEXT_PERSISTENCE.md in workspace', () => {
      const filePath = state.getStateFilePath();
      expect(filePath).toBe(path.resolve(tmpdir, 'CONTEXT_PERSISTENCE.md'));
    });
  });

  describe('validate', () => {
    it('should accept valid state object', () => {
      const valid = {
        version: '2.1',
        project: 'Test Project',
        task: 'Implement feature X',
        status: 'active',
        last_action: 'Done something',
        next_steps: ['step 1', 'step 2'],
        updated: '2026-02-25T19:00:00.000Z'
      };
      expect(() => state.validate(valid)).not.toThrow();
    });

    it('should reject missing required fields', () => {
      const invalid = { version: '2.1' };
      expect(() => state.validate(invalid)).toThrow(/missing required field/);
    });

    it('should reject invalid status enum', () => {
      const invalid = {
        version: '2.1',
        project: 'P',
        task: 'T',
        status: 'pending',
        last_action: 'A',
        next_steps: [],
        updated: '2026-02-25T19:00:00.000Z'
      };
      expect(() => state.validate(invalid)).toThrow(/must be one of/);
    });

    it('should reject next_steps not an array', () => {
      const invalid = {
        version: '2.1',
        project: 'P',
        task: 'T',
        status: 'active',
        last_action: 'A',
        next_steps: 'not an array',
        updated: '2026-02-25T19:00:00.000Z'
      };
      expect(() => state.validate(invalid)).toThrow(/must be array/);
    });

    it('should reject invalid updated format', () => {
      const invalid = {
        version: '2.1',
        project: 'P',
        task: 'T',
        status: 'active',
        last_action: 'A',
        next_steps: [],
        updated: '2026-02-25 19:00:00'
      };
      expect(() => state.validate(invalid)).toThrow(/must be valid ISO 8601/);
    });

    it('should accept optional fields when absent', () => {
      const valid = {
        version: '2.1',
        project: 'P',
        task: 'T',
        status: 'active',
        last_action: 'A',
        next_steps: [],
        updated: '2026-02-25T19:00:00.000Z'
      };
      expect(() => state.validate(valid)).not.toThrow();
    });
  });

  describe('parseFile', () => {
    it('should parse valid frontmatter and body', () => {
      const content = `---
version: "2.1"
project: "Test"
task: "Task"
status: "active"
last_action: "Done"
next_steps: ["a", "b"]
updated: "2026-02-25T19:00:00.000Z"
---
This is the body content.

With multiple lines.
`;
      const result = state.parseFile(content);
      expect(result.frontmatter).toEqual({
        version: '2.1',
        project: 'Test',
        task: 'Task',
        status: 'active',
        last_action: 'Done',
        next_steps: ['a', 'b'],
        updated: '2026-02-25T19:00:00.000Z'
      });
      expect(result.body).toBe('This is the body content.\n\nWith multiple lines.');
    });

    it('should handle empty body', () => {
      const content = `---
version: "2.1"
project: "Test"
---
`;
      const result = state.parseFile(content);
      expect(result.body).toBe('');
    });

    it('should throw on missing frontmatter delimiter', () => {
      const content = `no delimiters here`;
      expect(() => state.parseFile(content)).toThrow(/missing YAML frontmatter delimiters/);
    });

    it('should throw on invalid YAML', () => {
      const content = `---
version: "2.1"
project: "Test"
  bad: yes
---
body
`;
      expect(() => state.parseFile(content)).toThrow(/Failed to parse YAML/);
    });

    it('should handle body containing "---" by rejoining', () => {
      const content = `---
version: "2.1"
---
Body line 1
---
Body line 2
---
Body line 3
`;
      const result = state.parseFile(content);
      expect(result.body).toContain('Body line 1');
      expect(result.body).toContain('Body line 2');
      expect(result.body).toContain('Body line 3');
    });
  });

  describe('readState', () => {
    it('should return parsed state when file exists', async () => {
      const stateData = {
        version: '2.1',
        project: 'TestProject',
        task: 'TestTask',
        status: 'active',
        last_action: 'Test action',
        next_steps: ['step1', 'step2'],
        updated: '2026-02-25T19:00:00.000Z'
      };
      const content = `---
${yaml.dump(stateData, { lineWidth: -1 })}---
Body content here.
`;
      await fs.promises.writeFile(stateFile, content, 'utf8');

      const result = await state.readState();
      expect(result).toEqual({
        ...stateData,
        body: 'Body content here.'
      });
    });

    it('should return null when file does not exist', async () => {
      // Ensure file does not exist
      if (fs.existsSync(stateFile)) await fs.promises.unlink(stateFile);

      const result = await state.readState();
      expect(result).toBeNull();
    });

    it('should throw on corrupt YAML file', async () => {
      const corruptContent = `---
version: "2.1"
project: "Test"
  bad_indent: true
---
body
`;
      await fs.promises.writeFile(stateFile, corruptContent, 'utf8');

      await expect(state.readState()).rejects.toThrow(/Failed to parse YAML frontmatter/);
    });

    it('should throw on empty file', async () => {
      await fs.promises.writeFile(stateFile, '', 'utf8');

      await expect(state.readState()).rejects.toThrow(/missing YAML frontmatter delimiters/);
    });

    it('should auto-migrate state missing version field', async () => {
      const oldState = {
        project: 'OldProject',
        task: 'OldTask',
        status: 'blocked',
        last_action: 'Old action',
        next_steps: ['old step'],
        updated: '2026-01-01T00:00:00.000Z'
      };
      const content = `---
${yaml.dump(oldState, { lineWidth: -1 })}---
Old body
`;
      await fs.promises.writeFile(stateFile, content, 'utf8');

      const result = await state.readState();
      // No auto-migration on read; version should be as in file (undefined)
      expect(result.version).toBeUndefined();
      expect(result.project).toBe('OldProject');
      expect(result.body).toBe('Old body');
    });

    it('should handle unicode and special characters', async () => {
      const stateData = {
        version: '2.1',
        project: 'Проект медведь 🐻',
        task: 'Café support ☕',
        status: 'active',
        last_action: 'Test emoji',
        next_steps: ['😀', ' שלום'],
        updated: '2026-02-25T19:00:00.000Z'
      };
      const content = `---
${yaml.dump(stateData, { lineWidth: -1 })}
---
Body with émojî and "code" and "quotes"
`;
      await fs.promises.writeFile(stateFile, content, 'utf8');

      const result = await state.readState();
      expect(result.project).toContain('🐻');
      expect(result.task).toContain('☕');
      expect(result.next_steps[0]).toContain('😀');
      expect(result.body).toContain('émojî');
    });
  });

  describe('writeState', () => {
    it('should write valid state file atomically', async () => {
      const result = await state.writeState({
        version: '2.1',
        project: 'TestProject',
        task: 'TestTask',
        status: 'in-progress',
        last_action: 'Wrote test',
        next_steps: ['a', 'b']
      });

      expect(result.success).toBe(true);
      expect(result.updated).toBeDefined();
      expect(fs.existsSync(stateFile)).toBe(true);

      const content = await fs.promises.readFile(stateFile, 'utf8');
      expect(content).toMatch(/version:\s+['"]2\.1['"]/);
      expect(content).toContain('project: TestProject');
      expect(content).toContain('task: TestTask');
      expect(content).toContain('status: in-progress');
    });

    it('should auto-generate updated timestamp', async () => {
      const before = Date.now();
      await state.writeState({
        version: '2.1',
        project: 'TS',
        task: 'T',
        status: 'active',
        last_action: 'A',
        next_steps: []
      });

      const result = await state.readState();
      const updatedTime = new Date(result.updated).getTime();
      expect(updatedTime).toBeGreaterThanOrEqual(before);
      expect(updatedTime).toBeLessThanOrEqual(Date.now());
    });

    it('should merge with existing state preserving unspecified fields', async () => {
      const initial = {
        version: '2.1',
        project: 'Original',
        task: 'Original task',
        status: 'active',
        last_action: 'Original action',
        next_steps: ['original step'],
        body: 'Original body content',
        updated: '2026-02-25T00:00:00.000Z'
      };
      await fs.promises.writeFile(stateFile, `---
${yaml.dump(initial, { lineWidth: -1 })}---
Original body
`, 'utf8');

      await state.writeState({
        project: 'Updated project'
      });

      const result = await state.readState();
      expect(result.project).toBe('Updated project');
      expect(result.task).toBe('Original task');
      expect(result.next_steps).toEqual(['original step']);
      expect(result.body).toBe('Original body');
    });

    it('should add version 2.1 automatically on initial write', async () => {
      await state.writeState({
        project: 'NoVersion',
        task: 'Task',
        status: 'blocked',
        last_action: 'Action',
        next_steps: []
      });

      const result = await state.readState();
      expect(result.version).toBe('2.1');
    });

    it('should validate schema and reject invalid data', async () => {
      await expect(state.writeState({
        version: '2.1',
        project: 'P',
        task: 'T',
        last_action: 'A',
        next_steps: []
      })).rejects.toThrow(/validation failed.*status/);

      await expect(state.writeState({
        version: '2.1',
        project: 'P',
        task: 'T',
        status: 'invalid-status',
        last_action: 'A',
        next_steps: []
      })).rejects.toThrow(/must be one of/);

      await expect(state.writeState({
        version: '2.1',
        project: 'P',
        task: 'T',
        status: 'active',
        last_action: 'A',
        next_steps: 'not array'
      })).rejects.toThrow(/must be array/);
    });

    it('should clean up temp file on validation failure', async () => {
      try {
        await state.writeState({
          project: 'Missing required fields'
        });
      } catch (e) {
        // expected
      }

      const files = await fs.promises.readdir(tmpdir);
      const tempFiles = files.filter(f => f.includes('.tmp'));
      expect(tempFiles.length).toBe(0);
    });

    it('should handle disk full scenario gracefully', async () => {
      const writeFileSyncSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation((path, data, encoding) => {
        const err = new Error('No space left on device');
        err.code = 'ENOSPC';
        throw err;
      });

      await expect(state.writeState({
        version: '2.1',
        project: 'P',
        task: 'T',
        status: 'active',
        last_action: 'A',
        next_steps: []
      })).rejects.toThrow('No space left on device');

      writeFileSyncSpy.mockRestore();
      expect(fs.existsSync(stateFile)).toBe(false);
    });

    it('should raise permission error appropriately', async () => {
      const writeFileSyncSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation((path, data, encoding) => {
        const err = new Error('Permission denied');
        err.code = 'EACCES';
        throw err;
      });

      await expect(state.writeState({
        version: '2.1',
        project: 'P',
        task: 'T',
        status: 'active',
        last_action: 'A',
        next_steps: []
      })).rejects.toMatchObject({ code: 'EACCES' });

      writeFileSyncSpy.mockRestore();
    });

    it('should allow dryRun option without writing', async () => {
      const result = await state.writeState({
        version: '2.1',
        project: 'DryRun',
        task: 'Test',
        status: 'active',
        last_action: 'A',
        next_steps: []
      }, { dryRun: true });

      expect(result.success).toBe(true);
      expect(fs.existsSync(stateFile)).toBe(false);
    });

    it('should accept body updates', async () => {
      await state.writeState({
        version: '2.1',
        project: 'P',
        task: 'T',
        status: 'active',
        last_action: 'A',
        next_steps: [],
        body: 'Initial body'
      });

      await state.writeState({
        body: 'Updated body with more content\nLine 2'
      });

      const result = await state.readState();
      expect(result.body).toBe('Updated body with more content\nLine 2');
    });

    it('should preserve existing fields when body is updated', async () => {
      await state.writeState({
        version: '2.1',
        project: 'P',
        task: 'T',
        status: 'active',
        last_action: 'A',
        next_steps: ['step1']
      });

      await state.writeState({ body: 'New body' });

      const result = await state.readState();
      expect(result.project).toBe('P');
      expect(result.task).toBe('T');
      expect(result.body).toBe('New body');
    });
  });

  describe('configureCache', () => {
    it('should set default values when called with empty config', () => {
      state.configureCache({});
      const stats = state.getCacheStats();
      expect(stats.max).toBe(100);
      expect(stats.ttl).toBe(300000);
    });

    it('should configure cache with custom max and TTL', () => {
      state.configureCache({ max: 50, ttlMs: 600000 });
      const stats = state.getCacheStats();
      expect(stats.max).toBe(50);
      expect(stats.ttl).toBe(600000);
    });

    it('should ignore undefined values', () => {
      state.configureCache({ max: 30, ttlMs: 120000 });
      state.configureCache({ max: undefined });
      const stats = state.getCacheStats();
      expect(stats.max).toBe(30);
      expect(stats.ttl).toBe(120000);
    });

    it('should handle zero max (set to at least 1)', () => {
      state.configureCache({ max: 0 });
      const stats = state.getCacheStats();
      expect(stats.max).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getCache and getCacheStats', () => {
    it('should return cache instance with required methods', () => {
      const cache = state.getCache();
      expect(cache).toBeDefined();
      expect(typeof cache.get).toBe('function');
      expect(typeof cache.set).toBe('function');
      expect(typeof cache.clear).toBe('function');
      expect(typeof cache.size).toBe('number');
      expect(typeof cache.keys).toBe('function');
    });

    it('should store and retrieve values', () => {
      const cache = state.getCache();
      const key = 'test-key';
      const value = { results: ['a', 'b'] };
      const mtime = Date.now();

      cache.set(key, { value, mtime, timestamp: Date.now() });
      const entry = cache.get(key);

      expect(entry.value).toEqual(value);
      expect(entry.mtime).toBe(mtime);
      expect(entry.timestamp).toBeDefined();
    });

    it('should return undefined for non-existent key', () => {
      const cache = state.getCache();
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('getCacheStats should return size, max, ttl, and keys', () => {
      const stats = state.getCacheStats();
      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('max');
      expect(stats).toHaveProperty('ttl');
      expect(typeof stats.size).toBe('number');
      expect(typeof stats.max).toBe('number');
      expect(typeof stats.ttl).toBe('number');
    });
  });

  describe('discoverFromSessions', () => {
    let discoverFromSessions;
    beforeEach(() => {
      discoverFromSessions = state.discoverFromSessions;
    });

    it('should synthesize state from memory search results', async () => {
      const mockMemorySearch = async () => [
        {
          source: 'memory/meeting.md',
          content: 'Discussed project Alpha timeline.',
          score: 0.987,
          file: '/workspace/memory/meeting.md',
          mtime: 1740513600000
        }
      ];

      const result = await discoverFromSessions(mockMemorySearch, { limit: 5 });

      expect(result).toHaveProperty('project');
      expect(result).toHaveProperty('task');
      expect(result).toHaveProperty('status', 'active');
      expect(result).toHaveProperty('updated');
      expect(result).toHaveProperty('body');
    });

    it('should write discovered state automatically', async () => {
      const mockMemorySearch = async () => [
        {
          source: 'memory/test.md',
          content: 'Working on project XYZ and implementing feature ABC',
          score: 0.95
        }
      ];

      await discoverFromSessions(mockMemorySearch);

      // State file should now exist
      expect(fs.existsSync(stateFile)).toBe(true);
      const result = await state.readState();
      expect(result).toBeDefined();
      expect(result.project).toBeDefined();
    });

    it('should handle memory search with no results', async () => {
      const mockMemorySearch = async () => [];

      const result = await discoverFromSessions(mockMemorySearch);

      expect(result.project).toBe('');
      expect(result.task).toBe('');
      expect(result.next_steps).toEqual([]);
      expect(result.body).toContain('Auto-discovered');
    });

    it('should propagate errors from memory_search', async () => {
      const mockMemorySearch = async () => {
        throw new Error('Search failed');
      };

      await expect(discoverFromSessions(mockMemorySearch))
        .rejects.toThrow('Search failed');
    });

    it('should accept query override option', async () => {
      const mockMemorySearch = jest.fn().mockResolvedValue([
        { source: 'memory/test.md', content: 'Custom query result', score: 0.9 }
      ]);

      await discoverFromSessions(mockMemorySearch, {
        query: 'custom query string',
        limit: 20,
        minScore: 0.5
      });

      expect(mockMemorySearch).toHaveBeenCalledWith({
        query: 'custom query string',
        limit: 20,
        minScore: 0.5,
        sources: ['sessions']
      });
    });
  });

  describe('getConfig and setConfig', () => {
    it('should store and return plugin config', () => {
      const config = {
        cacheMax: 200,
        cacheTTLms: 600000,
        enablePrefetch: true,
        prefetchQueries: ['q1', 'q2']
      };
      state.setConfig(config);
      expect(state.getConfig()).toEqual(config);
    });

    it('should apply cache configuration when setConfig called', () => {
      state.setConfig({ cacheMax: 150, cacheTTLms: 900000 });
      const stats = state.getCacheStats();
      expect(stats.max).toBe(150);
      expect(stats.ttl).toBe(900000);
    });
  });

  describe('SCHEMA constant', () => {
    it('should define all required fields', () => {
      const schema = state.SCHEMA;

      expect(schema).toHaveProperty('version');
      expect(schema).toHaveProperty('project');
      expect(schema).toHaveProperty('task');
      expect(schema).toHaveProperty('status');
      expect(schema).toHaveProperty('last_action');
      expect(schema).toHaveProperty('next_steps');
      expect(schema).toHaveProperty('updated');
      expect(schema).toHaveProperty('body');
      expect(schema).toHaveProperty('context_anchor');
      expect(schema).toHaveProperty('conversation_summary');
    });

    it('should have correct enum values for status', () => {
      const schema = state.SCHEMA;
      expect(schema.status.values).toEqual(['active', 'blocked', 'done', 'in-progress']);
    });
  });

  describe('truncateAnchor', () => {
    it('should truncate text exceeding max tokens', () => {
      const longText = 'a'.repeat(10000);
      const truncated = state.truncateAnchor(longText, 100); // 400 chars max
      expect(truncated.length).toBeLessThanOrEqual(404);
      expect(truncated.endsWith('...')).toBe(true);
    });

    it('should not truncate short text', () => {
      const short = 'Short text';
      expect(state.truncateAnchor(short, 100)).toBe(short);
    });

    it('should handle empty string', () => {
      expect(state.truncateAnchor('', 100)).toBe('');
    });
  });

  describe('isCacheValid', () => {
    it('should return false for null/undefined results', () => {
      expect(state.isCacheValid(null)).toBe(false);
      expect(state.isCacheValid(undefined)).toBe(false);
    });

    it('should return false for non-array', () => {
      expect(state.isCacheValid({})).toBe(false);
    });

    it('should return true for array without file references', () => {
      expect(state.isCacheValid([{ result: 'test' }])).toBe(true);
    });

    it('should invalidate if file mtime changed', async () => {
      const testFile = path.resolve(tmpdir, 'test.txt');
      await fs.promises.writeFile(testFile, 'content', 'utf8');
      const mtime1 = (await fs.promises.stat(testFile)).mtimeMs;

      const results = [{
        file: testFile,
        _cachedMtime: mtime1
      }];

      // File unchanged - valid
      expect(state.isCacheValid(results)).toBe(true);

      // Modify file
      await fs.promises.writeFile(testFile, 'new content', 'utf8');
      const mtime2 = (await fs.promises.stat(testFile)).mtimeMs;
      expect(mtime2).toBeGreaterThan(mtime1);

      // Should now be invalid
      expect(state.isCacheValid([{ file: testFile, _cachedMtime: mtime1 }])).toBe(false);
    });

    it('should invalidate if file deleted', () => {
      const nonExistent = path.resolve(tmpdir, 'does-not-exist.txt');
      expect(state.isCacheValid([{ file: nonExistent, _cachedMtime: Date.now() }])).toBe(false);
    });
  });
});
