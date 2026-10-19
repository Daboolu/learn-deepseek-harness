# L1 · The Bare Loop

## What this lesson covers

The core of an AI coding agent is a loop:

> Send the user input to the model → if the model requests a tool, run it → write the tool result back into the conversation → send again → until the model stops requesting tools.

This lesson runs it in ~100 lines of TypeScript, talking to a real DeepSeek model and letting it accomplish tasks with the `bash` tool.

```
   user prompt ──> model ──> requests tool? ──yes──> run bash ──> result back to conversation
                    ^                                              │
                    └───────────────────────────────────────────────┘
```

## Core code

```ts
async function agentLoop(history) {
  while (true) {
    const res = await client.chat.completions.create({ messages: history, tools: TOOLS })
    const msg = res.choices[0].message
    history.push(msg)
    if (!msg.tool_calls?.length) return              // model requested no tool, done
    for (const call of msg.tool_calls) {
      const output = runBash(JSON.parse(call.function.arguments).command)
      history.push({ role: "tool", tool_call_id: call.id, content: output })
    }
  }
}
```

## How it works

Take `how many .ts files are in the current directory` as an example:

```
user input
  → model requests bash{ command: "ls *.ts | wc -l" }     history appends assistant(tool_call)
  → run it, get "3"                                        history appends tool(result)
  → model replies "There are 3 .ts files." (no more tools) history appends assistant(text)
  → loop ends
```

The model decides when the loop ends by whether it returns `tool_calls`; a tool result is linked to its call via `tool_call_id`.

## How the three pillars show up here

This lesson is intentionally rough. It presents three limitations up front, which the next three lessons resolve one by one:

| Pillar | Limitation here | Resolved by |
|--------|-----------------|-------------|
| 🧩 P1 Everything is a plugin | ❶ bash, safety checks and loop logic are coupled together; adding a tool means editing `agentLoop`. | **L2** split into plugins |
| 📜 P2 Session Log | ❷ the conversation is a mutable array `history`; it can be modified at will, is lost when the process ends, and cannot be deterministically replayed. | **L3** switch to an append-only event log |
| ⚡ P3 KV Cache | ❸ the entire `history` is resent every round; this lesson does not address the cache cost. | **L4** examine it from a KV-cache angle |

## Try it

```bash
# Create a local .env file (ignored by Git)
npm install
npm run dev
```

Try: `what files are in the current directory?`, `create hello.txt and write a line into it`, `how many lines is code.ts?`

The yellow `$ command` is the shell the model requested; its output follows below.

## Next

L2 introduces this course's most fundamental change — **everything is a plugin**: a minimal loop plus an event system, with `bash` turned from an inline function into a pluggable plugin.
