#!/usr/bin/env node
/**
 * Post-compaction Hook (v2.2.0)
 *
 * Runs after compaction completes. Older messages have been removed from active context.
 * We inject a system message with a context anchor to preserve continuity.
 *
 * Enhancement:
 *   - Uses context_anchor field if present in CONTEXT_PERSISTENCE.md
 *   - Falls back to conversation_summary if context_anchor missing
 *   - If neither present, calls context_persistence_summarize to generate one
 *   - Applies truncateAnchor to ensure token budget compliance
 *
 * Context:
 *   - session: session object (we can add system messages)
 *   - agent: agent instance with tools
 *
 * SECURITY MANIFEST:
 *   Environment variables accessed: none
 *   External endpoints called: LLM tool (if summarization needed)
 *   Local files read: CONTEXT_PERSISTENCE.md
 *   Local files written: CONTEXT_PERSISTENCE.md (if generating new anchor)
 */

const fs = require('fs');
const DEBUG_LOG = '/tmp/context-persistence-post-compaction.log';
function dbg(msg) {
  try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch (e) {}
}
dbg('=== post-compaction hook invoked ===');

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
    ctx.log?.error?.('[context-persistence] post-compaction:', msg);
    dbg('FATAL: ' + msg);
    dbg('hook complete: fatal destructure error');
    return { ok: false, error: msg };
  }

  try {
    let stateObj = await readState();
    dbg('state read: ' + (stateObj ? 'exists' : 'null'));

    if (!stateObj) {
      ctx.log?.info?.('[context-persistence] post-compaction: no state file found');
      dbg('skipped: no_state_file');
      return { ok: true, skipped: 'no_state_file' };
    }

    dbg('state fields: project=' + (stateObj.project||'') + ', task=' + (stateObj.task||'') + ', hasAnchor=' + !!(stateObj.context_anchor||stateObj.conversation_summary));

    // Determine anchor content
    let anchor = stateObj.context_anchor || stateObj.conversation_summary || null;

    // If no anchor, attempt to generate one using context_persistence_summarize
    if (!anchor) {
      // Check if we have tools context available
      if (agent?.tools) {
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
          ctx.log?.warn?.('[context-persistence] post-compaction: summarization failed:', summarizeError.message);
          // Fall through to use existing state fields
        }
      } else {
        dbg('agent.tools not available, skipping summarization');
        ctx.log?.info?.('[context-persistence] post-compaction: agent.tools not available, skipping summarization');
      }
    }

    // If we still have no anchor, build one from state fields
    if (!anchor) {
      const parts = [];
      if (stateObj.project) parts.push(`project: ${stateObj.project}`);
      if (stateObj.task) parts.push(`task: ${stateObj.task}`);
      if (stateObj.status) parts.push(`status: ${stateObj.status}`);
      if (stateObj.next_steps && Array.isArray(stateObj.next_steps) && stateObj.next_steps.length > 0) {
        const steps = stateObj.next_steps.slice(0, 3).join('; ');
        parts.push(`next: ${steps}`);
      }

      if (parts.length === 0) {
        ctx.log?.info?.('[context-persistence] post-compaction: state is empty, skipping injection');
        dbg('skipped: empty_state');
        return { ok: true, skipped: 'empty_state' };
      }

      anchor = parts.join(' | ');
      dbg('fallback anchor assembled, length=' + anchor.length);
    }

    // Apply truncation to enforce token budget (default 2000 tokens ≈ 8000 chars)
    const truncatedAnchor = truncateAnchor(anchor, 2000);
    const reminder = `[State Anchor] ${truncatedAnchor}`;
    dbg('injecting reminder (truncated length=' + truncatedAnchor.length + ')');

    // Inject as a system message
    let injected = false;
    let method = null;
    if (typeof session.addSystemMessage === 'function') {
      await session.addSystemMessage(reminder);
      method = 'addSystemMessage';
      injected = true;
    } else if (typeof session.push === 'function') {
      await session.push({ role: 'system', content: reminder });
      method = 'push';
      injected = true;
    } else if (typeof session.pushMessage === 'function') {
      await session.pushMessage({ role: 'system', content: reminder });
      method = 'pushMessage';
      injected = true;
    } else {
      ctx.log?.warn?.('[context-persistence] post-compaction: session object has no message injection method');
      dbg('injection failed: no method');
      return { ok: false, error: 'session_api_mismatch' };
    }

    dbg('injected via method: ' + method);
    ctx.log?.info?.('[context-persistence] post-compaction: anchor injected');
    dbg('hook complete: ok=true');
    return { ok: true, action: 'injected', anchorLength: truncatedAnchor.length };
  } catch (err) {
    ctx.log?.error?.('post-compaction error:', err);
    dbg('hook complete: ok=false, error=' + err.message);
    return { ok: false, error: err.message };
  }
};
