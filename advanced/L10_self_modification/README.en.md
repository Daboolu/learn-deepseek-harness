# L10 · Self-Modification (the ultimate form of P1)

## Changes from the previous lesson (L9 → L10)

- Added `selfModificationPlugin`: `define_tool` compiles and mounts a new tool at runtime via `new Function`.
- Reuses the registry's "regenerate the tool list every step" property so the new tool is visible on the next step.
- To focus on self-modification, this lesson keeps only `bash`.

---

## What this lesson covers

Let the model **write a new tool at runtime and mount it** into the running agent, then call it immediately. This is the end point of "everything is a plugin": even "extending itself" is a tool.

```
you: build yourself a string-reversing tool, then reverse "hello"
  → model: define_tool(name="reverse", code="return input.split('').reverse().join('')")
           [self-mod] mounted new tool "reverse"
  → model: reverse(input="hello")            ← next step it can call the tool it just built
           olleh
  → model: "the result is olleh"
```

## Why it works

Two things, both required:

```ts
// 1) the tool list is regenerated from the registry every step → a tool added at runtime is visible to the model next step
schemas() { return Object.entries(tools).map(...) }

// 2) the registry allows register at any time → adding needs no restart
ctx.services.tools.register(newName, newSchema, newRun)
```

`define_tool`'s implementation compiles the model-provided code into a function and registers it into the live registry:

```ts
(args) => {
  const fn = new Function("input", args.code)       // compile the model-written code
  ctx.services.tools.register(args.name, schema,     // mount it as a new tool
    (a) => String(fn(a.input)))
  return `mounted tool "${args.name}"`
}
```

## Limits and boundaries (consistent with the real harness)

- **Ephemeral**: mounted tools live only in memory, lost when the process ends; there is no automatic persistence or promotion path.
- **Trust level equals bash**: here `new Function` runs model code directly — **not a security boundary** (the real harness isolates via `node:vm`, but likewise declares it as bash-level trust).
- **Self-modification ≠ self-evolution**: "able to change itself" is only the mechanism; to become self-evolution it still needs an "evaluate → promote → persist" loop (settling a useful ephemeral tool into a permanent capability). This lesson only reaches the mechanism.

## How the three pillars show up here

| Pillar | This lesson |
|--------|-------------|
| 🧩 **P1 Everything is a plugin** | ✅ The ultimate form: even extending itself is a tool; a dynamic registry + regenerating the list every step makes it possible. |
| 📜 P2 Session Log | Preserved: `define_tool` and calls to the new tool both enter the log as events. |
| ⚡ P3 KV Cache | Note: changing the tool list changes the request prefix, invalidating the cache after it — the cost of changing the tool set at runtime. |

> **Compared with the real harness**: corresponds to `cordis_inspect` / `cordis_mount` / `cordis_unmount` — the model can inspect and mount temporary plugins, equally ephemeral, equally bash-level trust, equally with no automatic promotion.

## Try it

```bash
# Create a local .env file (ignored by Git)npm install
npm run dev
```

- `build yourself a tool that uppercases a string, then process "hello world"`
- `build a tool that measures string length and use it to count the characters in this sentence`
- `build a reverse tool and reverse "DeepSeek"`

Purple `[self-mod]` means the new tool is mounted; the model then calls it.

## Course recap

After ten lessons, a harness's **invariant core** is clearly small:

> **A minimal loop + one append-only event log + a plugin/event system + a few extension points (`agent/pre-step`, the tool pipeline).**

Everything else — tools, permissions, context injection, compaction, memory, subagents, self-modification — is a plugin hooked onto this skeleton. The three pillars run throughout:

- **P1 Everything is a plugin**: get the skeleton and seams right first, then add/remove capabilities freely.
- **P2 The Session Log is the single source of truth**: the foundation for replay, recovery, compaction, and isolation.
- **P3 KV-cache sensitivity**: from day one, factor "does this change the prefix, and who pays" into the design.

The right order to build a harness: establish the skeleton first, then hook on capabilities.
