// L8

import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import { execSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import * as readline from "node:readline/promises"
import "dotenv/config"

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
})
const MODEL = process.env.MODEL_ID ?? "deepseek-chat"
const SYSTEM = `You are a coding agent working in ${process.cwd()}. Use tools to accomplish tasks. When the user states a durable fact about themselves or the project, call remember. Act, don't over-explain.`

// ═══════════════════════════════════════════════════════════════
//  Mini framework
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
//  Session (with replace, from L6)
// ═══════════════════════════════════════════════════════════════
type SurfaceType = "user/message" | "assistant/message" | "tool/result"
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
    if (op === "append") this.surface.push(event.seq)
    else if (op && op.op === "replace") {
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
//  Tool registry with the pipeline (from L5)
// ═══════════════════════════════════════════════════════════════
interface ToolExec {
  callId: string
  name: string
  args: any
}
interface ToolResult {
  content: string
  isError: boolean
}
type PreToolDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask"; reason: string }

function createToolRegistry(ctx: Ctx) {
  const tools: Record<string, { schema: any; run: (args: any) => string }> = {}
  const guards: Array<(exec: ToolExec) => string | undefined> = []
  return {
    register(name: string, schema: any, run: (args: any) => string) {
      tools[name] = { schema, run }
    },
    guard(fn: (exec: ToolExec) => string | undefined) {
      guards.push(fn)
    },
    schemas(): ChatCompletionTool[] {
      return Object.entries(tools).map(([name, t]) => ({ type: "function", function: { name, ...t.schema } }))
    },
    async execute(exec: ToolExec): Promise<ToolResult> {
      let decision: PreToolDecision = await ctx.waterfall("tools/pre-execute", { exec }, async () => ({ kind: "allow" }))
      for (const g of guards) {
        const r = g(exec)
        if (r) decision = { kind: "deny", reason: r }
      }
      if (decision.kind === "ask") {
        const confirm = ctx.services.confirm as undefined | ((e: ToolExec, r: string) => Promise<boolean>)
        decision = confirm && (await confirm(exec, decision.reason)) ? { kind: "allow" } : { kind: "deny", reason: "not approved by user" }
      }
      if (decision.kind === "deny") return { content: `Error: tool call denied — ${decision.reason}`, isError: true }
      const t = tools[exec.name]
      let result: ToolResult = t ? { content: t.run(exec.args), isError: false } : { content: `Error: unknown tool ${exec.name}`, isError: true }
      result = await ctx.waterfall("tools/post-execute", { exec, result }, async () => result)
      await ctx.emit("tools/result", { exec, result })
      return result
    },
  }
}

// ═══════════════════════════════════════════════════════════════
//  Plugins (each independent, all from earlier lessons)
// ═══════════════════════════════════════════════════════════════
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

function readFilePlugin(ctx: Ctx) {
  ctx.services.tools.register(
    "read_file",
    { description: "Read a UTF-8 text file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    (args: { path: string }) => {
      try {
        return readFileSync(args.path, "utf8").slice(0, 50_000)
      } catch (e: any) {
        return `Error: ${e.message}`
      }
    },
  )
}

function permissionPlugin(ctx: Ctx) {
  ctx.services.tools.guard((exec: ToolExec) =>
    exec.name === "bash" && /rm\s+-rf\s+\/(?!\w)|shutdown|reboot/.test(exec.args.command ?? "") ? "matched an unexecutable dangerous pattern" : undefined,
  )
  ctx.on("tools/pre-execute", ({ exec }: { exec: ToolExec }): PreToolDecision => {
    if (exec.name === "bash" && /\b(rm|mv|cp|chmod|git\s+push|>|>>|tee|mkdir|touch|npm\s+i)/.test(exec.args.command ?? "")) {
      return { kind: "ask", reason: `about to run a command that may modify the system: ${exec.args.command}` }
    }
    return { kind: "allow" }
  })
}

function timeContextPlugin(ctx: Ctx) {
  // append to the end to keep the prefix stable (P3)
  ctx.on("agent/pre-step", async (_p: unknown, next: NextFn) => {
    const messages: ChatCompletionMessageParam[] = await next()
    return [...messages, { role: "user", content: `[context] current time: ${new Date().toISOString()}` }]
  })
}

const MEMORY_FILE = "agent-memory.json"
function memoryPlugin(ctx: Ctx) {
  type Memory = { text: string; ts: string }
  const memories: Memory[] = existsSync(MEMORY_FILE) ? JSON.parse(readFileSync(MEMORY_FILE, "utf8")) : []
  let recalled = false
  ctx.services.tools.register(
    "remember",
    { description: "Save a durable fact for future sessions.", parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] } },
    (args: { fact: string }) => {
      memories.push({ text: args.fact, ts: new Date().toISOString() })
      writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2))
      return `Remembered: ${args.fact}`
    },
  )
  ctx.on("agent/pre-step", async ({ session }: { session: Session }, next: NextFn) => {
    if (!recalled && memories.length) {
      recalled = true
      session.append("user/message", { content: `[memory] known facts:\n${memories.map((m, i) => `${i + 1}. ${m.text}`).join("\n")}` }, "append")
    }
    return next()
  })
}

const COMPACT_INSTRUCTION = "You are now a compaction engine. Condense the conversation above into a concise checkpoint, preserving the goal, key steps, conclusions, and open items. Output only the checkpoint text; do not call tools, and do not mention this compaction."
function compactionPlugin(ctx: Ctx, threshold = 10, retain = 4) {
  async function summarize(rangeMsgs: ChatCompletionMessageParam[]): Promise<string> {
    // reuse the conversation prefix + instruction at the end to maximize cache hits (P3)
    const messages: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM }, ...rangeMsgs, { role: "user", content: COMPACT_INSTRUCTION }]
    const res = await client.chat.completions.create({ model: MODEL, messages, tools: ctx.services.tools.schemas(), max_tokens: 1024 })
    return res.choices[0].message.content ?? "(empty summary)"
  }
  ctx.on("agent/pre-step", async ({ session }: { session: Session }, next: NextFn) => {
    if (session.surface.length > threshold && session.surface.length > retain) {
      let cut = session.surface.length - retain
      while (cut < session.surface.length && session.typeOfSeq(session.surface[cut]) === "tool/result") cut++
      if (cut >= 2) {
        const range = session.surface.slice(0, cut)
        const start = range[0]
        const end = range[range.length - 1]
        session.append("compact/start", { start, end })
        const summary = await summarize(session.deriveMessages(range))
        session.append("compact/summary", { summary, shadowed: range })
        session.append("user/message", { content: `<compacted-summary>\n${summary}\n</compacted-summary>` }, { op: "replace", start, end })
        session.append("compact/end", {})
        console.log(`\x1b[35m[compaction] compacted surface[${start}..${end}]\x1b[0m`)
      }
    }
    return next()
  })
}

// ═══════════════════════════════════════════════════════════════
//  Loop
// ═══════════════════════════════════════════════════════════════
async function step(ctx: Ctx, session: Session): Promise<boolean> {
  const messages: ChatCompletionMessageParam[] = await ctx.waterfall("agent/pre-step", { session }, async () => [
    { role: "system", content: SYSTEM },
    ...session.deriveMessages(),
  ])
  const res = await client.chat.completions.create({ model: MODEL, messages, tools: ctx.services.tools.schemas(), max_tokens: 4000 })
  const msg = res.choices[0].message
  session.append("assistant/message", { message: msg }, "append")
  if (!msg.tool_calls?.length) return false
  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments)
    const exec: ToolExec = { callId: call.id, name: call.function.name, args }
    session.append("tool/call", { callId: exec.callId, name: exec.name, args })
    console.log(`\x1b[33m$ ${exec.name} ${JSON.stringify(args)}\x1b[0m`)
    const result = await ctx.services.tools.execute(exec)
    console.log((result.isError ? "\x1b[31m" : "") + result.content.slice(0, 200) + "\x1b[0m")
    session.append("tool/result", { tool_call_id: call.id, content: result.content }, "append")
  }
  return true
}

async function runTurn(ctx: Ctx, session: Session, userText: string) {
  session.append("turn/start", { text: userText })
  session.append("user/message", { content: userText }, "append")
  while (await step(ctx, session)) {}
  session.append("turn/end", {})
}

// ═══════════════════════════════════════════════════════════════
//  Assembly: a complete harness. Adding/removing a capability only touches this block
// ═══════════════════════════════════════════════════════════════
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry(ctx))
bashPlugin(ctx)
readFilePlugin(ctx)
permissionPlugin(ctx)
memoryPlugin(ctx)
timeContextPlugin(ctx)
compactionPlugin(ctx)

const session = new Session()
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
ctx.provide("confirm", async (_e: ToolExec, reason: string) => (await rl.question(`\x1b[31m[confirm] ${reason}\n  Allow? (y/N) \x1b[0m`)).trim().toLowerCase() === "y")

console.log("L8 · Assemble a Small Harness")
console.log("Loaded: bash + read_file + permissions + memory + time context + compaction. Type q to quit.\n")

while (true) {
  const q = await rl.question("\x1b[36mL8 >> \x1b[0m")
  if (["q", "exit", ""].includes(q.trim().toLowerCase())) break
  await runTurn(ctx, session, q)
  const last = session.events[session.events.length - 2]
  if (last?.type === "assistant/message" && typeof last.data.message.content === "string") console.log(last.data.message.content)
  console.log()
}
rl.close()
