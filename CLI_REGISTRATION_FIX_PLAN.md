# CLI Registration Mismatch — Fix Plan

**Date:** 2026-02-26  
**Status:** Investigation complete; fix identified  
**Plugin:** context-persistence v2.2.0

---

## Problem

Gateway log on restart shows:

```
plugin CLI register failed (context-persistence): TypeError: program.command is not a function
```

This prevents the OpenClaw CLI commands (`openclaw context-persistence ...`) from being available.

---

## Root Cause

Missing second argument to `api.registerCli`.

According to OpenClaw documentation and reference plugins (e.g., `voice-call`, `memory-core`), the correct pattern is:

```ts
api.registerCli(
  ({ program }) => {
    // register commands on program
  },
  { commands: ["mycmd"] }  // REQUIRED
);
```

The `commands` option declares the top-level command names that the plugin adds. This is used for command overlap detection and proper CLI initialization.

Our implementation:

```js
api.registerCli(({ program }) => {
  commands(program);
});  // ← missing second argument
```

The absence of `{ commands: [...] }` causes the CLI loader to pass an inadequately initialized `program` object, leading to `program.command is not a function`.

---

## Fix

### File: `index.js`

Change:

```js
api.registerCli(({ program }) => {
  commands(program);
});
```

To:

```js
api.registerCli(
  ({ program }) => {
    commands(program);
  },
  { commands: ["context-persistence"] }
);
```

---

## Verification Steps

1. Apply the change
2. Restart Gateway: `openclaw gateway restart`
3. Test: `openclaw context-persistence show`
4. Check logs for absence of CLI registration errors
5. Run `openclaw --help` and confirm `context-persistence` appears

---

## References

- OpenClaw Plugin Docs: https://docs.openclaw.ai/tools/plugin
- CLI registration example: `extensions/voice-call/index.ts`
- Manifest requirements: `openclaw.plugin.json` (no CLI field needed)

---

## Risk Assessment

- **Low risk:** Only adds a declarations array; no behavior change
- **Rollback:** Revert the single line change if any unexpected side effects

---

## Implementation Status

- [x] Analysis complete
- [ ] Code fix applied
- [ ] Tests unnecessary (no unit test for CLI registration shape)
- [ ] Manual verification performed
