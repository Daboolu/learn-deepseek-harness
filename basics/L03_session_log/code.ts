// L3

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
//  Mini framework (same as L2)
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
//  ★ Star of this lesson: Session — an append-only event log
// ═══════════════════════════════════════════════════════════════
type SurfaceType = "user/message" | "assistant/message" | "tool/result"
interface SessionEvent {
  seq: number
  type: SurfaceType | "turn/start" | "turn/end"
  data: any
}

class Session {
  events: SessionEvent[] = []
  surface: number[] = [] // seqs of events on the surface, ordered
  private seqCounter = 0

  // onSurface decides whether the event enters the conversation. L3 only supports append; replace arrives in L6
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
          return e.data.message // stores the full model message, including content and tool_calls
        case "tool/result":
          return { role: "tool", tool_call_id: e.data.tool_call_id, content: e.data.content }
        default:
          throw new Error(`a non-surface event should not appear in the surface list: ${e.type}`)
      }
    })
  }
}

// ═══════════════════════════════════════════════════════════════
//  Tool registry + bash/log plugins (same as L2)
// ═══════════════════════════════════════════════════════════════
function createToolRegistry() {
  const tools: Record<string, { schema: any; run: (args: any) => string }> = {}
  return {
    register(name: string, schema: any, run: (args: any) => string) {
      tools[name] = { schema, run }
    },
    schemas(): ChatCompletionTool[] {
      return Object.entries(tools).map(([name, t]) => ({
        type: "function",
        function: { name, ...t.schema },
      }))
    },
    execute(name: string, args: any): string {
      const t = tools[name]
      if (!t) return `Error: unknown tool ${name}`
      return t.run(args)
    },
  }
}

function bashPlugin(ctx: Ctx) {
  function runBash(command: string): string {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
    if (dangerous.some((d) => command.includes(d))) return "Error: dangerous command blocked"
    try {
      const out = execSync(command, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] })
      return out.trim().slice(0, 50_000) || "(no output)"
    } catch (e: any) {
      const out = ((e.stdout ?? "") + (e.stderr ?? "")).trim()
      return out ? out.slice(0, 50_000) : `Error: ${e.message}`
    }
  }
  ctx.services.tools.register(
    "bash",
    {
      description: "Run a shell command and return its output.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "the shell command" } },
        required: ["command"],
      },
    },
    (args: { command: string }) => runBash(args.command),
  )
}

function logPlugin(ctx: Ctx) {
  ctx.on("tools/result", ({ exec }) => {
    console.log(`\x1b[90m  [log] tool "${exec.name}" finished\x1b[0m`)
  })
}

// ═══════════════════════════════════════════════════════════════
//  Loop: now appends events to the Session instead of mutating an array
// ═══════════════════════════════════════════════════════════════
async function step(ctx: Ctx, session: Session): Promise<boolean> {
  // SYSTEM is assembled each time and not written to the log: it belongs to the request envelope, not the conversation history
  const messages: ChatCompletionMessageParam[] = await ctx.waterfall("agent/pre-step", { session }, async () => [
    { role: "system", content: SYSTEM },
    ...session.deriveMessages(),
  ])

  const res = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools: ctx.services.tools.schemas(),
    max_tokens: 4000,
  })
  const msg = adaptToolCalls(res.choices[0].message)
  session.append("assistant/message", { message: msg }, true)
  if (!msg.tool_calls?.length) return false

  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments) as { command: string }
    console.log(`\x1b[33m$ ${args.command ?? JSON.stringify(args)}\x1b[0m`)
    const output: string = ctx.services.tools.execute(call.function.name, args)
    console.log(output.slice(0, 300))
    session.append("tool/result", { tool_call_id: call.id, content: output }, true)
    await ctx.emit("tools/result", { exec: { name: call.function.name, args }, result: { content: output } })
  }
  return true
}

async function runTurn(ctx: Ctx, session: Session, userText: string) {
  session.append("turn/start", { text: userText }) // boundary event, does not enter the surface
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
logPlugin(ctx)

const session = new Session()

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

console.log("L3 · The Session Log Is the Single Source of Truth")
console.log("Commands: /log print the event log | /surface print the surface | q to quit\n")

while (true) {
  const q = await rl.question("\x1b[36mL3 >> \x1b[0m")
  const cmd = q.trim().toLowerCase()
  if (["q", "exit", ""].includes(cmd)) break

  if (cmd === "/log") {
    console.log("\x1b[90m── event log (records all events) ──\x1b[0m")
    for (const e of session.events) {
      const on = session.surface.includes(e.seq) ? "\x1b[32m[on surface]\x1b[0m" : "\x1b[90m[log only]\x1b[0m"
      console.log(`  seq ${String(e.seq).padStart(2)} ${e.type.padEnd(18)} ${on}`)
    }
    console.log()
    continue
  }
  if (cmd === "/surface") {
    console.log(`\x1b[90msurface (seq order the model sees):\x1b[0m [${session.surface.join(", ")}]\n`)
    continue
  }

  await runTurn(ctx, session, q)
  // the last event is turn/end; the one before it is this turn's final assistant message
  const last = session.events[session.events.length - 2]
  if (last?.type === "assistant/message" && typeof last.data.message.content === "string") {
    console.log(last.data.message.content)
  }
  console.log()
}
rl.close()
