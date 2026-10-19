# L9 · Subagent (P1)

## Changes from the previous lesson (L8 → L9)

- The registry's `execute` becomes async; added `schemasFor` to provide a restricted tool set.
- Added a `subagent` plugin: `spawn_subagent` spawns a child loop with its own `Session` and returns only the conclusion.
- To focus on delegation, this lesson keeps only `bash`.

---

## What this lesson covers

Turn "spawn a child loop with its own context" into a tool `spawn_subagent(task)`. The subagent has its own independent Session, and after finishing the task **returns only the final result** to the parent agent.

```
parent agent (session A)
  │ calls spawn_subagent(task="count files per language under src")
  ▼
subagent (session B, isolated context, bash only)
  │ $ find ...   →  lots of intermediate output
  │ $ ...        →  more exploration
  │ reaches a conclusion
  ▼
only the "conclusion" string is returned to the parent
(all of the subagent's intermediate tool calls and output stay in session B, never entering session A)
```

## Core value: context isolation

While exploring, a subagent may produce many tool calls and verbose output. If all of it entered the parent's context, the parent's conversation would swell rapidly. Delegation **isolates it inside the subagent's own Session**, and the parent receives only a conclusion.

This brings two benefits:
- The parent's context stays lean and focused.
- Less context also means lower cost and better cache behavior (echoing P3).

```ts
async (args) => {
  return await runSubagent(ctx, args.task)   // only this return value enters the parent's context
}
```

The subagent uses a **restricted tool set** (only `bash`, excluding `spawn_subagent`) to avoid unbounded delegation:

```ts
const childTools = ctx.services.tools.schemasFor(["bash"])
```

## How the three pillars show up here

| Pillar | This lesson |
|--------|-------------|
| 🧩 **P1 Everything is a plugin** | ✅ A subagent is just another instance of the same loop, triggered by a tool; delegation itself is a plugin. |
| 📜 P2 Session Log | ✅ Parent and child each have their own Session; isolation is the natural result of "each conversation is an independent log". |
| ⚡ P3 KV Cache | ✅ Isolation keeps the parent context smaller — cheaper and more cache-friendly. |

> **Compared with the real harness**: corresponds to the subagent capability seam (backends like `spawn` / `fork`) and the design where "delegation is a tool, not built into the loop".

## Try it

```bash
# Create a local .env file (ignored by Git)npm install
npm run dev
```

Give a task that needs multi-step exploration but where you only care about the conclusion, for example:

- `use a subagent to count how many .ts / .json / .md files are in the current directory`
- `send a subagent to check what dependencies package.json declares, and just tell me the conclusion`

Gray `[subagent] $ ...` lines are the subagent's internal exploration steps; the parent agent answers based only on the returned conclusion.

## Next

L10 is the ultimate form of **everything is a plugin** — **self-modification**: letting the model write a new plugin at runtime and mount it into the running agent.
