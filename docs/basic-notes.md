# Basics 学习笔记（L01–L08）

这份笔记记录学习 Basics 过程中实际遇到的问题。目标不是重复课程 README，而是用已经理解过的语言串起 Agent Harness 的执行过程。

## 总览

```text
用户输入
  ↓
runTurn()：开始一轮对话
  ↓
step()：发起一次 LLM 请求
  ↓
agent/pre-step waterfall：记忆、压缩、动态上下文等插件介入
  ↓
LLM 返回普通回答或 tool_calls
  ↓
工具注册表按名称找到并执行工具
  ↓
工具结果写入 Session
  ↓
如果调用了工具，再执行一次 step()
```

贯穿 Basics 的三个核心设计：

```text
P1 一切皆插件：主流程保留扩展点，具体能力从外部接入
P2 Session Log：events 保存事实，surface 决定 LLM 看什么
P3 KV Cache：尽量保持输入 token 的稳定前缀
```

## 开始前：TypeScript、Node.js 与 tsx

- TypeScript 是带类型检查的 JavaScript。
- Node.js 是执行 JavaScript 的运行时。
- `tsx` 是直接运行 `.ts` 文件的命令行工具，不是一门语言。
- `npm run dev` 根据 `package.json` 执行 `tsx code.ts`。
- 终端中的 LLM 回答不是模型直接打印的，而是程序取得 API 响应后调用 `console.log()` 输出。

需要的语法详见 [最小 TypeScript 阅读指南](typescript-reading-guide.md)。

## L01：最小 Agent Loop

### LLM 如何调用工具？

LLM 不会亲自执行命令。程序先把工具的 schema 发给模型：

```ts
client.chat.completions.create({
  messages: history,
  tools: TOOLS,
})
```

模型返回工具调用请求后，程序解析参数并执行：

```ts
const args = JSON.parse(call.function.arguments)
const output = runBash(args.command)
```

`runBash()` 内真正连接操作系统的是：

```ts
execSync(command)
```

工具结果必须作为 `tool` 消息放回历史：

```ts
history.push({
  role: "tool",
  tool_call_id: call.id,
  content: output,
})
```

外层 `while` 随后再次调用 LLM，模型才能根据真实结果回答。

### 黄色 `$ command` 从哪里来？

```ts
console.log(`\x1b[33m$ ${args.command}\x1b[0m`)
```

- `\x1b[33m` 开始黄色。
- `\x1b[0m` 恢复默认颜色。
- 它只展示模型请求的命令；真正执行发生在 `execSync()`。

### `</think>` 是什么？

这是模型或服务端未完全处理好的 reasoning 标签残留，不是 bash 输出，也不是 Harness 主流程产生的内容。

### L01 结论

```text
模型提出工具请求
→ 本地程序执行
→ 工具结果交还模型
→ 模型给出最终回答
```

## L02：共享上下文、事件与插件

### `ctx` 是什么？

`ctx` 是共享上下文，兼具服务容器和事件系统：

```text
ctx
├── services：保存 tools、confirm 等服务
├── on()：注册 listener
├── emit()：广播通知
└── waterfall()：让 listener 组成可修改结果的处理链
```

### `ctx.services.tools` 什么时候出现？

创建 `ctx` 时，services 为空：

```ts
const ctx = new Ctx()
// ctx.services = {}
```

组装阶段执行：

```ts
ctx.provide("tools", createToolRegistry())
```

`provide()` 内部相当于：

```ts
ctx.services["tools"] = toolRegistry
```

此后插件才能调用：

```ts
ctx.services.tools.register(...)
```

因此安装顺序很重要。

### event、listener 和 payload 分别是什么？

```ts
ctx.on("tools/result", listener)
ctx.emit("tools/result", payload)
```

```text
event    = "tools/result"，用于找到监听器的 key
listener = 被保存并在事件触发时执行的函数
payload  = 传给 listener 的数据
```

例如：

```ts
const payload = {
  exec: { name: "bash" },
  result: { content: "hello" },
}
```

`({ exec }) => ...` 是对象解构，等价于先接收 `payload`，再读取 `payload.exec`。

### `emit` 和 `waterfall` 的区别

`emit` 用于通知已经发生的事情：

```text
同一个 payload → listener A、B、C
```

listener 的返回值不会改变主流程，适合日志、指标和审计。

`waterfall` 用于依次介入流程：

```text
listener A → listener B → listener C → base
```

每个 listener 接收相同的 payload，并通过 `next()` 进入下游；返回值再从内向外传回，所以可以被逐层修改。

### `next()` 在哪里实现？

它由 `Ctx.waterfall()` 创建：

```ts
const next = () =>
  i < chain.length
    ? chain[i++](payload, next)
    : base()
```

listener 必须主动调用 `next()`，后续 listener 和 `base()` 才会执行。不调用 `next()` 就会截断处理链。

### L02 结论

主循环不再写死 `bash` 或日志。插件通过注册服务或 listener 增加能力，主流程只调用统一接口和扩展点。

## L03：Session Log 与 surface

### events 与 surface 的关系

```text
events  = 当前 Session 中被 Harness 记录的完整事件账本
surface = LLM 当前可见事件的 seq 索引列表
```

例如：

```ts
events = [
  turnStart,
  userMessage,
  assistantToolCall,
  toolResult,
  assistantAnswer,
  turnEnd,
]

surface = [1, 2, 3, 4]
```

`turn/start` 和 `turn/end` 是内部生命周期事件，不需要给模型看。

### LLM 会直接收到 surface 数字吗？

不会。`deriveMessages()` 遍历 surface，从 events 取事件并转换：

```text
surface seq
→ events[seq]
→ user / assistant / tool message
→ messages
→ LLM API
```

真正发给模型的是：

```ts
client.chat.completions.create({ messages })
```

### Session 与 Turn

- Session：一次完整会话，包含多轮 Turn。
- Turn：一次用户输入到模型最终回答。
- Step：一次 LLM 请求及其工具处理。

一次 Turn 可能包含多个 Step，例如第一次请求工具，第二次根据工具结果回答。

### 为什么每次请求都带上历史？

Chat Completions API 本身无状态。程序必须将当前 surface 派生出的全部 messages 重新发送，模型才能表现出“记得”。

## L04：KV Cache 与上下文位置

### 为什么 append 更利于缓存？

KV Cache 按 token 前缀复用：

```text
append：  稳定旧前缀 | 每轮变化的新内容
prepend： system | 每轮变化的内容 | 全部旧历史
```

动态内容放在末尾时，已有前缀保持一致；插入开头附近时，从变化位置开始的后续缓存都可能失效。

### 时间上下文是否写入 Session？

L04 的时间插件只修改本次请求的 `messages`，不写入 Session Log：

```ts
const messages = await next()
return [...messages, ctxMsg]
```

### 为什么一直显示 hit 0？

当前 SGLang 服务没有返回教程读取的缓存统计字段。这里的 `0` 实际可能是“统计不可用”，不能据此证明缓存没有命中。

更合理的展示应是：

```text
cache stats unavailable
```

## L05：工具管线与权限

### 工具注册表为什么返回多个函数？

`createToolRegistry()` 返回一个对象：

```ts
{
  register,
  guard,
  schemas,
  execute,
}
```

这些函数不会在返回时一起执行，而是在需要时分别调用。

- `register()`：保存工具 schema 和执行函数。
- `guard()`：保存不可绕过的硬规则函数。
- `schemas()`：生成发给 LLM 的工具说明。
- `execute()`：运行权限管线并执行工具。

### `t.run` 从哪里来？

`run` 不是语言自带方法，只是项目定义的对象属性。注册工具时：

```ts
register(name, schema, run) {
  tools[name] = { schema, run }
}
```

注册 bash：

```ts
register("bash", schema, (args) => runBash(args.command))
```

执行时：

```ts
const t = tools[exec.name]
t.run(exec.args)
```

对于 bash，最终进入 `runBash()`，再由 `execSync()` 执行 Shell 命令。

### 为什么函数可以保存进对象？

JavaScript/TypeScript 中函数是一等值，可以像字符串和对象一样：

- 赋给变量
- 作为参数传递
- 保存进对象或数组
- 从函数返回

这使工具和插件能被注册、替换和组合，而不用在主流程写大量 `if`。

### 权限管线

```text
pre-execute：普通策略返回 allow / ask / deny
guard：硬规则可强制 deny
confirm：ask 时询问用户
execute：允许后才执行 t.run(args)
post-execute：可修改结果
result：emit 通知观察者
```

### 安全注意

教程中的权限检查依赖简单正则，存在漏判，例如重定向符号的匹配曾未触发确认。它只是演示权限分层，不是真正的安全沙箱。不要用真实破坏性命令验证 guard，也不要在重要目录中运行不受信任的写操作。

## L06：上下文压缩

### 压缩做了什么？

```text
旧事件仍保存在 events
→ LLM 为较旧对话生成摘要
→ 摘要作为新事件追加到 events
→ surface 用摘要 seq 替换旧 seq 区间
```

压缩是“遮蔽旧消息”，不是删除原始事实。

### 真正修改 surface 的代码

```ts
this.surface.splice(i, j - i + 1, summaryEvent.seq)
```

压缩后可能出现：

```ts
surface = [14, 5, 6, 9, 10]
```

surface 数字不必递增：`14` 是后来生成的摘要，但在模型阅读顺序中替换了最早的旧消息。

### 为什么保留最近消息？

摘要是有损的，可能遗漏细节。较旧部分适合压缩，近期消息保留原文有助于保持准确性与对话连续性。

### 压缩插件为何放在 `agent/pre-step`？

每次 Step 调用 LLM 前检查 surface 是否超过阈值。插件先执行 `maybeCompact()`，再调用 `next()`，使 `base()` 从已经压缩的 surface 派生 messages。

## L07：跨 Session 记忆

### Session Log 与 Memory 的区别

```text
Session Log：记录当前会话过程，本教程实现只在内存中
Memory：保存筛选后的长期事实，写入 agent-memory.json
```

### 写入记忆

`remember` 工具的匿名执行函数：

```ts
(args: { fact: string }) => {
  memories.push({
    text: args.fact,
    ts: new Date().toISOString(),
  })
  writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2))
  return `Remembered: ${args.fact}`
}
```

它在注册后保存为 `remember` 工具的 `run` 函数。

### 召回记忆

插件启动时读取文件：

```ts
const memories = existsSync(MEMORY_FILE)
  ? JSON.parse(readFileSync(MEMORY_FILE, "utf8"))
  : []
```

第一次 `agent/pre-step` 时追加到 Session：

```ts
if (!recalled && memories.length) {
  recalled = true
  session.append("user/message", { content: memoryText }, true)
}
```

listener 每个 Step 都会被调用，但只有“尚未召回且存在记忆”时才执行注入。无论是否注入，都会 `next()` 继续主流程。

### 当前实现的局限

- 加载全部记忆，没有相关性检索。
- 没有去重、更新或删除。
- JSON 文件不适合大规模数据。
- 模型自行判断哪些事实值得调用 `remember`，判断可能不稳定。

## L08：组装完整 Harness

L08 不引入新的核心机制，而是把已有能力安装到同一个 `ctx`：

```ts
ctx.provide("tools", createToolRegistry(ctx))
ctx.provide("confirm", confirmService)

bashPlugin(ctx)
readFilePlugin(ctx)
permissionPlugin(ctx)
timeContextPlugin(ctx)
memoryPlugin(ctx)
compactionPlugin(ctx)
```

### 是否所有插件都通过 waterfall？

不是。插件有三种主要接入方式：

```text
services：提供可调用能力，如 tools、confirm
waterfall：允许插件修改流程或返回值
emit：事情发生后通知日志、指标等观察者
```

### 插件何时执行？

插件安装时主要是注册服务或 listener，并不立即执行业务。主流程运行到对应扩展点时，框架才调用 listener。

listener 本身负责判断：

- 是否满足执行条件
- 执行什么逻辑
- 是否调用 `next()`
- 是否修改下游返回值

### “一切皆插件”的准确理解

主流程保持稳定：

```text
准备 messages
→ 调用 LLM
→ 执行工具
→ 写入 Session
→ 循环
```

`ctx` 提供服务容器和事件扩展点。记忆、压缩、权限、动态上下文和观察日志通过插件接入，新增或移除已有类型的能力通常无需修改主循环。

但插件不能凭空感知主流程没有暴露的阶段。如果需要全新的生命周期阶段，仍需先在主流程增加相应扩展点。

## Basics 完成后的自测

如果能回答下面问题，就已经掌握 L01–L08 的主线：

1. LLM 请求工具与本地程序执行工具有什么区别？
2. `schema` 给谁看，`run` 给谁执行？
3. `event`、`listener`、`payload` 分别是什么？
4. `emit` 和 `waterfall` 有什么区别？
5. `next()` 在哪里创建，不调用它会怎样？
6. `events`、`surface`、`messages` 的关系是什么？
7. 为什么动态上下文放在末尾更利于 KV Cache？
8. `t.run(exec.args)` 中的 `run` 从哪里来？
9. 压缩为什么不等于删除历史？
10. Memory 为什么能跨进程，而 Session Log 在本教程中不能？
11. 为什么说 L08 是组装，而不是新能力？
12. “一切皆插件”有什么边界？

