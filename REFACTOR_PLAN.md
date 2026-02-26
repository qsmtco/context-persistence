# Context Persistence: Refactoring Plan for Proper OpenClaw Plugin Architecture

**Date:** 2026-02-25
**Target:** Convert `/home/q/.openclaw/workspace/plugins/context-persistence/` into a proper OpenClaw plugin following official best practices
**Version:** Current 2.1.0 → Refactored 2.2.0

---

## 1. Current Architecture Overview & Components

### 1.1 What Exists Today

The context-persistence skill is **already mostly a proper OpenClaw plugin**, but it mixes skill-based conventions with plugin patterns without full API registration.

**Current Structure:**
```
context-persistence/
├── openclaw.plugin.json       (manifest - good!)
├── index.js                   (hook registration only)
├── hooks/
│   ├── pre-compaction.js
│   ├── post-compaction.js
│   ├── session-start.js
│   └── shutdown.js
├── scripts/
│   ├── state.js              (core state + LRU cache)
│   ├── tools.js              (tool implementations)
│   └── cli.js                (standalone CLI)
├── SKILL.md                  (skill documentation)
├── README.md                 (user guide)
├── SOFTWARE_SPECIFICATION.md
├── CACHE_ANCHOR_EXTENSION.md
├── tests/
├── node_modules/
└── package.json
```

### 1.2 Components & Their Roles

| Component | Purpose | Status |
|-----------|---------|--------|
| **Plugin Manifest** (`openclaw.plugin.json`) | Declaration, config schema, hook paths, permissions | ✅ Excellent - follows spec closely |
| **Hook Registration** (`index.js`) | Registers 4 lifecycle hooks | ✅ Works but limited to hooks only |
| **Hook Handlers** (`hooks/*.js`) | Implement pre-compaction, post-compaction, session-start, shutdown | ✅ Solid implementations with good error handling |
| **Core State Module** (`scripts/state.js`) | Read/write CONTEXT_PERSISTENCE.md, schema validation, LRU cache, mtime invalidation | ✅ Robust, well-tested |
| **Tool Implementations** (`scripts/tools.js`) | 6 tools: `context_persistence_read/write/discover`, `cached_memory_search`, `context_persistence_summarize`, `context_persistence_prefetch` | ⚠️ Exported but **not registered via API** |
| **CLI** (`scripts/cli.js`) | Standalone command-line interface | ⚠️ Works standalone but **not registered as OpenClaw CLI** |
| **Skill Documentation** (`SKILL.md`) | Skill metadata, usage, config, troubleshooting | ✅ Comprehensive |

### 1.3 Hook Context Protocol

Current hooks implicitly expect:
- `ctx.session` - session object with `addSystemMessage()` or `push()`
- `ctx.agent.tools` - access to `memory_search` tool
- `ctx.config` - plugin configuration
- `ctx.log` - logger

This matches OpenClaw's hook signature: `async (ctx) => { ... }`.

### 1.4 Tool Access Pattern

Tools are currently:
- Listed in `openclaw.plugin.json` `tools` array
- Implemented in `scripts/tools.js`
- **Not** registered via `api.registerTool()`

This works because OpenClaw's skill system may auto-discover them, but it's **non-standard** for plugins. Official plugin tools should be explicitly registered with JSON schemas.

---

## 2. Gaps Compared to Best Practices

### 2.1 Critical Gaps

| Gap | Current State | Best Practice | Impact |
|-----|---------------|---------------|--------|
| **Tool Registration** | Tools listed in manifest but not registered via `api.registerTool()` | Use `api.registerTool(spec, options)` with explicit JSON Schema | Tools may not appear in agent tool allowlists properly; no parameter validation |
| **CLI Integration** | Standalone CLI script only | Use `api.registerCli()` to extend `openclaw` command | Users must run `context-persistence` binary directly instead of `openclaw context-persistence` |
| **Plugin Manifest `skills` Field** | Not present | Should list skill directory to enable skill-based discovery | Misses skill integration benefits like unified docs |
| **TypeScript Adoption** | JavaScript only | Modern plugins use TypeScript for type safety | ❌ Optional but recommended |
| **Tool Schemas** | Implicit in code | Explicit JSON Schema or TypeBox in `api.registerTool()` | Better validation, LLM understanding |
| **Hook Handler Imports** | `require()` in hooks | Can keep but should use clean module boundaries | Minor |
| **Module Organization** | Mixed `scripts/` and `hooks/` | Clear separation: `lib/`, `hooks/`, `cli/`, `tools/` | Readability |
| **Backward Compatibility** | Direct file reads/writes in hooks | Should use registered tools where possible | Consistency |

### 2.2 Non-Gaps (Already Good)

- ✅ Manifest is complete with `configSchema`, `hooks`, `permissions`, `metadata`
- ✅ Hook registration is correct (`api.registerHook()`)
- ✅ Permissions model is properly declared
- ✅ Cache implementation is sophisticated (LRU, TTL, mtime invalidation)
- ✅ Error handling and logging in hooks
- ✅ Schema validation with `js-yaml`
- ✅ Atomic writes
- ✅ Configuration via `api.config` attempted in `index.js`
- ✅ Hook timeouts set appropriately

---

## 3. Proposed Plugin Structure

### 3.1 File Organization

```
context-persistence/
├── openclaw.plugin.json          # Manifest (updated)
├── index.js                      # Main entry: registers hooks, tools, CLI
├── lib/
│   ├── state.js                  # Core state + cache (from scripts/state.js)
│   ├── cache.js                  # (optional) extracted cache logic
│   └── errors.js                 # Custom error classes
├── hooks/
│   ├── preCompaction.js
│   ├── postCompaction.js
│   ├── sessionStart.js
│   └── shutdown.js
├── tools/
│   ├── index.js                  # Tool implementations + schemas
│   ├── contextPersistenceRead.js
│   ├── contextPersistenceWrite.js
│   ├── contextPersistenceDiscover.js
│   ├── cachedMemorySearch.js
│   ├── contextPersistenceSummarize.js
│   └── contextPersistencePrefetch.js
├── cli/
│   └── commands.js               # CLI command registration
├── tests/
│   ├── state.test.js
│   ├── tools.test.js
│   └── hooks.test.js
├── skills/
│   └── context-persistence/
│       ├── SKILL.md              # (unchanged)
│       └── ...                   # skill assets if any
├── package.json
├── README.md
└── CHANGELOG.md
```

### 3.2 Updated Manifest (`openclaw.plugin.json`)

```json
{
  "id": "context-persistence",
  "name": "Context Persistence",
  "description": "Automatic state persistence across compaction and restarts with LRU cache and enhanced context anchoring",
  "version": "2.2.0",
  "author": "qsmtco",
  "license": "MIT",
  "repository": {
    "url": "https://github.com/qsmtco/qrusher",
    "path": "plugins/context-persistence"
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "cacheMax": {
        "type": "number",
        "default": 100,
        "minimum": 1,
        "maximum": 1000,
        "description": "Maximum number of cache entries"
      },
      "cacheTTLms": {
        "type": "number",
        "default": 300000,
        "minimum": 60000,
        "maximum": 3600000,
        "description": "Cache entry TTL in milliseconds"
      },
      "enablePrefetch": {
        "type": "boolean",
        "default": false
      },
      "prefetchQueries": {
        "type": "array",
        "items": { "type": "string" },
        "default": []
      },
      "summarizationBudget": {
        "type": "object",
        "properties": {
          "maxCallsPerHour": { "type": "number", "default": 10 },
          "enabled": { "type": "boolean", "default": true }
        }
      }
    }
  },
  "uiHints": {
    "cacheMax": { "label": "Cache Max Entries", "description": "Maximum number of cached memory_search results" },
    "cacheTTLms": { "label": "Cache TTL (ms)", "description": "Time-to-live for cache entries" },
    "enablePrefetch": { "label": "Enable Prefetch", "description": "Warm cache on session start with anticipated queries" },
    "prefetchQueries": { "label": "Prefetch Queries", "description": "Queries to prefetch (JSON array)" },
    "summarizationBudget": { "label": "Summarization Budget", "description": "LLM call limits for anchor generation" }
  },
  "hooks": {
    "pre-compaction": {
      "enabled": true,
      "script": "./hooks/preCompaction.js",
      "timeoutMs": 10000
    },
    "post-compaction": {
      "enabled": true,
      "script": "./hooks/postCompaction.js",
      "timeoutMs": 15000
    },
    "session-start": {
      "enabled": true,
      "script": "./hooks/sessionStart.js",
      "timeoutMs": 15000
    },
    "shutdown": {
      "enabled": true,
      "script": "./hooks/shutdown.js",
      "timeoutMs": 5000
    }
  },
  "skills": [
    "./skills/context-persistence"
  ],
  "permissions": {
    "fileSystem": {
      "read": ["CONTEXT_PERSISTENCE.md", "memory/**/*.md"],
      "write": ["CONTEXT_PERSISTENCE.md"]
    },
    "tools": {
      "use": ["memory_search", "chat_completion", "generate", "llm", "openai"]
    }
  },
  "metadata": {
    "openclaw": {
      "minVersion": "2026.2.0",
      "docs": "https://github.com/qsmtco/qrusher/tree/main/skills/context-persistence",
      "tags": ["memory", "compaction", "state-management", "hooks", "cache", "lru", "anchoring"]
    }
  }
}
```

**Changes:**
- Added `skills` array to ship the skill
- Added `uiHints` for better config UI
- Hook script files renamed to camelCase for consistency (`preCompaction.js` vs `pre-compaction.js`)
- All other fields preserved

### 3.3 Tool Registration via `api.registerTool`

Tools should be registered in `index.js` or `tools/index.js` with explicit schemas:

**Example Tool Schema:**
```javascript
// Using simple JSON Schema
{
  name: "context_persistence_read",
  description: "Read the current CONTEXT_PERSISTENCE.md contents including frontmatter and body",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  async execute(_id, params, ctx) {
    const state = await stateLib.readState();
    if (!state) throw new Error("CONTEXT_PERSISTENCE.md does not exist");
    return state;
  }
}
```

**Or using TypeBox:**
```javascript
import { Type } from "@sinclair/typebox";

const ContextPersistenceReadSchema = Type.Object({
  // no parameters
}, { additionalProperties: false });

api.registerTool({
  name: "context_persistence_read",
  description: "Read the current CONTEXT_PERSISTENCE.md",
  parameters: ContextPersistenceReadSchema,
  async execute(_id, params, ctx) {
    // ... implementation
  }
}, { optional: false }); // or { optional: true }
```

---

## 4. Step-by-Step Implementation Plan

### Phase 0: Preparation (Backup & Testing)

1. Create backup of current skill:
   ```bash
   cp -r /home/q/.openclaw/workspace/plugins/context-persistence ~/backup/context-persistence-$(date +%Y%m%d-%H%M%S)
   ```

2. Verify current functionality:
   ```bash
   # Check hooks are firing
   tail -f ~/.openclaw/gateway.log | grep context-persistence

   # Test tools via agent
   context_persistence_read
   context_persistence_write "task: Test refactor"

   # Test cache stats
   context-persistence cache-stats
   ```

3. Document current test coverage and known issues.

---

### Phase 1: File Organization Refactor

**Step 1.1: Create new directory structure**
```bash
cd /home/q/.openclaw/workspace/plugins/context-persistence
mkdir -p lib tools cli
```

**Step 1.2: Move core modules**
```bash
# Move state.js to lib/
mv scripts/state.js lib/state.js

# Move tools.js to tools/index.js
mv scripts/tools.js tools/index.js

# Move cli.js to cli/commands.js
mv scripts/cli.js cli/commands.js
```

**Step 1.3: Rename hook files to camelCase**
```bash
mv hooks/pre-compaction.js hooks/preCompaction.js
mv hooks/post-compaction.js hooks/postCompaction.js
mv hooks/session-start.js hooks/sessionStart.js
# Keep shutdown.js as is (already camelCase)
```

**Step 1.4: Update manifest hook paths**
Edit `openclaw.plugin.json`:
```json
"hooks": {
  "pre-compaction": { "script": "./hooks/preCompaction.js", ... },
  "post-compaction": { "script": "./hooks/postCompaction.js", ... },
  "session-start": { "script": "./hooks/sessionStart.js", ... },
  "shutdown": { "script": "./hooks/shutdown.js", ... }
}
```

**Step 1.5: Update internal imports in hooks**
Each hook currently does:
```javascript
const state = require('../scripts/state');
const tools = require('../scripts/tools');
```

Update to:
```javascript
const state = require('../lib/state');
const tools = require('../tools');
```

**Step 1.6: Remove old `scripts/` directory**
```bash
rmdir scripts  # should be empty now
```

---

### Phase 2: Tool Registration via API

**Step 2.1: Define tool schemas in `tools/index.js`**

Refactor `tools/index.js` to export both implementations and schemas:

```javascript
// tools/index.js
const state = require('../lib/state');

const ToolSchemas = {
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
    description: "Update one or more fields in CONTEXT_PERSISTENCE.md. Automatically updates 'updated' timestamp. Validates against schema.",
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
  // ... other tools with proper schemas
};

async function context_persistence_read(ctx, args) {
  const stateObj = await state.readState();
  if (!stateObj) throw new Error("CONTEXT_PERSISTENCE.md does not exist");
  return stateObj;
}

// ... other tool implementations (copy from current tools.js)

module.exports = {
  schemas: ToolSchemas,
  context_persistence_read,
  context_persistence_write,
  context_persistence_discover,
  cached_memory_search,
  context_persistence_summarize,
  context_persistence_prefetch
};
```

**Step 2.2: Update `index.js` to register tools**

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
      Object.keys(mapped).forEach(k => mapped[k] === undefined && delete mapped[k]);
      if (Object.keys(mapped).length > 0) {
        const state = require('./lib/state');
        state.configureCache(mapped);
        api.log?.info?.('[context-persistence] Cache configured:', mapped);
      }
    }
  } catch (err) {
    console.error('[context-persistence] Failed to configure state module:', err.message);
  }

  // Register tools via API
  const toolList = [
    'context_persistence_read',
    'context_persistence_write',
    'context_persistence_discover',
    'cached_memory_search',
    'context_persistence_summarize',
    'context_persistence_prefetch'
  ];

  for (const toolName of toolList) {
    const schema = tools.schemas[toolName];
    const impl = tools[toolName];

    if (schema && impl) {
      api.registerTool(schema, {
        optional: false, // always available when plugin enabled
        // Could use { optional: true } for summarization/prefetch due to LLM dependency
      });
      api.log?.debug?.(`[context-persistence] Registered tool: ${toolName}`);
    } else {
      api.log?.warn?.(`[context-persistence] Missing schema or implementation for tool: ${toolName}`);
    }
  }

  // Register hooks (paths already updated in manifest)
  // The hook scripts themselves will import tools from new location
  api.registerHook('pre-compaction', require('./hooks/preCompaction'), {
    name: 'context-persistence.pre-compaction',
    description: 'Auto-save state before compaction'
  });
  api.registerHook('post-compaction', require('./hooks/postCompaction'), {
    name: 'context-persistence.post-compaction',
    description: 'Inject context anchor after compaction'
  });
  api.registerHook('session-start', require('./hooks/sessionStart'), {
    name: 'context-persistence.session-start',
    description: 'Inject state summary on session start'
  });
  api.registerHook('shutdown', require('./hooks/shutdown'), {
    name: 'context-persistence.shutdown',
    description: 'Log cache statistics on shutdown'
  });

  api.log?.info?.('[context-persistence] Plugin loaded with tools and hooks');
};
```

---

### Phase 3: CLI Registration (Optional Enhancement)

**Step 3.1: Create `cli/commands.js`**

```javascript
// cli/commands.js
const { program } = require('commander');
const state = require('../lib/state');

// Import tool functions if needed for refresh
// (refresh requires memory_search which may not be available in CLI context)

function registerCommands(api) {
  const mainCmd = program.command('context-persistence').description('Context Persistence commands');

  mainCmd.command('show')
    .description('Display current CONTEXT_PERSISTENCE.md contents')
    .action(async () => {
      const stateObj = await state.readState();
      if (!stateObj) {
        console.log('CONTEXT_PERSISTENCE.md does not exist or is empty.');
        return;
      }
      console.log('--- SESSION STATE ---');
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
      if (stateObj.body) {
        console.log('\n--- Context ---');
        console.log(stateObj.body);
      }
    });

  mainCmd.command('set <key> <value>')
    .description('Set a field in CONTEXT_PERSISTENCE.md')
    .action(async (key, value) => {
      const updates = { [key]: value };
      await state.writeState(updates);
      console.log(`Set ${key} = ${value}`);
    });

  mainCmd.command('cache-stats')
    .description('Show LRU cache statistics')
    .action(() => {
      const stats = state.getCacheStats();
      console.log('--- CACHE STATISTICS ---');
      console.log(`Size: ${stats.size}/${stats.max} entries`);
      console.log(`TTL: ${stats.ttl}ms (${stats.ttl / 60000} minutes)`);
      if (stats.keys?.length) {
        console.log('\nSample keys:');
        stats.keys.slice(0, 10).forEach((key, i) => {
          try {
            const parsed = JSON.parse(key);
            console.log(`  ${i + 1}. query: "${parsed.query?.substring(0, 40)}..."`);
          } catch {
            console.log(`  ${i + 1}. ${key.substring(0, 50)}...`);
          }
        });
      }
    });

  mainCmd.command('cache-clear')
    .description('Clear the LRU cache')
    .action(() => {
      const cache = state.getCache();
      if (cache?.clear) {
        const before = cache.size?.() || 0;
        cache.clear();
        console.log(`Cache cleared (${before} entries removed).`);
      } else {
        console.log('Cache not available.');
      }
    });

  // Note: 'refresh' and 'discover' are available as agent tools instead
}

module.exports = registerCommands;
```

**Step 3.2: Register CLI in `index.js`**

```javascript
const registerCliCommands = require('./cli/commands');

module.exports = function register(api) {
  // ... tool and hook registration ...

  // Register CLI
  if (api.registerCli) {
    registerCliCommands(api);
    api.log?.info?.('[context-persistence] CLI commands registered');
  }
};
```

---

### Phase 4: Hook Handler Updates (Minor)

**4.1: Update imports in all hooks**

Each hook file (`hooks/preCompaction.js`, etc.) should change:
```javascript
// Old:
const state = require('../scripts/state');
const tools = require('../scripts/tools');

// New:
const state = require('../lib/state');
const tools = require('../tools');  // will get registered tool implementations
```

**4.2: Ensure hooks use `api` context properly**

Current hooks expect `ctx.agent.tools` for memory_search. After tool registration, the `ctx.agent.tools` will include the registered tools automatically. The hooks' direct `require('../tools')` imports will also work.

Potential improvement: hooks could use `ctx.tools.cached_memory_search` instead of requiring the module, but current pattern is acceptable as long as it's consistent.

---

### Phase 5: Skill Integration

**5.1: Add `skills` field to manifest** (already done in Phase 1)

```json
"skills": ["./skills/context-persistence"]
```

**5.2: Ensure skill directory structure**

The skill directory should remain as is with `SKILL.md`. No changes needed.

**5.3: Optionally move `CACHE_ANCHOR_EXTENSION.md` and `SOFTWARE_SPECIFICATION.md` into skill docs**

Not required but cleaner:
```
skills/context-persistence/
├── SKILL.md
├── CACHE_ANCHOR_EXTENSION.md
├── SOFTWARE_SPECIFICATION.md
└── ... (other skill assets)
```

---

### Phase 6: Testing & Validation

**6.1: Unit Tests**

Create `tests/` directory with tests for:
- `state.js`: read/write/validate schema, atomic writes, mtime validation
- `tools/`: each tool function with mocked context
- `hooks/`: hook handlers with mocked ctx

**Test Framework:** Use Jest or Vitest (consistent with OpenClaw core).

**Example test:**
```javascript
// tests/state.test.js
const state = require('../lib/state');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('state module', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-test-'));
    process.env.OPENCLAW_WORKSPACE = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.OPENCLAW_WORKSPACE;
  });

  test('writeState and readState roundtrip', async () => {
    const result = await state.writeState({
      project: 'Test Project',
      task: 'Test Task',
      status: 'active',
      last_action: 'Testing',
      next_steps: ['Step 1', 'Step 2']
    }, { validate: true });

    expect(result.success).toBe(true);

    const read = await state.readState();
    expect(read.project).toBe('Test Project');
    expect(read.task).toBe('Test Task');
    expect(read.status).toBe('active');
    expect(read.version).toBe('2.1'); // auto-added
  });
});
```

**6.2: Integration Tests**

Write tests that simulate:
- Hook execution with mock context
- Tool execution with mock `ctx.tools`
- Cache hit/miss/stale scenarios

**6.3: Schema Validation**

Validate that `openclaw.plugin.json` conforms to OpenClaw plugin schema:
```bash
# If openclaw CLI is available
openclaw plugins doctor
# Or validate manually against known schema
```

**6.4: Config Validation**

Test that plugin config with `contextPersistenceTracker` key validates properly and defaults apply.

---

### Phase 7: Documentation Updates

**7.1: Update README.md**
- Note that plugin now uses `api.registerTool()` for better integration
- Document CLI commands via `openclaw context-persistence ...` (if CLI registered)
- Mention TypeScript readiness (if added later)

**7.2: Update SKILL.md**
- Possibly add "Implementation Notes" section about hooks
- Clarify that the skill is also a fully-fledged OpenClaw plugin

**7.3: Add DEVELOPER.md** (optional)
- For contributors: dev setup, testing, release process

**7.4: Update CHANGELOG.md**
Add:
```
## [2.2.0] - YYYY-MM-DD
### Changed
- Refactored to proper OpenClaw plugin architecture
- Tools now registered via api.registerTool() with explicit schemas
- CLI integrated via api.registerCli()
- File reorganization: scripts/ → lib/, hooks/ renamed to camelCase
- Added uiHints for config UI
- Added skills manifest field for skill integration

### Added
- Unit tests for state, tools, hooks
- DEVELOPER.md guidelines

### Fixed
- None yet
```

---

### Phase 8: Migration Strategy

**8.1: In-Place Refactor (Recommended)**

Since the plugin is already functional, perform the refactor **in-place** with careful git tracking:

```bash
cd /home/q/.openclaw/workspace/plugins/context-persistence
git init  # if not already a repo
git add -A
git commit -m "Current state before refactor (v2.1.0)"
```

**Apply changes incrementally**, committing after each phase:
```bash
git add .
git commit -m "Phase 1: Reorganize files (lib/, tools/, cli/)"
# ... test ...
git commit -m "Phase 2: Register tools via api.registerTool"
# ... test ...
git commit -m "Phase 3: Register CLI commands"
# ... test ...
git commit -m "Phase 4: Update hooks imports"
# ... test thoroughly ...
```

**8.2: Zero-Downtime Migration**

- The plugin is **backward compatible** because:
  - Hook script paths can be updated in the manifest
  - Tool implementations remain the same (only registration changes)
  - State file format unchanged
  - Cache logic unchanged

- **Rollout procedure:**
  1. Stop Gateway: `openclaw gateway stop`
  2. Apply refactored code (replace directory)
  3. Start Gateway: `openclaw gateway start`
  4. Check logs: `openclaw logs -f` or `journalctl -u openclaw -f`
  5. Verify hooks firing: trigger compaction or restart
  6. Test tools: `context_persistence_read`, `cached_memory_search`

- **Rollback:** If issues arise, restore from git backup:
  ```bash
  git checkout HEAD~1  # or specific commit
  openclaw gateway restart
  ```

**8.3: User Configuration Migration**

- No config migration needed; same `configSchema` structure
- Existing `plugins.entries["context-persistence"].config` remains valid
- Defaults unchanged

**8.4: Skill vs Plugin Awareness**

OpenClaw will auto-discover the skill via the `skills` manifest field. Users who had the skill manually installed might need to:
- Remove duplicate skill installations
- Ensure only the plugin entry exists in `plugins.entries`

**8.5: Testing Checklist Before Deploy**

- [ ] `openclaw plugins doctor` reports no issues
- [ ] `openclaw plugins list` shows plugin enabled
- [ ] Hooks appear in `openclaw hooks list --eligible`
- [ ] Tools appear in `openclaw tools list` (or agent tools)
- [ ] Agent can invoke `context_persistence_read` successfully
- [ ] Pre-compaction hook fires (check logs or induce compaction)
- [ ] Post-compaction anchor injection works
- [ ] Session-start injection works after Gateway restart
- [ ] CLI commands work: `openclaw context-persistence show`
- [ ] Cache stats accurate
- [ ] No regression in LRU behavior
- [ ] Schema validation passes on `CONTEXT_PERSISTENCE.md` writes
- [ ] Atomic writes verified (no partial files)
- [ ] Permissions: file reads/writes only to allowed paths

---

## 5. Optional Enhancements (Post-Refactor)

### 5.1 TypeScript Migration

Convert to TypeScript for better type safety:
- Rename `index.js` → `index.ts`
- Rename `lib/state.js` → `lib/state.ts`
- Add `tsconfig.json` with `"module": "NodeNext"`, `"target": "ES2022"`
- Add `@types/node` dev dependency
- Update `package.json`:
  ```json
  {
    "type": "module",
    "scripts": {
      "build": "tsc",
      "dev": "tsc --watch"
    }
  }
  ```
- OpenClaw's jiti runtime can load `.ts` files directly if `ts-node` is available, or precompile to `dist/`.

**Benefits:**
- Compile-time type checking
- Better IDE support
- Aligns with modern OpenClaw plugin ecosystem

**Risks:**
- Build step complexity
- Need to ensure `jiti` loads correctly in production
- Current codebase is small; JS may be sufficient

**Recommendation:** Defer until v3.0 unless there's a strong need.

### 5.2 Enhanced Error Reporting

Wrap tool errors with structured `OpenClawError` types:
```javascript
class ContextPersistenceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
// Return { error: { code, message } } from tools
```

### 5.3 Metrics & Observability

Add optional Prometheus/OpenTelemetry hooks:
- Cache hit/miss counters
- Hook execution durations
- Tool call counts

Could be gated behind `metrics.enabled` config flag.

### 5.4 Prefetch Configuration Validation

Add startup validation that `prefetchQueries` are strings and not excessively long.

### 5.5 Multi-Workspace Support

Currently assumes single workspace (via `OPENCLAW_WORKSPACE`). Could support:
- `workspaces: []` config array
- State file per workspace or aggregated

Likely out of scope for this plugin.

---

## 6. Success Criteria

After refactoring, the plugin should:

1. ✅ Load without errors on Gateway start (`openclaw gateway start`)
2. ✅ Pass `openclaw plugins doctor` validation
3. ✅ Have all 6 tools successfully registered and visible in agent context
4. ✅ Hooks fire on schedule (pre-compaction, post-compaction, session-start, shutdown)
5. ✅ Maintain 100% backward compatibility with existing state files and behavior
6. ✅ CLI commands accessible via `openclaw context-persistence <cmd>` (if CLI registered)
7. ✅ Unit tests achieve >90% coverage of core logic
8. ✅ Documentation accurately reflects new structure
9. ✅ No breaking changes for existing users

---

## 7. Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Hook paths mismatch after moving files | Medium | High | Careful manifest updates; test each hook individually |
| Tool registration conflicts with skill discovery | Low | Medium | Remove top-level `tools` array from manifest; rely solely on `api.registerTool` |
| Cache state lost on Gateway restart (module cache) | Low | Low | Cache is per-process; this is expected. State persists to file. |
| CLI command name collision with core | Low | Low | Use `context-persistence` (kebab) which isn't a core command |
| Breaking existing installations during file moves | Medium | High | Follow in-place refactor with git backups; test on dev environment first |
| Missing dependencies after reorganization | Low | Medium | Verify all `require()` paths updated; use relative path constants |

---

## 8. Timeline Estimate

| Phase | Estimated Time | Dependencies |
|-------|----------------|--------------|
| Phase 0: Backup & Testing | 0.5h | None |
| Phase 1: File Organization | 1h | None |
| Phase 2: Tool Registration | 2h | Phase 1 complete |
| Phase 3: CLI Integration | 1h | Phase 2 complete |
| Phase 4: Hook Updates | 0.5h | Phase 1 complete |
| Phase 5: Skill Integration | 0.5h | Phase 1 complete |
| Phase 6: Testing & Validation | 2h | All prior phases |
| Phase 7: Documentation | 1h | Phase 6 complete |
| Phase 8: Migration & Deployment | 1h | All complete |
| **Total** | **~9 hours** | — |

Can be done in a single day with focused effort.

---

## 9. Conclusion

The context-persistence is already a high-quality skill. This refactor elevates it to a **first-class OpenClaw plugin** by:

1. **Standardizing tool registration** via `api.registerTool()` with explicit schemas
2. **Integrating CLI** with `api.registerCli()` for seamless user experience
3. **Improving organization** for maintainability
4. **Adding tests** for reliability
5. **Formalizing skill integration** via `skills` manifest field

The changes are **incremental, backward-compatible, and low-risk**. The plugin will continue to work exactly as before while aligning with OpenClaw's evolving plugin ecosystem.

---

**Next Steps:**
1. Review this plan with stakeholders if needed
2. Begin Phase 1 in a feature branch
3. Run integration tests after each phase
4. Update documentation continuously
5. Tag v2.2.0 upon successful deployment
