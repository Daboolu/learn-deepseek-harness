# Advanced 学习笔记（L09–L10）

这份笔记整理 Advanced 学习过程中遇到的问题。L09 展示上下文隔离与任务委派，L10 展示运行时创建和挂载临时工具。

## 开始前：ctx、Session 和 messages

这三个概念的职责不同：

```text
ctx      = Agent 具备什么能力
Session  = 这次对话发生过什么
messages = 本次请求让 LLM 看到什么
```

### ctx

`ctx` 是共享运行环境，保存：

```text
services：tools 等可调用服务
listeners：各扩展点的插件 listener
```

### Session

每个 Session 保存自己的：

```text
events：完整事件日志
surface：模型可见事件的索引
```

### messages

messages 不保存在 `ctx` 中。它从 Session 派生，再经过 ctx 的插件管线：

```text
session.events
→ surface 选择
→ session.deriveMessages()
→ ctx.waterfall("agent/pre-step", { session }, base)
→ 最终 messages
→ client.chat.completions.create({ messages })
```

`{ session }` 是 `waterfall()` 的 payload，也就是第二个参数。内部调用 listener 时，相当于：

```ts
listener({ session }, next)
```

如果没有注册 `agent/pre-step` listener，waterfall 会直接执行 `base()`。

## L09：Subagent

### Subagent 的本质

Subagent 不是主循环中的特殊语法，而是一个普通工具：

```ts
ctx.services.tools.register(
  "spawn_subagent",
  schema,
  async (args) => runSubagent(ctx, args.task),
)
```

父模型调用它时，工具注册表执行 `runSubagent()`。

### 父子 Agent 的调用链

```text
父 LLM 请求 spawn_subagent
→ 父工具注册表执行 runSubagent(ctx, task)
→ 创建 child Session
→ 子 LLM 使用 bash 探索
→ 子 LLM 生成最终结论
→ 只把结论作为父 Agent 的 tool/result
→ 父 LLM 组织最终回答
```

一次实际运行中可以分辨出三层输出：

```text
$ spawn_subagent {...}  父 Agent 的工具调用
[subagent] $ ...         子 Agent 内部的 bash 调用
最终简短结论             父 Agent 的回答
```

### 父子共享什么，隔离什么？

调用：

```ts
runSubagent(ctx, task)
```

传入同一个 `ctx`，所以父子共享工具注册表、模型客户端等能力。

子 Agent 创建自己的 Session：

```ts
const child = new Session()
```

因此：

```text
共享 ctx：父子会什么
独立 Session：父子经历过什么
```

子 Agent 的工具调用和冗长输出都写入 `child.events`，不会进入父 Session。父 Agent 只收到 `runSubagent()` 返回的最终字符串，因此父上下文保持精简。

### 子循环如何结束？

```ts
for (let guard = 0; guard < 20; guard++) {
  // 调用子 LLM
  if (!msg.tool_calls?.length) return msg.content
  // 执行子工具
}
```

- 有工具调用：执行工具，继续下一 Step。
- 没有工具调用：把最终文本返回父 Agent。
- 最多 20 步：避免无限循环和失控消耗。

### `schemasFor(["bash"])` 为什么阻止再次委派？

系统注册表中存在：

```text
bash
spawn_subagent
```

父请求使用：

```ts
ctx.services.tools.schemas()
```

所以父模型看到全部工具。

子请求使用：

```ts
ctx.services.tools.schemasFor(["bash"])
```

实现是：

```ts
schemasFor(names: string[]) {
  return this.schemas().filter(
    (tool) => names.includes(tool.function.name),
  )
}
```

它只将 `bash` schema 放进子模型请求，过滤掉 `spawn_subagent`。因此子模型正常情况下不知道存在委派工具，无法继续派生下一层 Subagent。

更严格的生产系统还应在执行层检查允许列表，不能只依赖“不向模型展示”。

### L09 的价值

```text
上下文隔离：探索细节不污染父上下文
能力限制：子 Agent 只获得完成任务所需工具
成本控制：父 Agent 只读取一段结论
结构复用：子 Agent 仍是同一种 Agent Loop
```

## L10：运行时自我修改

### “创建工具”到底是什么？

这里不是创建 `.ts` 文件，也不是修改 Git 仓库，而是在内存中：

```text
模型生成工具名称、说明和代码字符串
→ Harness 把字符串编译成函数
→ 将 schema 与执行函数注册进工具注册表
→ 后续 Step 重新生成工具列表
→ 模型可以调用新工具
```

程序退出后，内存注册表消失，动态工具也随之消失。

### 实验中的数据

模型调用：

```json
{
  "name": "to_upper",
  "description": "converts string to uppercase",
  "code": "return input.toUpperCase();"
}
```

三个字段分别表示：

```text
name        = 新工具名称
description = 给后续 LLM 请求看的工具说明
code        = 新工具执行的 JavaScript 函数体
```

### `new Function()` 是什么？

`Function` 是 JavaScript 内置构造器。它可以将字符串编译成函数：

```ts
const fn = new Function(
  "input",
  "return input.toUpperCase();",
)
```

效果近似：

```ts
const fn = function (input) {
  return input.toUpperCase()
}
```

创建函数时只编译；调用时才执行：

```ts
fn("hello") // "HELLO"
```

### 为什么生成的函数能直接注册？

JavaScript 中函数是一等值，可以：

- 保存到变量
- 作为参数传递
- 保存到对象或数组
- 从函数返回
- 被其他函数引用

L10 包装生成的 `fn`：

```ts
const run = (args) => String(fn(args.input))
```

再注册：

```ts
ctx.services.tools.register(
  args.name,
  schema,
  run,
)
```

注册表内部保存：

```ts
tools[args.name] = {
  schema,
  run,
}
```

调用新工具时：

```text
tools["to_upper"].run({ input: "hello" })
→ fn("hello")
→ "HELLO"
```

### 为什么不直接把 `fn` 注册为 run？

生成的函数接收字符串：

```ts
fn("hello")
```

工具注册表统一传入参数对象：

```ts
run({ input: "hello" })
```

所以要包装一层：

```ts
(args) => fn(args.input)
```

否则直接注册 `fn` 时，它会收到对象，对象没有 `.toUpperCase()`。

### 什么是闭包？

闭包是函数连同它创建时能够访问的外部变量。

```ts
const fn = new Function("input", args.code)
const run = (a) => String(fn(a.input))
```

`run` 引用了外部变量 `fn`。即使注册代码已经执行结束，之后调用 `run()` 时，它仍然能找到这个 `fn`。

```text
run({ input: "hello" })
→ 闭包找到对应 fn
→ fn("hello")
→ "HELLO"
```

### 为什么下一 Step 才能调用新工具？

每次 `step()` 都重新生成工具列表：

```ts
tools: ctx.services.tools.schemas()
```

第一次请求：

```text
bash、define_tool
```

模型调用 `define_tool` 后，注册表新增 `to_upper`。

第二次请求：

```text
bash、define_tool、to_upper
```

模型这时才能从 API 提供的工具 schema 中看到并调用它。

### 为什么工具退出后消失？

动态工具只写入当前进程中的：

```ts
const tools = {}
```

它没有：

- 写入源代码文件
- 保存到数据库
- 提交到 Git
- 在启动时重新加载

因此它是 ephemeral（临时的）。

### 工具列表变化与 KV Cache

API 请求中的 `tools` schema 也是模型输入的一部分。动态增加工具后，工具定义前缀发生变化，已有 KV Cache 可能从变化位置失效。这是运行时修改工具集的固有成本。

### 安全边界

`new Function()` 会在当前 Node.js 进程中执行模型生成的 JavaScript，不是安全沙箱。模型代码可能访问进程能力、泄漏环境信息、进入死循环或造成其他副作用。

本课只适合演示纯字符串变换。生产环境至少需要：

- 独立进程或容器隔离
- 明确的权限与资源限制
- 超时和内存限制
- 静态检查与人工/自动审核
- 测试、监控和回滚

## Self-modification 与 RSI 的区别

L10 只实现：

```text
生成临时工具
→ 挂载
→ 当前 Session 调用
```

完整 Recursive Self-Improvement 至少还需要：

```text
发现能力缺口
→ 生成候选改动
→ 隔离测试
→ 自动评估
→ 与基线比较
→ 通过后晋升
→ 持久化
→ 持续监控
→ 失败时回滚
```

因此：

```text
Self-modification = 能改变自身能力
Self-improvement  = 能证明改变带来提升
RSI               = 改进能力本身还能继续促进下一轮改进
```

## Advanced 完成后的自测与答案

### 1. 父 Agent 和子 Agent 共享什么，隔离什么？

一句话：父子 **共享能力，隔离历史**。

```text
共享 ctx：模型客户端、工具注册表等
独立 Session：父使用 session，子使用 child
```

因此两者能使用同一套基础设施，但不会自动看见对方的对话事件。

### 2. 为什么子 Agent 的探索不会塞进父 Session？

因为子循环始终写入 `child`：

```text
子工具调用和结果 → child.events
子最终回答       → runSubagent() 返回字符串
返回字符串       → 父 Session 的一条 tool/result
```

父 Session 从未接收子 Agent 的完整事件列表。

### 3. `schemasFor(["bash"])` 如何限制子 Agent 能力？

它过滤“给子模型看的工具说明”：

```text
注册表实际拥有：bash、spawn_subagent
父 LLM 看到：   bash、spawn_subagent
子 LLM 看到：   bash
```

子模型没有收到 `spawn_subagent` schema，因此正常情况下不知道该如何调用它。生产系统还应在执行层再次校验允许列表。

### 4. 为什么子循环需要最大步数？

因为模型可能不断要求调用工具而始终不输出最终答案。20 步上限相当于保险丝，用来限制运行时间、API 成本和副作用范围。

### 5. LLM 为动态工具首先生成的是函数还是字符串？

首先生成的是字符串，不是已经能执行的函数：

```text
LLM 输出 code 字符串
→ new Function() 编译
→ 得到函数值 fn
→ register() 保存
```

### 6. `new Function()` 做了什么？

它是 JavaScript 内置的函数构造器，将“参数名字符串 + 函数体字符串”编译成可调用函数：

```ts
const fn = new Function("input", "return input.toUpperCase()")
fn("hello") // "HELLO"
```

创建 `fn` 时是编译，调用 `fn(...)` 时才真正执行函数体。

### 7. 动态工具的 `run` 为什么要包装 `fn(args.input)`？

因为两边的参数形状不同：

```text
工具注册表传入：run({ input: "hello" })
生成函数需要：  fn("hello")
```

所以包装函数 `(args) => fn(args.input)` 负责从对象中取出字符串再交给 `fn`。

### 8. 什么是闭包，它在 L10 中记住了什么？

闭包表示一个函数会记住它创建时引用的外部变量：

```ts
const fn = new Function("input", code)
const run = (args) => fn(args.input)
```

`run` 引用了外部的 `fn`。即使注册代码已经结束，以后从注册表调用 `run()` 时，它仍能找到这个 `fn`。

### 9. 为什么新工具在下一 Step 才可见？

因为一次 LLM 请求的工具列表在请求发出时就已经确定：

```text
Step 1 请求：tools = [bash, define_tool]
Step 1 执行 define_tool，注册 to_upper
Step 2 请求重新调用 schemas()
Step 2 tools = [bash, define_tool, to_upper]
```

所以模型只能在下一 Step 看到新 schema。

### 10. 为什么退出程序后新工具消失？

它只存在当前 Node.js 进程内存中的 `tools` 对象。代码没有把工具定义写入文件或数据库，也没有启动时的重新加载逻辑，因此进程退出后就消失。

### 11. 为什么 `new Function()` 不是安全边界？

因为它直接在当前 Node.js 进程内执行动态代码，没有隔离层。它不会自动限制文件、网络、环境变量、CPU 或内存访问，因此模型代码可能泄密、产生副作用或让进程失控。

### 12. Self-modification 为什么不等于 RSI？

Self-modification 只回答“能不能改自己”，没有证明“改完是否更好”。

RSI 还需要：

```text
生成候选改动
→ 隔离测试
→ 自动评估并与基线比较
→ 通过后持久化和晋升
→ 监控、失败回滚
→ 改进后的能力促进下一轮改进
```
