/**
 * Performance Benchmarks
 * These tests measure execution time for critical operations.
 * Run with: npm run test:perf
 * By default, they are included but marked as .skip to avoid running on every CI.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const state = require('../lib/state');

// Helper to create temp workspace
async function createTempWorkspace() {
  const tmpdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-perf-'));
  const stateFile = path.resolve(tmpdir, 'CONTEXT_PERSISTENCE.md');
  return { tmpdir, stateFile };
}

async function cleanupWorkspace(tmpdir) {
  if (tmpdir && fs.existsSync(tmpdir)) {
    await fs.promises.rm(tmpdir, { recursive: true, force: true });
  }
}

describe('Performance Benchmarks', () => {
  let tmpdir;
  let originalEnv;

  beforeEach(async () => {
    tmpdir = await createTempWorkspace();
    originalEnv = process.env.OPENCLAW_WORKSPACE;
    process.env.OPENCLAW_WORKSPACE = tmpdir;
    // Reset cache
    state.configureCache({ max: 100, ttlMs: 300000 });
    state.getCache().clear();
    state.setConfig({});
  });

  afterEach(async () => {
    await cleanupWorkspace(tmpdir);
    process.env.OPENCLAW_WORKSPACE = originalEnv;
  });

  describe('readState Performance', () => {
    it('should complete within 50ms average (over 100 iterations)', async () => {
      // Create initial state file
      await state.writeState({
        version: '2.1',
        project: 'PerfTest',
        task: 'Read performance test',
        status: 'active',
        last_action: 'Setup',
        next_steps: ['benchmark read'],
        body: ' '.repeat(10000) // 10KB body
      });

      const times = [];
      const ITERATIONS = 100;

      for (let i = 0; i < ITERATIONS; i++) {
        const start = Date.now();
        await state.readState();
        times.push(Date.now() - start);
      }

      const avg = times.reduce((a, b) => a + b, 0) / ITERATIONS;
      const max = Math.max(...times);
      const p95 = times.sort((a, b) => a - b)[Math.floor(ITERATIONS * 0.95)];

      console.log(`readState benchmark: avg=${avg.toFixed(2)}ms, p95=${p95.toFixed(2)}ms, max=${max.toFixed(2)}ms`);

      expect(avg).toBeLessThan(50);
      expect(p95).toBeLessThan(100);
      expect(max).toBeLessThan(200);
    });
  });

  describe('writeState Performance', () => {
    it('should complete within 50ms average (over 100 iterations)', async () => {
      const times = [];
      const ITERATIONS = 100;

      for (let i = 0; i < ITERATIONS; i++) {
        const start = Date.now();
        await state.writeState({
          version: '2.1',
          project: `PerfWrite${i}`,
          task: 'Write performance test',
          status: 'active',
          last_action: `Iteration ${i}`,
          next_steps: [`step ${i}`]
        });
        times.push(Date.now() - start);
      }

      const avg = times.reduce((a, b) => a + b, 0) / ITERATIONS;
      const max = Math.max(...times);
      const p95 = times.sort((a, b) => a - b)[Math.floor(ITERATIONS * 0.95)];

      console.log(`writeState benchmark: avg=${avg.toFixed(2)}ms, p95=${p95.toFixed(2)}ms, max=${max.toFixed(2)}ms`);

      expect(avg).toBeLessThan(50);
      expect(p95).toBeLessThan(100);
      expect(max).toBeLessThan(200);
    });
  });

  describe('Cache get/set Performance', () => {
    it('should complete cache operations under 5ms', async () => {
      const cache = state.getCache();

      const ITERATIONS = 1000;
      const key = 'perf-test-key';
      const value = { results: ['a', 'b', 'c'], mtime: Date.now() };

      // Measure set performance
      const setTimes = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const start = Date.now();
        cache.set(`${key}-${i}`, { ...value, timestamp: Date.now() });
        setTimes.push(Date.now() - start);
      }

      const avgSet = setTimes.reduce((a, b) => a + b, 0) / ITERATIONS;
      console.log(`cache.set avg: ${avgSet.toFixed(3)}ms`);

      // Measure get performance
      const getTimes = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const start = Date.now();
        cache.get(`${key}-${i}`);
        getTimes.push(Date.now() - start);
      }

      const avgGet = getTimes.reduce((a, b) => a + b, 0) / ITERATIONS;
      console.log(`cache.get avg: ${avgGet.toFixed(3)}ms`);

      expect(avgSet).toBeLessThan(5);
      expect(avgGet).toBeLessThan(5);
    });

    it('should handle high load without significant slowdown', async () => {
      const cache = state.getCache();

      // Insert 1000 entries
      for (let i = 0; i < 1000; i++) {
        cache.set(`key-${i}`, { value: i, mtime: Date.now(), timestamp: Date.now() });
      }

      // Random access pattern
      const accessTimes = [];
      for (let i = 0; i < 500; i++) {
        const randomKey = `key-${Math.floor(Math.random() * 1000)}`;
        const start = Date.now();
        cache.get(randomKey);
        accessTimes.push(Date.now() - start);
      }

      const avg = accessTimes.reduce((a, b) => a + b, 0) / accessTimes.length;
      expect(avg).toBeLessThan(5);
    });
  });

  describe('Hook Performance', () => {
    it('preCompaction should complete within 500ms', async () => {
      const preCompactionHandler = require('../hooks/preCompaction');
      // Mock state methods to be fast
      const stateModule = require('../lib/state');
      jest.spyOn(stateModule, 'readState').mockResolvedValue({
        version: '2.1',
        project: 'PerfProject',
        task: 'PerfTask',
        status: 'active',
        last_action: 'Benchmark',
        next_steps: [],
        updated: new Date().toISOString()
      });
      const writeStateMock = jest.fn().mockResolvedValue({ success: true });
      jest.spyOn(stateModule, 'writeState').mockImplementation(writeStateMock);

      const ctx = {
        log: { info: jest.fn(), debug: jest.fn(), error: jest.fn() },
        session: {}
      };

      const times = [];
      for (let i = 0; i < 50; i++) {
        const start = Date.now();
        await preCompactionHandler(ctx);
        times.push(Date.now() - start);
      }

      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const max = Math.max(...times);
      console.log(`preCompaction avg: ${avg.toFixed(2)}ms, max: ${max.toFixed(2)}ms`);
      expect(avg).toBeLessThan(500);
    });

    it('sessionStart with prefetch should complete within 2s (parallel)', async () => {
      const sessionStartHandler = require('../hooks/sessionStart');
      const stateModule = require('../lib/state');
      jest.spyOn(stateModule, 'readState').mockResolvedValue({ body: 'State loaded' });
      jest.spyOn(stateModule, 'getConfig').mockReturnValue({
        enablePrefetch: true,
        prefetchQueries: ['q1', 'q2', 'q3', 'q4', 'q5']
      });

      const delays = [100, 150, 80, 120, 90];
      let delayIdx = 0;
      const mockPrefetch = jest.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, delays[delayIdx++ % delays.length]));
        return { prefetched: [{ query: 'test', ok: true }] };
      });

      const ctx = {
        log: { info: jest.fn(), debug: jest.fn(), warn: jest.fn() },
        session: { addSystemMessage: jest.fn().mockResolvedValue(undefined) },
        tools: { cached_memory_search: mockPrefetch }
      };

      const start = Date.now();
      await sessionStartHandler(ctx);
      const duration = Date.now() - start;

      console.log(`sessionStart with 5 prefetch queries: ${duration}ms`);
      expect(duration).toBeLessThan(1000);
    });

    it('postCompaction should complete within 100ms', async () => {
      const postCompactionHandler = require('../hooks/postCompaction');
      const stateModule = require('../lib/state');
      jest.spyOn(stateModule, 'readState').mockResolvedValue({
        project: 'PerfProject',
        task: 'PerfTask',
        next_steps: ['a', 'b', 'c'],
        updated: new Date().toISOString()
      });

      const ctx = {
        log: { debug: jest.fn(), error: jest.fn() },
        session: { addSystemMessage: jest.fn().mockResolvedValue(undefined) }
      };

      const times = [];
      for (let i = 0; i < 50; i++) {
        const start = Date.now();
        await postCompactionHandler(ctx);
        times.push(Date.now() - start);
      }

      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      expect(avg).toBeLessThan(100);
    });
  });

  describe('cached_memory_search Performance', () => {
    it('cache hit should be sub-millisecond', async () => {
      const cache = state.getCache();

      // Populate cache
      const key = 'perf-hit-key';
      cache.set(key, {
        value: [{ result: 'test' }],
        mtime: Date.now(),
        cachedAt: Date.now()
      });

      const originalGet = cache.get.bind(cache);
      // Warm up any lazy init?

      // Measure get
      const start = process.hrtime.bigint();
      for (let i = 0; i < 1000; i++) {
        cache.get(key);
      }
      const elapsedNs = process.hrtime.bigint() - start;
      const avgMs = Number(elapsedNs) / 1e6 / 1000;

      console.log(`cache.get avg: ${avgMs.toFixed(3)}ms`);
      expect(avgMs).toBeLessThan(1);
    });
  });
});
