#!/usr/bin/env node
/**
 * Context Persistence Plugin - CLI Commands (v2.2.0)
 *
 * This module registers subcommands under `openclaw context-persistence`.
 *
 * Usage:
 *   openclaw context-persistence show
 *   openclaw context-persistence set <key> <value>
 *   openclaw context-persistence refresh
 *   openclaw context-persistence clear
 *   openclaw context-persistence cache-stats
 *   openclaw context-persistence cache-clear
 *   openclaw context-persistence show-cache
 *
 * SECURITY MANIFEST:
 *   Environment variables accessed: OPENCLAW_WORKSPACE (optional)
 *   External endpoints called: none
 *   Local files read: CONTEXT_PERSISTENCE.md
 *   Local files written: CONTEXT_PERSISTENCE.md
 */

const state = require('../lib/state');
const { readState, writeState, discoverFromSessions, getCacheStats, getCache } = state;

module.exports = function registerCommands(program) {
  const cmd = program.command('context-persistence')
    .description('Context Persistence plugin commands');

  cmd.command('show')
    .description('Display current CONTEXT_PERSISTENCE.md contents')
    .action(async function actionShow() {
      try {
        const stateObj = await readState();
        if (!stateObj) {
          console.log('CONTEXT_PERSISTENCE.md does not exist or is empty.');
          return;
        }
        console.log('--- CONTEXT PERSISTENCE STATE ---');
        for (const [key, value] of Object.entries(stateObj)) {
          if (key === 'body' || key === 'updated') continue;
          if (Array.isArray(value)) {
            console.log(`${key}:`);
            value.forEach(v => console.log(`  - ${v}`));
          } else if (typeof value === 'object' && value !== null) {
            console.log(`${key}: ${JSON.stringify(value)}`);
          } else {
            console.log(`${key}: ${value}`);
          }
        }
        if (stateObj.updated) {
          console.log(`\nupdated: ${stateObj.updated}`);
        }
        if (stateObj.body) {
          console.log('\n--- Context Body ---');
          console.log(stateObj.body);
        }
      } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
      }
    });

  cmd.command('set <key> <value>')
    .description('Set a field in CONTEXT_PERSISTENCE.md (JSON values auto-parsed)')
    .action(async function actionSet(key, value) {
      try {
        // Validate allowed keys as per specification
        const ALLOWED_KEYS = new Set([
          'version',
          'project',
          'task',
          'status',
          'last_action',
          'next_steps',
          'context_anchor',
          'conversation_summary',
          'updated',
          'body'
        ]);

        if (!ALLOWED_KEYS.has(key)) {
          console.error(`Invalid field '${key}'. Allowed fields: ${[...ALLOWED_KEYS].join(', ')}`);
          process.exit(1);
        }

        let parsedValue = value;
        try {
          if (/^\[|\{/.test(value)) {
            parsedValue = JSON.parse(value);
          }
        } catch (e) {
          // keep as string
        }
        await writeState({ [key]: parsedValue });
        console.log(`Set ${key} = ${JSON.stringify(parsedValue)}`);
      } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
      }
    });

  cmd.command('refresh')
    .description('Rediscover state from session transcripts (requires memory_search)')
    .action(async function actionRefresh() {
      try {
        // memory_search may be injected by OpenClaw when running as a tool.
        // In standalone CLI mode, this command will not work. That's acceptable.
        const memorySearch = global.__memory_search__ || null;
        if (!memorySearch) {
          console.error('memory_search tool not available. Enable session transcript indexing.');
          process.exitCode = 1;
          return;
        }
        const discovered = await discoverFromSessions(memorySearch);
        await writeState(discovered);
        console.log('CONTEXT_PERSISTENCE.md refreshed from session transcripts.');
        console.log(`Project: ${discovered.project}`);
        console.log(`Task: ${discovered.task}`);
      } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
      }
    });

  cmd.command('clear')
    .description('Reset CONTEXT_PERSISTENCE.md to empty')
    .action(async function actionClear() {
      try {
        await writeState({
          project: '',
          task: '',
          status: '',
          last_action: '',
          next_steps: [],
          updated: new Date().toISOString(),
          body: ''
        });
        console.log('CONTEXT_PERSISTENCE.md cleared.');
      } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
      }
    });

  cmd.command('cache-stats')
    .description('Show LRU cache statistics')
    .action(async function actionCacheStats() {
      try {
        const stats = getCacheStats();
        console.log('--- CACHE STATISTICS ---');
        console.log(`Size: ${stats.size}/${stats.max} entries`);
        console.log(`TTL: ${stats.ttl}ms (${stats.ttl / 60000} minutes)`);
        if (stats.keys && stats.keys.length > 0) {
          console.log('\nSample keys:');
          stats.keys.forEach((key, i) => {
            try {
              const parsed = JSON.parse(key);
              console.log(`  ${i + 1}. query: "${parsed.query?.substring(0, 40)}..."`);
            } catch {
              console.log(`  ${i + 1}. ${key.substring(0, 50)}...`);
            }
          });
        } else {
          console.log('\nCache is empty.');
        }
      } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
      }
    });

  cmd.command('cache-clear')
    .description('Clear the LRU cache')
    .action(async function actionCacheClear() {
      try {
        const cache = getCache();
        if (cache && typeof cache.clear === 'function') {
          const sizeBefore = typeof cache.size === 'function' ? cache.size() : (cache.size || 0);
          cache.clear();
          console.log(`Cache cleared (${sizeBefore} entries removed).`);
        } else {
          console.log('Cache not available or already empty.');
        }
      } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
      }
    });

  cmd.command('show-cache')
    .description('List all cached query keys')
    .action(async function actionShowCache() {
      try {
        const cache = getCache();
        const keys = cache.keys ? Array.from(cache.keys()) : [];

        if (keys.length === 0) {
          console.log('Cache is empty.');
          return;
        }

        console.log('--- CACHE ENTRIES ---');
        console.log(`Total: ${keys.length} entries\n`);

        keys.forEach((key, i) => {
          try {
            const parsed = JSON.parse(key);
            console.log(`${i + 1}. Query: "${parsed.query?.substring(0, 60)}..."`);
            console.log(`   Limit: ${parsed.limit}, MinScore: ${parsed.minScore}`);
            console.log(`   Sources: ${parsed.sources?.join(', ')}`);
          } catch {
            console.log(`${i + 1}. ${key.substring(0, 80)}...`);
          }
          console.log('');
        });
      } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
      }
    });
};
