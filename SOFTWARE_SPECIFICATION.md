# Context Persistence Plugin - Software Specification

**Status:** Draft
**Version:** 1.0
**Date:** 2026-02-25
**Author:** Lieutenant Qrusher (qsmtco)
**Plugin ID:** `context-persistence`
**Target OpenClaw Version:** 2026.2.0+

---

## 1. Introduction

### 1.1 Purpose

This document specifies the complete design and implementation plan for the **Context Persistence** plugin-a proper OpenClaw plugin that provides automatic state persistence across compaction and restarts using an LRU cache and enhanced context anchoring. The plugin will replace the existing `session-state-tracker` skill with a first-class plugin architecture using modern OpenClaw conventions.

### 1.2 Scope

The specification covers:

- Architectural refactoring from skill-based tool discovery to explicit `api.registerTool()` registration
- CLI integration via `api.registerCli()`
- File reorganization for maintainability (`lib/`, `tools/`, `cli/`, `hooks/`)
- Hook handler updates and manifest modernization
- Testing strategy and acceptance criteria
- Zero-downtime migration from the legacy skill

**Out of scope:** Skill wrapper integration (the plugin shall be standalone, not bundled as a skill), TypeScript conversion (JavaScript is acceptable for v2.x), provider integrations beyond what already exists.

### 1.3 Definitions

| Term | Definition |
|------|------------|
| LRU | Least Recently Used cache eviction policy |
| TTL | Time-to-Live (cache entry expiration) |
| Hook | Lifecycle callback (pre-compaction, post-compaction, session-start, shutdown) |
| Tool | Agent-callable function registered via `api.registerTool()` |
| CLI | Command-line interface extension to `openclaw` command |
| Manifest | `openclaw.plugin.json` plugin descriptor |
| State file | `CONTEXT_PERSISTENCE.md` containing frontmatter + body |
| Schema | JSON Schema for config and tool parameters |
| Anchor | System message injected after compaction to remind agent of context |
| Prefetch | Proactive caching of anticipated `memory_search` queries on session start |
| Summarization | LLM-generated context anchor when state changes significantly |

### 1.4 References

- OpenClaw Plugin Documentation: https://docs.openclaw.ai/tools/plugin
- OpenClaw Configuration Reference: https://docs.openclaw.ai/gateway/configuration-reference.md

### 1.5 Implementation Notes

- **CLI registration** requires the `{ commands: ['context-persistence'] }` option as the second argument to `api.registerCli`. See example in `index.js` and reference plugins (voice-call, memory-core).
- The `program` object passed to the registrar is a Commander instance. The plugin must call `program.command('context-persistence')` and register subcommands.
- All tools must be optional where LLM calls are involved; mark with `optional: true` during registration.
- Hooks return a result object `{ ok: boolean, action?: string, skipped?: string }`.
- Atomic file writes for state persistence use temp file + fsync + rename pattern.
- Cache invalidation uses file mtime comparison; do not skip reading if mtime unknown.
- OpenClaw CLI Config: https://docs.openclaw.ai/cli/config.md
- Existing skill: `/home/q/.openclaw/workspace/skills/session-state-tracker/`
- Refactoring plan: `/home/q/.openclaw/workspace/plugins/context-persistence/REFACTOR_PLAN.md`
- OpenClaw Plugin Manifest Spec: docs.openclaw.ai (latest)

### 1.5 Overview

Remaining sections describe the current architecture, gaps vs best practices, proposed structure, detailed implementation phases with atomic steps, testing, risks, and success criteria.

---

## 2. Overall Description

### 2.1 Product Perspective

The Context Persistence plugin integrates with OpenClaw Gateway as a trusted in-process extension. It hooks into compaction, session-start, and shutdown events to maintain a persistent state file and an LRU cache for efficient memory search results. It exposes tools to agents for manual inspection and updates.

### 2.2 Product Functions

| Function | Description |
|----------|-------------|
| Auto-save state | On `pre-compaction`, writes `CONTEXT_PERSISTENCE.md` if dirty |
| Inject anchor | On `post-compaction`, injects a system message summarizing current task/context |
| Load state on start | On `session-start`, optionally injects state summary and/or prefetches anticipated queries |
| Cache memory_search | Tool `cached_memory_search` wraps `memory_search` with LRU caching |
| Manual state I/O | Tools `context_persistence_read` and `context_persistence_write` for external access |
| Summarization | Optional LLM-based anchor generation via `context_persistence_summarize` |
| Prefetching | Optional cache warming via `context_persistence_prefetch` on session start |
| CLI commands | `openclaw context-persistence show|set|cache-stats|cache-clear` |

### 2.3 User Characteristics

- **Operator:** OpenClaw administrator installing/configuring the plugin
- **Agent:** AI agent that uses tools `context_persistence_*` and benefits from automatic anchoring
- **Developer:** Future maintainer of the plugin codebase

### 2.4 Constraints

- Must run in-process with Gateway (trusted code)
- Config must validate against JSON Schema without executing plugin code
- Hook scripts must be idempotent and fast (timeouts: 10-15s)
- State file must be human-readable Markdown with YAML frontmatter
- Must preserve backward compatibility with existing `CONTEXT_PERSISTENCE.md` format
- No external network dependencies beyond what OpenClaw already provides

### 2.5 Assumptions and Dependencies

- OpenClaw Gateway version ≥2026.2.0 (supports `api.registerTool`, `api.registerCli`)
- Agent has `memory_search` tool available (for `cached_memory_search`)
- LLM provider configured if summarization/prefetch is enabled
- Gateway is restarted after plugin installation or removal
- `plugins.load.paths` includes the plugin directory before enabling

---

## 3. System Architecture

### 3.1 Component Diagram

```
context-persistence/
├── openclaw.plugin.json       (manifest)
├── index.js                   (register(api) → tools, hooks, CLI)
├── lib/
│   ├── state.js               (readState, writeState, schema, cache)
│   └── errors.js              (custom error classes)
├── hooks/
│   ├── preCompaction.js       (auto-save)
│   ├── postCompaction.js      (inject anchor)
│   ├── sessionStart.js        (load state + prefetch)
│   └── shutdown.js            (log cache stats)
├── tools/
│   ├── index.js               (tool implementations + schemas)
│   ├── contextPersistenceRead.js
│   ├── contextPersistenceWrite.js
│   ├── contextPersistenceDiscover.js
│   ├── cachedMemorySearch.js
│   ├── contextPersistenceSummarize.js
│   └── contextPersistencePrefetch.js
├── cli/
│   └── commands.js            (openclaw context-persistence ...)
├── skills/                    (optional; omitted in pure plugin mode)
│   └── context-persistence/
│       └── SKILL.md
├── tests/
│   ├── state.test.js
│   ├── tools.test.js
│   └── hooks.test.js
├── package.json
├── README.md
└── CHANGELOG.md
```

### 3.2 Data Flow

1. **Write cycle (pre-compaction):**
   - Hook calls `state.writeState(ctx.session)`
   - `state.writeState` serializes session data to YAML frontmatter + markdown body
   - Atomic write to `CONTEXT_PERSISTENCE.md` (temp → fsync → rename)

2. **Read cycle (session-start):**
   - Hook calls `state.readState()` if file exists
   - Injects system message with context summary and next steps
   - If `enablePrefetch`, calls `cached_memory_search` for each prefetch query

3. **Cache flow (cached_memory_search):**
   - Normalize query → cache key (`JSON.stringify({query, filters, options})`)
   - LRU lookup; if miss and TTL ok, call `ctx.tools.memory_search`
   - Store result in cache with timestamp and mtime from underlying memory store

4. **Tool calls:**
   - Agent invokes `context_persistence_read` → returns state object
   - Agent invokes `context_persistence_write` → validates schema, updates fields, writes file
   - Agent invokes `context_persistence_summarize` → calls LLM to generate anchor

### 3.3 External Interfaces

| Interface | Provided By | Consumed By |
|-----------|-------------|-------------|
| `api.registerTool` | OpenClaw | Plugin (tool registration) |
| `api.registerCli` | OpenClaw | Plugin (CLI commands) |
| `api.registerHook` | OpenClaw | Plugin (hook registration) |
| `ctx.tools.memory_search` | Core/Memory plugin | `cached_memory_search` tool |
| `ctx.session` | Agent runtime | Hook handlers (state extraction) |
| FileSystem (CONTEXT_PERSISTENCE.md) | Host OS | `lib/state.js` |

---

## 4. Detailed Requirements

### 4.1 Functional Requirements

**FR-1:** The plugin shall load without errors when Gateway starts.

**FR-2:** The plugin shall register exactly six tools with explicit JSON Schema:
- `context_persistence_read` (no parameters)
- `context_persistence_write` (partial state object)
- `context_persistence_discover` (no parameters; returns plugin capabilities)
- `cached_memory_search` (same signature as `memory_search`)
- `context_persistence_summarize` (optional LLM params)
- `context_persistence_prefetch` (no parameters)

**FR-3:** The plugin shall register four hook handlers with correct paths and timeouts.

**FR-4:** The plugin shall expose CLI commands: `show`, `set <key> <value>`, `cache-stats`, `cache-clear`.

**FR-5:** The `state.writeState` function shall:
- Accept a session-like object or explicit state fields
- Validate against the state schema (version, project, task, status, etc.)
- Perform atomic writes (temp file + fsync + rename)
- Handle errors gracefully (disk full, permission denied, partial writes)
- Clean up temp file on failure
- Update `updated` timestamp automatically
- Preserve existing fields not being overwritten

**Implementation Note:**
```javascript
async function writeState(data) {
  // Use unique temp filename to prevent race conditions between concurrent writers
  const tmpPath = `${stateFilePath}.tmp.${process.pid}-${Date.now()}-${Math.random().toString(36).substr(2,9)}`;

  try {
    // Read current state for optimistic locking
    const existing = await readState().catch(() => ({}));
    const baseUpdated = existing.updated;

    // Merge with existing state to preserve fields not being overwritten
    const merged = { ...existing, ...data, updated: new Date().toISOString() };

    // Validate against schema before writing
    const validate = ajv.compile(stateSchema);
    const valid = validate(merged);
    if (!valid) {
      throw new Error(`State validation failed: ${validate.errors.map(e => \`\${e.instancePath} \${e.message}\`).join('; ')}`);
    }

    const yamlString = yaml.dump(merged, { lineWidth: 0 });

    // Write to unique temp file
    await fs.promises.writeFile(tmpPath, yamlString, 'utf8');
    // Sync to disk
    await fs.promises.fsync(tmpPath);

    // Optimistic concurrency check before rename (ensure no concurrent overwrite)
    // Read current state again to verify it hasn't changed since we read
    const currentState = await readState().catch(() => null);
    if (currentState && baseUpdated && currentState.updated !== baseUpdated) {
      // State changed concurrently - abort this write to prevent lost updates
      await fs.promises.unlink(tmpPath);
      throw new Error('Concurrent modification detected - please retry');
    }

    // Atomic rename
    await fs.promises.rename(tmpPath, stateFilePath);
    return true;
  } catch (err) {
    // Clean up temp file on failure
    try { await fs.promises.unlink(tmpPath); } catch (cleanupErr) {
      // Log cleanup failure but don't mask original error
      log?.warn?.('[context-persistence] Failed to cleanup temp file:', cleanupErr.message);
    }
    throw err;
  }
}
```

**FR-6:** The `state.readState` function shall:
- Parse `CONTEXT_PERSISTENCE.md` (YAML frontmatter + optional markdown body)
- Return a plain JS object with all frontmatter fields plus `body`
- Return `null` if file doesn't exist
- Handle parse errors gracefully by backing up corrupt files and logging diagnostic info
- Validate file mtime against cached mtime for cache invalidation

**Implementation Note:**
```javascript
async function readState() {
  try {
    const content = await fs.promises.readFile(stateFilePath, 'utf8');
    const doc = yaml.load(content);
    if (!doc || typeof doc !== 'object') {
      log?.warn?.('[context-persistence] State file is empty or invalid');
      return null;
    }
    return doc;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    
    // Handle YAML parse errors specifically
    if (err.name === 'YAMLException' || err.name === 'SyntaxError') {
      log?.error?.('[context-persistence] State file corrupt (YAML parse error):', err.message);
      try {
        const backup = `${stateFilePath}.corrupt.${Date.now()}`;
        await fs.promises.copyFile(stateFilePath, backup);
        log?.warn?.('[context-persistence] Backed up corrupt state to:', backup);
      } catch (backupErr) { /* ignore backup failure */ }
      return null;
    }
    
    // Handle permission errors
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      log?.error?.('[context-persistence] Permission denied reading state file:', err.path);
      return null;
    }
    
    // Generic I/O errors
    log?.error?.('[context-persistence] I/O error reading state:', err.code, err.message);
    return null;
  }
}
```

**FR-7:** The LRU cache shall:
- Have configurable max size (`cacheMax`, default 100) and TTL (`cacheTTLms`, default 5 min)
- Evict least-recently-used entries when full
- Invalidate entries if underlying `memory/search` results change (via mtime comparison)
- Provide `get(key)`, `set(key, value, mtime)`, `clear()`, `stats()`

**cached_memory_search Tool Implementation:**
```javascript
// tools/cachedMemorySearch.js
const state = require('../lib/state');

async function cached_memory_search(params, ctx) {
  // Normalize params to create deterministic cache key
  const key = JSON.stringify(params, Object.keys(params).sort());
  
  // Get cache from state module
  const cache = state.getCache();
  if (!cache) {
    // Fallback: call directly without caching
    return ctx.tools.memory_search(params);
  }
  
  // Check cache
  const cached = cache.get(key);
  if (cached && !isExpired(cached)) {
    ctx.log?.debug?.('[context-persistence] Cache hit for key:', key.substring(0, 50));
    return cached.value;
  }
  
  // Cache miss - call the underlying tool
  ctx.log?.debug?.('[context-persistence] Cache miss for key:', key.substring(0, 50));
  
  try {
    const result = await ctx.tools.memory_search(params);
    
    // Determine mtime of result (for invalidation tracking)
    const mtime = getResultMtime(result);
    
    // Store in cache
    cache.set(key, { value: result, mtime, timestamp: Date.now() });
    
    return result;
  } catch (err) {
    ctx.log?.error?.('[context-persistence] cached_memory_search failed:', err.message);
    // Propagate error to caller rather than swallowing it
    throw err;
  }
}

// Helper to determine if cached entry is expired
function isExpired(cachedEntry) {
  const config = state.getConfig?.() || {};
  const ttlMs = config.cacheTTLms || 300000; // default 5 min
  return Date.now() - cachedEntry.timestamp > ttlMs;
}

// Helper to get "mtime" from search results (for cache invalidation)
// Returns the most recent modification time across all returned items
function getResultMtime(results) {
  if (!Array.isArray(results) || results.length === 0) return Date.now();
  // Results may contain source file paths or timestamps - extract accordingly
  return results.reduce((max, r) => Math.max(max, r.mtime || Date.now()), 0);
}

module.exports = cached_memory_search;
```

**FR-8:** The `pre-compaction` hook shall:
- Call `state.writeState(ctx.session)` with the current session context
- Log success or error (do not throw)

**FR-9:** The `post-compaction` hook shall:
- Read the updated state
- Inject a system message into `ctx.session` summarizing project/task/next_steps
- Be tolerant of missing state file

**FR-10:** The `session-start` hook shall:
- Load state via `state.readState()`
- Inject a system message: "Resuming context: …"
- If `enablePrefetch` is true and `prefetchQueries` array non-empty, call `cached_memory_search` for each query and await all

**FR-11:** The `shutdown` hook shall:
- Log cache statistics (hits, misses, size, max, TTL)

**FR-12:** Tool parameter validation:
- All tools declared in manifest must have corresponding schema definitions
- Tools must throw descriptive errors when called with invalid parameters

**FR-13:** CLI commands must not interfere with agent tools; they are for operator use only.

**FR-14:** The plugin shall support dynamic config reload on Gateway restart:
- `cacheMax` and `cacheTTLms` re-read from `api.config` on each hook/tool call
- Changes take effect after Gateway restart (no hot-reload required)

### 4.2 Non-Functional Requirements

**NFR-1 (Performance):**
- Hook execution ≤500ms (excluding LLM calls)
- Cache lookup ≤5ms
- State file read/write ≤50ms (on typical SSD)

**NFR-2 (Reliability):**
- Atomic writes must never corrupt the state file
- Hook errors must be caught and logged; must not crash Gateway
- Cache must handle process restart gracefully (in-memory only; state persisted to file)

**NFR-3 (Security):**
- File permissions: read/write only to `CONTEXT_PERSISTENCE.md` in workspace
- No network calls beyond what tools already do
- No secrets stored in config or state

**NFR-4 (Maintainability):**
- Code split into logical modules (lib, tools, hooks, cli)
- Clear error messages with stack traces in debug mode
- JSDoc or TSDoc comments on public functions
- Unit tests ≥90% coverage of core logic (state, cache, tools)

**NFR-5 (Observability):**
- All hooks and tools log at appropriate levels (info, warn, error)
- Cache stats logged on shutdown
- Hook duration logged at debug level
- Log levels: `info` for normal operations, `warn` for recoverable issues, `error` for failures that should be flagged

**Logging Conventions:**
```javascript
// Normal operations
api.log?.info?.('[context-persistence] State saved before compaction');

// Recoverable issues
api.log?.warn?.('[context-persistence] Missing schema or impl:', toolName);

// Failures
api.log?.error?.('[context-persistence] pre-compaction failed:', err);

// Debug details (expensive operations)
api.log?.debug?.('[context-persistence] Cache hit for key:', cacheKey);
```

**NFR-6 (Compatibility):**
- Must load on OpenClaw 2026.2.0+
- Must not break if `plugins.entries` config entry is missing (use defaults)
- Must not interfere with other plugins' hooks

---

## 5. Implementation Plan (Phased)

### Phase 0: Preparation and Backup

**Objective:** Ensure current state is version-controlled and testable.

**Steps:**

1. **Backup current skill directory** (in case we need to reference):
   ```bash
   cp -r /home/q/.openclaw/workspace/skills/session-state-tracker ~/backup/session-state-tracker-$(date +%Y%m%d-%H%M%S)
   ```

2. **Initialize git repo in plugin directory** (if not already):
   ```bash
   cd /home/q/.openclaw/workspace/plugins/context-persistence
   git init
   git add -A
   git commit -m "Initial: empty plugin directory + refactor plan"
   ```

3. **Verify existing tests** (copy from skill if needed):
   ```bash
   cp -r /home/q/.openclaw/workspace/skills/session-state-tracker/tests .
   # Adapt tests later to new paths
   ```

**Acceptance criteria:**
- Backup exists outside workspace
- Git repo created with initial commit
- `tests/` directory present (may need updates later)

---

### Phase 1: File Organization Refactor

**Objective:** Establish clean module boundaries.

**Steps:**

1. **Create directory structure:**
   ```bash
   mkdir -p lib tools cli hooks
   ```

2. **Move core modules:**
   ```bash
   mv /home/q/.openclaw/workspace/skills/session-state-tracker/scripts/state.js lib/state.js
   mv /home/q/.openclaw/workspace/skills/session-state-tracker/scripts/tools.js tools/index.js
   mv /home/q/.openclaw/workspace/skills/session-state-tracker/scripts/cli.js cli/commands.js
   ```

3. **Rename hook files to camelCase:**
   ```bash
   mv /home/q/.openclaw/workspace/skills/session-state-tracker/hooks/pre-compaction.js hooks/preCompaction.js
   mv /home/q/.openclaw/workspace/skills/session-state-tracker/hooks/post-compaction.js hooks/postCompaction.js
   mv /home/q/.openclaw/workspace/skills/session-state-tracker/hooks/session-start.js hooks/sessionStart.js
   # shutdown.js already camelCase, just move if needed
   ```

4. **Update manifest (`openclaw.plugin.json`):**
   - Change hook `script` paths to `./hooks/preCompaction.js`, etc.
   - Change `tools` array to use `context_persistence_*` names (already done in manifest we created)
   - Remove any `skills` field (pure plugin)
   - Ensure `permissions.fileSystem` points to `CONTEXT_PERSISTENCE.md` (already done)

5. **Update imports in moved files:**

   - In `lib/state.js`: ensure all `require()` paths use `../` appropriately (it's in `lib/`, so `../hooks` no longer needed; but may need `fs`, `path`, `js-yaml`)

   - In `tools/index.js` and individual tool files (to be split): update any `require('./state')` to `require('../lib/state')`

   - In each hook file (`hooks/*.js`):
     ```javascript
     // Old:
     const state = require('../scripts/state');
     const tools = require('../scripts/tools');
     // New:
     const state = require('../lib/state');
     const tools = require('../tools');  // will export individual functions
     ```

6. **Delete empty `scripts/` directory:**
   ```bash
   rmdir /home/q/.openclaw/workspace/skills/session-state-tracker/scripts
   ```

7. **Commit changes:**
   ```bash
   git add -A
   git commit -m "Phase 1: Reorganize files (lib/, tools/, cli/, hooks/ camelCase)"
   ```

**Acceptance criteria:**
- Directory structure matches proposed diagram
- All file moves completed without breaking imports
- Manifest hook paths updated and valid JSON
- No `scripts/` directory remains
- Git commit with clear message

---

### Phase 2: Tool Registration via API

**Objective:** Convert tools from passive exports to active registration with schemas.

**Steps:**

1. **Define tool schemas in `tools/index.js`:**

   Create an object `Schemas` mapping tool name → `{ name, description, parameters }`.

   Example:
   ```javascript
   const Schemas = {
     context_persistence_read: {
       name: "context_persistence_read",
       description: "Read the current CONTEXT_PERSISTENCE.md contents including frontmatter and body",
       parameters: { type: "object", properties: {}, additionalProperties: false }
     },
     context_persistence_write: {
       name: "context_persistence_write",
       description: "Update one or more fields in CONTEXT_PERSISTENCE.md. Validates against schema. Updates 'updated' automatically.",
       parameters: {
         type: "object",
         properties: {
           project: { type: "string" },
           task: { type: "string" },
           status: { type: "string", enum: ["active", "blocked", "done", "in-progress"] },
           last_action: { type: "string" },
           next_steps: { type: "array", items: { type: "string" } },
           body: { type: "string" },
           context_anchor: { type: "string" },
           conversation_summary: { type: "string" }
         },
         additionalProperties: false,
         minProperties: 1
       }
     },
     // ... others (discover, cached_memory_search, summarize, prefetch)
   };
   ```

2. **Ensure each tool implementation is exported** from `tools/index.js`:
   ```javascript
   module.exports = {
     schemas: Schemas,
     context_persistence_read,
     context_persistence_write,
     context_persistence_discover,
     cached_memory_search,
     context_persistence_summarize,
     context_persistence_prefetch
   };
   ```

3. **Update `index.js` to register tools via `api`:**

   ```javascript
   // index.js
   const fs = require('fs');
   const path = require('path');
   const tools = require('./tools');

   module.exports = function register(api) {
     // Configure cache from plugin config
     try {
       if (api.config) {
         const mapped = {
           max: api.config.cacheMax,
           ttlMs: api.config.cacheTTLms
         };
         // Remove undefined keys
         Object.keys(mapped).forEach(k => mapped[k] === undefined && delete mapped[k]);
         if (Object.keys(mapped).length > 0) {
           const state = require('./lib/state');
           state.configureCache(mapped);
           api.log?.info?.('[context-persistence] Cache configured:', mapped);
         }
       }
     } catch (err) {
       api.log?.error?.('[context-persistence] Cache config failed:', err);
     }

     // Register tools
     const toolList = [
       'context_persistence_read',
       'context_persistence_write',
       'context_persistence_discover',
       'cached_memory_search',
       'context_persistence_summarize',
       'context_persistence_prefetch'
     ];

     for (const toolName of toolList) {
       try {
         const schema = tools.schemas[toolName];
         const impl = tools[toolName];
         if (schema && impl) {
           api.registerTool(schema, { optional: toolName.includes('summarize') || toolName.includes('prefetch') });
           api.log?.debug?.(`[context-persistence] Registered tool: ${toolName}`);
         } else {
           api.log?.warn?.(`[context-persistence] Missing schema or impl: ${toolName}`);
         }
       } catch (err) {
         api.log?.error?.(`[context-persistence] Failed to register tool ${toolName}:`, err);
       }
     }

     // Register hooks (hook objects are imported; see Phase 4)
     api.registerHook('pre-compaction', require('./hooks/preCompaction'), { name: 'context-persistence.pre-compaction', description: 'Auto-save state before compaction' });
     api.registerHook('post-compaction', require('./hooks/postCompaction'), { name: 'context-persistence.post-compaction', description: 'Inject context anchor after compaction' });
     api.registerHook('session-start', require('./hooks/sessionStart'), { name: 'context-persistence.session-start', description: 'Inject state summary on session start' });
     api.registerHook('shutdown', require('./hooks/shutdown'), { name: 'context-persistence.shutdown', description: 'Log cache statistics on shutdown' });

     api.log?.info?.('[context-persistence] Plugin loaded');
   };
   ```

4. **Split `tools/index.js` if needed:**
   - Keep `cached_memory_search` in its own file for clarity (optional but matches proposed structure)
   - Ensure each tool implementation uses the `state` module correctly

5. **Remove `tools` array from manifest** (since we're registering via API):
   - The manifest currently has `"tools": [...]`. This is acceptable but redundant. We can keep it for documentation; it won't cause issues. But best practice is to remove it to avoid confusion. Plan: keep it as documentation only, but note in implementation that `api.registerTool` is the authoritative registration.

6. **Commit:**
   ```bash
   git add -A
   git commit -m "Phase 2: Register tools via api.registerTool with schemas"
   ```

**Acceptance criteria:**
- `index.js` exists and exports `register(api)`
- `tools/index.js` exports `schemas` and all tool implementations
- All six tools are registered with OpenClaw when plugin loads
- `openclaw plugins doctor` reports no tool registration errors
- `openclaw hooks list` shows hook entries (tools appear in agent tool list)

---

### Phase 3: CLI Integration

**Objective:** Provide user-facing CLI commands.

**Steps:**

1. **Review `cli/commands.js` content:**

   Should define `registerCommands(api)` that receives the Commander `program` (or uses `api.registerCli`).

   Example:
   ```javascript
   // cli/commands.js
   const { program } = require('commander');
   const state = require('../lib/state');

   function registerCommands(api) {
     const cmd = program.command('context-persistence').description('Context Persistence commands');

     cmd.command('show')
        .description('Display current CONTEXT_PERSISTENCE.md')
        .action(async () => {
          const s = await state.readState();
          if (!s) {
            console.log('No state file found.');
            return;
          }
          console.log('--- State ---');
          const { body, ...frontmatter } = s;
          Object.entries(frontmatter).forEach(([k, v]) => {
            if (Array.isArray(v)) {
              console.log(`${k}:`);
              v.forEach(i => console.log(`  - ${i}`));
            } else if (typeof v === 'object' && v !== null) {
              console.log(`${k}: ${JSON.stringify(v, null, 2)}`);
            } else {
              console.log(`${k}: ${v}`);
            });
          if (body) {
            console.log('\n--- Context ---');
            console.log(body);
          }
        });

     cmd.command('set <key> <value>')
        .description('Set a field in CONTEXT_PERSISTENCE.md')
        .action(async (key, value) => {
          // Validate key against allowed fields
          const ALLOWED_KEYS = new Set(['version','project','task','status','last_action','next_steps','context_anchor','conversation_summary','updated','body']);
          if (!ALLOWED_KEYS.has(key)) {
            console.error(`Invalid field '${key}'. Allowed: ${[...ALLOWED_KEYS].join(', ')}`);
            process.exit(1);
          }
          
          // Handle JSON arrays/objects if value starts with { or [
          let parsedValue = value;
          try {
            if (/^\[|\{/.test(value)) parsedValue = JSON.parse(value);
          } catch (e) { /* keep as string */ }
          
          try {
            await state.writeState({ [key]: parsedValue });
            console.log(`Set ${key} = ${JSON.stringify(parsedValue)}`);
          } catch (err) {
            console.error(`Failed to set ${key}: ${err.message}`);
            process.exit(1);
          }
        });

     cmd.command('cache-stats')
        .description('Show LRU cache statistics')
        .action(() => {
          const stats = state.getCacheStats?.() ?? { size: 0, max: 0, ttl: 0 };
          console.log(`Cache size: ${stats.size}/${stats.max} (TTL: ${stats.ttl}ms)`);
        });

     cmd.command('cache-clear')
        .description('Clear the LRU cache')
        .action(() => {
          try {
            const cache = state.getCache?.();
            if (cache?.clear) {
              const before = cache.size?.() ?? 0;
              cache.clear();
              console.log(`Cache cleared (${before} entries)`);
            } else {
              console.log('Cache not available');
            }
          } catch (err) {
            console.error('Failed to clear cache:', err.message);
            process.exit(1);
          }
        });
   }

   module.exports = registerCommands;
   ```

2. **Register CLI in `index.js`:**

   ```javascript
   const registerCliCommands = require('./cli/commands');

   module.exports = function register(api) {
     // ... tool and hook registration ...

     // Register CLI (OpenClaw ≥2026.2.0 supports this)
     if (typeof api.registerCli === 'function') {
       registerCliCommands(api);
       api.log?.info?.('[context-persistence] CLI commands registered under openclaw context-persistence');
     } else {
       api.log?.warn?.('[context-persistence] api.registerCli not available; CLI commands not registered');
     }
   };
   ```

3. **Test CLI manually** (after plugin load):
   ```bash
   openclaw context-persistence show
   openclaw context-persistence cache-stats
   ```

4. **Commit:**
   ```bash
   git add -A
   git commit -m "Phase 3: Integrate CLI via api.registerCli"
   ```

**Acceptance criteria:**
- `openclaw context-persistence --help` works
- `show`, `set`, `cache-stats`, `cache-clear` commands execute without errors
- CLI commands do not interfere with agent tools

---

### Phase 4: Hook Handler Updates

**Objective:** Ensure hooks point to correct module paths and use proper context.

**Steps:**

1. **For each hook file (`hooks/preCompaction.js`, `postCompaction.js`, `sessionStart.js`, `shutdown.js`):**

   - **Update imports:**
     ```javascript
     // Top of file
     const state = require('../lib/state');
     const tools = require('../tools');  // will use tools[toolName]
     ```

   - **Verify hook signature:** `async (ctx) => { ... }`

   - **Pre-compaction (`preCompaction.js`):**
     ```javascript
     module.exports = async function preCompaction(ctx) {
       try {
         // Extract relevant session data from state file (not ctx.session directly)
         // The agent writes state via context_persistence_write tool; we just persist it
         const currentState = await state.readState();
         if (!currentState) {
           ctx.log?.debug?.('[context-persistence] No state to save');
           return;
         }
         // Update the timestamp
         currentState.updated = new Date().toISOString();
         const ok = await state.writeState(currentState);
         if (ok) ctx.log?.info?.('[context-persistence] State saved before compaction');
       } catch (err) {
         ctx.log?.error?.('[context-persistence] pre-compaction failed:', err);
         // Do not throw; let compaction continue
       }
     };
     ```

     **Note:** The plugin expects the agent to maintain state via the `context_persistence_write` tool. The pre-compaction hook simply persists whatever is currently in the state file, rather than extracting from `ctx.session` (which may not contain the expected fields). This design is more robust as it relies on explicit agent action rather than implicit session property extraction.

   - **Post-compaction (`postCompaction.js`):**
     ```javascript
     module.exports = async function postCompaction(ctx) {
       try {
         const s = await state.readState();
         if (!s) return;
         const summary = `Context: ${s.project || 'N/A'} • ${s.task || 'N/A'} • Next: ${(s.next_steps || []).join('; ') || 'none'}`;
         await ctx.session?.addSystemMessage(`[Context Anchor] ${summary}`);
         ctx.log?.debug?.('[context-persistence] Anchor injected');
       } catch (err) {
         ctx.log?.error?.('[context-persistence] post-compaction failed:', err);
       }
     };
     ```

   - **Session-start (`sessionStart.js`):**
     ```javascript
     module.exports = async function sessionStart(ctx) {
       try {
         const s = await state.readState();
         if (s) {
           await ctx.session?.addSystemMessage(`[Resume] ${s.body || 'Context loaded'}`);
           ctx.log?.info?.('[context-persistence] State injected on session start');
         }
         
         // Prefetch if configured - use ctx.tools for registered tool access
         const config = state.getConfig?.() || {};
         const queries = config.prefetchQueries;
         
         // Safe type check: ensure prefetchQueries is actually an array
         if (config.enablePrefetch && Array.isArray(queries) && queries.length > 0) {
           // Check if tool is available before attempting
           const toolFn = ctx.tools.cached_memory_search;
           if (!toolFn) {
             ctx.log?.warn?.('[context-persistence] Prefetch skipped: cached_memory_search tool not available');
             return;
           }
           
           ctx.log?.info?.('[context-persistence] Prefetching', queries);
           const results = await Promise.allSettled(
             queries.map(q => toolFn({ query: q }))
           );
           
           // Log each failure for diagnostics
           results.forEach((r, i) => {
             if (r.status === 'rejected') {
               ctx.log?.debug?.('[context-persistence] Prefetch query failed:', queries[i], r.reason?.message);
             }
           });
           
           const succeeded = results.filter(r => r.status === 'fulfilled').length;
           ctx.log?.info?.('[context-persistence] Prefetch complete:', succeeded, 'of', queries.length);
         }
       } catch (err) {
         ctx.log?.error?.('[context-persistence] session-start failed:', err);
       }
     };
     ```

   - **Shutdown (`shutdown.js`):**
     ```javascript
     module.exports = async function shutdown(ctx) {
       try {
         const stats = state.getCacheStats?.() ?? {};
         ctx.log?.info?.('[context-persistence] Shutdown cache stats:', stats);
       } catch (err) {
         ctx.log?.error?.('[context-persistence] Shutdown logging failed:', err);
       }
     };
     ```

2. **Update `lib/state.js` to expose cache stats and config:**

   Ensure it exports:
   ```javascript
   module.exports = {
     readState,
     writeState,
     configureCache,
     getCacheStats,
     getCache,
     getConfig: () => currentConfig   // store currentConfig from api.config
   };
   ```

3. **Commit:**
   ```bash
   git add -A
   git commit -m "Phase 4: Update hook handlers with correct imports and logic"
   ```

**Acceptance criteria:**
- All four hooks exist, have correct filenames, and are referenced correctly in manifest
- Hook code uses `require('../lib/state')` and `require('../tools')`
- Hooks are tolerant of errors (logged, not thrown)
- `getCacheStats` function exists and returns `{size, max, ttl, hits?, misses?}`

---

### Phase 5: Skill Integration (Optional - Omit per request)

**Note:** The user explicitly requested a pure plugin, not a skill wrapper. This phase is **skipped**.

If later we want to ship as both plugin and skill, we would add `skills` field to manifest and copy skill docs. But per user instruction: no skill integration.

---

### Phase 6: Testing & Validation

**Objective:** Verify correctness and prevent regressions.

**Steps:**

1. **Create mock fixtures** (`tests/__mocks__/`):
   ```javascript
   // tests/__mocks__/api.js
   module.exports = {
     config: {
       cacheMax: 100,
       cacheTTLms: 300000,
       enablePrefetch: false,
       prefetchQueries: [],
       summarizationBudget: { maxCallsPerHour: 10, enabled: true }
     },
     log: {
       info: jest.fn(),
       warn: jest.fn(),
       error: jest.fn(),
       debug: jest.fn()
     },
     registerTool: jest.fn(),
     registerHook: jest.fn(),
     registerCli: jest.fn()
   };

   // tests/__mocks__/ctx.js
   module.exports = {
     session: {
       addSystemMessage: jest.fn().mockResolvedValue(undefined),
       project: 'test-project',
       task: 'test-task',
       status: 'active',
       last_action: 'test action',
       next_steps: ['step 1', 'step 2'],
       body: 'test body context',
       context_anchor: 'test anchor',
       conversation_summary: 'test summary'
     },
     tools: {
       memory_search: jest.fn().mockResolvedValue([
         { source: 'memory/test.md', content: 'test result', score: 0.95 }
       ]),
       cached_memory_search: jest.fn()
     },
     log: {
       info: jest.fn(),
       error: jest.fn(),
       debug: jest.fn()
     }
   };
   ```

2. **Unit tests (`tests/state.test.js`):**
   - Test `writeState` and `readState` roundtrip
   - Test schema validation (valid/invalid)
   - Test atomic write (file exists only after complete write)
   - Test cache: put/get/evict/TTL
   - Test `configureCache` with different max/TTL

3. **Unit tests (`tests/tools.test.js`):**
   - Mock `api` and `ctx` for each tool
   - Verify `context_persistence_read` returns state
   - Verify `context_persistence_write` updates specific fields
   - Verify `cached_memory_search` calls through to `memory_search` on miss
   - Verify cache hits on repeated calls with same query

4. **Integration tests (`tests/hooks.test.js`):**
   - Mock `ctx.session` with sample data
   - Call each hook handler directly
   - Assert file written, message injected, logs called

5. **Test runner setup:** Use `vitest` or `jest`; add to `package.json`:
   ```json
   {
     "scripts": { "test": "vitest run" },
     "devDependencies": { "vitest": "^1.0.0" }
   }
   ```

6. **Run tests locally:**
   ```bash
   npm install
   npm test
   ```

7. **Fix any failures and iterate.

8. **Commit:**
   ```bash
   git add -A
   git commit -m "Phase 6: Add unit and integration tests"
   ```

**Acceptance criteria:**
- All tests pass locally
- `npm test` exits 0
- Coverage ≥90% for `lib/state.js` and `tools/index.js`

---

### Phase 7: Documentation Updates

**Objective:** Ensure users and maintainers have accurate docs.

**Steps:**

1. **Update `README.md` (create if missing):**
   - Plugin purpose and features
   - Installation steps (add to plugins.load.paths, enable, restart)
   - Configuration options (`cacheMax`, `cacheTTLms`, `enablePrefetch`, `prefetchQueries`, `summarizationBudget`)
   - Available tools
   - CLI commands
   - Troubleshooting

2. **Update `CHANGELOG.md`:**
   ```markdown
   ## [2.2.0] - 2026-02-25
   ### Changed
   - Converted from skill to proper OpenClaw plugin
   - Tools now registered via `api.registerTool()` with explicit schemas
   - CLI integrated via `api.registerCli()`
   - File reorganization: `scripts/` → `lib/`, `tools/`, `cli/`; hooks renamed to camelCase
   - Added `uiHints` for config UI
   - Removed skill integration (pure plugin)

   ### Added
   - Unit tests for state, tools, hooks
   - Cache statistics CLI
   - Prefetch support on session-start

   ### Fixed
   - N/A yet
   ```

3. **Create `DEVELOPER.md` (optional but good):**
   - Dev setup: `npm install`, `npm test`
   - File architecture
   - How to add new tools
   - Release process

4. **Finalize `SOFTWARE_SPECIFICATION.md`** (this document) and place in plugin root.

5. **Commit:**
   ```bash
   git add -A
   git commit -m "Phase 7: Documentation updates (README, CHANGELOG, SPEC)"
   ```

**Acceptance criteria:**
- `README.md` present and accurate
- `CHANGELOG.md` reflects v2.2.0 changes
- `SOFTWARE_SPECIFICATION.md` final version committed
- Operator can install and configure from README alone

---

### Phase 8: Migration & Deployment

**Objective:** Deploy the plugin to production with zero downtime.

**Steps:**

1. **Pre-deployment validation:**
   ```bash
   openclaw plugins doctor
   openclaw plugins list --all | grep -i context
   # Should show the plugin with ID 'context-persistence' and status enabled
   ```

2. **Check manifest integrity:**
   ```bash
   jq . /home/q/.openclaw/workspace/plugins/context-persistence/openclaw.plugin.json > /dev/null && echo "JSON valid"
   ```

3. **Ensure plugin directory is in load path:**
   Verify `plugins.load.paths` includes `~/.openclaw/workspace/plugins`. Already set earlier.

4. **Restart Gateway:**
   ```bash
   openclaw gateway restart
   ```

5. **Post-restart verification:**
   ```bash
   openclaw plugins list | grep -i context
   # Should show: context-persistence (loaded) with version 2.2.0
   openclaw plugins doctor  # should say "No plugin issues detected"
   ```

6. **Functional test:**
   - Trigger a compaction (e.g., send many messages until compaction threshold)
   - Verify `CONTEXT_PERSISTENCE.md` appears in workspace root
   - Check `openclaw context-persistence show` outputs state
   - Test `openclaw context-persistence cache-stats`
   - Restart agent session and verify context summary arrives

7. **Rollback plan:** If plugin fails to load or causes errors:

   **Option A: Disable plugin (no code changes)**
   ```bash
   # Disable without removing files
   openclaw config set plugins.entries.'context-persistence'.enabled false
   openclaw gateway restart
   ```

   **Option B: Remove plugin directory (clean removal)**
   ```bash
   # Remove plugin files
   rm -rf ~/.openclaw/workspace/plugins/context-persistence

   # Remove from config
   jq 'del(.plugins.entries."context-persistence")' ~/.openclaw/openclaw.json > /tmp/tmp.json && mv /tmp/tmp.json ~/.openclaw/openclaw.json

   # Restart
   openclaw gateway restart
   ```

   **Option C: Full restore from backup**
   ```bash
   # Locate backup from Phase 0
   ls -la ~/backup/session-state-tracker-*

   # Restore skill directory
   cp -r ~/backup/session-state-tracker-YYYYMMDD-HHMMSS/* ~/.openclaw/workspace/skills/session-state-tracker/

   # Re-enable skill in config
   openclaw config set skills.entries.'session-state-tracker'.enabled true

   # Remove plugin config
   jq 'del(.plugins.entries."context-persistence")' ~/.openclaw/openclaw.json > /tmp/tmp.json && mv /tmp/tmp.json ~/.openclaw/openclaw.json

   # Remove plugin directory
   rm -rf ~/.openclaw/workspace/plugins/context-persistence

   # Restore original plugins.load.paths if modified
   openclaw config set plugins.load.paths '["~/.openclaw/extensions"]'

   # Restart
   openclaw gateway restart
   ```

8. **Tag release** (optional):
   ```bash
   git tag v2.2.0 -m "Context Persistence plugin v2.2.0"
   ```

9. **Commit final state:**
   ```bash
   git add -A
   git commit -m "Phase 8: Deployment verification and final tweaks"
   ```

**Acceptance criteria:**
- Plugin appears in `openclaw plugins list` as `context-persistence` (loaded)
- Gateway starts without errors
- `openclaw context-persistence show` works
- Compaction triggers state save and anchor injection
- Session-start injects previous context
- Cache statistics report numbers
- No regressions in agent behavior

---

## 6. Testing & Validation

### 6.0 Test Plan Overview

| Test Type | Scope | Tools | Pass Condition |
|-----------|-------|-------|----------------|
| Unit | `lib/state.js` | Jest/Vitest | ≥90% coverage, all assertions pass |
| Unit | `tools/index.js` & submodules | Jest/Vitest | All tools return expected shapes |
| Integration | Hook handlers with mock context | Jest/Vitest | Hooks complete without throwing; correct state modifications |
| System | Full plugin load/unload | `openclaw plugins doctor`, `list` | No errors, plugin shows loaded |
| E2E | Compaction + session restore | Manual + logs | State file written, system messages appear in agent context |
| CLI | All commands | `openclaw context-persistence *` | Exit code 0, sensible output |

### 6.1 Detailed Unit Test Cases - lib/state.js

#### 6.1.1 readState()

**Purpose:** Verify correct parsing of state file, handling of missing/invalid files, and cache invalidation behavior.

**Test Cases:**

```javascript
describe('readState', () => {
  const stateFilePath = '/workspace/CONTEXT_PERSISTENCE.md';
  const mockFs = require('mock-fs'); // or jest.mock('fs/promises')

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  afterEach(() => {
    mockFs.restore();
  });

  it('should return parsed YAML frontmatter + body when file exists and is valid', async () => {
    mockFs({
      [stateFilePath]: `---
version: "2.1"
project: "test-project"
task: "implement feature X"
status: "active"
next_steps:
  - "write tests"
  - "review PR"
---
Long-form context body here.
`
    });

    const state = await require('../lib/state').readState();
    expect(state).toEqual({
      version: '2.1',
      project: 'test-project',
      task: 'implement feature X',
      status: 'active',
      next_steps: ['write tests', 'review PR'],
      body: 'Long-form context body here.\n',
      updated: expect.any(String)
    });
    // Body should include the markdown content after frontmatter
    expect(state.body).toContain('Long-form context body');
  });

  it('should return null when file does not exist (ENOENT)', async () => {
    mockFs({}); // empty fs

    const state = await require('../lib/state').readState();
    expect(state).toBeNull();
  });

  it('should handle invalid YAML syntax gracefully and return null', async () => {
    mockFs({
      [stateFilePath]: `---
version: "2.1"
project: "test"
  bad_indentation: true
---
body
`
    });

    // Should log error and backup corrupt file
    const state = await require('../lib/state').readState();
    expect(state).toBeNull();
    // Verify backup was attempted (check fs.existsSync with .corrupt.* pattern)
    const backups = mockFs.listSync('/', { deep: false }).filter(f => f.includes('.corrupt.'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('should propagate permission errors (EACCES) and return null', async () => {
    mockFs({
      [stateFilePath]: { mode: 0o000, content: '---\nversion: "2.1"\n---' } // unreadable
    });

    const state = await require('../lib/state').readState();
    expect(state).toBeNull();
    // Should log error with file path
  });

  it('should handle empty file and return null', async () => {
    mockFs({ [stateFilePath]: '' });

    const state = await require('../lib/state').readState();
    expect(state).toBeNull();
  });

  it('should handle file with only frontmatter (no body) correctly', async () => {
    mockFs({
      [stateFilePath]: `---
version: "2.1"
project: "test"
---
`
    });

    const state = await require('../lib/state').readState();
    expect(state.body).toBeUndefined(); // body key may be undefined or empty string
    expect(state.version).toBe('2.1');
  });

  it('should migrate pre-2.0 state automatically (missing version field)', async () => {
    mockFs({
      [stateFilePath]: `---
project: "old-project"
task: "old task"
status: "active"
---
old body
`
    });

    const state = await require('../lib/state').readState();
    expect(state.version).toBe('2.1'); // current version applied
    expect(state.project).toBe('old-project');
    // Migration should not destroy other fields
  });

  it('should apply multiple migrations if needed (version chain)', async () => {
    // Test chain: 1.0 -> 2.0 -> 2.1
    // See lib/state.js for Migration function
  });

  it('should attach updated timestamp from frontmatter if present', async () => {
    const fixedTime = '2026-02-25T19:00:00Z';
    mockFs({
      [stateFilePath]: `---
version: "2.1"
updated: "${fixedTime}"
---
body
`
    });

    const state = await require('../lib/state').readState();
    expect(state.updated).toBe(fixedTime);
  });

  it('should handle extremely large state file without crashing (stress test)', async () => {
    const hugeBody = 'x'.repeat(10 * 1024 * 1024); // 10MB
    mockFs({
      [stateFilePath]: `---
version: "2.1"
project: "big"
---
${hugeBody}
`
    });

    // Should not throw OOM or hang; may need to increase Jest timeout
    const start = Date.now();
    const state = await require('../lib/state').readState();
    const duration = Date.now() - start;
    expect(state.body.length).toBeGreaterThan(1000000);
    expect(duration).toBeLessThan(5000); // should complete within 5s
  });

  it('should handle Unicode and special characters in all fields', async () => {
    mockFs({
      [stateFilePath]: `---
version: "2.1"
project: "Проект медведь 🐻"
task: "Implement café support ☕"
next_steps:
  - "Test emoji: 😀"
  - "Test RTL: שלום"
---
Body with émojî and \`code\` and "quotes"
`
    });

    const state = await require('../lib/state').readState();
    expect(state.project).toContain('🐻');
    expect(state.task).toContain('☕');
    expect(state.next_steps[0]).toContain('😀');
    expect(state.body).toContain('émojî');
  });
});
```

#### 6.1.2 writeState()

**Purpose:** Verify atomic writes, schema validation, optimistic concurrency control, error cleanup, and field merging.

**Test Cases:**

```javascript
describe('writeState', () => {
  const stateFilePath = '/workspace/CONTEXT_PERSISTENCE.md';
  const mockFs = require('mock-fs');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  afterEach(() => {
    mockFs.restore();
  });

  it('should write valid state file atomically with fsync', async () => {
    mockFs({}); // empty workspace

    const { writeState } = await import('../lib/state');
    const result = await writeState({
      version: '2.1',
      project: 'test-project',
      task: 'write test',
      status: 'in-progress'
    });

    expect(result).toBe(true);
    // Verify file exists
    const content = mockFs.readFileSync(stateFilePath, 'utf8');
    expect(content).toContain('version: "2.1"');
    expect(content).toContain('project: test-project');

    // Verify atomicity: temp file should not exist after success
    const tempFiles = mockFs.listSync('/', { deep: false }).filter(f => f.includes('.tmp.'));
    expect(tempFiles.length).toBe(0);
  });

  it('should auto-generate updated timestamp if not provided', async () => {
    mockFs({});

    const beforeWrite = Date.now();
    const { writeState } = await import('../lib/state');

    await writeState({ version: '2.1', project: 'ts' });
    const content = mockFs.readFileSync(stateFilePath, 'utf8');
    const doc = require('js-yaml').load(content);

    const updatedTime = new Date(doc.updated).getTime();
    expect(updatedTime).toBeGreaterThanOrEqual(beforeWrite);
    expect(updatedTime).toBeLessThanOrEqual(Date.now());
  });

  it('should merge with existing state, preserving unspecified fields', async () => {
    // Setup existing state file
    mockFs({
      [stateFilePath]: `---
version: "2.1"
project: "existing"
task: "existing task"
status: "active"
next_steps:
  - "existing step"
---
old body
`
    });

    const { writeState } = await import('../lib/state');
    await writeState({
      project: 'updated project',
      // task and next_steps not provided - should be preserved
    });

    const content = mockFs.readFileSync(stateFilePath, 'utf8');
    const doc = require('js-yaml').load(content);
    expect(doc.project).toBe('updated project');
    expect(doc.task).toBe('existing task'); // preserved
    expect(doc.next_steps).toEqual(['existing step']); // preserved
    expect(doc.body).toContain('old body'); // preserved (body not touched)
  });

  it('should reject write with invalid schema (missing version)', async () => {
    mockFs({});

    const { writeState } = await import('../lib/state');
    await expect(writeState({ project: 'test' }))
      .rejects.toThrow(/validation failed.*version/);
  });

  it('should reject write with invalid status enum value', async () => {
    mockFs({});

    const { writeState } = await import('../lib/state');
    await expect(writeState({
      version: '2.1',
      status: 'invalid-status'
    })).rejects.toThrow(/enum/);
  });

  it('should reject write with next_steps not an array', async () => {
    mockFs({});

    const { writeState } = await import('../lib/state');
    await expect(writeState({
      version: '2.1',
      next_steps: 'not an array'
    })).rejects.toThrow(/type/);
  });

  it('should handle concurrent writes with optimistic locking', async () => {
    mockFs({
      [stateFilePath]: `---
version: "2.1"
project: "original"
updated: "2026-02-25T00:00:00Z"
---
original
`
    });

    const { writeState, readState } = await import('../lib/state');

    // Simulate two concurrent writes
    const write1 = writeState({ project: 'writer1' });
    const write2 = writeState({ project: 'writer2' });

    // Force write1 to complete first by manually controlling time? Hard to test with real fs.
    // Instead, we'll test the logic by mocking readState inside writeState?
    // This test might be complex; document the pattern but skip actual implementation in unit test
    // Alternatively, use a fake-fs that allows race condition simulation.
    expect.assertions(2);
    const results = await Promise.allSettled([write1, write2]);
    // One should succeed, one should fail with concurrent modification error
    const successes = results.filter(r => r.status === 'fulfilled').length;
    expect(successes).toBe(1);
    const failures = results.filter(r => r.status === 'rejected');
    expect(failures[0].reason.message).toContain('Concurrent modification');
  });

  it('should clean up temp file on validation error', async () => {
    mockFs({});

    const { writeState } = await import('../lib/state');

    try {
      await writeState({ invalid: 'missing version' });
    } catch (err) {
      // expected
    }

    const tempFiles = mockFs.listSync('/', { deep: false }).filter(f => f.includes('.tmp.'));
    expect(tempFiles.length).toBe(0); // cleanup happened
  });

  it('should clean up temp file on I/O error during write', async () => {
    // Simulate disk full after writeFile but before fsync
    mockFs({
      [stateFilePath]: 'existing content'
    });

    const { writeState } = await import('../lib/state');
    // Mock fs.promises.writeFile to throw after writing? Hard with mock-fs.
    // This is a negative test that's hard without proper mocking of fs functions.
    // Document as important but may be skipped in early test suite.
  });

  it('should handle disk full (ENOSPC) by throwing descriptive error', async () => {
    // Setup mock fs to throw ENOSPC on writeFile or fsync
    // Requires stubbing fs.promises functions directly
    jest.unstable_mockModule('fs/promises', () => ({
      writeFile: jest.fn().mockRejectedValue(Object.assign(new Error('No space'), { code: 'ENOSPC' })),
      fsync: jest.fn(), // may not be reached
      rename: jest.fn(),
      unlink: jest.fn()
    }));

    const { writeState } = await import('../lib/state');
    await expect(writeState({ version: '2.1' }))
      .rejects.toMatchObject({ code: 'ENOSPC' });
  });

  it('should handle file system permission denied (EACCES) on rename', async () => {
    jest.unstable_mockModule('fs/promises', () => ({
      writeFile: jest.fn().mockResolvedValue(undefined),
      fsync: jest.fn().mockResolvedValue(undefined),
      rename: jest.fn().mockRejectedValue(Object.assign(new Error('Permission denied'), { code: 'EACCES' })),
      unlink: jest.fn()
    }));

    const { writeState } = await import('../lib/state');
    await expect(writeState({ version: '2.1' }))
      .rejects.toMatchObject({ code: 'EACCES' });
  });
});
```

#### 6.1.3 configureCache()

**Purpose:** Configure the LRU cache with dynamic settings from plugin config.

```javascript
describe('configureCache', () => {
  it('should configure cache with default values when called with empty config', () => {
    const { configureCache, getCacheStats } = require('../lib/state');

    configureCache({});
    const stats = getCacheStats();
    expect(stats.max).toBe(100); // default
    expect(stats.ttl).toBe(300000); // default 5 min
  });

  it('should configure cache with custom max and TTL', () => {
    const { configureCache, getCacheStats } = require('../lib/state');

    configureCache({ max: 50, ttlMs: 600000 });
    const stats = getCacheStats();
    expect(stats.max).toBe(50);
    expect(stats.ttl).toBe(600000);
  });

  it('should ignore undefined values and keep existing settings', () => {
    const { configureCache, getCacheStats } = require('../lib/state');

    configureCache({ max: 30, ttlMs: 120000 });
    configureCache({ max: undefined }); // only update max
    const stats = getCacheStats();
    expect(stats.max).toBe(30);
    expect(stats.ttl).toBe(120000); // unchanged
  });

  it('should reject negative or zero max (should clamp to 1 or throw?)', () => {
    // Define behavior: either throw error or set to 1
    const { configureCache, getCacheStats } = require('../lib/state');

    configureCache({ max: 0 });
    const stats = getCacheStats();
    expect(stats.max).toBeGreaterThanOrEqual(1);
  });
});
```

#### 6.1.4 getCacheStats() and getCache()

**Purpose:** Verify cache statistics and access.

```javascript
describe('cache operations', () => {
  it('getCacheStats should return size, max, ttl, hits, misses', () => {
    const { getCacheStats, getCache } = require('../lib/state');
    const cache = getCache();
    if (!cache) throw new Error('Cache not initialized');

    // Pre-warm cache with some entries
    cache.set('key1', { value: 'result1', mtime: Date.now(), timestamp: Date.now() });
    cache.set('key2', { value: 'result2', mtime: Date.now(), timestamp: Date.now() });

    const stats = getCacheStats();
    expect(stats.size).toBe(2);
    expect(stats.max).toBeGreaterThanOrEqual(2);
    expect(typeof stats.hits).toBe('number');
    expect(typeof stats.misses).toBe('number');
  });

  it('getCache should return LRU cache instance with get/set/clear methods', () => {
    const { getCache } = require('../lib/state');
    const cache = getCache();
    expect(cache).toBeDefined();
    expect(typeof cache.get).toBe('function');
    expect(typeof cache.set).toBe('function');
    expect(typeof cache.clear).toBe('function');
    expect(typeof cache.size).toBe('function');
  });

  it('cache.set should store value with mtime and timestamp', () => {
    const { getCache } = require('../lib/state');
    const cache = getCache();

    const key = 'test-key';
    const value = { results: ['a', 'b'] };
    const mtime = Date.now();
    cache.set(key, { value, mtime, timestamp: Date.now() });

    const entry = cache.get(key);
    expect(entry.value).toEqual(value);
    expect(entry.mtime).toBe(mtime);
    expect(entry.timestamp).toBeDefined();
  });

  it('cache.get should return undefined for non-existent key', () => {
    const { getCache } = require('../lib/state');
    const cache = getCache();

    const entry = cache.get('nonexistent');
    expect(entry).toBeUndefined();
  });
});
```

#### 6.1.5 validateState() and migrateState()

**Purpose:** Schema validation and state version migration.

```javascript
describe('validateState and migrateState', () => {
  const { validateState, migrateState } = require('../lib/state');

  it('validateState should accept valid state objects', () => {
    const valid = {
      version: '2.1',
      project: 'test',
      task: 'task',
      status: 'active',
      next_steps: ['a', 'b'],
      updated: new Date().toISOString()
    };
    expect(() => validateState(valid)).not.toThrow();
  });

  it('validateState should reject missing required fields', () => {
    const invalid = { version: '2.1' }; // missing status, next_steps, updated
    expect(() => validateState(invalid)).toThrow(/required/);
  });

  it('migrateState should add version if missing', () => {
    const old = { project: 'p', task: 't' };
    const migrated = migrateState(old);
    expect(migrated.version).toBe('2.1');
    expect(migrated.project).toBe('p');
  });

  it('migrateState should handle version 2.0 to 2.1 changes', () => {
    // If there are specific field changes between versions
    const v20 = { version: '2.0', status: 'active' };
    const migrated = migrateState(v20);
    expect(migrated.version).toBe('2.1');
    // Check other transformations
  });

  it('migrateState should be idempotent', () => {
    const state = { version: '2.1', project: 'p' };
    const once = migrateState(state);
    const twice = migrateState(once);
    expect(twice).toEqual(once);
  });
});
```

### 6.2 Integration Test Cases - Hook Handlers

**Purpose:** Verify hooks interact correctly with state, tools, and session context.

```javascript
describe('Hook Handlers', () => {
  const mockApiLog = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };

  const mockSession = {
    addSystemMessage: jest.fn().mockResolvedValue(undefined),
    // session may have other fields used by hooks
  };

  const mockCtx = {
    log: mockApiLog,
    session: mockSession,
    tools: {
      memory_search: jest.fn().mockResolvedValue([{ source: 'test.md', content: 'result' }]),
      cached_memory_search: jest.fn().mockResolvedValue([{ source: 'test.md', content: 'cached' }])
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    // Setup mock file system with initial state if needed
  });

  describe('preCompaction', () => {
    it('should save current state file before compaction', async () => {
      const { preCompaction } = await import('../hooks/preCompaction');

      // Mock state.readState to return some state
      jest.doMock('../lib/state', () => ({
        readState: jest.fn().mockResolvedValue({
          version: '2.1',
          project: 'current-project',
          updated: '2026-02-25T19:00:00Z'
        }),
        writeState: jest.fn().mockResolvedValue(true)
      }));

      await preCompaction(mockCtx);

      const { readState, writeState } = require('../lib/state');
      expect(readState).toHaveBeenCalled();
      expect(writeState).toHaveBeenCalledWith(expect.objectContaining({
        version: '2.1',
        project: 'current-project'
      }));
      expect(mockApiLog.info).toHaveBeenCalledWith(
        expect.stringContaining('State saved before compaction')
      );
    });

    it('should handle missing state file gracefully (no state to save)', async () => {
      jest.doMock('../lib/state', () => ({
        readState: jest.fn().mockResolvedValue(null),
        writeState: jest.fn()
      }));

      const { preCompaction } = await import('../hooks/preCompaction');
      await preCompaction(mockCtx);

      const { writeState } = require('../lib/state');
      expect(writeState).not.toHaveBeenCalled();
      expect(mockApiLog.debug).toHaveBeenCalledWith(
        expect.stringContaining('No state to save')
      );
    });

    it('should log error but not throw if write fails', async () => {
      jest.doMock('../lib/state', () => ({
        readState: jest.fn().mockResolvedValue({ version: '2.1' }),
        writeState: jest.fn().mockResolvedValue(false) // simulate failure
      }));

      const { preCompaction } = await import('../hooks/preCompaction');
      await expect(preCompaction(mockCtx)).resolves.not.toThrow();
      expect(mockApiLog.error).toHaveBeenCalledWith(
        expect.stringContaining('pre-compaction failed')
      );
    });
  });

  describe('postCompaction', () => {
    it('should inject context anchor system message after compaction', async () => {
      jest.doMock('../lib/state', () => ({
        readState: jest.fn().mockResolvedValue({
          version: '2.1',
          project: 'MyProject',
          task: 'Design system',
          next_steps: ['Step A', 'Step B'],
          body: 'Detailed context'
        })
      }));

      const { postCompaction } = await import('../hooks/postCompaction');
      await postCompaction(mockCtx);

      expect(mockSession.addSystemMessage).toHaveBeenCalledWith(
        expect.stringMatching(/Context: MyProject • Design system • Next: Step A; Step B/)
      );
      expect(mockApiLog.debug).toHaveBeenCalledWith(
        expect.stringContaining('Anchor injected')
      );
    });

    it('should not fail if state file does not exist', async () => {
      jest.doMock('../lib/state', () => ({
        readState: jest.fn().mockResolvedValue(null)
      }));

      const { postCompaction } = await import('../hooks/postCompaction');
      await expect(postCompaction(mockCtx)).resolves.not.toThrow();
      expect(mockSession.addSystemMessage).not.toHaveBeenCalled();
    });

    it('should handle empty next_steps gracefully', async () => {
      jest.doMock('../lib/state', () => ({
        readState: jest.fn().mockResolvedValue({
          project: 'Proj',
          task: 'Task',
          next_steps: []
        })
      }));

      const { postCompaction } = await import('../hooks/postCompaction');
      await postCompaction(mockCtx);

      expect(mockSession.addSystemMessage).toHaveBeenCalledWith(
        expect.stringContaining('Next: none')
      );
    });
  });

  describe('sessionStart', () => {
    it('should inject resume message with state body on session start', async () => {
      jest.doMock('../lib/state', () => ({
        readState: jest.fn().mockResolvedValue({
          body: 'Previous context notes...'
        }),
        getConfig: jest.fn().mockReturnValue({ enablePrefetch: false })
      }));

      const { sessionStart } = await import('../hooks/sessionStart');
      await sessionStart(mockCtx);

      expect(mockSession.addSystemMessage).toHaveBeenCalledWith(
        expect.stringContaining('[Resume] Previous context notes')
      );
    });

    it('should prefetch queries when enablePrefetch is true', async () => {
      jest.doMock('../lib/state', () => ({
        readState: jest.fn().mockResolvedValue({ body: 'state' }),
        getConfig: jest.fn().mockReturnValue({
          enablePrefetch: true,
          prefetchQueries: ['query1', 'query2', 'query3']
        })
      }));

      const { sessionStart } = await import('../hooks/sessionStart');
      await sessionStart(mockCtx);

      const { cached_memory_search } = mockCtx.tools;
      expect(cached_memory_search).toHaveBeenCalledTimes(3);
      expect(cached_memory_search).toHaveBeenCalledWith({ query: 'query1' });
      expect(cached_memory_search).toHaveBeenCalledWith({ query: 'query2' });
      expect(cached_memory_search).toHaveBeenCalledWith({ query: 'query3' });
    });

    it('should skip prefetch if tool not available', async () => {
      jest.doMock('../lib/state', () => ({
        readState: jest.fn().mockResolvedValue({}),
        getConfig: jest.fn().mockReturnValue({
          enablePrefetch: true,
          prefetchQueries: ['q1']
        })
      }));

      const mockCtxNoTool = {
        ...mockCtx,
        tools: { memory_search: mockCtx.tools.memory_search } // no cached_memory_search
      };

      const { sessionStart } = await import('../hooks/sessionStart');
      await sessionStart(mockCtxNoTool);

      expect(mockApiLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Prefetch skipped: cached_memory_search tool not available')
      );
    });

    it('should handle prefetch failures gracefully and continue', async () => {
      jest.doMock('../lib/state', () => ({
        readState: jest.fn().mockResolvedValue({}),
        getConfig: jest.fn().mockReturnValue({
          enablePrefetch: true,
          prefetchQueries: ['good', 'bad', 'good']
        })
      }));

      mockCtx.tools.cached_memory_search
        .mockImplementationOnce(async (params) => {
          if (params.query === 'bad') throw new Error('search failed');
          return [{ result: 'ok' }];
        })
        .mockResolvedValueOnce([{ result: 'ok2' }]);

      const { sessionStart } = await import('../hooks/sessionStart');
      await sessionStart(mockCtx);

      // Should still succeed overall
      expect(mockApiLog.info).toHaveBeenCalledWith(
        expect.stringContaining('Prefetch complete:')
      );
      // The error for 'bad' should be logged at debug level, not crash
    });
  });

  describe('shutdown', () => {
    it('should log cache statistics on shutdown', async () => {
      jest.doMock('../lib/state', () => ({
        getCacheStats: jest.fn().mockReturnValue({
          size: 42,
          max: 100,
          ttl: 300000,
          hits: 1234,
          misses: 567
        })
      }));

      const { shutdown } = await import('../hooks/shutdown');
      await shutdown(mockCtx);

      expect(mockApiLog.info).toHaveBeenCalledWith(
        expect.stringContaining('Shutdown cache stats:'),
        expect.objectContaining({ size: 42, hits: 1234, misses: 567 })
      );
    });

    it('should handle missing cache stats gracefully', async () => {
      jest.doMock('../lib/state', () => ({
        getCacheStats: jest.fn().mockReturnValue(undefined)
      }));

      const { shutdown } = await import('../hooks/shutdown');
      await expect(shutdown(mockCtx)).resolves.not.toThrow();
      const { getCacheStats } = require('../lib/state');
      expect(getCacheStats).toHaveBeenCalled();
    });
  });
});
```

### 6.3 Unit Test Cases - Tools

#### 6.3.1 context_persistence_read

```javascript
describe('context_persistence_read', () => {
  const mockCtx = { log: { debug: jest.fn() } };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('should return full state object including body', async () => {
    const mockState = {
      version: '2.1',
      project: 'MyProject',
      body: 'Context body text',
      updated: '2026-02-25T19:00:00Z'
    };
    jest.doMock('../lib/state', () => ({
      readState: jest.fn().mockResolvedValue(mockState)
    }));

    const { context_persistence_read } = await import('../tools/contextPersistenceRead');
    const result = await context_persistence_read({}, mockCtx);

    expect(result).toEqual(mockState);
  });

  it('should return null if no state file exists', async () => {
    jest.doMock('../lib/state', () => ({
      readState: jest.fn().mockResolvedValue(null)
    }));

    const { context_persistence_read } = await import('../tools/contextPersistenceRead');
    const result = await context_persistence_read({}, mockCtx);
    expect(result).toBeNull();
  });

  it('should not modify state; read-only operation', async () => {
    jest.doMock('../lib/state', () => ({
      readState: jest.fn().mockResolvedValue({ version: '2.1' })
    }));

    const { context_persistence_read } = await import('../tools/contextPersistenceRead');
    await context_persistence_read({}, mockCtx);

    const { readState } = require('../lib/state');
    expect(readState).toHaveBeenCalledWith(); // no args
  });
});
```

#### 6.3.2 context_persistence_write

```javascript
describe('context_persistence_write', () => {
  const mockCtx = { log: { debug: jest.fn() } };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('should write partial updates (only provided fields)', async () => {
    const existingState = {
      version: '2.1',
      project: 'OldProject',
      task: 'OldTask',
      status: 'active',
      next_steps: ['old1', 'old2'],
      body: 'old body',
      updated: '2026-02-25T00:00:00Z'
    };

    jest.doMock('../lib/state', () => ({
      readState: jest.fn().mockResolvedValue(existingState),
      writeState: jest.fn().mockResolvedValue(true)
    }));

    const { context_persistence_write } = await import('../tools/contextPersistenceWrite');
    await context_persistence_write({
      project: 'NewProject',
      status: 'blocked'
    }, mockCtx);

    const { writeState } = require('../lib/state');
    expect(writeState).toHaveBeenCalledWith(expect.objectContaining({
      version: '2.1',
      project: 'NewProject',
      task: 'OldTask', // preserved
      status: 'blocked',
      next_steps: ['old1', 'old2'], // preserved
      body: 'old body' // preserved
    }));
    // Updated timestamp should be auto-generated
    expect(writeState.mock.calls[0][0].updated).toBeDefined();
  });

  it('should validate required fields on initial write (version required)', async () => {
    jest.doMock('../lib/state', () => ({
      readState: jest.fn().mockResolvedValue(null),
      writeState: jest.fn()
    }));

    const { context_persistence_write } = await import('../tools/contextPersistenceWrite');

    await expect(context_persistence_write({
      project: 'TestProject'
      // missing version, status, next_steps, updated
    }, mockCtx)).rejects.toThrow(/validation failed/);
  });

  it('should handle writeState errors and propagate them', async () => {
    jest.doMock('../lib/state', () => ({
      readState: jest.fn().mockResolvedValue({ version: '2.1' }),
      writeState: jest.fn().mockRejectedValue(new Error('Disk full'))
    }));

    const { context_persistence_write } = await import('../tools/contextPersistenceWrite');
    await expect(context_persistence_write({ status: 'active' }, mockCtx))
      .rejects.toThrow('Disk full');
  });

  it('should reject unknown fields (additionalProperties: false)', async () => {
    jest.doMock('../lib/state', () => ({
      readState: jest.fn().mockResolvedValue({ version: '2.1' }),
      writeState: jest.fn().mockResolvedValue(true)
    }));

    const { context_persistence_write } = await import('../tools/contextPersistenceWrite');
    await expect(context_persistence_write({
      unknown_field: 'should fail'
    }, mockCtx)).rejects.toThrow(/additionalProperties/);
  });

  it('should accept body updates (markdown content)', async () => {
    const existing = { version: '2.1', body: 'old' };
    jest.doMock('../lib/state', () => ({
      readState: jest.fn().mockResolvedValue(existing),
      writeState: jest.fn().mockResolvedValue(true)
    }));

    const { context_persistence_write } = await import('../tools/contextPersistenceWrite');
    await context_persistence_write({ body: 'new body\nwith lines' }, mockCtx);

    const { writeState } = require('../lib/state');
    expect(writeState).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'new body\nwith lines' })
    );
  });
});
```

#### 6.3.3 context_persistence_discover

```javascript
describe('context_persistence_discover', () => {
  const mockCtx = {};

  it('should return plugin capabilities and available tools', async () => {
    const { context_persistence_discover } = await import('../tools/contextPersistenceDiscover');
    const result = await context_persistence_discover({}, mockCtx);

    expect(result).toHaveProperty('plugin', 'context-persistence');
    expect(result).toHaveProperty('version', '2.2.0');
    expect(result.tools).toContain('context_persistence_read');
    expect(result.tools).toContain('cached_memory_search');
    expect(result.hooks).toContain('pre-compaction');
    expect(result.hooks).toContain('post-compaction');
    expect(result.hooks).toContain('session-start');
    expect(result.hooks).toContain('shutdown');
  });

  it('should include cache configuration from state', async () => {
    jest.doMock('../lib/state', () => ({
      getConfig: jest.fn().mockReturnValue({
        cacheMax: 200,
        cacheTTLms: 600000,
        enablePrefetch: true,
        prefetchQueries: ['q1', 'q2']
      })
    }));

    const { context_persistence_discover } = await import('../tools/contextPersistenceDiscover');
    const result = await context_persistence_discover({}, mockCtx);

    expect(result.config).toEqual({
      cacheMax: 200,
      cacheTTLms: 600000,
      enablePrefetch: true,
      prefetchQueries: ['q1', 'q2']
    });
  });
});
```

#### 6.3.4 cached_memory_search

```javascript
describe('cached_memory_search', () => {
  const mockCtx = {
    log: { debug: jest.fn(), error: jest.fn() },
    tools: {
      memory_search: jest.fn()
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('should call memory_search on cache miss and cache result', async () => {
    const mockResult = [{ source: 'file.md', content: 'test', score: 0.9 }];
    mockCtx.tools.memory_search.mockResolvedValue(mockResult);

    jest.doMock('../lib/state', () => ({
      getCache: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(null), // miss
        set: jest.fn()
      })
    }));

    const { cached_memory_search } = await import('../tools/cachedMemorySearch');
    const result = await cached_memory_search({ query: 'test query' }, mockCtx);

    expect(mockCtx.tools.memory_search).toHaveBeenCalledWith({ query: 'test query' });
    expect(result).toEqual(mockResult);
  });

  it('should return cached result on hit (same query)', async () => {
    const cached = {
      value: [{ source: 'cached.md', content: 'cached', score: 0.95 }],
      mtime: Date.now(),
      timestamp: Date.now()
    };

    jest.doMock('../lib/state', () => ({
      getCache: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(cached)
      })
    }));

    const { cached_memory_search } = await import('../tools/cachedMemorySearch');
    const result = await cached_memory_search({ query: 'same' }, mockCtx);

    expect(mockCtx.tools.memory_search).not.toHaveBeenCalled();
    expect(result).toEqual(cached.value);
    expect(mockCtx.log.debug).toHaveBeenCalledWith(
      expect.stringContaining('Cache hit')
    );
  });

  it('should return fresh result if cache entry expired (TTL)', async () => {
    const oldTimestamp = Date.now() - 600000; // 10 min ago, TTL default 5 min
    const cached = {
      value: [{ source: 'old' }],
      mtime: Date.now(),
      timestamp: oldTimestamp
    };

    jest.doMock('../lib/state', () => ({
      getConfig: jest.fn().mockReturnValue({ cacheTTLms: 300000 }),
      getCache: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(cached),
        set: jest.fn()
      })
    }));

    mockCtx.tools.memory_search.mockResolvedValue([{ source: 'fresh' }]);

    const { cached_memory_search } = await import('../tools/cachedMemorySearch');
    const result = await cached_memory_search({ query: 'expired' }, mockCtx);

    expect(mockCtx.tools.memory_search).toHaveBeenCalled();
    expect(result[0].source).toBe('fresh');
  });

  it('should normalize cache key (sorted keys)', async () => {
    mockCtx.tools.memory_search.mockResolvedValue([{ source: 'res' }]);

    jest.doMock('../lib/state', () => ({
      getCache: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        set: jest.fn()
      })
    }));

    const { cached_memory_search } = await import('../tools/cachedMemorySearch');
    const call1 = cached_memory_search({ b: 2, a: 1 }, mockCtx);
    const call2 = cached_memory_search({ a: 1, b: 2 }, mockCtx);

    await Promise.all([call1, call2]);
    // Should have only called memory_search once (cache hit on second)
    expect(mockCtx.tools.memory_search).toHaveBeenCalledTimes(1);
  });

  it('should pass through memory_search errors', async () => {
    mockCtx.tools.memory_search.mockRejectedValue(new Error('search failed'));

    jest.doMock('../lib/state', () => ({
      getCache: jest.fn().mockReturnValue({ get: () => null })
    }));

    const { cached_memory_search } = await import('../tools/cachedMemorySearch');
    await expect(cached_memory_search({ query: 'x' }, mockCtx))
      .rejects.toThrow('search failed');
  });

  it('should handle cache disabled (getCache returns null)', async () => {
    mockCtx.tools.memory_search.mockResolvedValue([{ result: 'direct' }]);

    jest.doMock('../lib/state', () => ({
      getCache: jest.fn().mockReturnValue(null)
    }));

    const { cached_memory_search } = await import('../tools/cachedMemorySearch');
    const result = await cached_memory_search({ query: 'test' }, mockCtx);

    expect(mockCtx.tools.memory_search).toHaveBeenCalledWith({ query: 'test' });
    expect(result).toEqual([{ result: 'direct' }]);
  });

  it('should store mtime from search results for invalidation', async () => {
    mockCtx.tools.memory_search.mockResolvedValue([
      { source: 'a.md', mtime: 100000 },
      { source: 'b.md', mtime: 200000 }
    ]);

    jest.doMock('../lib/state', () => ({
      getCache: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        set: jest.fn()
      })
    }));

    const { cached_memory_search } = await import('../tools/cachedMemorySearch');
    await cached_memory_search({ query: 'test' }, mockCtx);

    const { getCache } = require('../lib/state');
    const cache = getCache();
    expect(cache.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        mtime: 200000 // should take max
      })
    );
  });
});
```

#### 6.3.5 context_persistence_summarize

```javascript
describe('context_persistence_summarize', () => {
  const mockCtx = {
    log: { info: jest.fn(), error: jest.fn() },
    tools: {
      llm: {
        chat: {
          complete: jest.fn().mockResolvedValue({
            content: 'Summary: project is X, task is Y, next steps Z'
          })
        }
      }
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('should call LLM to generate context anchor', async () => {
    jest.doMock('../lib/state', () => ({
      readState: jest.fn().mockResolvedValue({
        project: 'MyProject',
        task: 'Implement feature',
        next_steps: ['Write tests', 'Review']
      }),
      writeState: jest.fn().mockResolvedValue(true)
    }));

    const { context_persistence_summarize } = await import('../tools/contextPersistenceSummarize');
    const result = await context_persistence_summarize({}, mockCtx);

    expect(mockCtx.tools.llm.chat.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'system', content: expect.stringContaining('summarize') }),
          expect.objectContaining({ role: 'user', content: expect.stringContaining('MyProject') })
        ])
      })
    );
    expect(result).toHaveProperty('anchor');
  });

  it('should write generated anchor back to state', async () => {
    jest.doMock('../lib/state', () => ({
      readState: jest.fn().mockResolvedValue({ project: 'P' }),
      writeState: jest.fn().mockResolvedValue(true)
    }));

    const { context_persistence_summarize } = await import('../tools/contextPersistenceSummarize');
    await context_persistence_summarize({}, mockCtx);

    const { writeState } = require('../lib/state');
    expect(writeState).toHaveBeenCalledWith(
      expect.objectContaining({ context_anchor: expect.any(String) })
    );
  });

  it('should handle LLM errors gracefully', async () => {
    mockCtx.tools.llm.chat.complete.mockRejectedValue(new Error('API limit'));

    jest.doMock('../lib/state', () => ({
      readState: jest.fn().mockResolvedValue({ project: 'P' }),
      writeState: jest.fn()
    }));

    const { context_persistence_summarize } = await import('../tools/contextPersistenceSummarize');
    await expect(context_persistence_summarize({}, mockCtx))
      .rejects.toThrow('API limit');
  });

  it('should be optional tool (may not have LLM configured)', async () => {
    const mockCtxNoLLM = { log: { error: jest.fn() } }; // no tools.llm

    jest.doMock('../lib/state', () => ({
      readState: jest.fn().mockResolvedValue({ project: 'P' }),
      writeState: jest.fn()
    }));

    const { context_persistence_summarize } = await import('../tools/contextPersistenceSummarize');
    await expect(context_persistence_summarize({}, mockCtxNoLLM))
      .rejects.toThrow(/llm/); // should fail with descriptive error
  });
});
```

#### 6.3.6 context_persistence_prefetch

```javascript
describe('context_persistence_prefetch', () => {
  const mockCtx = {
    log: { info: jest.fn(), debug: jest.fn() },
    tools: {
      cached_memory_search: jest.fn().mockResolvedValue([{ result: 'prefetched' }])
    }
  };

  it('should call cached_memory_search with prefetchQueries from config', async () => {
    jest.doMock('../lib/state', () => ({
      getConfig: jest.fn().mockReturnValue({
        enablePrefetch: true,
        prefetchQueries: ['query A', 'query B']
      })
    }));

    const { context_persistence_prefetch } = await import('../tools/contextPersistencePrefetch');
    await context_persistence_prefetch({}, mockCtx);

    expect(mockCtx.tools.cached_memory_search).toHaveBeenCalledTimes(2);
    expect(mockCtx.tools.cached_memory_search).toHaveBeenCalledWith({ query: 'query A' });
    expect(mockCtx.tools.cached_memory_search).toHaveBeenCalledWith({ query: 'query B' });
  });

  it('should do nothing if enablePrefetch is false', async () => {
    jest.doMock('../lib/state', () => ({
      getConfig: jest.fn().mockReturnValue({
        enablePrefetch: false,
        prefetchQueries: ['query']
      })
    }));

    const { context_persistence_prefetch } = await import('../tools/contextPersistencePrefetch');
    await context_persistence_prefetch({}, mockCtx);

    expect(mockCtx.tools.cached_memory_search).not.toHaveBeenCalled();
  });

  it('should do nothing if prefetchQueries is empty', async () => {
    jest.doMock('../lib/state', () => ({
      getConfig: jest.fn().mockReturnValue({
        enablePrefetch: true,
        prefetchQueries: []
      })
    }));

    const { context_persistence_prefetch } = await import('../tools/contextPersistencePrefetch');
    await context_persistence_prefetch({}, mockCtx);

    expect(mockCtx.tools.cached_memory_search).not.toHaveBeenCalled();
  });

  it('should wait for all prefetches to complete', async () => {
    const delays = [10, 20, 5];
    mockCtx.tools.cached_memory_search
      .mockImplementationOnce(async (params) => {
        await new Promise(resolve => setTimeout(resolve, delays.shift()));
        return [{ result: params.query }];
      });

    jest.doMock('../lib/state', () => ({
      getConfig: jest.fn().mockReturnValue({
        enablePrefetch: true,
        prefetchQueries: ['a', 'b', 'c']
      })
    }));

    const { context_persistence_prefetch } = await import('../tools/contextPersistencePrefetch');
    const start = Date.now();
    await context_persistence_prefetch({}, mockCtx);
    const duration = Date.now() - start;

    // Should have run in parallel, total time should be ~max delay (20ms), not sum (35ms)
    expect(duration).toBeLessThan(50);
  });

  it('should log failures without blocking other queries', async () => {
    mockCtx.tools.cached_memory_search
      .mockResolvedValueOnce([{ result: 'ok' }])
      .mockRejectedValueOnce(new Error('fail1'))
      .mockResolvedValueOnce([{ result: 'ok2' }]);

    jest.doMock('../lib/state', () => ({
      getConfig: jest.fn().mockReturnValue({
        enablePrefetch: true,
        prefetchQueries: ['good1', 'bad', 'good2']
      })
    }));

    const { context_persistence_prefetch } = await import('../tools/contextPersistencePrefetch');
    await context_persistence_prefetch({}, mockCtx);

    expect(mockCtx.log.debug).toHaveBeenCalledWith(
      expect.stringContaining('Prefetch query failed')
    );
    // Should still call for all three
    expect(mockCtx.tools.cached_memory_search).toHaveBeenCalledTimes(3);
  });
});
```

### 6.4 CLI Command Tests

```javascript
describe('CLI Commands', () => {
  const mockLog = { info: jest.fn(), error: jest.fn() };
  const mockApi = { log: mockLog };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    // Mock process.stdout.write if needed
  });

  describe('context-persistence show', () => {
    it('should print formatted state to stdout', async () => {
      const mockState = {
        version: '2.1',
        project: 'TestProject',
        task: 'Test task',
        status: 'active',
        next_steps: ['Step 1', 'Step 2'],
        body: 'Detailed body\nwith multiple lines',
        updated: '2026-02-25T19:00:00Z'
      };

      jest.doMock('../lib/state', () => ({
        readState: jest.fn().mockResolvedValue(mockState)
      }));

      const { registerCommands } = await import('../cli/commands');
      // Simulate commander action by calling the handler directly
      const program = { command: jest.fn().mockReturnThis(), description: jest.fn().mockReturnThis(), action: jest.fn() };
      registerCommands(mockApi);

      // Extract the action function from program.command('show').action(fn)
      const showAction = program.command.mock.calls.find(call => call[0] === 'show')[1].action;
      await showAction();

      // Verify output contains key fields
      const logOutput = mockLog.info.mock.calls.map(c => c[0]).join('\n');
      expect(logOutput).toContain('version: 2.1');
      expect(logOutput).toContain('project: TestProject');
      expect(logOutput).toContain('--- Context ---');
      expect(logOutput).toContain('Detailed body');
    });

    it('should print "No state file found" when state is null', async () => {
      jest.doMock('../lib/state', () => ({
        readState: jest.fn().mockResolvedValue(null)
      }));

      const { registerCommands } = await import('../cli/commands');
      const program = { command: jest.fn().mockReturnThis(), description: jest.fn().mockReturnThis(), action: jest.fn() };
      registerCommands(mockApi);

      const showAction = program.command.mock.calls.find(call => call[0] === 'show')[1].action;
      await showAction();

      expect(mockLog.info).toHaveBeenCalledWith('No state file found.');
    });
  });

  describe('context-persistence set', () => {
    it('should call writeState with the provided key-value pair', async () => {
      jest.doMock('../lib/state', () => ({
        readState: jest.fn().mockResolvedValue({ version: '2.1' }),
        writeState: jest.fn().mockResolvedValue(true)
      }));

      const { registerCommands } = await import('../cli/commands');
      const program = { command: jest.fn().mockReturnThis(), description: jest.fn().mockReturnThis(), action: jest.fn() };
      registerCommands(mockApi);

      const setAction = program.command.mock.calls.find(call => call[0] === 'set')[1].action;
      await setAction('project', 'NewProject');

      const { writeState } = require('../lib/state');
      expect(writeState).toHaveBeenCalledWith({ project: 'NewProject' });
    });

    it('should parse JSON values when string starts with { or [', async () => {
      jest.doMock('../lib/state', () => ({
        readState: jest.fn().mockResolvedValue({ version: '2.1' }),
        writeState: jest.fn().mockResolvedValue(true)
      }));

      const { registerCommands } = await import('../cli/commands');
      const program = { command: jest.fn().mockReturnThis(), description: jest.fn().mockReturnThis(), action: jest.fn() };
      registerCommands(mockApi);

      const setAction = program.command.mock.calls.find(call => call[0] === 'set')[1].action;
      await setAction('next_steps', '["step 1", "step 2"]');

      const { writeState } = require('../lib/state');
      expect(writeState).toHaveBeenCalledWith({
        next_steps: ['step 1', 'step 2']
      });
    });

    it('should reject invalid key names', async () => {
      jest.doMock('../lib/state', () => ({
        readState: jest.fn().mockResolvedValue({ version: '2.1' }),
        writeState: jest.fn()
      }));

      const { registerCommands } = await import('../cli/commands');
      const program = { command: jest.fn().mockReturnThis(), description: jest.fn().mockReturnThis(), action: jest.fn() };
      registerCommands(mockApi);

      const setAction = program.command.mock.calls.find(call => call[0] === 'set')[1].action;
      await setAction('invalid_key', 'value');

      expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining("Invalid field 'invalid_key'"));
    });
  });

  describe('context-persistence cache-stats', () => {
    it('should display cache statistics', async () => {
      jest.doMock('../lib/state', () => ({
        getCacheStats: jest.fn().mockReturnValue({ size: 42, max: 100, ttl: 300000, hits: 1000, misses: 200 })
      }));

      const { registerCommands } = await import('../cli/commands');
      const program = { command: jest.fn().mockReturnThis(), description: jest.fn().mockReturnThis(), action: jest.fn() };
      registerCommands(mockApi);

      const statsAction = program.command.mock.calls.find(call => call[0] === 'cache-stats')[1].action;
      await statsAction();

      expect(mockLog.info).toHaveBeenCalledWith(
        'Cache size: 42/100 (TTL: 300000ms)'
      );
    });
  });

  describe('context-persistence cache-clear', () => {
    it('should clear the cache and report number of entries cleared', async () => {
      const mockCache = {
        clear: jest.fn(),
        size: jest.fn().mockReturnValue(50)
      };

      jest.doMock('../lib/state', () => ({
        getCache: jest.fn().mockReturnValue(mockCache)
      }));

      const { registerCommands } = await import('../cli/commands');
      const program = { command: jest.fn().mockReturnThis(), description: jest.fn().mockReturnThis(), action: jest.fn() });
      registerCommands(mockApi);

      const clearAction = program.command.mock.calls.find(call => call[0] === 'cache-clear')[1].action;
      await clearAction();

      expect(mockCache.clear).toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith('Cache cleared (50 entries)');
    });

    it('should handle missing cache gracefully', async () => {
      jest.doMock('../lib/state', () => ({
        getCache: jest.fn().mockReturnValue(null)
      }));

      const { registerCommands } = await import('../cli/commands');
      const program = { command: jest.fn().mockReturnThis(), description: jest.fn().mockReturnThis(), action: jest.fn() });
      registerCommands(mockApi);

      const clearAction = program.command.mock.calls.find(call => call[0] === 'cache-clear')[1].action;
      await clearAction();

      expect(mockLog.info).toHaveBeenCalledWith('Cache not available');
    });
  });
});
```

### 6.5 Edge Case and Error Handling Tests

**File System Errors:**

```javascript
describe('File System Edge Cases', () => {
  it('should handle disk quota exceeded (EDQUOT)', async () => {
    // Mock fs to throw EDQUOT on writeFile/fsync
  });

  it('should handle read-only file system (EROFS)', async () => {
    // Mock fs to throw EROFS
  });

  it('should handle too many symbolic links (ELOOP)', async () => {
    // Mock circular symlink in path
  });

  it('should handle file name too long (ENAMETOOLONG)', async () => {
    // Mock extremely long path
  });
});
```

**Schema Violations:**

```javascript
describe('Schema Validation Edge Cases', () => {
  it('should reject status values that are not in enum', () => {
    const invalidStatuses = ['IN_PROGRESS', 'pending', 'cancelled', ''];
    invalidStatuses.forEach(status => {
      expect(() => validateState({ version: '2.1', status, next_steps: [], updated: new Date().toISOString() }))
        .toThrow(/enum/);
    });
  });

  it('should reject next_steps with non-string items', () => {
    expect(() => validateState({
      version: '2.1',
      status: 'active',
      next_steps: [123, null, { obj: true }],
      updated: new Date().toISOString()
    })).toThrow(/string/);
  });

  it('should reject version field with non-string value', () => {
    expect(() => validateState({
      version: 2.1, // number not string
      status: 'active',
      next_steps: [],
      updated: new Date().toISOString()
    })).toThrow();
  });
});
```

**Concurrent Access:**

```javascript
describe('Concurrent Access Pattern', () => {
  it('should handle two reads while one write is in progress (no corruption)', async () => {
    // This tests read operations during a write - readers should see either old or new fully-written state, never partial
  });

  it('should handle many concurrent writes with sequential wins (last-writer-wins with conflict detection)', async () => {
    // Stress test with 10 concurrent writes; expect some failures with concurrent modification error
  });
});
```

### 6.6 Test Coverage Matrix

| Module | Function/Method | What Should Be Tested | Test Type | Expected Coverage |
|--------|-----------------|----------------------|-----------|-------------------|
| `lib/state.js` | `readState()` | Valid file, missing file, invalid YAML, permission denied, empty file, only frontmatter, migration paths, large file, Unicode, I/O errors | Unit | 100% |
| `lib/state.js` | `writeState()` | Atomicity, fsync, timestamp auto-gen, field merging, schema validation (valid/invalid), temp file cleanup on error, concurrency control, disk full, permission errors, encoding errors | Unit | 100% |
| `lib/state.js` | `configureCache()` | Default config, custom config, partial updates, invalid values | Unit | 100% |
| `lib/state.js` | `getCache()` | Returns cache instance, null when unconfigured | Unit | 100% |
| `lib/state.js` | `getCacheStats()` | Returns size, max, ttl, hits, misses | Unit | 100% |
| `lib/state.js` | `validateState()` | Valid object, missing required, type mismatches, enum violations | Unit | 100% |
| `lib/state.js` | `migrateState()` | Pre-2.0 → 2.1, 2.0 → 2.1, idempotence, no-op on current version | Unit | 100% |
| `tools/contextPersistenceRead.js` | `context_persistence_read` | Returns state, returns null, no side effects | Unit | 100% |
| `tools/contextPersistenceWrite.js` | `context_persistence_write` | Partial updates, full validation, errors propagate, idempotence | Unit | 100% |
| `tools/contextPersistenceDiscover.js` | `context_persistence_discover` | Returns plugin metadata, tools list, hooks list, config snapshot | Unit | 100% |
| `tools/cachedMemorySearch.js` | `cached_memory_search` | Cache hit, miss, TTL expiry, key normalization, cache disabled, result mtime calculation, error passthrough | Unit | 100% |
| `tools/contextPersistenceSummarize.js` | `context_persistence_summarize` | LLM called with correct prompt, result written to state, LLM error handling, missing LLM | Unit | 100% (with mock LLM) |
| `tools/contextPersistencePrefetch.js` | `context_persistence_prefetch` | Prefetch triggered when enabled, skipped when disabled, parallel execution, failure tolerance | Unit | 100% |
| `hooks/preCompaction.js` | `preCompaction` | Saves state on valid data, no-op on missing state, error logged (no throw) | Integration | 100% |
| `hooks/postCompaction.js` | `postCompaction` | Injects anchor message, handles empty next_steps, no failure on missing state | Integration | 100% |
| `hooks/sessionStart.js` | `sessionStart` | Injects resume message with body, triggers prefetch when config enabled, skips if tool missing, logs prefetch results | Integration | 100% |
| `hooks/shutdown.js` | `shutdown` | Logs cache stats, handles missing stats | Integration | 100% |
| `cli/commands.js` | `show` | Formats output, handles null state, prints body section | Integration | 100% |
| `cli/commands.js` | `set` | Parses JSON values, validates keys, calls writeState | Integration | 100% |
| `cli/commands.js` | `cache-stats` | Calls getCacheStats and formats | Integration | 100% |
| `cli/commands.js` | `cache-clear` | Calls cache.clear, reports size, handles null cache | Integration | 100% |

**Overall Target Coverage:** ≥90% statements, ≥85% branches, ≥90% functions across `lib/` and `tools/`.

### 6.7 Mock Fixtures

Create `tests/__mocks__/` directory containing reusable mock objects:

```javascript
// tests/__mocks__/api.js - Mock OpenClaw API object
module.exports = {
  config: {
    cacheMax: 100,
    cacheTTLms: 300000,
    enablePrefetch: false,
    prefetchQueries: [],
    summarizationBudget: {
      maxCallsPerHour: 10,
      enabled: true
    }
  },
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  },
  registerTool: jest.fn(),
  registerHook: jest.fn(),
  registerCli: jest.fn()
};
```

```javascript
// tests/__mocks__/ctx.js - Mock agent context object
module.exports = (overrides = {}) => ({
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  },
  session: {
    id: 'session-123',
    addSystemMessage: jest.fn().mockResolvedValue(undefined),
    // Include any fields that tools might read from ctx.session
    project: 'default-project',
    task: 'default-task',
    status: 'active',
    last_action: '',
    next_steps: [],
    body: '',
    context_anchor: '',
    conversation_summary: ''
  },
  tools: {
    memory_search: jest.fn().mockResolvedValue([
      { source: 'memory/test.md', content: 'search result', score: 0.95, mtime: Date.now() }
    ]),
    // cached_memory_search will be provided by the plugin itself
    llm: {
      chat: {
        complete: jest.fn().mockResolvedValue({
          content: 'Mock LLM summary response'
        })
      }
    }
  },
  ...overrides // allow test-specific overrides
});
```

```javascript
// tests/__mocks__/fs.js - Mock file system using mock-fs
const mockFs = require('mock-fs');

// Helper to create a workspace with initial state file
function createWorkspace(stateContent) {
  mockFs({
    '/workspace/CONTEXT_PERSISTENCE.md': stateContent || '',
    // Add other files as needed (e.g., memory files for search tests)
  });
}

module.exports = { mockFs, createWorkspace };
```

```javascript
// tests/__mocks__/memorySearchResponse.js - Standard mock memory_search result
module.exports = [
  {
    source: 'memory/meeting-2026-02-25.md',
    content: 'Discussed project Alpha timeline.',
    score: 0.987,
    mtime: 1740513600000
  },
  {
    source: 'memory/design-decisions.md',
    content: 'Chose React over Vue for frontend.',
    score: 0.924,
    mtime: 1740427200000
  }
];
```

### 6.8 Test Data Sets

Place test data files in `tests/fixtures/`:

```yaml
# tests/fixtures/valid-state-v2.1.yaml
---
version: "2.1"
project: "Demo Project"
task: "Add user authentication"
status: "in-progress"
last_action: "Implemented OAuth2 flow"
next_steps:
  - "Write unit tests"
  - "Update documentation"
  - "Submit PR"
context_anchor: "Working on auth"
conversation_summary: "Short summary of recent work"
updated: "2026-02-25T19:00:00.000Z"
---
This is the body section with detailed notes, decisions, and context.

* Decision: Use JWT tokens
* Blockers: None
* Next meeting: Friday
```

```yaml
# tests/fixtures/state-missing-version.yaml
---
project: "Old Project"
task: "Legacy task"
status: "active"
next_steps: ["migrate"]
---
Legacy body without version field; should auto-migrate to 2.1
```

```yaml
# tests/fixtures/state-invalid-status.yaml
---
version: "2.1"
status: "in progress"  # invalid, should be in-progress or enum value
next_steps: []
updated: "2026-02-25T19:00:00Z"
---
This state should fail validation due to status.
```

```yaml
# tests/fixtures/state-corrupt.yaml
---
version: "2.1"
project: "Test"
  bad_indentation: oops
next_steps: []
---
Corrupt YAML; parser should back it up and return null
```

```markdown
# tests/fixtures/state-with-large-body.md
---
version: "2.1"
project: "Big"
status: "active"
next_steps: []
updated: "2026-02-25T19:00:00Z"
---
[10MB of repeated text here]
```

### 6.9 Performance Testing

Create `tests/performance/` directory for benchmark tests using `benchmark` or custom timers:

```javascript
// tests/performance/state-benchmarks.js
const { performance } = require('perf_hooks');
const { readState, writeState } = require('../lib/state');

describe('Performance Benchmarks', () => {
  const ITERATIONS = 100;

  it('should read state file within 50ms average (SSD)', async () => {
    // Pre-write a valid state file first
    await writeState({ version: '2.1', project: 'benchmark', status: 'active', next_steps: [] });

    const times = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      await readState();
      times.push(performance.now() - start);
    }

    const avg = times.reduce((a, b) => a + b, 0) / ITERATIONS;
    const max = Math.max(...times);
    console.log(`readState avg: ${avg.toFixed(2)}ms, max: ${max.toFixed(2)}ms`);
    expect(avg).toBeLessThan(50);
    expect(max).toBeLessThan(200); // Allow occasional spikes
  });

  it('should write state file within 50ms average (SSD)', async () => {
    const times = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      await writeState({ version: '2.1', project: `bench-${i}` });
      times.push(performance.now() - start);
    }

    const avg = times.reduce((a, b) => a + b, 0) / ITERATIONS;
    const max = Math.max(...times);
    console.log(`writeState avg: ${avg.toFixed(2)}ms, max: ${max.toFixed(2)}ms`);
    expect(avg).toBeLessThan(50);
    expect(max).toBeLessThan(200);
  });
});
```

```javascript
// tests/performance/cache-benchmarks.js
const { getCache, configureCache } = require('../lib/state');

describe('Cache Performance', () => {
  beforeEach(() => {
    configureCache({ max: 1000, ttlMs: 300000 });
  });

  it('should have cache hit < 5ms', async () => {
    const cache = getCache();
    const key = 'test-key';
    cache.set(key, { value: 'result', mtime: Date.now(), timestamp: Date.now() });

    const times = [];
    for (let i = 0; i < 1000; i++) {
      const start = process.hrtime.bigint();
      cache.get(key);
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
      times.push(elapsed);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    expect(avg).toBeLessThan(5);
  });

  it('should evict LRU entries when exceeding max capacity', () => {
    const cache = getCache();
    const max = 10;

    // Insert max+1 entries
    for (let i = 0; i < max + 1; i++) {
      cache.set(`key${i}`, { value: i, mtime: Date.now(), timestamp: Date.now() });
    }

    expect(cache.size()).toBe(max);
    // Oldest entry (key0) should be evicted
    expect(cache.get('key0')).toBeUndefined();
  });
});
```

```javascript
// tests/performance/hook-benchmarks.js
const { performance } = require('perf_hooks');
const { preCompaction, postCompaction, sessionStart } = require('../hooks');

describe('Hook Performance', () => {
  const mockCtx = {
    log: { info: jest.fn(), debug: jest.fn() },
    session: { addSystemMessage: jest.fn().mockResolvedValue(undefined) },
    tools: {
      cached_memory_search: jest.fn().mockResolvedValue([{ result: 'ok' }])
    }
  };

  it('preCompaction should complete within 500ms (excluding I/O wait)', async () => {
    // Mock state.readState/writeState to be fast
    jest.doMock('../lib/state', () => ({
      readState: jest.fn().mockResolvedValue({ version: '2.1', project: 'p', task: 't' }),
      writeState: jest.fn().mockResolvedValue(true)
    }));

    const { preCompaction } = await import('../hooks/preCompaction');
    const start = performance.now();
    await preCompaction(mockCtx);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(500);
  });

  it('sessionStart with 5 prefetch queries should complete within 2s', async () => {
    jest.doMock('../lib/state', () => ({
      readState: jest.fn().mockResolvedValue({}),
      getConfig: jest.fn().mockReturnValue({
        enablePrefetch: true,
        prefetchQueries: ['q1', 'q2', 'q3', 'q4', 'q5']
      })
    }));

    // Simulate slow memory_search (50ms each)
    mockCtx.tools.cached_memory_search.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return [{ result: 'ok' }];
    });

    const { sessionStart } = await import('../hooks/sessionStart');
    const start = performance.now();
    await sessionStart(mockCtx);
    const duration = performance.now() - start;

    // 5 queries in parallel should take ~50ms, but allow 2s for overhead
    expect(duration).toBeLessThan(2000);
  });
});
```

### 6.10 CI/CD Integration

#### GitHub Actions Workflow

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18.x, 20.x, 22.x]

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js ${{ matrix.node }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}

      - name: Install dependencies
        run: |
          cd plugins/context-persistence
          npm ci

      - name: Run lint (if configured)
        run: |
          cd plugins/context-persistence
          npx eslint . || echo "No ESLint config"

      - name: Run tests with coverage
        run: |
          cd plugins/context-persistence
          npm test -- --coverage --coverage.reporter=lcov --coverage.reporter=text-summary

      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v3
        with:
          file: plugins/context-persistence/coverage/lcov.info
          flags: unittests
          name: codecov-umbrella

      - name: Check coverage thresholds
        run: |
          cd plugins/context-persistence
          # Extract coverage from summary and fail if below threshold
          COVERAGE=$(npm test 2>&1 | grep -oP 'All files[^0-9]*\K[0-9.]+' || echo "0")
          echo "Overall coverage: $COVERAGE%"
          if (( $(echo "$COVERAGE < 90" | bc -l) )); then
            echo "Coverage below 90% threshold"
            exit 1
          fi
```

#### Test Automation Commands

Add to `package.json`:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:perf": "vitest run tests/performance",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit", // if using TypeScript later
    "verify": "npm run lint && npm test && npm run test:perf"
  }
}
```

#### Coverage Requirements

- **Statements:** ≥ 90%
- **Branches:** ≥ 85%
- **Functions:** ≥ 90%
- **Lines:** ≥ 90%

Enforce via CI gate; PRs failing coverage check must be updated.

### 6.11 Testing Conventions

#### Naming Conventions

- Test files: `<module>.test.js` (e.g., `state.test.js`, `cachedMemorySearch.test.js`)
- Hook test file: `hooks.test.js`
- CLI test file: `cli.test.js`
- Performance: `performance/<benchmark-name>.js`
- Describe blocks: `describe('<module>', () => { ... })`
- It blocks: `it('should <expected behavior> when <condition>', () => { ... })`
- Hooks: `beforeEach`, `afterEach`, `beforeAll`, `afterAll` as needed

#### Mocks vs Real Implementations

- **Heavily mock external dependencies:** `fs/promises`, `ctx.tools.memory_search`, `ctx.tools.llm`, `api` object.
- **Use real lib/state.js implementation when testing tools and hooks** (unit tests for tools should use mocked state module only for specific operations like `getCache` or `getConfig`; otherwise use `jest.doMock` for precise control).
- **For integration tests**, mock the context but use real tool implementations (require them normally).
- **Never hit real file system in unit tests**; use `mock-fs` to create isolated temporary workspace.
- **Never call real LLM or memory_search** in tests; always mock to return deterministic fixtures.

#### Testing Async Operations

- Always `await` async functions; avoid `.then()` for clarity.
- Use `resolves`/`rejects` matchers: `await expect(promise).resolves.toEqual(...)`, `await expect(promise).rejects.toThrow(...)`.
- For Promise.all patterns, test both fulfilled and rejected outcomes.
- Add explicit timeouts for async tests if needed (default Jest timeout is 5s; increase with `jest.setTimeout(10000)` for I/O-heavy tests).

#### Error Case Testing Patterns

For each error scenario:
1. Mock the underlying error (e.g., `fs.promises.writeFile` throws `new Error('ENOSPC')`).
2. Call the function under test.
3. Assert that the error is thrown (or logged, depending on expected behavior).
4. Verify side effects: temp file cleaned up, logs called with appropriate level.

**Pattern:**
```javascript
it('should handle <error scenario>', async () => {
  jest.doMock('fs/promises', () => ({
    writeFile: jest.fn().mockRejectedValue(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }))
  }));

  const { writeState } = await import('../lib/state');
  await expect(writeState({ version: '2.1' }))
    .rejects.toMatchObject({ code: 'ENOSPC' });
});
```

#### Fixture Loading

Create helper to load fixture files:

```javascript
// tests/helpers.js
const fs = require('fs');
const path = require('path');

function loadFixture(name) {
  const fixturePath = path.join(__dirname, 'fixtures', name);
  return fs.readFileSync(fixturePath, 'utf8');
}

module.exports = { loadFixture };
```

Then in tests:
```javascript
const { loadFixture } = require('./helpers');
const validStateYaml = loadFixture('valid-state-v2.1.yaml');
```

#### Log Assertions

Mock log functions (`jest.fn()`) and assert they were called with expected messages:

```javascript
expect(mockLog.error).toHaveBeenCalledWith(
  expect.stringContaining('pre-compaction failed')
);
```

Use `expect.stringMatching(/regex/)` for complex patterns.

#### Cache Assertions

For LRU cache tests, verify:
- `cache.size()` (number of entries)
- `cache.get(key)` returns expected or undefined
- `cache.set` called with correct parameters
- Eviction order (ifLRU implementation exposes it or can be inferred)

#### Isolation and Cleanup

- Use `jest.resetModules()` between tests to clear module cache.
- Use `jest.clearAllMocks()` to reset mock call counts.
- Ensure `mockFs.restore()` in `afterEach` to avoid cross-test contamination.
- Never write to real workspace; keep all file operations within mock-fs.

### 6.12 Additional Test Categories (Future)

- **Fuzz testing:** Generate random but valid state objects to test serializer/deserializer robustness.
- **Memory leak detection:** Use heap snapshots to ensure no leaks in cache over time.
- **Integration with real Gateway:** (Not unit tests) - Deploy plugin to sandbox Gateway and run behavioral tests via MCP or direct tool invocation.

---

**End of Phase 6 Expansion**

---

## 7. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Hook script path mismatch after move | Medium | High | Double-check manifest paths; test each hook individually |
| Tool registration conflicts with skill system | Low | Medium | Remove `tools` array from manifest; rely solely on `api.registerTool` |
| Cache not persisting across restarts (expected) | Low | Low | Document that cache is in-memory only; state persisted to file |
| LLM call failures in summarization | Medium | Medium | Make summarization optional; fallback to plain state dump |
| Config validation errors during Gateway start | Medium | High | Validate JSON Schema locally before restart; use `openclaw plugins doctor` |
| State file schema drift | Medium | Medium | Keep schema in `lib/state.js` as source of truth; version field with migrations if needed |
| Permission denied on state file write | Low | Medium | Ensure workspace root is writable; handle error gracefully |
| Unknown port scans (unrelated) | N/A | N/A | Not in scope; already alerted earlier |

---

## 8. Deliverables

| Item | Location | Status |
|------|----------|--------|
| Plugin manifest | `plugins/context-persistence/openclaw.plugin.json` | ✅ Created |
| Refactoring plan | `plugins/context-persistence/REFACTOR_PLAN.md` | ✅ Created |
| Software specification | `plugins/context-persistence/SOFTWARE_SPECIFICATION.md` | ✅ This document |
| Main plugin entry | `plugins/context-persistence/index.js` | ❌ To implement |
| Core state module | `plugins/context-persistence/lib/state.js` | ❌ To implement |
| Tool implementations | `plugins/context-persistence/tools/` | ❌ To implement |
| Hook handlers | `plugins/context-persistence/hooks/` | ❌ To implement (after move) |
| CLI commands | `plugins/context-persistence/cli/` | ❌ To implement |
| Tests | `plugins/context-persistence/tests/` | ❌ To implement |
| README | `plugins/context-persistence/README.md` | ❌ To create |
| CHANGELOG | `plugins/context-persistence/CHANGELOG.md` | ❌ To create |
| package.json | `plugins/context-persistence/package.json` | ❌ To create |

Add to Phase 1:

**Create `package.json`:**
```bash
cat > package.json << 'EOF'
{
  "name": "@qsmtco/context-persistence",
  "version": "2.2.0",
  "description": "Context Persistence plugin for OpenClaw - automatic state persistence across compaction and restarts",
  "main": "index.js",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "keywords": ["openclaw", "persistence", "context", "anchoring", "lru-cache"],
  "author": "qsmtco",
  "license": "MIT",
  "dependencies": {
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "vitest": "^1.0.0"
  },
  "engines": {
    "openclaw": ">=2026.2.0"
  }
}
EOF
```

---

## 9. Timeline (Effort Estimate)

| Phase | Estimated hours | Dependencies |
|-------|----------------|--------------|
| 0. Preparation | 0.5 | None |
| 1. File organization | 1.0 | None |
| 2. Tool registration | 2.0 | Phase 1 |
| 3. CLI integration | 1.0 | Phase 2 |
| 4. Hook updates | 0.5 | Phase 1 |
| 5. Skill integration | 0 (skipped) | - |
| 6. Testing | 2.0 | Phases 2-4 |
| 7. Documentation | 1.0 | Phase 6 |
| 8. Migration & deploy | 1.0 | All previous |
| **Total** | **~9 hours** | - |

---

## 10. Appendix

### 10.1 State Schema (YAML Frontmatter)

```yaml
version: "2.1"            # string, required
project: ""               # string, optional
task: ""                  # string, optional
status: "active"          # enum: active|blocked|done|in-progress
last_action: ""           # string, optional
next_steps: []            # array of strings
context_anchor: ""        # string, optional (LLM-generated summary)
conversation_summary: ""  # string, optional (brief summary)
updated: "2026-02-25T18:30:00Z"  # ISO8601, set automatically
```

Body (markdown) is free-form and can contain longer context notes.

### 10.2 Tool Parameter Schemas (JSON Schema)

See Phase 2 for individual tool schemas. All tools use `additionalProperties: false` except where arrays are expected.

### 10.3 Cache Key Normalization

`cached_memory_search` builds a cache key from the tool parameters (query, filters, options) using `JSON.stringify` with sorted keys to ensure deterministic keys.

### 10.4 Migration from Skill

Since we are starting fresh in a new plugin directory and the old skill is uninstalled, no data migration is needed. If a user previously had `SESSION_STATE.md` in their workspace, the plugin will automatically pick it up on first run (but note filename change to `CONTEXT_PERSISTENCE.md`). To preserve data, one could copy/rename the file manually. This spec does not include automatic migration; it can be added in a future version if needed.

### 10.5 State Version Migration

The plugin includes a migration helper to handle schema changes across versions:

```javascript
// lib/state.js - Migration helper
const CURRENT_VERSION = '2.1';

function migrateState(state) {
  if (!state) return { version: CURRENT_VERSION };

  // Handle missing version (pre-2.0)
  if (!state.version) {
    state.version = CURRENT_VERSION;
    state.status = state.status || 'active';
    state.next_steps = state.next_steps || [];
    // Old fields may need mapping
  }

  // Future migrations go here:
  // if (state.version === '2.0') { /* migrate to 2.1 */ }

  return state;
}

// Apply migration on read
async function readState() {
  try {
    const content = await fs.promises.readFile(stateFilePath, 'utf8');
    const { ...frontmatter } = yaml.load(content);
    const state = migrateState(frontmatter);
    return state;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    log?.error?.('[context-persistence] Failed to read state:', err);
    return null;
  }
}
```

---

**End of Software Specification v1.0**