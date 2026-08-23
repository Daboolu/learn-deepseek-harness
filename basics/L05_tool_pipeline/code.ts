// L5

import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import * as readline from "node:readline/promises"
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
//  Session (same as L3)
// ═══════════════════════════════════════════════════════════════
type SurfaceType = "user/message" | "assistant/message" | "tool/result"
interface SessionEvent {
  seq: number
  type: SurfaceType | "turn/start" | "turn/end" | "tool/call"
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
//  ★ Star of this lesson: a tool registry with a layered pipeline
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
// allow / deny / ask the user
type PreToolDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask"; reason: string }

function createToolRegistry(ctx: Ctx) {
  const tools: Record<string, { schema: any; run: (args: any) => string }> = {}
  const guards: Array<(exec: ToolExec) => string | undefined> = []

  return {
    register(name: string, schema: any, run: (args: any) => string) {
      tools[name] = { schema, run }
    },
    // monotonic guard: once a guard denies, no later stage can reverse it (an unbypassable hard rule)
    guard(fn: (exec: ToolExec) => string | undefined) {
      guards.push(fn)
    },
    schemas(): ChatCompletionTool[] {
      return Object.entries(tools).map(([name, t]) => ({
        type: "function",
        function: { name, ...t.schema },
      }))
    },

    async execute(exec: ToolExec): Promise<ToolResult> {
      // 1) pre-execute waterfall: plugins return allow/deny/ask, default allow
      let decision: PreToolDecision = await ctx.waterfall(
        "tools/pre-execute",
        { exec },
        async () => ({ kind: "allow" }),
      )

      // 2) guard: monotonic denial, after pre-execute; no ask can reverse it
      for (const g of guards) {
        const reason = g(exec)
        if (reason) decision = { kind: "deny", reason }
      }

      // 3) ask: defer to the confirm service to ask the user; degrade to deny when no confirm service exists
      if (decision.kind === "ask") {
        const confirm = ctx.services.confirm as undefined | ((e: ToolExec, r: string) => Promise<boolean>)
        const ok = confirm ? await confirm(exec, decision.reason) : false
        decision = ok ? { kind: "allow" } : { kind: "deny", reason: "not approved by user" }
      }

      if (decision.kind === "deny") {
        return { content: `Error: tool call denied — ${decision.reason}`, isError: true }
      }

      // 4) execute
      const t = tools[exec.name]
      let result: ToolResult = t
        ? { content: t.run(exec.args), isError: false }
        : { content: `Error: unknown tool ${exec.name}`, isError: true }

      // 5) post-execute waterfall: plugins may rewrite the result content
      result = await ctx.waterfall("tools/post-execute", { exec, result }, async () => result)

      // 6) result notification: observe only, cannot change the result
      await ctx.emit("tools/result", { exec, result })
      return result
    },
  }
}

// ═══════════════════════════════════════════════════════════════
//  Tool plugins
// ═══════════════════════════════════════════════════════════════
function bashPlugin(ctx: Ctx) {
  function runBash(command: string): string {
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
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
    (args: { command: string }) => runBash(args.command),
  )
}

function readFilePlugin(ctx: Ctx) {
  ctx.services.tools.register(
    "read_file",
    {
      description: "Read a UTF-8 text file and return its content.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    (args: { path: string }) => {
      try {
        return readFileSync(args.path, "utf8").slice(0, 50_000)
      } catch (e: any) {
        return `Error: ${e.message}`
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════
//  ★ Permission plugin: separates policy from hard rules
//    · hard rules use guard: denied on match, no ask can reverse it (e.g. rm -rf /)
//    · ordinary write/delete operations use pre-execute to return ask, deferring to user confirmation
// ═══════════════════════════════════════════════════════════════
function permissionPlugin(ctx: Ctx) {
  const registry = ctx.services.tools

  registry.guard((exec: ToolExec) => {
    if (exec.name === "bash" && /rm\s+-rf\s+\/(?!\w)|shutdown|reboot|:\(\)\s*\{/.test(exec.args.command ?? "")) {
      return "matched an unexecutable dangerous pattern"
    }
    return undefined
  })

  ctx.on("tools/pre-execute", ({ exec }: { exec: ToolExec }): PreToolDecision => {
    if (exec.name === "bash") {
      const cmd: string = exec.args.command ?? ""
      const mutating = /\b(rm|mv|cp|chmod|chown|git\s+push|>|>>|tee|mkdir|touch|npm\s+i)/.test(cmd)
      if (mutating) return { kind: "ask", reason: `about to run a command that may modify the system: ${cmd}` }
    }
    return { kind: "allow" } // read_file and read-only commands pass through
  })
}

// ═══════════════════════════════════════════════════════════════
//  Loop: record tool/call (audit intent) first, then run the pipeline, then record tool/result
// ═══════════════════════════════════════════════════════════════
async function step(ctx: Ctx, session: Session): Promise<boolean> {
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
  const msg = res.choices[0].message
  session.append("assistant/message", { message: msg }, true)
  if (!msg.tool_calls?.length) return false

  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments)
    const exec: ToolExec = { callId: call.id, name: call.function.name, args }
    // record the call intent (log-only) before executing: on a crash we can tell whether a call was issued
    session.append("tool/call", { callId: exec.callId, name: exec.name, args })
    console.log(`\x1b[33m$ ${exec.name} ${JSON.stringify(args)}\x1b[0m`)
    const result = await ctx.services.tools.execute(exec)
    console.log((result.isError ? "\x1b[31m" : "") + result.content.slice(0, 300) + "\x1b[0m")
    session.append("tool/result", { tool_call_id: call.id, content: result.content }, true)
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
ctx.provide("tools", createToolRegistry(ctx))
bashPlugin(ctx)
readFilePlugin(ctx)
permissionPlugin(ctx)

const session = new Session()
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

// confirm service: the pipeline calls it on ask. Policy (what to ask) lives in the permission plugin; mechanism (how to ask) lives here
ctx.provide("confirm", async (_exec: ToolExec, reason: string): Promise<boolean> => {
  const a = await rl.question(`\x1b[31m[confirmation needed] ${reason}\n  Allow? (y/N) \x1b[0m`)
  return a.trim().toLowerCase() === "y"
})

console.log("L5 · Tool Pipeline + Permissions")
console.log("Read-only commands run directly; write/delete commands ask for confirmation. Type q to quit.\n")

while (true) {
  const q = await rl.question("\x1b[36mL5 >> \x1b[0m")
  if (["q", "exit", ""].includes(q.trim().toLowerCase())) break
  await runTurn(ctx, session, q)
  const last = session.events[session.events.length - 2]
  if (last?.type === "assistant/message" && typeof last.data.message.content === "string") {
    console.log(last.data.message.content)
  }
  console.log()
}
rl.close()
