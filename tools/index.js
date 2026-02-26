const state = require('../lib/state');
const fs = require('fs');

/**
 * Context Persistence Plugin - Tool Implementations and Schemas
 *
 * Tool names (snake_case):
 * - context_persistence_read
 * - context_persistence_write
 * - context_persistence_discover
 * - cached_memory_search
 * - context_persistence_summarize
 * - context_persistence_prefetch
 *
 * All tools are registered via api.registerTool(schema, options).
 *
 * SECURITY MANIFEST:
 *   Environment variables accessed: OPENCLAW_WORKSPACE (via state module)
 *   External endpoints called: memory_search, LLM tools
 *   Local files read: CONTEXT_PERSISTENCE.md, memory/** / *.md (for mtime validation)
 *   Local files written: CONTEXT_PERSISTENCE.md
 */

// =====================
// Tool Schemas
// =====================

const Schemas = {
  context_persistence_read: {
    name: "context_persistence_read",
    description: "Read the current CONTEXT_PERSISTENCE.md contents including frontmatter fields and body",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },

  context_persistence_write: {
    name: "context_persistence_write",
    description: "Update one or more fields in CONTEXT_PERSISTENCE.md. Validates against schema and automatically updates the 'updated' timestamp. Partial updates are merged with existing state.",
    parameters: {
      type: "object",
      properties: {
        version: { type: "string" },
        project: { type: "string" },
        task: { type: "string" },
        status: {
          type: "string",
          enum: ["active", "blocked", "done", "in-progress"]
        },
        last_action: { type: "string" },
        next_steps: {
          type: "array",
          items: { type: "string" }
        },
        body: { type: "string" },
        context_anchor: { type: "string" },
        conversation_summary: { type: "string" },
        artifact_refs: {
          type: "array",
          items: { type: "string" }
        }
      },
      additionalProperties: false,
      minProperties: 1
    }
  },

  context_persistence_discover: {
    name: "context_persistence_discover",
    description: "Discover current project/task state from session transcripts using memory_search. Automatically writes discovered state to CONTEXT_PERSISTENCE.md. Returns synthesized state with _meta information.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 100, default: 10 },
        minScore: { type: "number", minimum: 0, maximum: 1, default: 0.3 },
        query: { type: "string", default: "project|task|working on|next step|implementing|building" }
      },
      additionalProperties: false
    }
  },

  cached_memory_search: {
    name: "cached_memory_search",
    description: "LRU-cached wrapper around memory_search. Returns cached results when valid; otherwise calls memory_search and caches results with file mtime tracking for invalidation. Accepts the same parameters as memory_search.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
        limit: { type: "number", minimum: 1, maximum: 100, default: 10 },
        minScore: { type: "number", minimum: 0, maximum: 1, default: 0.3 },
        sources: {
          type: "array",
          items: { type: "string" },
          default: ["memory", "sessions"]
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },

  context_persistence_summarize: {
    name: "context_persistence_summarize",
    description: "Generate a concise context anchor (≤2000 tokens) using an LLM. Reads current state, gathers recent snippets via cached_memory_search, and produces a factual summary. Optionally writes anchor to state. This tool is optional and requires an LLM tool (chat_completion, generate, llm, or openai) to be available.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Query to use for snippet gathering; defaults to current task" },
        maxTokens: { type: "number", default: 2000, minimum: 100, maximum: 4000 },
        writeToState: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },

  context_persistence_prefetch: {
    name: "context_persistence_prefetch",
    description: "Prefetch queries to warm the cache. Calls cached_memory_search for each query in parallel. Optionally used by the session-start hook. This tool is optional.",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          minItems: 1
        }
      },
      required: ["queries"],
      additionalProperties: false
    }
  }
};

// =====================
// Tool Implementations
// =====================

/**
 * Read the current CONTEXT_PERSISTENCE.md
 * @param {object} ctx - tool context
 * @param {object} args - arguments (none)
 * @returns {Promise<object>} state object including frontmatter fields and body
 */
async function context_persistence_read(ctx, args) {
  const stateObj = await state.readState();
  if (!stateObj) {
    throw new Error('CONTEXT_PERSISTENCE.md does not exist or is empty. Use context_persistence_write to create it.');
  }
  return stateObj;
}

/**
 * Update one or more fields in CONTEXT_PERSISTENCE.md.
 * Automatically updates `updated` timestamp unless provided.
 * Validates against schema before writing.
 *
 * @param {object} ctx - tool context
 * @param {object} args - partial state updates, e.g., { "task": "New task", "status": "active" }
 * @returns {Promise<object>} { success: true, fields: [...], updated: "ISO timestamp", path: "..." }
 */
async function context_persistence_write(ctx, args) {
  if (!args || typeof args !== 'object' || Object.keys(args).length === 0) {
    throw new Error('context_persistence_write requires at least one field to update');
  }

  // Ensure body is a string if provided
  if (args.body !== undefined && typeof args.body !== 'string') {
    throw new Error('field "body" must be a string if provided');
  }

  const result = await state.writeState(args, { validate: true });
  return {
    success: true,
    fields: Object.keys(args),
    updated: result.updated,
    path: result.path
  };
}

/**
 * Discover current state from session transcripts using memory_search.
 * Useful when CONTEXT_PERSISTENCE.md is missing or you want to recover recent context.
 * Automatically writes discovered state to the file.
 *
 * @param {object} ctx - tool context (provides memory_search)
 * @param {object} args - optional overrides: { limit?, minScore?, query? }
 * @returns {Promise<object>} synthesized state object with _meta
 */
async function context_persistence_discover(ctx, args) {
  const memorySearch = ctx.tools?.memory_search;
  if (!memorySearch) {
    throw new Error('memory_search tool not available. Ensure session transcript indexing is enabled.');
  }

  const limit = args?.limit ?? 10;
  const minScore = args?.minScore ?? 0.3;
  const query = args?.query ?? 'project|task|working on|next step|implementing|building';

  try {
    const stateObj = await state.discoverFromSessions(memorySearch, { limit, minScore, query });
    // Write automatically (discoverFromSessions already writes, but we'll be explicit)
    const writeResult = await state.writeState(stateObj, { validate: false });
    return {
      ...stateObj,
      _meta: {
        action: 'discovered',
        limit,
        minScore,
        query,
        written: writeResult.success,
        updated: writeResult.updated
      }
    };
  } catch (err) {
    throw new Error(`context_persistence_discover failed: ${err.message}`);
  }
}

/**
 * Cached memory_search tool.
 * Wraps native memory_search with LRU cache and mtime-based invalidation.
 *
 * @param {object} ctx - Tool context
 * @param {object} args - Search arguments {query, limit?, minScore?, sources?}
 * @returns {Promise<Array>} Search results with enriched _cachedMtime
 */
async function cached_memory_search(ctx, args) {
  // Validate required argument
  if (!args || !args.query) {
    throw new Error('cached_memory_search requires a "query" argument');
  }

  const cache = state.getCache();
  // Handle cache disabled (null)
  if (!cache) {
    const tool = ctx.tools?.memory_search;
    if (!tool) {
      throw new Error('memory_search tool not available in context');
    }
    const results = await tool(args, ctx);
    return results || [];
  }

  const key = JSON.stringify(state.normalizeCacheKey(args));

  // Attempt cache lookup
  const cached = cache.get(key);

  if (cached) {
    // Validate against file mtimes
    const valid = state.isCacheValid(cached.results);

    if (valid) {
      if (ctx.log?.debug) ctx.log.debug(`[cached_memory_search] cache hit (valid) for query: "${args.query.substring(0, 50)}..."`);
      return cached.results;
    }

    // Stale entry: evict and proceed to miss
    if (ctx.log?.debug) ctx.log.debug('[cached_memory_search] cache stale (mtimes changed); evicting');
    cache.delete(key);
  }

  // Cache miss or stale: call underlying tool
  const tool = ctx.tools?.memory_search;
  if (!tool) {
    throw new Error('memory_search tool not available in context');
  }

  ctx.log?.debug?.(`[cached_memory_search] cache miss for query: "${args.query.substring(0, 50)}..."`);
  const results = await tool(args, ctx);

  // Handle null/undefined results
  if (!results) {
    return [];
  }

  // Enrich results with current file mtimes
  const enrichedResults = results.map(result => ({
    ...result,
    _cachedMtime: result.file
      ? (() => {
          try {
            return fs.statSync(result.file).mtimeMs;
          } catch {
            return undefined;
          }
        })()
      : undefined
  }));

  // Store in cache with metadata
  const cacheEntry = {
    results: enrichedResults,
    cachedAt: Date.now(),
    sourceFiles: enrichedResults.map(r => r.file).filter(Boolean),
    sourceMtimes: {}
  };

  cache.set(key, cacheEntry);
  ctx.log?.debug?.('[cached_memory_search] cache store');

  return enrichedResults;
}

/**
 * Generate a concise context anchor using LLM summarization.
 * Creates a ≤2000-word summary of current project state.
 *
 * @param {object} ctx - Tool context
 * @param {object} args - Options {query?, maxTokens?, writeToState?}
 * @returns {Promise<object>} {anchor, generated_at, snippet_count}
 */
async function context_persistence_summarize(ctx, args = {}) {
  // Read current state
  const currentState = await state.readState();
  if (!currentState) {
    throw new Error('Cannot generate anchor: CONTEXT_PERSISTENCE.md does not exist. Use context_persistence_write or context_persistence_discover first.');
  }

  // Gather recent snippets using cached search
  const query = args.query || currentState.task || 'recent conversation';
  const searchArgs = {
    query,
    limit: 10,
    minScore: 0.2
  };

  const snippetsResult = await cached_memory_search(ctx, searchArgs);
  const snippets = snippetsResult
    .slice(0, 5)
    .map(r => r.content || r.snippet || r.text || '');

  // Build summarization prompt
  const prompt = `
You are a summary generator for a project tracker.
Project: ${currentState.project || 'Unknown'}
Task: ${currentState.task || 'Unknown'}
Status: ${currentState.status || 'active'}

Recent conversation snippets:
${snippets.length ? snippets.map((s, i) => `${i + 1}. ${s}`).join('\n') : '(none)'}

Instructions:
- Write one paragraph (max ${args.maxTokens || 2000} tokens) that captures the essential state of the project.
- Include: objective, current progress, blockers, next steps.
- Be concise and factual.
`.trim();

  // Find available LLM tool
  const llmTool = ctx.tools?.chat_completion
    || ctx.tools?.generate
    || ctx.tools?.llm
    || ctx.tools?.openai;

  if (!llmTool) {
    throw new Error('No LLM tool available for summarization. Expected one of: chat_completion, generate, llm, openai');
  }

  // Enforce 10-second timeout
  const { setTimeout } = require('timers');
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('LLM summarization timeout (10s)')), 10000)
  );

  const llmPromise = llmTool({
    prompt,
    max_tokens: args.maxTokens || 2000,
    temperature: 0.5
  }, ctx);

  const response = await Promise.race([llmPromise, timeoutPromise]);

  // Extract anchor text (handle various response formats)
  let anchor;
  if (typeof response === 'string') {
    anchor = response;
  } else if (response.text) {
    anchor = response.text;
  } else if (response.content) {
    anchor = response.content;
  } else if (response.message?.content) {
    anchor = response.message.content;
  } else if (response.choices?.[0]?.message?.content) {
    anchor = response.choices[0].message.content;
  } else {
    anchor = String(response);
  }

  // Quality validation
  if (anchor.length < 20) {
    ctx.log?.warn?.('[context_persistence_summarize] Anchor too short (<20 chars), may be low quality');
  }

  // Check for refusal phrases
  const refusalPhrases = ['I cannot', "I'm unable", 'I apologize', 'As an AI', 'I am not able'];
  if (refusalPhrases.some(phrase => anchor.includes(phrase))) {
    ctx.log?.warn?.('[context_persistence_summarize] Anchor contains refusal phrase, quality may be degraded');
  }

  // Optionally write anchor to state
  if (args.writeToState !== false) {
    try {
      await state.writeState({
        context_anchor: anchor.trim()
      }, { validate: false });
    } catch (writeError) {
      ctx.log?.warn?.(`[context_persistence_summarize] Failed to write anchor to state: ${writeError.message}`);
    }
  }

  return {
    anchor: anchor.trim(),
    generated_at: new Date().toISOString(),
    snippet_count: snippets.length
  };
}

/**
 * Prefetch queries to warm the cache.
 * Useful for loading anticipated queries before a session.
 *
 * @param {object} ctx - Tool context
 * @param {object} args - {queries: string[]}
 * @returns {Promise<object>} {prefetched: {query, ok, error?}[]}
 */
async function context_persistence_prefetch(ctx, args) {
  const { queries = [] } = args || {};

  if (!Array.isArray(queries)) {
    throw new Error('context_persistence_prefetch requires "queries" to be an array');
  }

  if (queries.length === 0) {
    return { prefetched: [] };
  }

  const results = [];

  for (const query of queries) {
    try {
      // Use default cache-friendly parameters
      await cached_memory_search(ctx, {
        query,
        limit: 5,
        minScore: 0.3
      });

      results.push({ query, ok: true });
    } catch (error) {
      results.push({
        query,
        ok: false,
        error: error.message
      });
    }
  }

  const successCount = results.filter(r => r.ok).length;
  if (ctx.log?.debug) ctx.log.debug?.(`[context_persistence_prefetch] Prefetched ${successCount}/${queries.length} queries`);

  return { prefetched: results };
}

/**
 * Internal cache statistics for debugging.
 * @returns {object} Cache metrics
 */
function _cacheStats() {
  return state.getCacheStats();
}

// =====================
// Module Exports
// =====================

module.exports = {
  // Schemas for tool registration
  schemas: Schemas,

  // Tool implementations
  context_persistence_read,
  context_persistence_write,
  context_persistence_discover,
  cached_memory_search,
  context_persistence_summarize,
  context_persistence_prefetch,

  // Internal
  _cacheStats
};
