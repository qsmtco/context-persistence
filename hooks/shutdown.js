#!/usr/bin/env node
/**
 * Shutdown Hook (v2.2.0)
 *
 * Runs when OpenClaw Gateway is shutting down (SIGTERM, SIGINT).
 * Logs cache statistics for diagnostics and performs any cleanup needed.
 *
 * Note: State file writes are already atomic, so no explicit flush needed.
 * Cache is per-process and transient by design.
 *
 * Context:
 *   - agent: agent instance
 *
 * SECURITY MANIFEST:
 *   Environment variables accessed: none
 *   External endpoints called: none
 *   Local files read: none
 *   Local files written: none
 */

const state = require('../lib/state');
const { getCacheStats } = state;

module.exports = async function (ctx) {
  try {
    // Log cache stats for diagnostics
    const stats = getCacheStats();

    ctx.log?.info?.('[context-persistence] shutdown: cache statistics:');
    ctx.log?.info?.(`  - Size: ${stats.size}/${stats.max} entries`);
    ctx.log?.info?.(`  - TTL: ${stats.ttl}ms`);
    if (stats.keys && stats.keys.length > 0) {
      ctx.log?.info?.(`  - Sample keys: ${stats.keys.slice(0, 3).map(k => k.substring(0, 30) + '...').join(', ')}`);
    }

    // Log completion
    ctx.log?.info?.('[context-persistence] shutdown complete');

    return { ok: true, stats };
  } catch (err) {
    ctx.log?.error?.('[context-persistence] shutdown error:', err.message);
    return { ok: false, error: err.message };
  }
};
