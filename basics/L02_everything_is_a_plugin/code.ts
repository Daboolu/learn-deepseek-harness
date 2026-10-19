// L2

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
//  Mini framework: shared context + event system (copied verbatim into later lessons)
//
//  Using `any` inside the framework is a deliberate trade-off. Precise typing would require
//  generics and an event map on Ctx, drifting from this lesson's topic. The real DeepSeek
//  Harness trades generics for full type safety.
// ═══════════════════════════════════════════════════════════════
type NextFn = () => Promise<any>
type Listener = (payload: any, next: NextFn) => Promise<any> | any

class Ctx {
  services: Record<string, any> = {}
  private listeners: Record<string, Listener[]> = {}

  provide(name: string, service: any) {
    this.services[name] = service
  }

  // returns an unregister function so a plugin can clean up its own listeners on unload
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

  // base is the default value when the chain reaches its end; each listener calls next() to get the downstream result and may reshape it
  async waterfall(event: string, payload: any, base: NextFn): Promise<any> {
    const chain = this.listeners[event] ?? []
    let i = 0
    const next: NextFn = () =>
      i < chain.length ? Promise.resolve(chain[i++](payload, next)) : base()
    return next()
  }
}

// ═══════════════════════════════════════════════════════════════
//  Service: the tool registry (tools are now registered in, not inlined in the loop)
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

// ═══════════════════════════════════════════════════════════════
//  Plugin 1: bash — registers bash as a tool
// ═══════════════════════════════════════════════════════════════
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
    // explicit param type: register obtained via the any-typed ctx.services has no contextual type, so under strict we annotate it ourselves
    (args: { command: string }) => runBash(args.command),
  )
}

// ═══════════════════════════════════════════════════════════════
//  Plugin 2: log — a pure observer that only listens to "a tool has executed", without touching the main flow.
//  It changes neither the loop nor bash, proving that adding a capability needs no change to the core.
// ═══════════════════════════════════════════════════════════════
function logPlugin(ctx: Ctx) {
  ctx.on("tools/result", ({ exec }) => {
    console.log(`\x1b[90m  [log] tool "${exec.name}" finished\x1b[0m`)
  })
}

// ═══════════════════════════════════════════════════════════════
//  Minimal loop: only fires events and calls services; contains no concrete capability
// ═══════════════════════════════════════════════════════════════
async function step(ctx: Ctx, history: ChatCompletionMessageParam[]): Promise<boolean> {
  // agent/pre-step waterfall: the unified hook before a request. No listener yet, so base returns history as-is; from L4 on, context is injected here
  const messages: ChatCompletionMessageParam[] = await ctx.waterfall("agent/pre-step", { history }, async () => history)

  const res = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools: ctx.services.tools.schemas(),
    max_tokens: 4000,
  })
  const msg = adaptToolCalls(res.choices[0].message)
  history.push(msg)
  if (!msg.tool_calls?.length) return false

  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments) as { command: string }
    console.log(`\x1b[33m$ ${args.command ?? JSON.stringify(args)}\x1b[0m`)
    const output: string = ctx.services.tools.execute(call.function.name, args)
    console.log(output.slice(0, 300))
    history.push({ role: "tool", tool_call_id: call.id, content: output })
    await ctx.emit("tools/result", { exec: { name: call.function.name, args }, result: { content: output } })
  }
  return true
}

async function runAgent(ctx: Ctx, history: ChatCompletionMessageParam[]) {
  while (await step(ctx, history)) {}
}

// ═══════════════════════════════════════════════════════════════
//  Assembly: adding/removing a capability only touches these lines; the loop stays put
// ═══════════════════════════════════════════════════════════════
const ctx = new Ctx()
ctx.provide("tools", createToolRegistry())
bashPlugin(ctx)
logPlugin(ctx) // comment out this line to verify: removing a capability needs no change to the loop

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const history: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM }]

console.log("L2 · Everything Is a Plugin")
console.log("Type a question and press enter; type q to quit.\n")

while (true) {
  const q = await rl.question("\x1b[36mL2 >> \x1b[0m")
  if (["q", "exit", ""].includes(q.trim().toLowerCase())) break
  history.push({ role: "user", content: q })
  await runAgent(ctx, history)
  const last = history[history.length - 1]
  if (last.role === "assistant" && typeof last.content === "string") console.log(last.content)
  console.log()
}
rl.close()
