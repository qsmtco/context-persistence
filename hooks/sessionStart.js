#!/usr/bin/env node
/**
 * Session-start Hook (v2.2.0)
 *
 * Runs when a new session begins (after gateway restart or new conversation).
 * Reads CONTEXT_PERSISTENCE.md and injects a summary into the initial context
 * so the agent immediately knows what it was working on.
 *
 * Enhancement:
 *   - Uses context_anchor field if present
 *   - Falls back to conversation_summary if context_anchor missing
 *   - Applies truncateAnchor to ensure token budget compliance
 *   - Uses cached_memory_search for snippet gathering (if summarization needed)
 *
 * Context:
 *   - session: the new session object
 *   - agent: agent instance with tools
 *
 * If state file is missing or stale (>24h), we skip injection.
 *
 * SECURITY MANIFEST:
 *   Environment variables accessed: none
 *   External endpoints called: LLM tool (if summarization needed)
 *   Local files read: CONTEXT_PERSISTENCE.md
 *   Local files written: CONTEXT_PERSISTENCE.md (if generating new anchor)
 */

const fs = require('fs');
const DEBUG_LOG = '/tmp/context-persistence-session-start.log';
function dbg(msg) {
  try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch (e) {}
}
dbg('=== session-start hook invoked ===');

const state = require('../lib/state');
const { readState, writeState, truncateAnchor } = state;
const tools = require('../tools');

module.exports = async function (ctx) {
  // Safely extract session and agent with error logging
  let session = null, agent = null;
  try {
    if (!ctx) throw new Error('ctx is undefined');
    ({ session, agent } = ctx);
    dbg('hook start: session keys=' + (session ? Object.keys(session).join(',') : 'null') + ', agent.tools=' + (agent?.tools ? 'available' : 'null'));
  } catch (e) {
    const msg = 'Destructure failed: ' + e.message;
    ctx.log?.error?.('[context-persistence] session-start:', msg);
    dbg('FATAL: ' + msg);
    dbg('hook complete: fatal destructure error');
    return { ok: false, error: msg };
  }

  try {
    let stateObj = await readState();
    dbg('state read: ' + (stateObj ? 'exists' : 'null'));

    if (!stateObj) {
      ctx.log?.info?.('[context-persistence] session-start: no state file found');
      dbg('skipped: no_state_file');
      return { ok: true, skipped: 'no_state_file' };
    }

    dbg('state fields: project=' + (stateObj.project||'') + ', task=' + (stateObj.task||'') + ', updated=' + (stateObj.updated||''));

    // Check freshness: skip if >24 hours old
    if (stateObj.updated) {
      const updated = new Date(stateObj.updated);
      const ageHours = (Date.now() - updated.getTime()) / (1000 * 60 * 60);
      dbg('state age: ' + ageHours.toFixed(2) + ' hours');
      if (ageHours > 24) {
        ctx.log?.info?.(`[context-persistence] session-start: state is stale (${ageHours.toFixed(1)}h old), skipping injection`);
        dbg('skipped: stale_state');
        return { ok: true, skipped: 'stale_state', ageHours };
      }
    }

    // Determine anchor content
    let anchor = stateObj.context_anchor || stateObj.conversation_summary || null;
    dbg('anchor source: ' + (anchor ? 'existing field' : 'none'));

    // If no anchor and agent.tools available, attempt to generate one
    if (!anchor && agent?.tools) {
      try {
        dbg('attempting summarization via context_persistence_summarize');
        const result = await tools.context_persistence_summarize(
          { tools: agent.tools, log: ctx.log },
          { writeToState: true }
        );
        anchor = result.anchor;
        dbg('summarization succeeded, anchor length=' + anchor.length);

        // Re-read state to get updated context_anchor
        stateObj = await readState();
      } catch (summarizeError) {
        dbg('summarization failed: ' + summarizeError.message);
        ctx.log?.warn?.('[context-persistence] session-start: summarization failed:', summarizeError.message);
      }
    } else if (!anchor) {
      dbg('no agent.tools available, skipping summarization');
    }

    // If we still have no anchor, build one from state fields
    if (!anchor) {
      const parts = [];
      if (stateObj.project) parts.push(`Project: ${stateObj.project}`);
      if (stateObj.task) parts.push(`Task: ${stateObj.task}`);
      if (stateObj.status) parts.push(`Status: ${stateObj.status}`);
      if (stateObj.next_steps && Array.isArray(stateObj.next_steps) && stateObj.next_steps.length > 0) {
        const steps = stateObj.next_steps.slice(0, 3).join('; ');
        parts.push(`Next: ${steps}`);
      }

      if (parts.length === 0) {
        ctx.log?.info?.('[context-persistence] session-start: state is empty, skipping injection');
        dbg('skipped: empty_state');
        return { ok: true, skipped: 'empty_state' };
      }

      anchor = parts.join(' | ');
      dbg('fallback anchor assembled, length=' + anchor.length);
    }

    // Apply truncation
    const truncatedAnchor = truncateAnchor(anchor, 2000);
    const summary = `[Resume] ${truncatedAnchor}`;
    dbg('injecting summary (truncated length=' + truncatedAnchor.length + ')');

    // Inject as early system message
    let injected = false;
    let method = null;
    if (typeof session.addSystemMessage === 'function') {
      await session.addSystemMessage(summary);
      method = 'addSystemMessage';
      injected = true;
    } else if (typeof session.push === 'function') {
      await session.push({ role: 'system', content: summary });
      method = 'push';
      injected = true;
    } else if (typeof session.pushMessage === 'function') {
      await session.pushMessage({ role: 'system', content: summary });
      method = 'pushMessage';
      injected = true;
    } else {
      ctx.log?.warn?.('[context-persistence] session-start: session object has no message injection method');
      dbg('injection failed: no method');
      return { ok: false, error: 'session_api_mismatch' };
    }

    dbg('injected via method: ' + method);
    ctx.log?.info?.('[context-persistence] session-start: state injected');

    // Prefetch queries if configured (Phase 4)
    const config = state.getConfig();
    const queries = config?.prefetchQueries;
    if (config?.enablePrefetch && Array.isArray(queries) && queries.length > 0) {
      const prefetchFn = ctx.tools?.cached_memory_search;
      if (typeof prefetchFn !== 'function') {
        ctx.log?.warn?.('[context-persistence] session-start: cached_memory_search tool not available, skipping prefetch');
      } else {
        ctx.log?.info?.('[context-persistence] session-start: prefetching', queries.length, 'queries');
        try {
          const results = await Promise.allSettled(queries.map(q => prefetchFn({ query: q })));
          let successCount = 0;
          results.forEach((r, i) => {
            if (r.status === 'fulfilled') {
              successCount++;
            } else {
              ctx.log?.debug?.('[context-persistence] session-start: prefetch query failed:', queries[i], r.reason?.message);
            }
          });
          ctx.log?.info?.('[context-persistence] session-start: prefetch complete -', successCount, '/', queries.length, 'succeeded');
        } catch (err) {
          ctx.log?.error?.('[context-persistence] session-start: prefetch failed unexpectedly:', err.message);
        }
      }
    }

    dbg('hook complete: ok=true');
    return { ok: true, action: 'injected', anchorLength: truncatedAnchor.length };
  } catch (err) {
    ctx.log?.error?.('session-start error:', err.message);
    dbg('hook complete: ok=false, error=' + err.message);
    return { ok: false, error: err.message };
  }
};
