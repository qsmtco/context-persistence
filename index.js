#!/usr/bin/env node
/**
 * Context Persistence Plugin (v2.2.0)
 *
 * Main entry point. Exports a `register(api)` function that OpenClaw Gateway
 * calls to initialize the plugin.
 *
 * - Configures LRU cache from plugin configuration
 * - Registers six tools with explicit JSON schemas
 * - Registers four hook handlers
 * - Registers CLI commands (if api.registerCli available)
 *
 * SECURITY MANIFEST:
 *   Environment variables accessed: OPENCLAW_WORKSPACE (via state module)
 *   External endpoints called: none (tools may call out to LLMs or memory_search)
 *   Local files read: CONTEXT_PERSISTENCE.md, memory/** / *.md (globs)
 *   Local files written: CONTEXT_PERSISTENCE.md
 */

const toolsModule = require('./tools');
const state = require('./lib/state');

// Plugins may be reloaded in same process; guard against double registration
let alreadyRegistered = false;

module.exports = function register(api) {
  if (alreadyRegistered) {
    api.log?.warn?.('[context-persistence] Already registered, skipping');
    return;
  }
  alreadyRegistered = true;

  try {
    api.log?.info?.('[context-persistence] Registering plugin (v2.2.0)');

    // =====================
    // 1. Configure Cache
    // =====================
    try {
      if (api.config) {
        const mapped = {
          max: api.config.cacheMax,
          ttlMs: api.config.cacheTTLms
        };
        // Remove undefined keys
        Object.keys(mapped).forEach(k => mapped[k] === undefined && delete mapped[k]);
        if (Object.keys(mapped).length > 0) {
          state.configureCache(mapped);
          // Also set plugin config for tools that need it
          state.setConfig(api.config);
          api.log?.info?.('[context-persistence] Cache configured:', mapped);
        } else {
          // Still set config even if no cache overrides
          state.setConfig(api.config);
        }
      } else {
        // Initialize with defaults
        state.setConfig({});
      }
    } catch (err) {
      api.log?.error?.('[context-persistence] Cache configuration failed:', err);
      // Continue registration; cache will use defaults
    }

    // =====================
    // 2. Register Tools
    // =====================
    const toolNames = [
      'context_persistence_read',
      'context_persistence_write',
      'context_persistence_discover',
      'cached_memory_search',
      'context_persistence_summarize',
      'context_persistence_prefetch'
    ];

    for (const toolName of toolNames) {
      try {
        const schema = toolsModule.schemas?.[toolName];
        const impl = toolsModule[toolName];

        if (!schema) {
          api.log?.warn?.(`[context-persistence] Missing schema for tool: ${toolName}`);
          continue;
        }
        if (!impl) {
          api.log?.warn?.(`[context-persistence] Missing implementation for tool: ${toolName}`);
          continue;
        }

        // Optional tools: summarize and prefetch (may not be usable if LLM or prefetch disabled)
        const options = {};
        if (toolName === 'context_persistence_summarize' || toolName === 'context_persistence_prefetch') {
          options.optional = true;
        }

        api.registerTool(schema, impl, options);
        api.log?.debug?.(`[context-persistence] Registered tool: ${toolName}`);
      } catch (err) {
        api.log?.error?.(`[context-persistence] Failed to register tool ${toolName}:`, err);
        // Continue with other tools
      }
    }

    // =====================
    // 3. Register Hooks
    // =====================
    const hookRegistrations = [
      { name: 'pre-compaction', fn: require('./hooks/preCompaction'), opts: { name: 'context-persistence.pre-compaction', description: 'Auto-save state before compaction' } },
      { name: 'post-compaction', fn: require('./hooks/postCompaction'), opts: { name: 'context-persistence.post-compaction', description: 'Inject context anchor after compaction' } },
      { name: 'session-start', fn: require('./hooks/sessionStart'), opts: { name: 'context-persistence.session-start', description: 'Inject state summary on session start' } },
      { name: 'shutdown', fn: require('./hooks/shutdown'), opts: { name: 'context-persistence.shutdown', description: 'Log cache statistics on shutdown' } }
    ];

    for (const { name: hookName, fn, opts } of hookRegistrations) {
      try {
        if (typeof fn === 'function') {
          api.registerHook(hookName, fn, opts);
          api.log?.debug?.(`[context-persistence] Registered hook: ${hookName}`);
        } else {
          api.log?.warn?.(`[context-persistence] Hook ${hookName} is not a function`);
        }
      } catch (err) {
        api.log?.error?.(`[context-persistence] Failed to register hook ${hookName}:`, err);
      }
    }

    // =====================
    // 4. Register CLI
    // =====================
    if (typeof api.registerCli === 'function') {
      try {
        const registerCommands = require('./cli/commands');
        // Register commands with explicit command names for CLI overlap detection
        api.registerCli(
          ({ program }) => {
            registerCommands(program);
          },
          { commands: ['context-persistence'] }
        );
        api.log?.info?.('[context-persistence] CLI commands registered');
      } catch (err) {
        api.log?.error?.('[context-persistence] Failed to register CLI:', err);
      }
    } else {
      api.log?.debug?.('[context-persistence] API does not provide registerCli; CLI commands not available');
    }

    api.log?.info?.('[context-persistence] Plugin registration complete');
  } catch (err) {
    api.log?.error?.('[context-persistence] Registration fatal error:', err);
    // Do not throw; allow Gateway to continue loading other plugins
  }
};
