// L6

import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import { execSync } from "node:child_process"
import * as readline from "node:readline/promises"
import { adaptToolCalls } from "./tool-call-adapter.js"
import "dotenv/config"

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
})
const MODEL = process.env.MODEL_ID ?? "deepseek-chat"
const SYSTEM = `You are a coding agent working in ${process.cwd()}. Use tools to accomplish tasks. Act, don't over-explain.`

// ═══════════════════════════════════════════════════════════════
//  Mini framework (same as before)
// ═══════════════════════════════════════════════════════════════
type NextFn = () => Promise<any>
type Listener = (payload: any, next: NextFn) => Promise<any> | any

class Ctx {
  services: Record<string, any> = {}
  private listeners: Record<string, Listener[]> = {}
  provide(name: string, service: any) {
    this.services[name] = service
  }
  on(event: string, fn: Listener): () => void {
    ;(this.listeners[event] ??= []).push(fn)
    return () => {
      const arr = this.listeners[event]!
      arr.splice(arr.indexOf(fn), 1)
    }
  }
  async emit(event: string, payload: any): Promise<void> {
    for (const fn of this.listeners[event] ?? []) await fn(payload, async () => {})
  }
  async waterfall(event: string, payload: any, base: NextFn): Promise<any> {
    const chain = this.listeners[event] ?? []
    let i = 0
    const next: NextFn = () =>
      i < chain.length ? Promise.resolve(chain[i++](payload, next)) : base()
    return next()
  }
}

// ═══════════════════════════════════════════════════════════════
//  Session: adds replace semantics
// ═══════════════════════════════════════════════════════════════
type SurfaceType = "user/message" | "assistant/message" | "tool/result"
// append: enter the surface tail; replace: replace the [start,end] span on the surface with this event
type SurfaceOp = "append" | { op: "replace"; start: number; end: number }
interface SessionEvent {
  seq: number
  type: SurfaceType | "turn/start" | "turn/end" | "tool/call" | "compact/start" | "compact/summary" | "compact/end"
  data: any
}

class Session {
  events: SessionEvent[] = []
  surface: number[] = []
  private seqCounter = 0

  append(type: SessionEvent["type"], data: any, op?: SurfaceOp): SessionEvent {
    const event: SessionEvent = { seq: this.seqCounter++, type, data }
    this.events.push(event)
    if (op === "append") {
      this.surface.push(event.seq)
    } else if (op && op.op === "replace") {
      // replace the contiguous [start,end] span on the surface with the new event; the replaced originals stay in the log
      const i = this.surface.indexOf(op.start)
      const j = this.surface.indexOf(op.end)
      this.surface.splice(i, j - i + 1, event.seq)
    }
    return event
  }

  typeOfSeq(seq: number): string {
    return this.events[seq].type // seq is the event index, so index directly
  }

  deriveMessages(seqs: number[] = this.surface): ChatCompletionMessageParam[] {
    // seq equals the event's index in events (events only grows, seq increments in lockstep with push), so index directly
    return seqs.map((seq) => {
      const e = this.events[seq]
      switch (e.type) {
        case "user/message":
          return { role: "user", content: e.data.content }
        case "assistant/message":
          return e.data.message
        case "tool/result":
          return { role: "tool", tool_call_id: e.data.tool_call_id, content: e.data.content }
        default:
          throw new Error(`a non-surface event should not appear in the surface list: ${e.type}`)
      }
    })
  }
}

// ═══════════════════════════════════════════════════════════════
//  Tool registry + bash (simplified)
// ═══════════════════════════════════════════════════════════════
function createToolRegistry() {
  const tools: Record<string, { schema: any; run: (args: any) => string }> = {}
  return {
    register(name: string, schema: any, run: (args: any) => string) {
      tools[name] = { schema, run }
    },
    schemas(): ChatCompletionTool[] {
      return Object.entries(tools).map(([name, t]) => ({ type: "function", function: { name, ...t.schema } }))
    },
    execute(name: string, args: any): string {
      const t = tools[name]
      return t ? t.run(args) : `Error: unknown tool ${name}`
    },
  }
}

function bashPlugin(ctx: Ctx) {
  ctx.services.tools.register(
    "bash",
    { description: "Run a shell command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    (args: { command: string }) => {
      try {
        return execSync(args.command, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] }).trim().slice(0, 50_000) || "(no output)"
      } catch (e: any) {
        return (((e.stdout ?? "") + (e.stderr ?? "")).trim() || `Error: ${e.message}`).slice(0, 50_000)
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════
//  ★ Star of this lesson: the compaction plugin
// ═══════════════════════════════════════════════════════════════
const COMPACT_INSTRUCTION =
  "You are now a compaction engine. Condense the conversation above into a concise checkpoint, " +
  "preserving the goal, key steps done, important conclusions, and open items. " +
  "Output only the checkpoint text; do not call tools, and do not mention this compaction request."

// The summarization request reuses the current conversation prefix: [system + span to compact] is the prefix of the
// request just sent, with the compaction instruction placed at the end. So the server hits the existing cache and need
// not recompute the whole span for the summary.
async function summarize(ctx: Ctx, rangeMsgs: ChatCompletionMessageParam[]): Promise<string> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    ...rangeMsgs,
    { role: "user", content: COMPACT_INSTRUCTION },
  ]
  const res = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools: ctx.services.tools.schemas(), // keep the prefix identical to the conversation request to maximize cache reuse
    max_tokens: 1024,
  })
  const hit = (res.usage as any)?.prompt_cache_hit_tokens ?? 0
  console.log(`\x1b[35m[compaction] summarization request reused the conversation prefix, cache hit ${hit} tokens\x1b[0m`)
  return res.choices[0].message.content ?? "(empty summary)"
}

async function maybeCompact(ctx: Ctx, session: Session, threshold: number, retain: number, force = false) {
  if (!force && session.surface.length <= threshold) return
  if (session.surface.length <= retain) return

  let cut = session.surface.length - retain
  // avoid the retained tail starting with an orphaned tool/result (its assistant call is in the compacted span): fold those tool/results into the compacted span
  while (cut < session.surface.length && session.typeOfSeq(session.surface[cut]) === "tool/result") cut++
  if (cut < 2) return

  const rangeSeqs = session.surface.slice(0, cut)
  const start = rangeSeqs[0]
  const end = rangeSeqs[rangeSeqs.length - 1]

  session.append("compact/start", { start, end }) // log-only: records the compaction range
  const summary = await summarize(ctx, session.deriveMessages(rangeSeqs))
  session.append("compact/summary", { summary, shadowed: rangeSeqs }) // log-only: keeps the summary and the shadowed seqs
  // the only surface change: replace the compacted range with one summary message; originals stay in the log
  session.append("user/message", { content: `<compacted-summary>\n${summary}\n</compacted-summary>` }, { op: "replace", start, end })
  session.append("compact/end", {})

  console.log(`\x1b[35m[compaction] replaced surface[${start}..${end}] with one summary; the server cache from that point on will be invalidated (the inherent cost of compaction)\x1b[0m`)
}

// ═══════════════════════════════════════════════════════════════
//  Loop
// ═══════════════════════════════════════════════════════════════
const THRESHOLD = 8 // auto-compact when the surface exceeds this many entries
const RETAIN = 4 // keep this many recent entries uncompacted

async function step(ctx: Ctx, session: Session): Promise<boolean> {
  // compaction hooks at the front of agent/pre-step: (maybe) compact first, then base derives messages from the compacted surface
  const messages: ChatCompletionMessageParam[] = await ctx.waterfall("agent/pre-step", { session }, async () => [
    { role: "system", content: SYSTEM },
    ...session.deriveMessages(),
  ])

  const res = await client.chat.completions.create({ model: MODEL, messages, tools: ctx.services.tools.schemas(), max_tokens: 4000 })
  const msg = adaptToolCalls(res.choices[0].message)
  session.append("assistant/message", { message: msg }, "append")
  if (!msg.tool_calls?.length) return false

  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments)
    console.log(`\x1b[33m$ ${call.function.name} ${JSON.stringify(args)}\x1b[0m`)
    const output = ctx.services.tools.execute(call.function.name, args)
    console.log(output.slice(0, 200))
    session.append("tool/result", { tool_call_id: call.id, content: output }, "append")
  }
  return true
}

function compactionPlugin(ctx: Ctx) {
  ctx.on("agent/pre-step", async ({ session }: { session: Session }, next: NextFn) => {
    await maybeCompact(ctx, session, THRESHOLD, RETAIN)
    return next()
  })
}

async function runTurn(ctx: Ctx, session: Session, userText: string) {
  session.append("turn/start", { text: userText })
  session.append("user/message", { content: userText }, "append")
  while (await step(ctx, session)) {}
  session.append("turn/end", {})
}

// ═══════════════════════════════════════════════════════════════
//  Assembly
// ═══════════════════════════════════════════════════════════════
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry())
bashPlugin(ctx)
compactionPlugin(ctx)

const session = new Session()
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

console.log("L6 · Context Compaction")
console.log(`Auto-compacts when the surface exceeds ${THRESHOLD} entries, keeping the last ${RETAIN}. Commands:`)
console.log("  /compact compact now | /log view the log and surface | q to quit\n")

while (true) {
  const q = await rl.question("\x1b[36mL6 >> \x1b[0m")
  const cmd = q.trim().toLowerCase()
  if (["q", "exit", ""].includes(cmd)) break

  if (cmd === "/compact") {
    await maybeCompact(ctx, session, THRESHOLD, RETAIN, true)
    console.log()
    continue
  }
  if (cmd === "/log") {
    console.log("\x1b[90m── event log (includes originals shadowed by compaction, all kept) ──\x1b[0m")
    for (const e of session.events) {
      const on = session.surface.includes(e.seq) ? "\x1b[32m[on surface]\x1b[0m" : "\x1b[90m[log only]\x1b[0m"
      console.log(`  seq ${String(e.seq).padStart(2)} ${e.type.padEnd(16)} ${on}`)
    }
    console.log(`\x1b[90msurface:\x1b[0m [${session.surface.join(", ")}]\n`)
    continue
  }

  await runTurn(ctx, session, q)
  const last = session.events[session.events.length - 2]
  if (last?.type === "assistant/message" && typeof last.data.message.content === "string") {
    console.log(last.data.message.content)
  }
  console.log()
}
rl.close()
