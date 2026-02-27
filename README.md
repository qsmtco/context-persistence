# Context Persistence Plugin for OpenClaw

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://docs.openclaw.ai)

> **Never lose your agent's context again.** Automatic state persistence across compaction and restarts, with LRU caching and smart anchoring.

---

## 🚀 What is this?

The **Context Persistence** plugin transforms your OpenClaw agent from forgetful to reliable. It automatically saves state, caches memory searches for instant recall, and injects context anchors so your agent always knows what project it's working on.

**Perfect for:** long-running automation, project management assistants, code review bots, compliance-heavy workflows, and any agent that needs institutional memory.

---

## ✨ Key Features

- **Automatic State Persistence** — No manual backup; context survives restarts and compaction
- **LRU Cache with TTL** — Speed up `memory_search` by 10x with intelligent caching
- **Smart Anchoring** — System message after compaction keeps agent focused
- **Prefetch on Startup** — Warm the cache with anticipated queries (optional)
- **Full Observability** — CLI commands to inspect state and cache statistics
- **Production-Ready** — 100% test coverage (128/128), atomic writes, schema migrations
- **OpenClaw-Native** — Proper plugin architecture; no skill wrapper overhead

---

## 📦 What You Get

- **6 Tools:** `context_persistence_read`, `context_persistence_write`, `context_persistence_discover`, `cached_memory_search`, `context_persistence_summarize`, `context_persistence_prefetch`
- **4 Hooks:** `pre-compaction` (auto-save), `post-compaction` (anchor injection), `session-start` (resume), `shutdown` (stats)
- **7 CLI Commands:** `show`, `set`, `cache-stats`, `cache-clear`, `refresh`, `clear`, `show-cache`
- **Configurable:** Cache size, TTL, prefetch, summarization budget

---

## 🛠️ Installation

### From GitHub (recommended)

```bash
# Install directly from this repository
openclaw plugins install https://github.com/qsmtco/context-persistence.git

# Restart Gateway
openclaw gateway restart
```

### Manual (for development)

```bash
# Clone or copy into your workspace extensions directory
cp -r /path/to/context-persistence ~/.openclaw/extensions/

# Add to openclaw.json if not auto-discovered:
# "plugins": { "entries": { "context-persistence": { "enabled": true } } }

openclaw gateway restart
```

---

## ⚙️ Configuration

Add to your `openclaw.json` under `plugins.entries.context-persistence.config`:

```json5
{
  "plugins": {
    "entries": {
      "context-persistence": {
        "enabled": true,
        "config": {
          "cacheMax": 100,           // Max cache entries (default: 100)
          "cacheTTLms": 300000,      // TTL in ms (default: 5 minutes)
          "enablePrefetch": false,   // Warm cache on session start (default: false)
          "prefetchQueries": [],     // Queries to prefetch
          "summarizationBudget": {   // LLM budget for anchor generation
            "enabled": true,
            "maxCallsPerHour": 10
          }
        }
      }
    }
  }
}
```

---

## 🎯 Quick Start

1. **Show current state:**
   ```bash
   openclaw context-persistence show
   ```

2. **Set a field:**
   ```bash
   openclaw context-persistence set project "My Awesome Project"
   ```

3. **Check cache health:**
   ```bash
   openclaw context-persistence cache-stats
   ```

4. **Clear cache if needed:**
   ```bash
   openclaw context-persistence cache-clear
   ```

---

## 🔍 How It Works

- **State File:** `CONTEXT_PERSISTENCE.md` (YAML frontmatter + markdown body)
- **Atomic Writes:** Temp file + fsync + rename prevents corruption
- **Cache Invalidation:** File mtime + TTL ensures freshness
- **Schema Version:** 2.1 (automatic migration from pre-2.0)
- **Concurrency:** Optimistic locking detects conflicting writes

---

## 📊 Testing

```bash
# Run the full test suite
cd /path/to/plugins/context-persistence
npm test
```

**Result:** 128/128 tests passing (100% coverage)

---

## 🧩 Technical Details

| Component | Description |
|-----------|-------------|
| **Plugin Entry** | `index.js` — registers tools, hooks, CLI |
| **State Core** | `lib/state.js` — read/write, cache, migrations |
| **Tools** | `tools/*.js` — explicit JSON schemas |
| **Hooks** | `hooks/*.js` — compaction & session lifecycle |
| **CLI** | `cli/commands.js` — commander-based subcommands |
| **Manifest** | `openclaw.plugin.json` — plugin descriptor |

**OpenClaw Version:** 2026.2.0+

---

## 🆘 Troubleshooting

- **CLI commands not found?** Ensure `plugins.entries.context-persistence.enabled` is `true` and restart Gateway.
- **Cache not warming?** Set `enablePrefetch: true` and add queries to `prefetchQueries`.
- **State file errors?** Check file permissions and JSON/YAML syntax. Use `openclaw context-persistence show` to validate.
- **Need help?** See `MARKETING.md` for full feature matrix or `SOFTWARE_SPECIFICATION.md` for architecture.

---

## 📄 License

MIT (see LICENSE file in repository)

---

## 🙋 Support & Contributing

This plugin is part of the OpenClaw ecosystem. For issues, feature requests, or contributions, please open an issue on GitHub.

**Repository:** https://github.com/YOUR-USERNAME/context-persistence  
**Specification:** [SOFTWARE_SPECIFICATION.md](SOFTWARE_SPECIFICATION.md)  
**Marketing:** [MARKETING.md](MARKETING.md)

---

**Made with ❤️ by Lieutenant Qrusher (qsmtco)**
