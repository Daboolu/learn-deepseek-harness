# L7 · Cross-Session Memory (P2 + P3)

## Changes from the previous lesson (L6 → L7)

- Added a `memory` plugin: a `remember` tool (writes to disk) + recall at session start.
- To focus on memory, this lesson does not stack compaction.

---

## What this lesson covers

Earlier lessons' conversations vanish when the process ends. This lesson gives the agent **cross-session memory**:

- **Write**: the model calls the `remember` tool to store facts about the user/project in the disk file `agent-memory.json`.
- **Recall**: at the start of a new session, read those facts back and inject them into the conversation.

```
   session 1                        session 2 (rerun the program)
   you: remember I'm Alex, I use pnpm
   model: remember(fact="user is Alex")  →  agent-memory.json
          remember(fact="user uses pnpm")              │
   (exit)                                              ▼
                              recalled at startup: "known facts about the user: 1. user is Alex 2. user uses pnpm"
                              you: help me install a dependency
                              model: (knows it's pnpm) pnpm add ...
```

## Core: a memory plugin

```ts
function memoryPlugin(ctx) {
  const memories = existsSync(FILE) ? JSON.parse(readFileSync(FILE)) : []   // read back at startup

  // write: the remember tool, persisted to disk
  ctx.services.tools.register("remember", { ... }, (args) => {
    memories.push({ text: args.fact, ts: ... }); writeFileSync(FILE, JSON.stringify(memories))
    return `remembered: ${args.fact}`
  })

  // recall: on this session's first agent/pre-step, write the facts as one event onto the surface (once)
  ctx.on("agent/pre-step", async ({ session }, next) => {
    if (!recalled && memories.length) {
      recalled = true
      session.append("user/message", { content: `[memory] known facts:\n${list}` }, true)
    }
    return next()
  })
}
```

## How the three pillars show up here

| Pillar | This lesson |
|--------|-------------|
| 🧩 P1 Everything is a plugin | Preserved: memory is a plugin (a `remember` tool + an `agent/pre-step` recall listener). |
| 📜 **P2 Session Log** | ✅ Writing is a persistent append (same idea as the event log: append-only); recall enters the surface as one event. |
| ⚡ **P3 KV Cache** | ✅ The recalled facts are injected once as an **early and stable** entry, keeping the prefix stable and cache-friendly. |

> **A key trade-off (connecting to real systems)**: here we inject all memories, and only once at session start, so it is a stable prefix and cache-friendly. But a real memory system **retrieves by relevance**, and the memories surfaced each round may differ — injecting different content into an early position would change the prefix every round and break the cache. This is exactly where **Position-Independent Caching (PIC)** is needed: making each memory block's cache independent of its absolute position. It is also a frontier challenge for systems like DeepSeek Harness on the memory front.

> **Compared with the real harness**: real systems have a dedicated memory capability seam (write/recall), recall is typically injected at `agent/pre-step`, and storage lives in a separate backend.

## Try it

```bash
# Create a local .env file (ignored by Git)npm install
npm run dev
```

1. First run: `remember I'm Alex, my project uses pnpm` — the model calls `remember`, and you'll see `agent-memory.json` created.
2. Type `q` to exit.
3. **Rerun** `npm run dev`: at startup it prints `[memory] recalled N memories`. Now ask `help me add a dependency`, and the model should answer based on "uses pnpm", even though this is a brand-new session.

## Next

L8 **assembles** the plugins from earlier lessons (tool pipeline, permissions, compaction, memory…) into a complete small harness, showcasing the three pillars working together: adding any capability takes just one line at the assembly point.
