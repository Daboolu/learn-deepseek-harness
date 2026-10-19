# L2 · Everything Is a Plugin (Pillar P1 🧩)

## Changes from the previous lesson (L1 → L2)

- Added a mini framework: the shared context `ctx` and an event system (`on` / `emit` / `waterfall`).
- Added a tool registry; `bash` changed from an inline function to a plugin; added a pure-observer `log` plugin.
- The loop is slimmed to `step`, introducing the `agent/pre-step` waterfall as the unified entry point before each request.

---

## The problem this lesson solves

In L1, bash, safety checks and loop logic are coupled together (limitation ❶): adding a tool or a log line means editing `agentLoop`. The loop swells as features grow.

DeepSeek Harness's core idea:

> **Shrink the loop to the minimum — it only drives the flow and fires events at fixed points; all capabilities are externalized as plugins.**

## Two pieces of infrastructure

```
        ┌──────────── shared context ctx ─────────────┐
        │  services: { tools: tool registry, ... }     │  services registered here
        │  event system: on (listen) / emit / waterfall│  plugins hook in here
        └──────────────────────────────────────────────┘
                 ▲              ▲               ▲
            bash plugin     log plugin     later: context / compaction / memory plugins
          (registers tool) (listens)

        minimal loop: only fire events + call capabilities via ctx.services
```

- **Shared context ctx**: services (capabilities) are registered here; plugins obtain each other via `ctx.services.xxx`.
- **Event system**: the loop fires events at fixed points, and plugins listen and intervene.

Events come in two kinds, used throughout the course:

| Type | Semantics | Can it change the main flow? | Use |
|------|-----------|------------------------------|-----|
| `emit` notification | broadcast | No | "a tool has executed" |
| `waterfall` | passed in turn, can rewrite then pass on | Yes | "modify messages before a request" |

## Core: the loop's slimmed form

```ts
async function step(ctx, history) {
  const messages = await ctx.waterfall("agent/pre-step", { history }, async () => history)  // unified pre-request hook
  const res = await client.chat.completions.create({
    messages, tools: ctx.services.tools.schemas(),   // tool list comes from the registry
  })
  history.push(res.choices[0].message)
  if (!msg.tool_calls?.length) return false
  for (const call of msg.tool_calls) {
    const output = ctx.services.tools.execute(...)    // execution also goes through the registry
    history.push({ role: "tool", ... })
    await ctx.emit("tools/result", { exec: { name }, result: { content: output } })
  }
  return true
}
```

The loop contains no specific tool name and does not know whether a log exists. It does only three things: fire `agent/pre-step`, ask the registry for the tool list, and ask the registry to execute.

## bash becomes a plugin

```ts
function bashPlugin(ctx) {
  ctx.services.tools.register("bash", { ...schema }, (args) => runBash(args.command))
}
```

Wired in at assembly time:

```ts
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry())
bashPlugin(ctx)
logPlugin(ctx)   // pure observer, only listens to tools/result
```

## How the three pillars show up here

| Pillar | This lesson |
|--------|-------------|
| 🧩 **P1 Everything is a plugin** | ✅ The theme. The loop is minimal; bash / log are both plugins, hooked in via ctx + the event system. |
| 📜 P2 Session Log | Not yet. `history` is still a mutable array (limitation ❷) — resolved in L3. |
| ⚡ P3 KV Cache | Not yet. But the `agent/pre-step` waterfall is in place — it is the unified entry for L4's context injection and all later "modify messages before a request". |

> **Compared with the real DeepSeek Harness**: these names largely match the real source — `ctx` corresponds to Cordis's Context, `on` / `emit` / `waterfall` to its event system, and `agent/pre-step` / `tools/result` are the same names. These ~30 lines are its minimal runnable core.

## Try it

```bash
# Create a local .env file (ignored by Git)
npm install
npm run dev
```

Type `list files in the current directory` and you'll see:
- yellow `$ ls` is the command the model requested;
- gray `[log] tool "bash" finished` comes from the log plugin.

**Verify "adding a capability doesn't touch the core"**: comment out `logPlugin(ctx)` at the end of `code.ts` and rerun — the gray log disappears while the loop code is unchanged. You can write a `read_file` plugin modeled on `bashPlugin`, adding just one line at the assembly point.

## Next

The conversation state is still an array `history` that can be modified at will and is lost when the process ends (limitation ❷). L3 introduces the second pillar — replacing it with an **append-only event log**, from which the conversation the model sees is **derived**. This is the common foundation for compaction, memory, and crash recovery.
