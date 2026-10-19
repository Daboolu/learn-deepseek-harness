// L7

import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import { execSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import * as readline from "node:readline/promises"
import { adaptToolCalls } from "./tool-call-adapter.js"
import "dotenv/config"

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
})
const MODEL = process.env.MODEL_ID ?? "deepseek-chat"
const SYSTEM = `You are a coding agent working in ${process.cwd()}. Use tools to accomplish tasks. When the user tells you a durable fact about themselves or the project, call remember to save it. Act, don't over-explain.`

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
//  Session (same as L3)
// ═══════════════════════════════════════════════════════════════
type SurfaceType = "user/message" | "assistant/message" | "tool/result"
interface SessionEvent {
  seq: number
  type: SurfaceType | "turn/start" | "turn/end"
  data: any
}

class Session {
  events: SessionEvent[] = []
  surface: number[] = []
  private seqCounter = 0
  append(type: SessionEvent["type"], data: any, onSurface = false): SessionEvent {
    const event: SessionEvent = { seq: this.seqCounter++, type, data }
    this.events.push(event)
    if (onSurface) this.surface.push(event.seq)
    return event
  }
  deriveMessages(): ChatCompletionMessageParam[] {
    // seq equals the event's index in events (events only grows, seq increments in lockstep with push), so index directly
    return this.surface.map((seq) => {
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
//  Tool registry + bash
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
//  ★ Star of this lesson: the memory plugin
// ═══════════════════════════════════════════════════════════════
const MEMORY_FILE = "agent-memory.json"

function memoryPlugin(ctx: Ctx) {
  type Memory = { text: string; ts: string }
  const memories: Memory[] = existsSync(MEMORY_FILE) ? JSON.parse(readFileSync(MEMORY_FILE, "utf8")) : []
  let recalled = false

  // write: the remember tool. Persists to a disk file so future sessions can read it back
  ctx.services.tools.register(
    "remember",
    {
      description: "Save a durable fact about the user or project for future sessions.",
      parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
    },
    (args: { fact: string }) => {
      memories.push({ text: args.fact, ts: new Date().toISOString() })
      writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2))
      return `Remembered: ${args.fact}`
    },
  )

  // recall: on this session's first agent/pre-step, write the known facts as one event onto the surface (once).
  // It is early and stable, so it is cache-friendly. A real system retrieves by relevance; here we inject all of them.
  ctx.on("agent/pre-step", async ({ session }: { session: Session }, next: NextFn) => {
    if (!recalled && memories.length) {
      recalled = true
      const list = memories.map((m, i) => `${i + 1}. ${m.text}`).join("\n")
      session.append("user/message", { content: `[memory] known facts about the user/project:\n${list}` }, true)
      console.log(`\x1b[35m[memory] recalled ${memories.length} memories\x1b[0m`)
    }
    return next()
  })
}

// ═══════════════════════════════════════════════════════════════
//  Loop (same as L3)
// ═══════════════════════════════════════════════════════════════
async function step(ctx: Ctx, session: Session): Promise<boolean> {
  const messages: ChatCompletionMessageParam[] = await ctx.waterfall("agent/pre-step", { session }, async () => [
    { role: "system", content: SYSTEM },
    ...session.deriveMessages(),
  ])
  const res = await client.chat.completions.create({ model: MODEL, messages, tools: ctx.services.tools.schemas(), max_tokens: 4000 })
  const msg = adaptToolCalls(res.choices[0].message)
  session.append("assistant/message", { message: msg }, true)
  if (!msg.tool_calls?.length) return false
  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments)
    console.log(`\x1b[33m$ ${call.function.name} ${JSON.stringify(args)}\x1b[0m`)
    const output = ctx.services.tools.execute(call.function.name, args)
    console.log(output.slice(0, 200))
    session.append("tool/result", { tool_call_id: call.id, content: output }, true)
  }
  return true
}

async function runTurn(ctx: Ctx, session: Session, userText: string) {
  session.append("turn/start", { text: userText })
  session.append("user/message", { content: userText }, true)
  while (await step(ctx, session)) {}
  session.append("turn/end", {})
}

// ═══════════════════════════════════════════════════════════════
//  Assembly
// ═══════════════════════════════════════════════════════════════
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry())
bashPlugin(ctx)
memoryPlugin(ctx)

const session = new Session()
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

console.log("L7 · Cross-Session Memory")
console.log(`Memories are stored in ${MEMORY_FILE}. Tell it facts about you, then rerun to recall. Type q to quit.\n`)

while (true) {
  const q = await rl.question("\x1b[36mL7 >> \x1b[0m")
  if (["q", "exit", ""].includes(q.trim().toLowerCase())) break
  await runTurn(ctx, session, q)
  const last = session.events[session.events.length - 2]
  if (last?.type === "assistant/message" && typeof last.data.message.content === "string") {
    console.log(last.data.message.content)
  }
  console.log()
}
rl.close()
