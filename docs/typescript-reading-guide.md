# 阅读本教程所需的最小 TypeScript

这不是一门完整的 TypeScript 课程。目标是让你能读懂 `basics/` 和 `advanced/` 中的 Agent Harness 代码。

## 1. TypeScript、JavaScript、Node.js 和 tsx

四者的关系：

```text
TypeScript 源码 code.ts
        ↓ tsx 转换
JavaScript
        ↓ Node.js 执行
程序通过终端输入和输出
```

- **JavaScript** 是实际运行的语言。
- **TypeScript** 在 JavaScript 上增加类型检查。
- **Node.js** 是运行 JavaScript 的环境。
- **tsx** 是直接运行 `.ts` 文件的命令行工具。
- **npm** 负责安装依赖和运行 `package.json` 中的脚本。

本教程执行：

```bash
npm run dev
```

实际运行的是：

```bash
tsx code.ts
```

类型通常只在开发阶段帮助检查代码，运行时会被移除。

## 2. 变量、数组和对象

### 变量

```ts
const model = "model"
let injectMode = "append"
```

- `const`：变量不能重新赋值。
- `let`：变量可以重新赋值。

对象或数组即使用 `const` 声明，其内部内容仍可修改：

```ts
const history: string[] = []
history.push("hello") // 可以
```

### 数组

```ts
const surface = [1, 2, 3]
surface.push(4)
```

- `array[index]`：按下标读取。
- `push(value)`：在末尾追加。
- `slice(start, end)`：复制一个区间。
- `map(fn)`：逐项转换，生成新数组。

### 对象

```ts
const event = {
  seq: 1,
  type: "user/message",
  data: { content: "hello" },
}

console.log(event.type)
```

对象是字段到值的映射。`event.type` 表示读取 `type` 字段。

## 3. 函数和箭头函数

具名函数：

```ts
function add(a: number, b: number): number {
  return a + b
}
```

箭头函数：

```ts
const add = (a: number, b: number): number => {
  return a + b
}
```

只有一个表达式时可以简写：

```ts
const add = (a: number, b: number) => a + b
```

函数可以作为数据传递：

```ts
ctx.on("tools/result", (payload) => {
  console.log(payload)
})
```

这里的箭头函数是 listener。`on()` 保存它，之后 `emit()` 再执行它。

## 4. 参数类型和返回值类型

```ts
function runBash(command: string): string {
  return command
}
```

- `command: string`：参数应为字符串。
- 函数括号后的 `: string`：函数应返回字符串。

```ts
async function step(): Promise<boolean> {
  return true
}
```

表示异步函数最终产生布尔值。

读懂逻辑时，可以暂时把类型标注在脑中删除：

```ts
function runBash(command) {
  return command
}
```

## 5. 对象解构

```ts
const payload = {
  exec: { name: "bash" },
  result: { content: "hello" },
}

const { exec, result } = payload
```

等价于：

```ts
const exec = payload.exec
const result = payload.result
```

函数参数也可以直接解构：

```ts
ctx.on("tools/result", ({ exec }) => {
  console.log(exec.name)
})
```

等价于：

```ts
ctx.on("tools/result", (payload) => {
  const exec = payload.exec
  console.log(exec.name)
})
```

## 6. 展开语法 `...`

展开数组：

```ts
const oldMessages = [userMessage, assistantMessage]
const messages = [systemMessage, ...oldMessages]
```

结果是一个平坦数组：

```ts
[systemMessage, userMessage, assistantMessage]
```

展开对象：

```ts
const schema = { description: "Run bash", parameters: {} }
const tool = { name: "bash", ...schema }
```

结果包含 `name`、`description` 和 `parameters`。

## 7. `async`、`await` 和 `Promise`

网络请求不会立刻完成，因此返回 Promise：

```ts
const res = await client.chat.completions.create(...)
```

`await` 表示暂停当前异步函数，等待结果：

```text
发出 HTTP 请求
    ↓ 等待
取得模型响应 res
    ↓
继续执行下一行
```

使用 `await` 的函数通常要声明为 `async`：

```ts
async function step(): Promise<boolean> {
  const res = await requestModel()
  return res.hasToolCall
}
```

## 8. `class`、`this` 和 `private`

```ts
class Session {
  events: SessionEvent[] = []
  private seqCounter = 0

  append(event: SessionEvent) {
    this.events.push(event)
    this.seqCounter += 1
  }
}
```

创建实例：

```ts
const session = new Session()
session.append(event)
```

- `class`：定义一类对象的字段和方法。
- `new Session()`：创建实例。
- `this`：当前实例。
- `private`：只允许类内部访问；主要是类型检查约束。

## 9. `type`、`interface` 和联合类型

对象结构可以用 `interface` 描述：

```ts
interface SessionEvent {
  seq: number
  type: string
  data: any
}
```

类型别名：

```ts
type SurfaceType = "user/message" | "assistant/message" | "tool/result"
```

`|` 表示“其中一种”。所以 `SurfaceType` 只能是这三个字符串之一。

函数类型：

```ts
type NextFn = () => Promise<any>
```

表示一个不接收参数、返回 Promise 的函数。

```ts
type Listener = (payload: any, next: NextFn) => Promise<any> | any
```

表示 listener 接收 `payload` 和 `next`，可以返回 Promise，也可以直接返回普通值。

## 10. 泛型写法 `<...>`

```ts
const events: SessionEvent[] = []
const services: Record<string, any> = {}
const result: Promise<boolean> = step()
```

- `SessionEvent[]`：SessionEvent 数组。
- `Record<string, any>`：字符串 key 到任意值的对象。
- `Promise<boolean>`：以后会得到布尔值的 Promise。

这里的 `<...>` 是类型参数，不是大小比较符号，也不是 HTML 标签。

## 11. `?.`、`??`、`??=` 和 `!`

### 可选链 `?.`

```ts
if (!msg.tool_calls?.length) return false
```

如果 `tool_calls` 不存在，不抛异常，整个表达式得到 `undefined`。

### 空值合并 `??`

```ts
const model = process.env.MODEL_ID ?? "deepseek-chat"
```

只有左侧是 `null` 或 `undefined` 时，才使用右侧默认值。

### 空值赋值 `??=`

```ts
this.listeners[event] ??= []
```

等价于：

```ts
if (this.listeners[event] === null || this.listeners[event] === undefined) {
  this.listeners[event] = []
}
```

### 非空断言 `!`

```ts
const arr = this.listeners[event]!
```

这里的 `!` 告诉 TypeScript：“我确认它不是空值。”它不会增加运行时检查。

## 12. 类型断言 `as`

```ts
const args = JSON.parse(text) as { command: string }
```

意思是告诉 TypeScript：“在这里把结果当成包含 `command` 字符串的对象。”

它不是数据转换，也不会验证模型是否真的返回了正确结构。下面的断言仍可能在运行时报错：

```ts
const value = JSON.parse("{}") as { command: string }
value.command.toUpperCase()
```

## 13. 回调、事件和 payload

```ts
const listener = (payload: any) => {
  console.log(payload.exec.name)
}

ctx.on("tools/result", listener)
ctx.emit("tools/result", {
  exec: { name: "bash" },
  result: { content: "hello" },
})
```

三者分别是：

```text
event    = "tools/result"，用于找到监听器
listener = 可执行函数
payload  = 传给监听器的数据对象
```

## 14. `map()`、`some()` 和 `Object.entries()`

### `map()`

```ts
const messages = surface.map((seq) => events[seq])
```

对每个 `seq` 执行函数，把返回值组成新数组。

### `some()`

```ts
const blocked = dangerous.some((text) => command.includes(text))
```

只要有一个元素满足条件，就返回 `true`。

### `Object.entries()`

```ts
Object.entries(tools).map(([name, tool]) => ...)
```

把对象转换成 `[key, value]` 数组，再解构成 `name` 和 `tool`。

## 15. 三元表达式

```ts
const messages = injectMode === "append"
  ? [...oldMessages, contextMessage]
  : [oldMessages[0], contextMessage, ...oldMessages.slice(1)]
```

等价于：

```ts
let messages
if (injectMode === "append") {
  messages = [...oldMessages, contextMessage]
} else {
  messages = [oldMessages[0], contextMessage, ...oldMessages.slice(1)]
}
```

## 16. `import` 和 Node.js 模块

```ts
import OpenAI from "openai"
import { execSync } from "node:child_process"
import type { ChatCompletionTool } from "openai/resources/chat/completions"
```

- 第一行导入 npm 包的默认导出。
- 第二行导入 Node.js 内置模块的具名导出。
- `import type` 只导入类型，运行时会被移除。

## 17. 错误处理

```ts
try {
  return execSync(command, { encoding: "utf8" })
} catch (e: any) {
  return `Error: ${e.message}`
}
```

- `try`：尝试执行可能失败的代码。
- `catch`：发生异常后处理错误。
- 模板字符串 `` `${value}` ``：把变量插入字符串。

## 18. 阅读 Agent Harness 的推荐顺序

不要从文件第一行机械地读到最后一行。每课建议按这个顺序：

1. 从底部看 assembly：创建了哪些对象、安装了哪些插件。
2. 看命令行入口：用户输入如何进入 `runTurn()`。
3. 看 `runTurn()`：一次 Turn 如何重复调用 `step()`。
4. 看 `step()`：如何调用模型、执行工具、决定是否继续。
5. 看本课新增的 plugin 或数据结构。
6. 最后再看复制自上一课的框架代码。

遇到类型复杂的代码，可以先删除类型进行脑内翻译：

```ts
async function step(ctx: Ctx, session: Session): Promise<boolean>
```

先读成：

```js
async function step(ctx, session)
```

## 19. 学完后的自测

如果能解释下面代码，就已经具备继续阅读 L05–L10 的语法基础：

```ts
ctx.on("tools/result", async ({ exec, result }, next) => {
  const downstream = await next()
  return { ...downstream, tool: exec.name, output: result.content }
})
```

应该能指出：

- `ctx.on()` 注册 listener。
- `"tools/result"` 是 event 名称。
- `{ exec, result }` 从 payload 解构字段。
- listener 是匿名异步箭头函数。
- `await next()` 执行下游处理。
- `{ ...downstream, ... }` 展开旧对象并增加或覆盖字段。
- listener 返回一个 Promise，最终值是新对象。

