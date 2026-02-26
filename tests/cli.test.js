/**
 * CLI Command Tests
 * Tests commands.js handler functions directly
 */

// Mock state module
jest.mock('../lib/state', () => ({
  readState: jest.fn(),
  writeState: jest.fn(),
  getCacheStats: jest.fn().mockReturnValue({ size: 0, max: 0, ttl: 0 }),
  getCache: jest.fn(),
  discoverFromSessions: jest.fn()
}));

const state = require('../lib/state');
const commands = require('../cli/commands');

// Mock process.exit to prevent test process from exiting
const originalExit = process.exit;
beforeAll(() => {
  jest.spyOn(process, 'exit').mockImplementation(code => {
    if (code !== 0) {
      throw new Error(`process.exit(${code})`);
    }
  });
});
afterAll(() => {
  if (process.exit.mockRestore) process.exit.mockRestore();
  else process.exit = originalExit;
});

// Mock console methods globally for all tests
let mockConsoleLog;
let mockConsoleError;
let mockConsoleWarn;

beforeEach(() => {
  mockConsoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
  mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.clearAllMocks();
});

afterEach(() => {
  mockConsoleLog.mockRestore();
  mockConsoleError.mockRestore();
  mockConsoleWarn.mockRestore();
});

function createMockProgram() {
  const handlers = {};

  // Helper to extract base command name (e.g., 'set <key> <value>' -> 'set')
  function getBaseName(fullName) {
    return fullName.split(' ')[0].split('<')[0];
  }

  // Helper to create builder objects that can handle nested commands
  function builder(name) {
    const baseName = getBaseName(name);
    return {
      description: jest.fn().mockReturnThis(),
      action: jest.fn().mockImplementation(handler => {
        // Store handler under both full name and base name
        handlers[baseName] = handler;
        handlers[name] = handler;
      }),
      command: jest.fn().mockImplementation(subName => {
        return builder(subName);
      })
    };
  }

  const program = {
    command: jest.fn().mockImplementation(name => {
      return builder(name);
    })
  };

  return { program, handlers };
}

describe('CLI commands', () => {
  describe('command: show', () => {
    it('should print formatted state when file exists', async () => {
      const stateData = {
        version: '2.1',
        project: 'DemoProject',
        task: 'Add auth',
        status: 'in-progress',
        last_action: 'Implemented OAuth',
        next_steps: ['Write tests', 'Review PR'],
        context_anchor: 'Working on auth',
        updated: '2026-02-25T19:00:00.000Z',
        body: 'This is the body content.\nWith multiple lines.'
      };
      state.readState.mockResolvedValue(stateData);

      const { program, handlers } = createMockProgram();
      commands(program);
      const showHandler = handlers['show'];

      await showHandler();

      const logged = console.log.mock.calls.map(args => args.join(' ')).join('\n');
      expect(logged).toContain('version: 2.1');
      expect(logged).toContain('project: DemoProject');
      expect(logged).toContain('status: in-progress');
      expect(logged).toContain('next_steps:');
      expect(logged).toContain('  - Write tests');
      expect(logged).toContain('  - Review PR');
      expect(logged).toContain('updated: 2026-02-25T19:00:00.000Z');
      expect(logged).toContain('context_anchor: Working on auth');
      expect(logged).toContain('--- Context Body ---');
      expect(logged).toContain('This is the body content');
    });

    it('should print message when file missing', async () => {
      state.readState.mockResolvedValue(null);

      const { program, handlers } = createMockProgram();
      commands(program);
      const showHandler = handlers['show'];

      await showHandler();

      const logged = console.log.mock.calls.map(args => args.join(' ')).join('\n');
      expect(logged).toContain('does not exist or is empty.');
    });
  });

  describe('command: set', () => {
    it('should call writeState with provided key-value', async () => {
      state.readState.mockResolvedValue({ version: '2.1' });
      state.writeState.mockResolvedValue({ success: true, updated: new Date().toISOString() });

      const { program, handlers } = createMockProgram();
      commands(program);
      // Debug: list all registered handlers and their types
      const handlerNames = Object.keys(handlers).join(', ') || '(none)';
      expect(handlerNames).toMatch(/set/);
      console.log('handlers["set"] =', handlers['set'], 'type:', typeof handlers['set']);
      const setHandler = handlers['set'];
      expect(typeof setHandler).toBe('function');
      await setHandler('project', 'NewProject');

      expect(state.writeState).toHaveBeenCalledWith(
        expect.objectContaining({ project: 'NewProject' })
      );
    });

    it('should parse JSON values when string starts with { or [', async () => {
      state.readState.mockResolvedValue({ version: '2.1' });
      state.writeState.mockResolvedValue({ success: true, updated: new Date().toISOString() });

      const { program, handlers } = createMockProgram();
      commands(program);
      const setHandler = handlers['set'];

      await setHandler('next_steps', '["a","b","c"]');

      expect(state.writeState).toHaveBeenCalledWith(
        expect.objectContaining({ next_steps: ['a', 'b', 'c'] })
      );
    });

    it('should reject invalid key names', async () => {
      state.readState.mockResolvedValue({ version: '2.1' });

      const { program, handlers } = createMockProgram();
      commands(program);
      const setHandler = handlers['set'];

      try {
        await setHandler('invalid_key', 'value');
      } catch (e) {
        // Expected: process.exit(1) throws
      }

      const errorLogged = console.error.mock.calls.map(args => args.join(' ')).join('\n');
      expect(errorLogged).toContain("Invalid field 'invalid_key'");
    });

    it('should print success message on valid write', async () => {
      state.readState.mockResolvedValue({ version: '2.1' });
      state.writeState.mockResolvedValue({ success: true, updated: new Date().toISOString() });

      const { program, handlers } = createMockProgram();
      commands(program);
      const setHandler = handlers['set'];

      await setHandler('status', 'blocked');

      const logged = console.log.mock.calls.map(args => args.join(' ')).join('\n');
      // JSON.stringify adds quotes around strings
      expect(logged).toContain('Set status = "blocked"');
    });

    it('should handle write errors and exit', async () => {
      state.writeState.mockRejectedValue(new Error('Disk full'));
      const { program, handlers } = createMockProgram();
      commands(program);
      const setHandler = handlers['set'];

      try {
        await setHandler('project', 'Test');
      } catch (e) {
        // Expected to throw due to process.exit mock
      }

      const errorLogged = console.error.mock.calls.map(args => args.join(' ')).join('\n');
      expect(errorLogged).toContain('Error: Disk full');
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('command: cache-stats', () => {
    it('should display cache statistics', async () => {
      state.getCacheStats.mockReturnValue({ size: 42, max: 100, ttl: 300000 });

      const { program, handlers } = createMockProgram();
      commands(program);
      const statsHandler = handlers['cache-stats'];

      await statsHandler();

      const logged = console.log.mock.calls.map(args => args.join(' ')).join('\n');
      expect(logged).toContain('Size: 42/100 entries');
      expect(logged).toContain('TTL: 300000ms');
    });
  });

  describe('command: cache-clear', () => {
    it('should clear the cache and report count', async () => {
      const mockCache = {
        clear: jest.fn(),
        size: jest.fn().mockReturnValue(50)
      };
      state.getCache.mockReturnValue(mockCache);

      const { program, handlers } = createMockProgram();
      commands(program);
      const clearHandler = handlers['cache-clear'];

      await clearHandler();

      expect(mockCache.clear).toHaveBeenCalled();
      const logged = console.log.mock.calls.map(args => args.join(' ')).join('\n');
      expect(logged).toContain('Cache cleared (50 entries removed).');
    });

    it('should handle missing cache gracefully', async () => {
      state.getCache.mockReturnValue(null);

      const { program, handlers } = createMockProgram();
      commands(program);
      const clearHandler = handlers['cache-clear'];

      await clearHandler();

      const logged = console.log.mock.calls.map(args => args.join(' ')).join('\n');
      expect(logged).toContain('Cache not available or already empty.');
    });
  });
});