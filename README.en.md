# Learn DeepSeek Harness

**English** | [中文](README.md)

[![Read online](https://img.shields.io/badge/%F0%9F%93%96%20Read%20online-web%20course-4c8aea?style=for-the-badge)](https://prism-shadow.github.io/learn-deepseek-harness/)

Starting from the barest loop, grow it lesson by lesson into a **real agent harness**. Each lesson is a standalone runnable TypeScript package — `npm install && npm run dev` talks to a real DeepSeek model.

> 📖 **There's a web version**: read without cloning — [read online here](https://prism-shadow.github.io/learn-deepseek-harness/). The directory, README, code, and per-lesson diff are all on one page.

---

## How this differs from Learn Claude Code

This course borrows its **format** from [Learn Claude Code](https://github.com/shareAI-lab/learn-claude-code) (one runnable package + README per lesson), but the **core is entirely different**. Claude Code and DeepSeek Harness follow two different design paths — this course only covers the latter, focusing on the three fundamental designs that set it apart from Claude Code:

- **🧩 Everything is a plugin**: an ultra-thin core loop + every capability as a pluggable plugin.
- **📜 The Session Log is the permanent history and memory**: a conversation is an append-only event log, the single source of truth.
- **⚡ Extreme sensitivity to the KV Cache**: every context operation takes "does this break the prefix cache" as its first constraint.

The main course develops these three points layer by layer (detailed below).

As for capabilities **common to all agents** — subagents, more tools, a task system, a plan system, etc. — they are not what makes DeepSeek Harness distinctive, so they are **mentioned briefly** in later chapters; and they are all added in DeepSeek Harness's favorite form: **as plugins** (from L9 on).

**Why insist on "everything is a plugin"?** Because it paves the way for **RSI (Recursive Self-Improvement)**: when every capability is a hot-pluggable plugin, the agent can hot-update and hot-swap its own harness code at runtime — first building capabilities for itself, then settling the useful ones. L10 shows an early form of this mechanism; **how to truly achieve RSI / Self-Evolution on top of DeepSeek Harness will be covered in later chapters**.

---

## The three pillars (the skeleton of this course)

DeepSeek Harness is what it is because of these three things. The whole course reinforces them repeatedly:

### 🧩 P1 · Everything is a plugin
The core loop is ultra-thin — it only drives the flow and fires events at fixed extension points. Tools, context, compaction, memory — every real capability is an **external plugin**, hooked in via a shared context `ctx` and an event system. Adding a feature = adding a plugin, the core untouched.

### 📜 P2 · The Session Log is the eternal single source of truth
A conversation is not an in-memory message array but an **append-only event log**. The conversation the model sees is **derived** from the log. This lets the harness replay deterministically, recover from crashes, compact, and fork.

### ⚡ P3 · Sensitivity to the KV Cache
The iron rule of server-side prefix caching: "a hit requires a byte-for-byte identical token sequence". So anything added to the conversation is **always append-only** (append to the end, never modify the middle); modify the middle and the cache from that point on is wasted. This course lets you **measure cache hits by hand** and understand why each design is the way it is.

Every lesson README has a fixed section: **"How the three pillars show up here"**.

---

## Course map

The course has two tracks: **Basics (L1–L8)** lays the foundation, and **Advanced (L9 onward)** stacks more powerful capabilities on top (and will keep growing). The repo mirrors this with `basics/` and `advanced/` directories.

### Basics (`basics/`)

| # | Lesson | Main pillar | What you'll learn |
|---|--------|-------------|-------------------|
| **L1** | The bare loop | (groundwork) | the essence of an agent: user→LLM→tool→loop; and **deliberately leaves three limitations** for the pillars to solve |
| **L2** | Everything is a plugin | **P1** | mini framework: `ctx` + event system + waterfall; turn bash into a plugin |
| **L3** | The Session Log is the source of truth | **P2** | replace the message array with an event log; derive messages from the log; surface |
| **L4** | KV-cache sensitivity | **P3** | append-only context-injection plugin; measure `cacheReadTokens` |
| **L5** | Tool pipeline + permissions | P1+P2 | the layered execution pipeline; permissions as a plugin |
| **L6** | Context compaction | **P1+P2+P3** | the crown lesson: compaction = plugin + replace event + cache cliff |
| **L7** | Cross-session memory | P2+P3 | memory plugin: recall + write |
| **L8** | Assemble a small harness | all three | compose all plugins into a complete whole |

### Advanced (`advanced/`)

| # | Lesson | Main pillar | What you'll learn |
|---|--------|-------------|-------------------|
| **L9** | Subagent | P1 | spawn a subagent as a tool |
| **L10** | Self-modification | **P1 ultimate** | mount a plugin at runtime (the ultimate form of everything-is-a-plugin) |

Read in order. Each lesson's `README` follows: problem → core code → how it works → the three pillars here → try it → next.

---

## How to run

Each lesson is a standalone package (under `basics/` or `advanced/`):

```bash
cd basics/L01_agent_loop
# Create a local .env with DEEPSEEK_API_KEY (all .env* files are ignored by Git)
npm install
npm run dev
```

You need a DeepSeek API key ([platform.deepseek.com](https://platform.deepseek.com)). DeepSeek's API is OpenAI-compatible, so we use the `openai` SDK pointed at DeepSeek's endpoint.

### Local Qwen / SGLang servers

This branch adds a client-side compatibility adapter. If an OpenAI-compatible server leaves Qwen tool calls in `<tool_call>` text instead of populating the standard `tool_calls` field, the adapter normalizes them at the API boundary. Standard server-provided tool calls pass through unchanged.

For example:

```dotenv
DEEPSEEK_API_KEY=dummy
DEEPSEEK_BASE_URL=http://10.86.84.160:8002/v1
MODEL_ID=qwen3.5-35b-a3b
```

Each lesson contains its own `tool-call-adapter.ts`, so it remains independently copyable and runnable. A native server-side tool-call parser is still more reliable; the local adapter is a fallback when the server cannot be changed.

---

## A note for TypeScript beginners (about types)

This course aims for **minimalism**. The type strategy is "enough is enough":

- **Fill in the types that matter at the edges** — messages, tools, and function signatures use real types, giving you editor autocomplete and immediate red squiggles on typos.
- **The mini framework is deliberately kept simple internally** — places like `ctx.services` and event `payload` that are "typed only at runtime" stay `any`, and we **never introduce generics or such complex syntax for the sake of types** (the real harness trades generics for full type safety — that's its choice; we keep the focus on "how the harness works").
- Occasionally you'll see one manual type annotation (e.g. `(args: { command: string })`) — that's the only small tax at the "crossing the any-typed framework" spots, and the code comments point it out.

In one line: **understandability over type rigor**. Every avoidable bit of type gymnastics is skipped, with Chinese comments alongside.

If you really aren't familiar with TypeScript, you can absolutely use AI to parse the syntax and meaning line by line while reading these ~100 lines of agent code — far easier than reading DeepSeek Harness's real source directly.
