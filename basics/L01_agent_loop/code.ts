// L1

import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import { execSync } from "node:child_process"
import * as readline from "node:readline/promises"
import "dotenv/config"

// DeepSeek's API is OpenAI-compatible, so we use the openai SDK pointed at DeepSeek's endpoint
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
})
const MODEL = process.env.MODEL_ID ?? "deepseek-chat"

const SYSTEM = `You are a coding agent working in ${process.cwd()}. Use the bash tool to accomplish tasks. Act, don't over-explain.`

const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command and return its output.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "the shell command" } },
        required: ["command"],
      },
    },
  },
]

function runBash(command: string): string {
  // minimal safety guard; L5 upgrades this into a full permission pipeline
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
  if (dangerous.some((d) => command.includes(d))) return "Error: dangerous command blocked"

  try {
    const out = execSync(command, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] })
    return out.trim().slice(0, 50_000) || "(no output)"
  } catch (e: any) {
    // a non-zero exit makes execSync throw, but stdout/stderr must still go back to the model
    const out = ((e.stdout ?? "") + (e.stderr ?? "")).trim()
    return out ? out.slice(0, 50_000) : `Error: ${e.message}`
  }
}

async function agentLoop(history: ChatCompletionMessageParam[]) {
  while (true) {
    const res = await client.chat.completions.create({
      model: MODEL,
      messages: history,
      tools: TOOLS,
      max_tokens: 4000,
    })

    const msg = res.choices[0].message
    history.push(msg)

    // model requested no tool, this turn is done
    if (!msg.tool_calls || msg.tool_calls.length === 0) return

    for (const call of msg.tool_calls) {
      // arguments is a model-generated JSON string whose shape is only known at runtime: a boundary the type system can't cover
      const args = JSON.parse(call.function.arguments) as { command: string }
      console.log(`\x1b[33m$ ${args.command}\x1b[0m`)
      const output = runBash(args.command)
      console.log(output.slice(0, 300))
      history.push({ role: "tool", tool_call_id: call.id, content: output })
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const history: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM }]

console.log("L1 · The Bare Loop")
console.log("Type a question and press enter; type q to quit.\n")

while (true) {
  const q = await rl.question("\x1b[36mL1 >> \x1b[0m")
  if (["q", "exit", ""].includes(q.trim().toLowerCase())) break

  history.push({ role: "user", content: q })
  await agentLoop(history)

  const last = history[history.length - 1]
  if (last.role === "assistant" && typeof last.content === "string") console.log(last.content)
  console.log()
}
rl.close()
