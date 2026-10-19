// L10

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
const SYSTEM =
  `You are a coding agent working in ${process.cwd()}. ` +
  `If a small pure transformation would help, you may create a tool for it via define_tool ` +
  `(the tool body reads a variable 'input' and returns a value), then call the newly created tool. ` +
  `Act, don't over-explain.`

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
//  Tool registry (execute async; supports register at any time at runtime)
// ═══════════════════════════════════════════════════════════════
function createToolRegistry() {
  const tools: Record<string, { schema: any; run: (args: any) => string | Promise<string> }> = {}
  return {
    register(name: string, schema: any, run: (args: any) => string | Promise<string>) {
      tools[name] = { schema, run }
    },
    // called anew on every request to regenerate the tool list — so a tool added at runtime is visible on the next step
    schemas(): ChatCompletionTool[] {
      return Object.entries(tools).map(([name, t]) => ({ type: "function", function: { name, ...t.schema } }))
    },
    async execute(name: string, args: any): Promise<string> {
      const t = tools[name]
      return t ? await t.run(args) : `Error: unknown tool ${name}`
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
//  ★ Star of this lesson: the self-modification tool define_tool
// ═══════════════════════════════════════════════════════════════
function selfModificationPlugin(ctx: Ctx) {
  ctx.services.tools.register(
    "define_tool",
    {
      description:
        "Create and mount a new tool at runtime for this session. The body reads a string variable `input` and returns a value. " +
        "After creation, call the new tool by its name.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "new tool name (letters/underscore)" },
          description: { type: "string" },
          code: { type: "string", description: "JS function body; reads `input`, uses `return`" },
        },
        required: ["name", "description", "code"],
      },
    },
    (args: { name: string; description: string; code: string }) => {
      let fn: (input: string) => unknown
      try {
        // run the model-written code directly: trust level equals bash, not a security boundary
        fn = new Function("input", args.code) as (input: string) => unknown
      } catch (e: any) {
        return `Error: failed to parse code — ${e.message}`
      }
      ctx.services.tools.register(
        args.name,
        { description: args.description, parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } },
        (a: { input: string }) => {
          try {
            return String(fn(a.input))
          } catch (e: any) {
            return `Error: ${e.message}`
          }
        },
      )
      console.log(`\x1b[35m[self-mod] mounted new tool "${args.name}"\x1b[0m`)
      return `Mounted tool "${args.name}"; callable within this session (ephemeral, lost when the process ends).`
    },
  )
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
  const msg = adaptToolCalls(res.choices[0].message)
  session.append("assistant/message", { message: msg }, true)
  if (!msg.tool_calls?.length) return false
  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments)
    console.log(`\x1b[33m$ ${call.function.name} ${JSON.stringify(args).slice(0, 200)}\x1b[0m`)
    const output = await ctx.services.tools.execute(call.function.name, args)
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
selfModificationPlugin(ctx)

const session = new Session()
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

console.log("L10 · Self-Modification")
console.log("Ask it to build itself a tool first, then use that tool. Type q to quit.\n")

while (true) {
  const q = await rl.question("\x1b[36mL10 >> \x1b[0m")
  if (["q", "exit", ""].includes(q.trim().toLowerCase())) break
  await runTurn(ctx, session, q)
  const last = session.events[session.events.length - 2]
  if (last?.type === "assistant/message" && typeof last.data.message.content === "string") console.log(last.data.message.content)
  console.log()
}
rl.close()
