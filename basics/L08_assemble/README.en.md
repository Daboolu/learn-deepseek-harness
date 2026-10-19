# L8 · Assemble a Small Harness (all three pillars together)

## Changes from the previous lesson (L7 → L8)

- Assembly: merge L5's pipeline registry and L6's `Session` (with `replace`), and load six plugins at once — `bash` / `read_file` / permissions / memory / time context / compaction.
- No new mechanism; the point is to show the plugins compose orthogonally and can be added/removed with one line.

---

## What this lesson covers

Earlier lessons each produced independent plugins. This lesson assembles them into a **complete, usable small harness**:

```
load list (at the assembly point):
  bash + read_file          tools (L2/L5)
  permissionPlugin          permissions: guard + ask confirmation (L5)
  memoryPlugin              cross-session memory (L7)
  timeContextPlugin         context injection (L4)
  compactionPlugin          automatic compaction (L6)
```

## The convergence point: assembly is a single block

```ts
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry(ctx))
bashPlugin(ctx)
readFilePlugin(ctx)
permissionPlugin(ctx)
memoryPlugin(ctx)
timeContextPlugin(ctx)
compactionPlugin(ctx)
```

This is the compounding return of "everything is a plugin": **each capability is orthogonal and independent; add or remove one by editing only this block, leaving the loop and other plugins untouched.** Want to drop compaction? Delete a line. Want a `web_search` tool? Write one modeled on `bashPlugin` and add a line.

The capabilities cooperate in order along the same `agent/pre-step` waterfall: memory recall, time injection, and compaction each hook a listener — independent yet together forming the final context of each request.

## How the three pillars show up here

| Pillar | This lesson |
|--------|-------------|
| 🧩 **P1 Everything is a plugin** | ✅ Six orthogonal plugins assembled into a complete harness; add/remove with one line. |
| 📜 **P2 Session Log** | ✅ User/model/tool messages, `tool/call` audits, `compact/*`, memory recall — all events on the same log. |
| ⚡ **P3 KV Cache** | ✅ Time injection appended to the end, memory recall placed in a stable early position, compaction reusing the summary prefix — all obey the cache discipline. |

> By now the **invariant core** of a harness is clearly small — a minimal loop + one event log + a plugin/event system + a few extension points (`agent/pre-step`, the tool pipeline). Everything else is a plugin.

## Try it

```bash
# Create a local .env file (ignored by Git)npm install
npm run dev
```

An end-to-end run (exercising every capability):

1. `remember I'm Alex, the project uses pnpm` — triggers remember (memory).
2. `read the first 30 lines of code.ts` — read_file executes directly.
3. `create note.txt and write hi` — a write triggers permission confirmation.
4. Ask several rounds of small talk — the surface exceeds the threshold and auto-compacts (purple `[compaction]`).
5. Exit and rerun — recalls "Alex / pnpm" at startup.

## Next

This harness is already usable. The remaining two lessons show more advanced forms of **everything is a plugin**:
- **L9 Subagent**: turn "spawn a child loop with its own session" into a tool.
- **L10 Self-modification**: let the model write and mount a new plugin at runtime.
