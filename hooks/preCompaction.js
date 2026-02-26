#!/usr/bin/env node
/**
 * Pre-compaction Hook (v2.2.0)
 *
 * Runs just before compaction begins. Persists current state by updating
 * the `updated` timestamp. Does not throw errors; logs and continues.
 *
 * Context:
 *   - log: logging interface
 *
 * SECURITY MANIFEST:
 *   Environment variables accessed: none
 *   External endpoints called: none
 *   Local files read: CONTEXT_PERSISTENCE.md
 *   Local files written: CONTEXT_PERSISTENCE.md
 */

const state = require('../lib/state');

module.exports = async function (ctx) {
  try {
    // Read current state to ensure file exists
    const current = await state.readState();
    if (!current) {
      ctx.log?.debug?.('[context-persistence] pre-compaction: no state file, skipping');
      return { ok: true, skipped: 'no_state' };
    }

    // Write state with updated timestamp (writeState auto-updates 'updated')
    await state.writeState({});
    ctx.log?.info?.('[context-persistence] pre-compaction: state saved');
    return { ok: true, action: 'saved' };
  } catch (err) {
    ctx.log?.error?.('pre-compaction failed:', err);
    // Do not throw; allow Gateway to continue
    return { ok: false, error: err.message };
  }
};
