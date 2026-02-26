#!/usr/bin/env node
/**
 * Context Persistence - Core Module (v2.2.0)
 *
 * Provides utilities for reading, writing, and discovering session state
 * from CONTEXT_PERSISTENCE.md and indexed session transcripts.
 *
 * v2.1.0 Additions:
 * - LRU cache for memory_search results with TTL and mtime invalidation
 * - State file versioning for forward compatibility
 * - Anchor truncation for token budget management
 * - Cache statistics and configuration
 *
 * SECURITY MANIFEST:
 *   Environment variables accessed: OPENCLAW_WORKSPACE (optional)
 *   External endpoints called: none
 *   Local files read: CONTEXT_PERSISTENCE.md, memory/** / *.md (for mtime validation)
 *   Local files written: CONTEXT_PERSISTENCE.md (atomic)
 *
 * This module is used by hook scripts, CLI, and tool wrappers.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// =====================
// Cache Infrastructure
// =====================

/**
 * Try to load lru-cache, fallback to no-op if unavailable.
 */
let LRUCache;
try {
  LRUCache = require('lru-cache').LRUCache;
} catch (err) {
  console.warn('[session-state-tracker] lru-cache not available, using no-op cache');
  LRUCache = null;
}

/**
 * Cache configuration with defaults.
 */
let cacheConfig = {
  max: 100, // Maximum number of entries (count-based)
  ttlMs: 300000 // 5 minutes
};

/**
 * Plugin configuration (from OpenClaw api.config)
 */
let pluginConfig = {};

/**
 * Cache instance (module-global, shared across sessions in same process).
 * @type {LRU|null}
 */
let memoryCache = null;

/**
 * Get or initialize the LRU cache instance.
 * Falls back to no-op cache if LRU unavailable or init fails.
 * @returns {LRU|object}
 */
function getCache() {
  if (memoryCache) return memoryCache;

  try {
    if (!LRUCache) {
      throw new Error('lru-cache module not loaded');
    }

    memoryCache = new LRUCache({
      max: cacheConfig.max,
      ttl: cacheConfig.ttlMs,
      disposeAfter: (value, key, reason) => {
        console.log(`[session-state-tracker] Cache evicted: ${key.substring(0, 50)}... (reason: ${reason})`);
      }
    });

  } catch (error) {
    console.error('[session-state-tracker] Failed to initialize LRU cache:', error.message);
    console.warn('[session-state-tracker] Using no-op cache as fallback');

    // Fallback no-op cache
    memoryCache = {
      set: () => false,
      get: () => null,
      del: () => false,
      clear: () => {},
      size: () => 0,
      keys: () => [],
      max: 0,
      ttl: 0
    };
  }

  return memoryCache;
}

/**
 * Update cache configuration at runtime.
 * Recreates cache if max entries changed.
 * @param {object} cfg - {max?, ttlMs?, sizeCalculationEnabled?}
 */
function configureCache(cfg) {
  // Merge with existing config, ignoring undefined values
  for (const key of Object.keys(cfg)) {
    if (cfg[key] !== undefined) {
      cacheConfig[key] = cfg[key];
    }
  }

  // Enforce minimum max
  if (cacheConfig.max < 1) {
    cacheConfig.max = 1;
  }

  // If cache already initialized, recreate with new config if max changed
  if (memoryCache && cacheConfig.max !== memoryCache.max) {
    try {
      memoryCache = new LRUCache({
        max: cacheConfig.max,
        ttl: cacheConfig.ttlMs,
        disposeAfter: (value, key, reason) => {
          console.log(`[session-state-tracker] Cache evicted: ${key.substring(0, 50)}... (reason: ${reason})`);
        }
      });
      console.log('[session-state-tracker] Cache reconfigured and recreated');
    } catch (error) {
      console.error('[session-state-tracker] Failed to reconfigure cache:', error.message);
    }
  }
}

/**
 * Normalize memory_search arguments to create stable cache keys.
 * @param {object} args - memory_search arguments
 * @returns {object} Normalized arguments object
 */
function normalizeCacheKey(args) {
  return {
    query: (args.query || '').trim(),
    limit: Number(args.limit) || 10,
    minScore: Number(args.minScore) || 0.3,
    sources: Array.isArray(args.sources)
      ? [...args.sources].sort()
      : ['memory', 'sessions']
  };
}

/**
 * Truncate anchor text to fit within token budget.
 * Rough estimate: 1 token ≈ 4 characters.
 * @param {string} anchor - Anchor text to truncate
 * @param {number} maxTokens - Maximum tokens (default 2000)
 * @returns {string} Truncated anchor
 */
function truncateAnchor(anchor, maxTokens = 2000) {
  if (!anchor) return '';

  const maxChars = maxTokens * 4;

  if (anchor.length <= maxChars) return anchor;

  // Truncate and add ellipsis
  return anchor.slice(0, maxChars) + '...';
}

/**
 * Check if cached results are still valid by comparing source file mtimes.
 * @param {Array} cachedResults - Results from cache with enriched _cachedMtime
 * @returns {boolean} true if cache is valid, false if stale
 */
function isCacheValid(cachedResults) {
  if (!cachedResults || !Array.isArray(cachedResults)) {
    return false;
  }

  // Check each result's file mtime
  for (const result of cachedResults) {
    if (result.file) {
      try {
        const currentMtime = fs.statSync(result.file).mtimeMs;
        const cachedMtime = result._cachedMtime;

        // If file modified since caching, entry is stale
        if (cachedMtime && currentMtime > cachedMtime) {
          console.log(`[session-state-tracker] Cache stale: file modified ${result.file}`);
          return false;
        }
      } catch (error) {
        // File deleted, unreadable, or permissions error - invalidate
        console.log(`[session-state-tracker] Cache stale: file error ${result.file} - ${error.message}`);
        return false;
      }
    }
  }

  return true;
}

/**
 * Get cache statistics for monitoring and diagnostics.
 * @returns {object} Cache statistics
 */
function getCacheStats() {
  const cache = getCache();

  return {
    size: typeof cache.size === 'function' ? cache.size() : (cache.size || 0),
    max: cacheConfig.max,
    ttl: cacheConfig.ttlMs,
    keys: cache.keys ? Array.from(cache.keys()).slice(0, 10) : []
  };
}

// =====================
// Workspace Resolution
// =====================

/**
 * Get the workspace directory from environment or cwd.
 * @returns {string}
 */
function getWorkspace() {
  return process.env.OPENCLAW_WORKSPACE || process.cwd();
}

/**
 * Get the absolute path to CONTEXT_PERSISTENCE.md.
 * @returns {string}
 */
function getStateFilePath() {
  return path.resolve(getWorkspace(), 'CONTEXT_PERSISTENCE.md');
}

// =====================
// Schema & Validation
// =====================

/**
 * State schema definition.
 * All fields are required unless marked optional.
 * v2.1.0: Added version field and extension fields.
 */
const SCHEMA = {
  version: { type: 'string', required: false }, // Schema version (default "2.0" if missing)
  project: { type: 'string', required: true },
  task: { type: 'string', required: true },
  status: { type: 'enum', values: ['active', 'blocked', 'done', 'in-progress'], required: true },
  last_action: { type: 'string', required: true },
  next_steps: { type: 'array', required: true },
  updated: { type: 'string', required: true }, // ISO 8601
  body: { type: 'string', required: false }, // freeform notes (optional in frontmatter, may be separate body section)
  // v2.1.0 Extension Fields (optional)
  context_anchor: { type: 'string', required: false },
  conversation_summary: { type: 'string', required: false },
  artifact_refs: { type: 'array', required: false },
  hot_cache_meta: { type: 'object', required: false }
};

/**
 * Validate a state object against schema.
 * Throws Error with detailed message if validation fails.
 * @param {object} state
 */
function validate(state) {
  const errors = [];

  for (const [field, rules] of Object.entries(SCHEMA)) {
    const value = state[field];

    // Required check
    if (rules.required && value === undefined) {
      errors.push(`missing required field: '${field}'`);
      continue;
    }

    if (value === undefined) continue; // skip optional fields that are absent

    // Type checks
    if (rules.type === 'string') {
      if (typeof value !== 'string') {
        errors.push(`field '${field}' must be string, got ${typeof value}`);
      } else if (value.trim() === '') {
        errors.push(`field '${field}' cannot be empty`);
      }
    } else if (rules.type === 'array') {
      if (!Array.isArray(value)) {
        errors.push(`field '${field}' must be array, got ${typeof value}`);
      }
    } else if (rules.type === 'enum') {
      if (!rules.values.includes(value)) {
        errors.push(`field '${field}' must be one of [${rules.values.join(', ')}], got '${value}'`);
      }
    } else if (rules.type === 'object') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`field '${field}' must be object, got ${typeof value}`);
      }
    }
  }

  // Additional cross-field validation
  if (state.updated && typeof state.updated === 'string') {
    const isoMatch = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(state.updated);
    if (!isoMatch) {
      errors.push(`field 'updated' must be valid ISO 8601 timestamp (e.g., 2026-02-14T23:20:00.000Z)`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`State validation failed: ${errors.join('; ')}`);
  }
}

// =====================
// File I/O
// =====================

/**
 * Parse YAML frontmatter and body from a Markdown file.
 * Uses js-yaml for robust parsing.
 * @param {string} content
 * @returns {{ frontmatter: object, body: string }}
 */
function parseFile(content) {
  // Split on '---' delimiter lines. We need at least: (content) --- fm --- body
  const parts = content.split(/^---$/m);
  if (parts.length < 3) {
    throw new Error('Invalid SESSION_STATE.md: missing YAML frontmatter delimiters (---)');
  }
  const fmStr = parts[1].trim();
  const body = parts.slice(2).join('---').trim(); // Rejoin in case body contains '---'

  try {
    const frontmatter = yaml.load(fmStr);
    if (!frontmatter || typeof frontmatter !== 'object') {
      throw new Error('Invalid YAML frontmatter: must be an object');
    }
    return { frontmatter, body };
  } catch (err) {
    err.message = `Failed to parse YAML frontmatter: ${err.message}`;
    throw err;
  }
}

/**
 * Read SESSION_STATE.md and return full state (frontmatter fields + body).
 * @returns {Promise<object|null>} state object or null if file doesn't exist
 */
async function readState() {
  const STATE_FILE = getStateFilePath();
  try {
    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = parseFile(content);
    return { ...parsed.frontmatter, body: parsed.body || '' };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Write SESSION_STATE.md with given updates.
 * Writes atomically via temp file + rename.
 * Preserves existing fields not mentioned in updates.
 * Always updates `updated` timestamp to current ISO unless explicitly provided.
 * v2.1.0: Adds version field automatically.
 *
 * @param {object} updates - partial state updates
 * @param {object} options - { validate: boolean (default true), dryRun: boolean }
 * @returns {Promise<{success: boolean, updated: string, path: string}>}
 */
async function writeState(updates, options = {}) {
  const { validate: doValidate = true, dryRun = false } = options;
  const STATE_FILE = getStateFilePath();

  const current = await readState() || {};
  const { body: currentBody, ...currentFm } = current;

  // Separate body from updates; remaining updatesFm are frontmatter
  const { body: updateBody, ...updatesFm } = updates;

  // Merge frontmatter
  const merged = { ...currentFm, ...updatesFm };
  // Ensure updated timestamp (override if provided)
  merged.updated = updates.updated || new Date().toISOString();
  // v2.1.0: Add version field
  merged.version = '2.1';

  // Determine final body
  const finalBody = updateBody !== undefined ? updateBody : currentBody;

  if (doValidate) {
    try {
      validate(merged);
    } catch (err) {
      err.message = `writeState validation error: ${err.message}`;
      throw err;
    }
  }

  // Reconstruct file
  const fmYaml = yaml.dump(merged, {
    lineWidth: -1, // no wrapping
    indent: 2,
    sortKeys: true // deterministic output
  });
  const output = `---\n${fmYaml}---\n${finalBody ? finalBody + '\n' : ''}`;

  if (dryRun) {
    console.log('[session-state-tracker] writeState (dryRun): would write:', output.substring(0, 200) + '...');
    return { success: true, updated: merged.updated, path: STATE_FILE };
  }

  // Atomic write: write to temp file then rename
  const tmpPath = STATE_FILE + '.tmp';
  try {
    // Ensure directory exists
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, output, 'utf-8');
    fs.renameSync(tmpPath, STATE_FILE); // atomic on POSIX filesystems
  } catch (err) {
    // Cleanup temp file on failure
    try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
    throw err;
  }

  return { success: true, updated: merged.updated, path: STATE_FILE };
}

// =====================
// Discovery
// =====================

/**
 * Discover current session state from indexed transcripts.
 * Uses memory_search on sessions to find recent mentions of project/task.
 *
 * @param {object} memorySearch - the memory_search tool function (injected)
 * @param {object} opts - { limit?: number, minScore?: number, query?: string }
 * @returns {Promise<object>} synthesized state object (includes body)
 */
async function discoverFromSessions(memorySearch, opts = {}) {
  const { limit = 10, minScore = 0.3, query = 'project|task|working on|next step|implementing|building' } = opts;

  try {
    const results = await memorySearch({
      query,
      sources: ['sessions'],
      limit,
      minScore
    });

    if (!results || results.length === 0) {
      return {
        project: '',
        task: '',
        status: 'active',
        last_action: '',
        next_steps: [],
        updated: new Date().toISOString(),
        body: 'Auto-discovered from session transcripts (no clear task found)'
      };
    }

    // Naive synthesis: take the top result's snippet as task hint
    const top = results[0];
    const snippet = (top.text || '').replace(/\n/g, ' ').substring(0, 200);
    const projectMatch = snippet.match(/(?:project|working on)\s+([A-Za-z0-9_-]+)/i);
    const taskMatch = snippet.match(/(?:task|implementing|building)\s+([A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+)*)/i);

    const project = projectMatch ? projectMatch[1] : '';
    const task = taskMatch ? taskMatch[1] : snippet.slice(0, 80);

    const body = `Top snippet: ${snippet}\n\nSource: ${top.file}~${top.fromLine}-${top.toLine}`;

    const state = {
      project: project || '',
      task: task || 'Discovered from recent conversation',
      status: 'active',
      last_action: `Discovered from ${results.length} session snippet(s)`,
      next_steps: [],
      updated: new Date().toISOString(),
      body
    };

    // Write automatically
    const writeResult = await writeState(state, { validate: false });
    return state;
  } catch (err) {
    // Discovery failure: return a safe empty state but log
    console.error('[session-state-tracker] discoverFromSessions error:', err.message);
    throw err;
  }
}

// =====================
// Plugin Config
// =====================

/**
 * Set plugin configuration from API. Typically called once during registration.
 * @param {object} config - Plugin configuration object
 */
function setConfig(config) {
  pluginConfig = config || {};
  // Also configure cache based on config values
  const cacheOverrides = {};
  if (pluginConfig.cacheMax !== undefined) cacheOverrides.max = pluginConfig.cacheMax;
  if (pluginConfig.cacheTTLms !== undefined) cacheOverrides.ttlMs = pluginConfig.cacheTTLms;
  if (Object.keys(cacheOverrides).length > 0) {
    configureCache(cacheOverrides);
  }
}

/**
 * Get current plugin configuration.
 * @returns {object}
 */
function getConfig() {
  return { ...pluginConfig };
}

// =====================
// Module Exports
// =====================

module.exports = {
  // Core state operations
  readState,
  writeState,
  discoverFromSessions,
  parseFile,
  validate,
  SCHEMA,
  getStateFilePath,

  // v2.1.0 Cache infrastructure
  getCache,
  configureCache,
  normalizeCacheKey,
  truncateAnchor,
  isCacheValid,
  getCacheStats,

  // Plugin config
  setConfig,
  getConfig,

  // Backward compatibility
  get STATE_FILE() { return getStateFilePath(); }
};
