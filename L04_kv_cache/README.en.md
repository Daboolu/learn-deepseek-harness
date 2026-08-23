# L4 · KV-Cache Sensitivity (Pillar P3 ⚡)

## Changes from the previous lesson (L3 → L4)

- Added `timeContextPlugin`: injects context at `agent/pre-step`.
- The loop now reads and prints DeepSeek's cache hits (`prompt_cache_hit_tokens`).
- Added `/append` and `/prepend` switches to compare how injection position affects the cache; `SYSTEM` is lengthened to make the cache observable.

---

## What this lesson covers

Every step sends DeepSeek a long stream of tokens. How does the server cache it, and how does each of our actions affect that cache?

The server-side prefix cache rule:

> **Only a prefix that is byte-for-byte identical from the first token can hit the cache and skip recomputation; once any position changes, everything after it is invalidated.**

From this follows the discipline behind all context design:

> **Context injection always appends to the end (append-only), never modifying the middle.**

This lesson verifies it empirically: hook in a context-injection plugin, print the real cache-hit count, and use a switch to compare "append to end" versus "insert at the front".

## Core: the first context-injection plugin

Corresponds to the real harness's `time-context`: within the `agent/pre-step` waterfall, obtain the downstream messages, then inject context.

```ts
function timeContextPlugin(ctx) {
  ctx.on("agent/pre-step", async (_payload, next) => {
    const messages = await next()                          // [system, ...history]
    const ctxMsg = { role: "user", content: `[context] current time: ${new Date()}` }  // a value that changes each round
    return injectMode === "append"
      ? [...messages, ctxMsg]                              // end: prefix unchanged, hit
      : [messages[0], ctxMsg, ...messages.slice(1)]        // front: prefix changed, everything after invalidated
  })
}
```

The injected value changes every round (the current time), so its position directly determines the cache:
- **End**: the preceding `[system + conversation]` prefix is unchanged, hits, and only the new tail needs computing.
- **Front** (after system, before the conversation): changes the prefix, so the whole conversation after it is invalidated and recomputed every round.

## Observing cache hits

The loop gains one step: read and print the cache-hit count DeepSeek returns in `usage`.

```ts
const usage = res.usage as any   // prompt_cache_hit_tokens is not in the openai standard types; read via as any (external boundary)
const hit = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0
console.log(`[KV] input ${total} tokens: hit ${hit} / miss ${miss}`)
```

## How the three pillars show up here

| Pillar | This lesson |
|--------|-------------|
| 🧩 P1 Everything is a plugin | Preserved: context injection is yet another plugin, hooked at `agent/pre-step`, loop unchanged. |
| 📜 P2 Session Log | Preserved: the conversation is still derived from the log. (This lesson's injection affects only the current request and is not written to the log; the real harness would log it too — simplified here to focus on KV.) |
| ⚡ **P3 KV Cache** | ✅ The theme. Injection plugin + measured cache hits + append/prepend comparison. |

## Try it

```bash
cp .env.example .env      # fill in DEEPSEEK_API_KEY
npm install
npm run dev
```

1. Default is `/append`. Ask several questions in a row (`hi` → `tell a joke` → `another one`). Watch the purple `[KV]`: as the conversation grows, the hit count rises, because the earlier part is a stable prefix and is reused.
2. Type `/prepend` and ask a few more: the hit rate drops to near 0%, because the changing time at the front each round invalidates the whole conversation after it, forcing recomputation.
3. Switch back to `/append` and the hit rate recovers.

```
   append (correct)                prepend (contrast)
   ┌─────────────────┐            ┌─────────────────┐
   │ system          │ hit        │ system          │ hit
   │ ...conversation │ hit        │ [time, changes] │ changed
   │ [time]  new only│            │ ...conversation │ invalidated, recompute
   └─────────────────┘            └─────────────────┘
        high hit rate                  hit rate ≈ 0
```

This is why the real harness's context injectors are all append-only.

## Next

The three pillars are now established: **L2 Everything is a plugin · L3 Session Log · L4 KV Cache**. Every later lesson hooks a concrete capability onto this foundation while embodying all three pillars. L5 builds the **tool pipeline + permissions**: upgrading "execute a tool" from a single function into a layered `pre-execute → guard → execute → post-execute → result` pipeline, with permissions hooked in as a plugin at the gate.
