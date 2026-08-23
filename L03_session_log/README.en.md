# L3 · The Session Log Is the Single Source of Truth (Pillar P2 📜)

## Changes from the previous lesson (L2 → L3)

- Added `Session`: an append-only event log + `surface` + `deriveMessages`.
- The loop now appends events to the `Session` (`user/message` / `assistant/message` / `tool/result`, plus `turn/start` `turn/end`).
- Added `/log` and `/surface` commands to inspect the log and the surface.

---

## The problem this lesson solves

In L2 the conversation is still a mutable array `history` (limitation ❷), with three weaknesses:

- **Lost when the process ends** — state lives only in memory.
- **No deterministic replay** — there is no reliable source to "recompute" the current conversation.
- **No graceful compaction** — replacing a middle span means editing the array directly, and the original content cannot be preserved.

DeepSeek Harness's second pillar:

> **A conversation is not a mutable array but an append-only event log. The conversation the model sees is derived from the log.**

## Two concepts

```
   event log events[]  (records all events, append-only)
   ┌──────────────────────────────────────────────┐
   │ seq0 turn/start        [log only]              │
   │ seq1 user/message      [on surface] user input │
   │ seq2 assistant/message [on surface] tool call  │
   │ seq3 tool/result       [on surface] command out│
   │ seq4 assistant/message [on surface] model reply│
   │ seq5 turn/end          [log only]              │
   └──────────────────────────────────────────────┘
              │  deriveMessages(): take events by surface order
              ▼
   surface = [1, 2, 3, 4]   the subset the model actually sees, in this order
```

- **event log `events[]`**: records all events (including `turn/start`, `turn/end` boundaries), append-only, never modified.
- **surface `surface[]`**: an ordered list of seqs indicating which events the current conversation includes; `turn` boundaries do not enter.

Deriving means: take the events listed by `surface` in order and project them into model messages.

## Core code: the Session class

```ts
class Session {
  events: SessionEvent[] = []
  surface: number[] = []

  append(type, data, onSurface = false) {
    const event = { seq: this.seqCounter++, type, data }
    this.events.push(event)
    if (onSurface) this.surface.push(event.seq)   // messages enter surface; turn boundaries do not
    return event
  }

  deriveMessages() {
    return this.surface.map((seq) => {
      const e = bySeq.get(seq)!
      switch (e.type) {
        case "user/message":      return { role: "user", content: e.data.content }
        case "assistant/message": return e.data.message
        case "tool/result":       return { role: "tool", tool_call_id: e.data.tool_call_id, content: e.data.content }
      }
    })
  }
}
```

The loop no longer does `history.push(...)`; it calls `session.append(...)`, and calls `session.deriveMessages()` before a request.

`SYSTEM` is not written to the log: it belongs to the request envelope, assembled every time, and is not part of the conversation history — this is also how the real harness handles it.

## How the three pillars show up here

| Pillar | This lesson |
|--------|-------------|
| 🧩 P1 Everything is a plugin | Preserved: the framework and bash/log plugins are unchanged; only the state carrier changed. |
| 📜 **P2 Session Log** | ✅ The theme. Mutable array → append-only event log; messages derived from the log; surface introduced. |
| ⚡ P3 KV Cache | Groundwork: the conversation is re-derived each step — L4 examines this token stream from a cache angle. |

> This separation is the foundation for later capabilities:
> - **Compaction (L6)**: doesn't delete the log; only appends a replace event to rewrite the surface, keeping the original content.
> - **Crash recovery**: replaying the log reconstructs the current state exactly.
> - **Memory (L7)**: writing is appending an event.

## Try it

```bash
cp .env.example .env      # fill in DEEPSEEK_API_KEY
npm install
npm run dev
```

Compare the log with the surface:

1. First ask something that needs a tool, e.g. `how many files are in the current directory?`
2. Type **`/log`**: in the full log, `turn/start` and `turn/end` are marked `[log only]`, and messages are marked `[on surface]`.
3. Type **`/surface`**: only the seqs that entered the surface remain — the conversation the model actually sees.

The log records all events (including boundary events invisible to the model); the model only receives events on the surface. This "record everything / expose a subset" split is why L6 compaction can "shadow rather than delete".

## Next

L4 introduces the third pillar — **KV-cache sensitivity**: hooking in the first context-injection plugin (modifying messages at `agent/pre-step`), measuring `prompt_cache_hit_tokens` for real, and verifying that "appending to the end" hits the cache while "modifying the middle" invalidates the cache from that point on.
