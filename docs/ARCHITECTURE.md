# myna 技术契约（pi 原生）

> 参考实现：`C:\Users\Luke\projects\deepseek-harness`（MIT）与
> [jmfederico/pi-web](https://github.com/jmfederico/pi-web)（MIT）。
> 借鉴状态边界、会话分层和交互规则，不复制产品外观或引入它们的运行时依赖。

## 0. 产品骨架

myna 只服务 pi。产品状态按 pi 的真实概念组织：

```text
工作区（cwd）
  └─ 会话（session jsonl）
      └─ 回合（agent start → messages/tools → settled）
          ├─ 用户消息
          ├─ 思考与正文
          └─ 工具调用及结果
```

侧栏的 `src/core/session-groups.js` 只负责“工作区 → 会话”的筛选、分组和排序；
DOM 创建、菜单和持久化仍由渲染层负责。这个边界借鉴 pi-web 对 Machine / Project /
Workspace / Session 的分层，同时保留本地 pi 会话文件的语义。

回合的 `src/core/turn-model.js` 保存生命周期、统计和回合内 assistant 消息快照；
消息快照同时保存正文、thinking、`pendingText`、终稿和工具结果。
`src/app.js` 通过 `currentAssistant()` 只读访问当前快照，DOM 不再维护一份 assistant 镜像。

事件边界按 pi RPC 的生命周期处理：`message_end.message` 是 assistant 的权威终稿；
`tool_execution_update.partialResult` 只替换同一 `toolCallId` 的最新预览，
`tool_execution_end.result` 才结算工具；带 `parentToolCallId` 的嵌套调用不另画顶层卡；
`agent_settled.aborted` 与本地停止闩锁共同决定回合结果，结算后的迟到事件丢弃。

DSH 的 `conversation contract`、事件注册和工具视图是参考资料。myna 采用原生
ES module 与 DOM，不引入 React、Cordis 或 DSH 的运行时。

## 1. 模块契约（pi-mini 既有，保持）

```js
// src/features/xxx.js
export function init(ctx) {}
```

- 由 `src/app.js` 的 `FEATURES` 数组登记
- `ctx`：`state` / `stream` / `input` / `pi` / `md` / `esc` / `buildToolRow` / `toggleDisclosure` / `relPath` / `follow` / `addUser` / `ICON`
- 模块自注入 `<style>`，类名带前缀，不改 `base.css`
- 只用 `ctx.pi` 的 IPC/RPC，不直接碰 Electron

对应 DSH：`ctx.slots.register` + Cordis 插件。我们只保留「一个文件、一个 init、自己管 DOM/CSS」。

## 2. 输入触发管线（`ui-input-trigger`）

DSH 的职责拆分：**检测（core）→ 候选菜单（client）→ 选择路由（source）**。

pi-mini 的等价物：`src/features/input-trigger.js` 一个模块内分三段实现。

### 检测
- 只看**光标所在行**、光标之前的文本
- `@`：token 以 `@` 开头，token 边界 = 空白 / `"` / `'` / `=` / CJK 标点；开括号 `([{<` 可剥离
- `@"…`：未闭合引号优先按「带空格路径」处理
- `/`：`trimStart()` 后以 `/` 开头、且尚无空格；进入参数后不再弹命令列表

### 菜单
- `role="listbox"` 放在**滚动容器**上（不是外壳），`aria-activedescendant` 指向当前行
- 行是 `role="option"`，`mousedown` 取选（保 textarea 焦点），`mousemove` 同步高亮
- 打开时不预选；方向键后才有高亮
- `Tab`：可钻取的行钻取，普通行取选；无高亮时放行
- `Esc` / `Shift+Tab`：只关菜单，不消费草稿
- 「同 token 同 query 被 Esc 关闭后保持关闭」，输入变化或换 token 才重新打开

### 选择路由
- `/`：把 `/name ` 插入，光标落在空格后
- `@` 文件：插入 `@path ` 并关闭；目录插入 `@dir/` 且**保持菜单**，继续列下一级
- 带空格用 `@"path with spaces"`；用户已开引号则保持引号
- 目录钻取发布面包屑（DSH 的 `header` 钩子）；pi-mini 用输入框里的路径本身充当面包屑，暂不单独渲染

### pi-mini 的限制
- 命令只支持「插入文本」这一种（DSH 的 `popupSelect` / `action` 需要命令自带 UI，RPC 不提供）
- 没有内置命令目录（`get_commands` 只有 extension/prompt/skill）
- session 引用（`@[label](dsh-session:…)`）无法实现：pi RPC 没有 session mention 协议

消息事件和历史 assistant 条目先进入 `src/core/assistant-message.js`，再由 `app.js` 驱动当前 DOM；
这样 thinking、正文、终稿和工具结果有一个 pi 语义上的状态源。

## 3. 命令分发（`ui-commands`）

DSH 按会话目录把一行 `/` 解析成三种：

1. `leadingInput`：命令带 `input`，把参数交给宿主输入
2. `popupSelect`：命令注册了弹层（`/model`、`/permission`）
3. `action`：纯客户端动作，不提交消息

pi-mini 只有 1 的简化版：把 `/name ` 写进输入框，交给 pi 当普通 prompt。**不伪造 2/3**，避免「看起来能用其实不生效」。

## 4. 引用管线（`ui-reference`）

- 文件优先、会话其次（pi-mini 只有文件）
- 目录行有两个动词：取选=插入目录引用；钻取=保持可编辑路径 + 菜单不关
- 文件选中后是原子引用（pi-mini 用纯文本 `@path`，因为 pi 不解析 atom）
- 路径解析按工作区根目录；`@` 补全永远相对 cwd

## 5. 对话壳（`ui-conversation`）

只吸收能落地的：

- 草稿草稿状态、提交后清空、发送失败保留草稿
- `Enter` 发送 / `Shift+Enter` 换行；菜单打开时 `Enter` 归菜单
- `Esc Esc` 停止（pi-mini 目前单 Esc abort，后续可加）
- 上下文占用条（DSH 有 ring + 百分比；pi-mini 可用 `get_session_stats` 做简化版）
- 排队和插话保留为本地队列语义：排队消息空闲后发送，插话消息直接发 `steer`；
  不伪造 pi 没有的远端队列状态。

## 6. 菜单材质

DSH 的 `MenuSurface`（共享材质、macOS 模糊背景、统一阴影）→ pi-mini 用 `--shadow-menu` + 1px `--line` + 12px 圆角模拟，不做背景模糊。

## 7. 工具视图

DSH 用 `ui-tool` 的插槽按工具名注册视图；pi-mini 的 `toolSpec` switch 是等价物。

后续新工具视图（JSON、图片）按「一个 feature 文件 + 认领 `.tool[data-tool=…] .inner`」扩展，不改 `buildToolRow`。

## 8. 懒高亮

DSH：视口内才高亮、虚拟行。pi-mini：`IntersectionObserver` + shiki 主进程，已对齐；新视图不得全量高亮。

## 9. 明确不采用

| DSH 能力 | 不采用的原因 |
|---|---|
| React + slots + Cordis | 零构建约束 |
| session 引用 | pi RPC 无协议 |
| popupSelect 命令 | RPC 无命令 UI 描述 |
| DSH 的多工作区/任务 dock | pi TUI 没有对应语义，不引入 |
| DSH 的远端队列/自动化任务 | myna 只保留本地排队和 pi `steer` 语义 |
| DSH 的运行时插件架构 | 保留 pi 扩展入口，但不引入 React/Cordis |

附件/图片与设置页已实现：`features/attachments.js`、`features/settings.js`。

## 10. 落地映射

| DSH 包 | pi-mini |
|---|---|
| `ui-input-trigger` | `src/features/input-trigger.js` |
| `ui-commands` | 同一模块的 `/` 分支 |
| `ui-reference` | 同一模块的 `@` 分支 |
| `ui-conversation` | `src/app.js` 的输入/提交/滚动 |
| `ui-tool` | `src/app.js` `toolSpec` + 新 feature |
| `ui-primitives/DisclosureRow` | `buildToolRow` + `toggleDisclosure` |
| `ui-primitives/highlight` | 主进程 shiki + `applyHighlight` |
| `ui-sidebar` | `app.js` `renderSessions` + `features/right-panel.js` |
| `ui-settings` 分栏外壳 | `features/settings.js`（左导航 + pane，208px 网格；内容驱动高度） |
| `ui-settings-models` | `features/settings.js` 提供商分区（write-only key、最小字段保存、写前备份） |
| 终端 | `features/terminal.js` + main.js `pi:term-run`（`powershell -Command`，非 PTY） |
| 命令面板 | `features/shortcuts.js`（`Ctrl+K`，命令列举 + 可用性） |
| 会话搜索 | main.js `pi:search-sessions` + `app.js` 侧栏检索 |
