# pi RPC 覆盖矩阵

> 生成时间：2026-11-03；2026-11-04 复核
> 协议来源：`C:\Users\Luke\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\modes\rpc\rpc-types.d.ts`
> Myna 侧来源：`src/app.js`、`src/features/*.js`、`main.js`、`preload.cjs` 中实际出现的 `type: "…"`

图例：✅ 已支持 · 🟡 部分支持 · 🚧 开发中 · ❌ 未支持 · ⛔ 明确不做

## 1. 命令覆盖（33 条）

### 会话

| 命令 | 用途 | Myna | 实现位置 | 备注 |
|---|---|---|---|---|
| `new_session` | 新建会话 | ✅ | `app.js` `newSession()` | 侧栏「新聊天」/ 项目行圆形加号 |
| `switch_session` | 切换会话 | ✅ | `app.js` `pickSession()` | 侧栏会话行 |
| `get_messages` | 读历史 | ✅ | `main.js` `pi:switch-session` | 切会话后重放 |
| `get_state` | 会话状态 | ✅ | `app.js` `refreshState()` | 启动、切会话、档位同步 |
| `set_session_name` | 重命名会话 | ✅ | `features/settings.js` | 设置弹窗「会话名」，Enter 提交 |
| `get_entries` | 会话条目 | ✅ | `features/message-fork.js` / `features/right-panel.js` | 扁平条目；大会话 `get_tree` 爆栈时用来自己建树 |
| `get_tree` | 会话树 | ✅ | `features/right-panel.js` | 右栏「会话」tab，显示角色/摘要/leaf |
| `get_last_assistant_text` | 最后回复 | ✅ | `features/settings.js` | 快捷操作「复制上一条回复」 |
| `fork` | 在某条消息分支 | ✅ | `features/message-fork.js` | 用户消息 hover 分支按钮 |
| `clone` | 克隆当前会话 | ✅ | `features/settings.js` | 快捷操作「复制会话」 |
| `get_fork_messages` | 可分支消息 | ✅ | `features/message-fork.js` | 按消息文本匹配 entryId |

### 消息与运行

| 命令 | 用途 | Myna | 实现位置 | 备注 |
|---|---|---|---|---|
| `prompt` | 发送消息 | ✅ | `app.js` `submit()` | 纯文本 + `images`（features/attachments.js） |
| `steer` | 流式中插话 | ✅ | `features/queue.js` | 「插话」模式 |
| `follow_up` | 流式中排队 | 🟡 | `features/queue.js` | 队列在本地排队，空闲后自动 `prompt`；没有发这条 RPC |
| `abort` | 中止 | ✅ | `app.js` `setStreaming` + Esc | 流式中发送键变停止 |
| `clear_queue` | 清空队列 | 🟡 | `features/queue.js` | 本地队列逐条删除，没有发这条 RPC |
| `bash` | 直接跑命令 | ⛔ | — | 不通过 pi RPC 调 bash；桌面侧另有独立命令终端（PowerShell -Command，非 PTY），不走这条 RPC |
| `abort_bash` | 中止命令 | ⛔ | — | 同上，独立命令终端用自己的 runId 中止 |

### 模型与推理

| 命令 | 用途 | Myna | 实现位置 | 备注 |
|---|---|---|---|---|
| `get_available_models` | 模型列表 | ✅ | `app.js` `loadModels()` | 输入框右下角菜单 |
| `set_model` | 切模型 | ✅ | `app.js` `#model` 菜单 | |
| `cycle_model` | 循环切模型 | ✅ | `features/settings.js` | 快捷操作「切换模型」 |
| `get_available_thinking_levels` | 档位列表 | ✅ | `app.js` `#model` 菜单 | 与模型名合并显示「模型 · High」 |
| `set_thinking_level` | 切档位 | ✅ | `app.js` `#model` 菜单 | 菜单分「思考档位 / 模型」两段 |
| `cycle_thinking_level` | 循环切档位 | ✅ | `features/settings.js` | 快捷操作「切换档位」 |

### 压缩与重试

| 命令 | 用途 | Myna | 实现位置 | 备注 |
|---|---|---|---|---|
| `compact` | 压缩上下文 | ✅ | `features/settings.js` | 二次确认后执行 |
| `set_auto_compaction` | 自动压缩开关 | ✅ | `features/settings.js` | 读取 `get_state.autoCompactionEnabled` |
| `set_auto_retry` | 自动重试开关 | 🟡 | `features/settings.js` | pi 无读回字段，仅 localStorage 记录 |
| `abort_retry` | 中止重试 | ✅ | `features/settings.js` | 快捷操作「停止自动重试」 |

### steering / 队列模式

| 命令 | 用途 | Myna | 实现位置 | 备注 |
|---|---|---|---|---|
| `set_steering_mode` | 插话策略 | ✅ | `features/settings.js` | 「一条一条 / 全部」 |
| `set_follow_up_mode` | 排队策略 | ✅ | `features/settings.js` | 「一条一条 / 全部」 |

### 统计 / 导出 / 命令目录

| 命令 | 用途 | Myna | 实现位置 | 备注 |
|---|---|---|---|---|
| `get_session_stats` | 用量统计 | ✅ | `features/context-meter.js` | 底栏圆环 + 浮层 |
| `export_html` | 导出 HTML | ✅ | `features/export-html.js` | 顶栏按钮，落在工作区根目录 |
| `get_commands` | 斜杠命令目录 | ✅ | `features/input-trigger.js` @ `/` 弹层 | |

### 扩展 UI

| 类型 | 用途 | Myna | 实现位置 | 备注 |
|---|---|---|---|---|
| `extension_ui_request` | 扩展要用户输入 | ✅ | `features/extension-ui.js` | select/confirm/input/editor，含 ANSI 清理 |
| `extension_ui_response` | 回传结果 | ✅ | `features/extension-ui.js` → `preload.cjs` `sendRaw` → `pi:send-raw` | 每次请求只回一次 |

## 2. 事件覆盖

| 事件 | Myna | 实现位置 | 备注 |
|---|---|---|---|
| `message_start` | ✅ | `app.js` `window.pi.onEvent` | 助手行 |
| `message_update`（`text_delta`） | ✅ | 同上 | 只追加文本节点 |
| `message_end` | ✅ | 同上 | 整段 markdown |
| `tool_execution_start` | ✅ | 同上 | 工具行 |
| `tool_execution_end` | ✅ | 同上 | 输出/diff/失败态 |
| `agent_start` / `agent_settled` | ✅ | 同上 | 流式状态 |
| `session_info_changed` | ✅ | 同上 | 会话列表/标题 |
| 其他事件类型 | ❌ | — | 未处理，静默忽略 |

## 3. 汇总

- 命令总数 **33**（`rpc-types.d.ts` 的 36 个 type 去掉 `response` 与两个 `extension_ui_*`）
- ✅ 完整支持 **28**：new_session / switch_session / get_messages / get_state / set_session_name / get_entries / abort / get_available_models / set_model / get_available_thinking_levels / set_thinking_level / compact / set_auto_compaction / set_steering_mode / set_follow_up_mode / get_session_stats / get_commands / steer / export_html / fork / get_fork_messages / prompt（含 images）/ get_tree / get_last_assistant_text / clone / cycle_model / cycle_thinking_level / abort_retry
- 🟡 部分 **3**：set_auto_retry（pi 无读回字段，仅本地记录）；follow_up / clear_queue（队列完全本地，只用到 steer）
- 🚧 开发中 **0**
- ❌ 未支持 **0**
- ⛔ 明确不做 **2**：bash / abort_bash

覆盖率（完整 + 部分）：**31 / 33 ≈ 94%**。
扩展 UI 的 `extension_ui_request/response` 不在这 34 条命令内，已单独实现（见第 1 节「扩展 UI」）。

## 4. 补全优先级

| 优先级 | 命令 | 依赖 |
|---|---|---|
| P0 | ~~`extension_ui_request/response`~~ 已完成 | — |
| P1 | ~~`steer` / `follow_up` / `clear_queue`~~ 已完成 | — |
| P1 | ~~`export_html`~~ / ~~`fork`~~ / ~~`get_fork_messages`~~ 已完成 | — |
| P2 | ~~`compact`~~ / ~~`set_auto_compaction`~~ / `set_auto_retry`（部分） | 设置入口已完成 |
| P3 | ~~`get_tree`~~ / ~~`get_last_assistant_text`~~ / ~~`clone`~~ / ~~`cycle_*`~~ / ~~`abort_retry`~~ / ~~`get_entries`~~ 已完成 | — |
| ⛔ | `bash` / `abort_bash` | 不走 pi RPC；桌面侧独立命令终端是另一条路径 |

## 5. 如何复核

```powershell
# pi 侧命令清单
Select-String -Path "C:\Users\Luke\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\modes\rpc\rpc-types.d.ts" `
  -Pattern 'type: "([a-z_]+)"' | ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique

# Myna 侧实际用到的命令
cd C:\Users\Luke\projects\pi-mini
Select-String -Path src\app.js,src\features\*.js,main.js,preload.cjs -Pattern 'type:\s*"([a-z_]+)"' -AllMatches `
  | ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
```


