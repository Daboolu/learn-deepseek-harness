# L5 · Tool Pipeline + Permissions (P1 + P2)

## Changes from the previous lesson (L4 → L5)

- The tool registry is upgraded to a layered pipeline: `tools/pre-execute → guard → execute → tools/post-execute → tools/result`.
- Added a `read_file` tool, a `permission` plugin, and a `confirm` service; added a `tool/call` audit event.
- To focus on the pipeline, this lesson does not stack L4's context injection (L8 recombines everything).

---

## What this lesson covers

In earlier lessons, tool execution was a single direct function call. The real harness upgrades it into a **layered pipeline** so that permissions, auditing, and result rewriting each hook in as an independent stage:

```
  pre-execute        guard          execute       post-execute        result
  (waterfall)        (monotonic)                  (waterfall)         (notification)
  allow/deny/ask  →  hard-rule deny → run tool  →  rewrite content →  observe
```

Each stage is an extension point with a clear role:
- **pre-execute** (waterfall): the allow/deny/ask gate that plugins can rewrite — safety policy hooks here.
- **guard** (monotonic): once it denies, no later stage (including user confirmation) can reverse it — an unbypassable hard rule.
- **execute**: run the tool body.
- **post-execute** (waterfall): rewrite the result content.
- **result** (notification): observe only, cannot change.

## Permissions: separating policy from hard rules

`permissionPlugin` uses two stages, showing the division of labor:

```ts
// hard rule: denied on match, the user cannot approve either
registry.guard((exec) => {
  if (exec.name === "bash" && /rm\s+-rf\s+\//.test(exec.args.command)) return "dangerous pattern"
})

// ordinary write/delete operations: return ask, defer to user confirmation
ctx.on("tools/pre-execute", ({ exec }) => {
  if (exec.name === "bash" && /\b(rm|mv|>|git\s+push|...)/.test(exec.args.command))
    return { kind: "ask", reason: `about to run: ${exec.args.command}` }
  return { kind: "allow" }   // read_file and read-only commands pass through
})
```

When the pipeline hits `ask`, it calls the `confirm` service to ask the user. **The policy (what to ask) lives in the permission plugin; the mechanism (how to ask) lives in the `confirm` service** — they are separate, so swapping to a different UI (a web confirmation dialog) only replaces `confirm` and leaves the policy untouched.

## Auditing: record intent, then execute

Before executing, the loop writes a `tool/call` (log-only); after executing, it writes `tool/result` (on surface):

```ts
session.append("tool/call", { callId, name, args })   // record the call intent
const result = await ctx.services.tools.execute(exec)  // run the pipeline
session.append("tool/result", { tool_call_id, content: result.content }, true)
```

**Record intent before executing**: if a crash lands between the two, replaying the log reveals "a call was issued but has no result", avoiding blindly retrying an operation with side effects.

## How the three pillars show up here

| Pillar | This lesson |
|--------|-------------|
| 🧩 **P1 Everything is a plugin** | ✅ Permissions are a plugin, hooked via `tools/pre-execute` and `guard`; every pipeline stage is an extension point. |
| 📜 **P2 Session Log** | ✅ `tool/call` (log-only audit) and `tool/result` (surface) are both events; record intent before executing. |
| ⚡ P3 KV Cache | Preserved: `tool/result` is appended to the surface, leaving the prefix unaffected. |

> **Compared with the real harness**: the pipeline corresponds to `tools/pre-execute → guard → tools/execute → tools/post-execute → tools/result`; `confirm` corresponds to the approval service.

## Try it

```bash
# Create a local .env file (ignored by Git)npm install
npm run dev
```

- `read the first 20 lines of code.ts` — read_file and read-only commands execute directly.
- `create test.txt and write hello into it` — a write triggers confirmation; enter `y` to allow, `N` to deny (the model sees the denial reason and adjusts).
- Ask it to try an `rm -rf /`-style command — denied outright by the guard; the confirmation step never appears.

## Next

L6 is where the three pillars converge — **context compaction**: it is a plugin (P1), rewrites the surface by appending a replace event to the log (P2), and directly involves cache invalidation and prefix reuse for the summarization request (P3).
