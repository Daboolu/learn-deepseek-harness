let localToolCallSeq = 0

// Some OpenAI-compatible servers leave Qwen tool calls in XML-like content instead of
// populating message.tool_calls. Normalize that fallback at the API boundary.
export function adaptToolCalls(message: any) {
  if (message.tool_calls?.length || typeof message.content !== "string") return message

  const blocks = [...message.content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)]
  const toolCalls = blocks.flatMap((block: RegExpMatchArray) => {
    const body = block[1].trim()

    try {
      const parsed = JSON.parse(body)
      const name = parsed.name ?? parsed.function?.name
      const args = parsed.arguments ?? parsed.function?.arguments ?? {}
      if (!name) return []
      return [{
        id: `local_call_${++localToolCallSeq}`,
        type: "function",
        function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
      }]
    } catch {
      const fn = body.match(/<function=([^>]+)>\s*([\s\S]*?)\s*<\/function>/)
      if (!fn) return []

      const args: Record<string, unknown> = {}
      for (const param of fn[2].matchAll(/<parameter=([^>]+)>\s*([\s\S]*?)\s*<\/parameter>/g)) {
        const value = param[2].trim()
        try { args[param[1]] = JSON.parse(value) }
        catch { args[param[1]] = value }
      }
      return [{
        id: `local_call_${++localToolCallSeq}`,
        type: "function",
        function: { name: fn[1].trim(), arguments: JSON.stringify(args) },
      }]
    }
  })

  if (toolCalls.length) {
    message.content = null
    message.tool_calls = toolCalls
  }
  return message
}
