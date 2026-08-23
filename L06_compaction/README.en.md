# L6 · Context Compaction (P1 + P2 + P3 converge)

## Changes from the previous lesson (L5 → L6)

- `Session` gains `replace` semantics (`SurfaceOp`).
- Added a `compaction` plugin: `compact/*` events + summarization request reusing the prefix; added a `/compact` command.
- To focus on compaction, this lesson returns to the simplified registry and keeps only `bash`.

---

## What this lesson covers

As the conversation grows, it needs compaction: replace an older span with a single summary to shorten later requests. This lesson is where the three pillars converge — one feature uses all three at once.

```
before  surface: [u1, a2, u3, a4, u5, a6, u7, a8, u9, a10]   (too long)
                  └────── compact this span ──────┘ └ keep ┘
after   surface: [S,  u9, a10]     S = one <compacted-summary> message
```

## How the three pillars work together

**P1 (plugin)**: compaction is a plugin hooked at `agent/pre-step`; the loop is unchanged. It runs before the request, then base derives messages from the compacted surface:

```ts
ctx.on("agent/pre-step", async ({ session }, next) => {
  await maybeCompact(...)   // may rewrite the surface
  return next()             // base derives from the compacted surface
})
```

**P2 (Session Log)**: compaction deletes nothing. It only appends events to the log and rewrites the surface with one `replace` message:

```
compact/start        (log-only) records the compaction range
compact/summary      (log-only) keeps the summary text and the list of shadowed seqs
user/message + replace{start,end}   the only surface change: summary replaces the old range
compact/end          (log-only)
```

The replaced original events remain in `events[]` — inspect via `/log`. This is "shadow, not delete", and the precondition for replayable crash recovery.

**P3 (KV Cache)** has two points:

1. **The summarization request reuses the prefix**: the summary also requires one model call. The request is built as `[system, ...span to compact, {compaction instruction}]` — the first part is exactly the prefix of the conversation request just sent, with the instruction placed at the end. So the server hits the existing cache and does not recompute the whole span for the summary. The program prints this hit count.
2. **Compaction invalidates the cache**: replacing a middle span of the surface invalidates the server cache from that point on, so later conversation must be recomputed. This is the **inherent cost** of compaction saving context window — one recomputation in exchange for shorter input on every later round.

```ts
const messages = [{ role: "system", content: SYSTEM }, ...rangeMsgs, { role: "user", content: COMPACT_INSTRUCTION }]
//                └──────────── reuse the conversation request's prefix ────────────┘  └── instruction at the end ──┘
```

## Boundary handling

When choosing the compaction range, if the retained tail would start with an orphaned `tool/result` (whose corresponding assistant call falls in the compacted span), those `tool/result`s are folded into the compacted span, avoiding an ownerless tool result in the tail that would cause an API error.

## How the three pillars show up here

| Pillar | This lesson |
|--------|-------------|
| 🧩 P1 | ✅ Compaction is a plugin hooked at `agent/pre-step`; the loop is unchanged. |
| 📜 P2 | ✅ Compaction = append `compact/*` + one replace message; original events preserved and replayable. |
| ⚡ P3 | ✅ The summarization request reuses the prefix (prints the hit count); the replacement invalidates the cache after it (inherent cost). |

> **Compared with the real harness**: corresponds to the `compact` capability seam, `surfaceOp:{op:'replace'}`, and the "summarization request reuses the warm prefix + instruction placed last" optimization.

## Try it

```bash
cp .env.example .env
npm install
npm run dev
```

1. Ask several rounds in a row (let the surface exceed 8 entries) to trigger automatic compaction. You'll see two purple `[compaction]` lines: one reports the summarization request's cache hit, one notes the replacement invalidating the cache.
2. You can also type `/compact` any time to compact manually.
3. Type `/log`: the compacted original events remain marked `[log only]` in the log, while the surface has been replaced by the summary. The model still answers coherently after compaction, showing the summary carried the context forward.

## Next

L7 builds **cross-session memory**: writing important facts to external storage and recalling/injecting them at the start of a new session — involving writing (P2) and the cache trade-off of recall injection (P3).
