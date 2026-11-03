# 适配器契约（IR：中性中间层）

> 目的：让渲染层只认 IR，不认任何具体 agent。每种 agent 一个适配器。
> 约束：适配器**不得** import electron；只允许 node 内置模块（`child_process`、`http`、`fetch` 等）。
> 渲染层（`src/app.js`、`src/features/*`）**本期不改**。

## 1. 目录

```
src/core/ir.js                  IR 常量与校验（事件名/命令名唯一来源）
src/core/adapters/index.js      注册表：create(id) → adapter
src/core/adapters/pi.js         pi 适配器（`pi --mode rpc`，JSONL）
tests/adapter-contract.test.mjs 一致性测试（本契约的可执行版本）
```

## 2. 适配器接口

```js
// src/core/adapters/<id>.js
export const id = "pi";                 // 唯一标识
export const caps = {                   // 能力声明：UI 按此渲染，未声明的不画
  fork: true, compact: true, reason: true, queue: true,
  extUI: true, models: true, sessions: true,
};

export function createAdapter({ cwd, onEvent, onLog }) {
  // onEvent(irEvent) 同步调用；onLog(text) 可选
  return {
    id,
    caps,
    async start(),        // 启动底层进程/连接；失败抛错
    async stop(),         // 幂等
    async call(cmd),      // IR 命令；返回 IR 数据；失败抛错
  };
}
```

## 3. IR 事件（适配器 → UI）

字段名固定，未提供的字段省略，不要塞 `undefined`。

| type | 字段 | 说明 |
|---|---|---|
| `turn.start` | `sessionId` | 一轮开始 |
| `turn.end` | `sessionId`, `outcome`: `"ok"｜"failed"｜"aborted"` | 一轮结束 |
| `text.delta` | `sessionId`, `delta`: string | 正文增量 |
| `text.done` | `sessionId`, `text`: string | 正文定稿（用于 markdown 整体渲染） |
| `reason.delta` | `sessionId`, `delta`: string | 思考增量（caps.reason 才有） |
| `tool.start` | `sessionId`, `toolCallId`, `name`, `args`（object） | 工具开始 |
| `tool.end` | `sessionId`, `toolCallId`, `ok`: boolean, `output`?: string, `diff`?: string, `durationMs`?: number | 工具结束 |
| `error` | `sessionId`?, `message`: string, `fatal`?: boolean | 可恢复错误或进程死亡 |
| `usage` | `sessionId`?, `input`, `output`, `cost`? | token 用量。**必须在该条消息的 `text.done` 之前发出**；消息定稿后到的 `usage` 会被投影层丢弃（不能跨消息归属） |
| `session.meta` | `sessionId`, `title`?, `model`? | 会话元信息变化 |

## 4. IR 命令（UI → 适配器）

| cmd.type | 入参 | 返回 |
|---|---|---|
| `prompt` | `text`, `images?` | `{ messageId }` |
| `abort` | — | `{}` |
| `list_sessions` | `limit?` | `{ sessions: [{ id, title, updatedAt, cwd }] }` |
| `load_history` | `sessionId` | `{ messages: [{ role: "user"｜"assistant", text, ts?, toolCalls? }] }` |
| `new_session` | — | `{ sessionId }` |
| `switch_session` | `sessionId` | `{ sessionId }` |
| `list_models` | — | `{ models: [{ id, name, provider }] }` |
| `set_model` | `modelId` | `{}` |
| `fork` | `sessionId`, `messageId` | `{ sessionId }` |
| `compact` | — | `{}` |
| `rename` | `sessionId`, `title` | `{}` |

未实现的命令：**抛 `Error("unsupported: <type>")`**，并确保 `caps` 里对应位为 `false`。不允许静默返回空对象。

## 5. 映射参考

### pi（已验证，来自现有代码）

| IR | pi 来源 |
|---|---|
| `turn.start` | `agent_start` |
| `turn.end` | `agent_settled` / `process_exit`(fatal) |
| `text.delta` | `message_update.text_delta` |
| `text.done` | `message_end` |
| `reason.delta` | reasoning block（现有 `makeThinkBlock` 消费的同一数据） |
| `tool.start` | `tool_execution_start` |
| `tool.end` | `tool_execution_end` |

## 6. 验收

`npm test` 必须通过 `tests/adapter-contract.test.mjs`，它检查：

1. 每个适配器 `export` 了 `id` / `caps` / `createAdapter`
2. `caps` 的键都在 IR 白名单内
3. `createAdapter()` 返回 `start` / `stop` / `call` 三个函数
4. `call` 对未声明能力的命令抛 `unsupported:`
5. 适配器文件不 import `electron`，不使用 `require()`

新增 agent = 加一个适配器文件 + 在 `index.js` 注册一行 + 补映射表。

## 7. 主进程接入（2026-11-03）

- 当前产品只启动 pi；后端切换不属于产品范围。
- pi 继续走 `main.js` 的直连 JSONL 桥；本契约只保留给未来的内部拆分使用。

### IR → 旧事件投影

| IR | 旧事件 |
|---|---|
| `turn.start` | `agent_start` |
| `turn.end` | `agent_settled` |
| `text.delta` | `message_update.assistantMessageEvent.text_delta` |
| `reason.delta` | `message_update.assistantMessageEvent.thinking_delta` |
| `text.done` | `message_end`（`message.content` 含缓冲后的 thinking block） |
| `tool.start` | `tool_execution_start` |
| `tool.end` | `tool_execution_end` |
| `session.meta` | `session_info_changed` |
| `error`（`fatal`） | `process_exit` |

