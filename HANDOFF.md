# pi-mini 交接文档

给接手这个项目的 agent 看。读完这份不用再问任何问题就能开工。

---

## 1. 这是什么

给 [pi](https://github.com/earendil-works/pi) 做的**极简 Electron 桌面前端**。pi 是一个 CLI agent，官方只有 TUI；这个项目给它一个 GUI。

**设计参照**：OpenAI Codex 桌面 App 的视觉语言（白底、克制、单栏阅读宽度 600px、hairline 边框、无卡片阴影、圆形发送键）。

**参照图**：`C:\Users\Luke\AppData\Local\Packages\Microsoft.ScreenSketch_8wekyb3d8bbwe\TempState\Snips\屏幕截图 2026-11-03 015855.png`

## 2. 位置与运行

```
C:\Users\Luke\projects\pi-mini\
```

```bash
cd C:/Users/Luke/projects/pi-mini
npm i                                  # 只有 electron + shiki 两个运行时依赖
set PI_MINI_DEV=1                      # 开热重载（bash: PI_MINI_DEV=1 ./node_modules/electron/dist/electron.exe .）
./node_modules/electron/dist/electron.exe .
```

**必须知道的环境事实**：
- 全局 pi 在 `C:\Users\Luke\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent`
- 探针：`node <pkg>/dist/cli.js --mode rpc` 是 pi 的子进程协议入口
- **`git clone` 走 github.com 会 TLS 失败**（schannel），但 `raw.githubusercontent.com` 和 `api.github.com` 能直连；`api.github.com` 有匿名限流
- `fetch_content` 抓 github.com 会被 fake-IP 拦截（198.18.0.0/15），要抓用 `curl` 或 anysearch 的 `extract`

## 3. 硬约束（不要破坏）

| 约束 | 原因 |
|---|---|
| **运行时依赖只允许 electron + shiki** | 极简是产品目标，不是偏好 |
| **零构建**：无 Vite / 无打包器 / 无 TypeScript / 无 React | 同上 |
| 渲染层用 **ES module + 自定义 `app://` 协议** | `file://` 下 `<script type="module">` 被 CORS 拦，所以主进程注册了特权协议 `app://bundle/...` |
| CSP 是 `script-src 'self'` | 不要在页面里内联脚本或加载远程脚本 |
| **shiki 跑在主进程**，渲染层通过 IPC 拿 HTML | 绕开 CSP 限制，且 shiki 需要 Node |
| pi 通过 `pi --mode rpc` 子进程接入，**不开 HTTP 端口** | 安全模型：渲染层 `app://` + `contextBridge` IPC，与 DSH 的 `dsh-app://` 同思路 |

## 4. 文件结构

```
pi-mini/
├── main.js                 # 主进程：窗口、app:// 协议、pi 子进程、 shiki、session 索引、dev 热重载
├── preload.cjs             # contextBridge，暴露 window.pi.*
├── index.html              # 页面骨架（无内联样式、无内联脚本）
├── styles/base.css         # 全部样式（15KB）
├── src/
│   ├── app.js              # 状态、渲染、事件、启动；导出 ctx 给功能模块
│   └── features/           # 功能模块，每个导出 init(ctx)
│       ├── code-toolbar.js
│       └── message-actions.js
├── extensions/subagent/    # 从 pi 官方示例复制的子代理扩展（备份用）
└── node_modules/           # 389MB
```

### 模块契约

`src/app.js` 末尾：

```js
export const ctx = { state, stream, input, pi, md, esc, buildToolRow, toggleDisclosure, relPath, follow, addUser, ICON };
const FEATURES = ["./features/code-toolbar.js", "./features/message-actions.js"];
```

新增功能 = 建一个 `src/features/xxx.js`，`export function init(ctx)`，然后在 `FEATURES` 里加一行。
**功能模块自己注入 CSS**（`document.createElement("style")`），不要改 `styles/base.css`，避免并行冲突。

## 5. 已完成（都验证过，有截图和 DOM 计数）

| 能力 | 实现位置 | 关键决策 |
|---|---|---|
| 会话列表（按工作区分组、可折叠） | `src/app.js` `renderSessions` | 只展开当前工作区，其余默认收起 |
| 会话切换 | `switchSession` → RPC `switch_session` | 历史通过 `get_messages` 重放 |
| 工作区切换 | 原生目录对话框 → 重启 pi 子进程 | |
| 模型选择 | RPC `get_available_models` / `set_model` | 选择器在输入框右下角 |
| 流式聊天 | `message_update` 的 `text_delta` | **流式期间只追加纯文本节点**，`message_end` 才整段渲染 markdown（避免 O(n²)） |
| 粘底滚动 | `follow()` + `stickBottom` 状态 | 用户上滚即停止跟随，浮出「回到底部」 |
| markdown | `md()` / `renderFragment()` / `inlineMd()` | 段落、标题、列表、代码块、行内代码、加粗 |
| 代码高亮 | shiki（主进程）+ `IntersectionObserver` | **只高亮视口内**（实测 72ms/块，全量会卡） |
| 路径识别 | `parseFileLink` / `isExplicitFilePath` / `BARE_PATH` | 盘符、反斜杠、带空格、剥尾部中文标点；单趟合并正则（否则盘符路径被二次包裹） |
| 外部链接 | `parseFileLink` 判失败且是 http(s) → `shell.openExternal` | |
| 工具行 | `buildToolRow` | 24px 行高、hover 才露 chevron、`grid-template-rows: 0fr→1fr` 展开、键盘 Enter/Space、`aria-expanded` |
| 工具图标 | `toolSpec` | bash/read/write/edit/ls/grep/find 各一种，未知工具圆点 |
| 失败标记 | 红色「失败」胶囊 | 成功和运行中不显示 |
| 运行中 | `.running` shimmer | 标题微光扫过 |
| diff 渲染 | `parseDiff` / `buildDiffBlock` | pi 的 `EditToolDetails.diff` 格式是 `<标记><行号> <内容>`，标记为 ` ` / `-` / `+`；summary 显示 `+N −M` |
| read 结果 | `appendReadOutput` | 补行号（起点取 `args.offset`），>600 行显示剩余数 |
| grep 结果 | `appendSearchOutput` | 按文件分组 + 匹配数徽章；**解析不出 `path:line:content` 就自动退回 `<pre>`** |
| 时间分隔线 | `timeDivider` / `fmtStamp` | 间隔 >10 分钟或跨天才插 |
| 代码块工具条 | `features/code-toolbar.js` | hover 显示语言标签 + 复制 |
| 消息操作 | `features/message-actions.js` | hover 出现复制按钮 |

## 6. 原剩余项（2026-11-03 已全部落地）

1. **`src/features/input-trigger.js`** —— ✅ 输入框内联建议：`@` 文件引用 + `/` 命令。
   - `pi:list-files`（main.js，递归扫 cwd，限 2000 条，5s 缓存）；命令走 `get_commands`
   - 弹层贴输入框上方，↑↓ 选择，Enter/Tab 插入，Esc 关闭；目录 Tab 钻取；含空格路径用 `@"…"`
2. **`JsonTree` / 图片预览** —— ✅ `features/json-view.js`（工具 JSON 折叠树）+ 附件缩略图
3. **右栏** —— ✅ `features/right-panel.js`：文件树 / 工作区变更（含 diff）/ 会话树，打开时主界面让出 300px
4. **消息级重试 / 分支** —— ✅ `features/message-retry.js`（重发上一条）+ `features/message-fork.js`（hover 分支，`fork` RPC）

其余已完成：设置面板（`settings.js`，含 clone / cycle_model / cycle_thinking_level / abort_retry / get_last_assistant_text）、队列与插话（`queue.js`）、导出 HTML（`export-html.js`）、扩展 UI 桥（`extension-ui.js`）、上下文圆环（`context-meter.js`）、空态 chip（`empty-chips.js`）。

## 7. 开发闭环（重要，能省你大量时间）

### 热重载
`PI_MINI_DEV=1` 时主进程用 `fs.watch({recursive:true})`：
- `.js` / `.css` / `.html` 改动 → 140ms 后 `webContents.reload()`
- `main.js` 改动 → `app.relaunch()`（有 `relaunching` 守卫防重复）

### 日志
**不要看 stdout** —— `app.relaunch()` 之后 stdout 管道会断。日志无条件写到：

```
C:\Users\Luke\AppData\Local\Temp\pi-mini.log
```

包含：热重载事件、渲染层 error/warning（`console-message`）、`render-process-gone`、截图探针计数。

### 截图验证
页面自己截图，不受窗口位置/DPI 影响：

```bash
cd C:/Users/Luke/projects/pi-mini && printf 'diff' > shot.request
```

触发后写 `live.png`，同时打印 DOM 计数：

```
[dev] shot -> live.png  {"time":1,"tools":18,"diffs":2,"shiki":3,"links":10,"xlinks":2,"rows":22}
```

`shot.request` 内容含 `diff` 时，还会等 `window.__ready` 之后注入 `window.__selftest()` 样例（markdown、代码块、diff、read、grep），再截图。**改 UI 后一定要看这张图。**

### 直接读会话数据
```bash
# 会话在 ~/.pi/agent/sessions/--<cwd 转义>--/<时间戳>_<id>.jsonl
# pi 的工具结果格式可以直接从历史里抽样
```

## 8. 踩过的坑（别再踩）

1. **Python heredoc 会吃掉反斜杠**：写含 `\n`、`\\` 的 JS 代码时，Python 字符串必须用 `r'''...'''`，否则 `\n` 变成真换行、`\\` 变成 `\`，产出语法错误。更稳的做法是干脆避免反斜杠（用 `String.fromCharCode(10/92)`）。
2. **整块 CSS 替换会误删**：按 `.tool {` … `.caret {` 区间替换时，区间里的 `.flink` / `.diff` / `.dl` 一起被删了，结果 diff 变裸文本、链接不变蓝。改 CSS 用「插入到锚点前」，别用「替换区间」。
3. **`pi:boot` 必须幂等**：热重载会重新 boot，若无条件 `startPi()` 会反复重启 pi 子进程。现在只在 `!child` 时启动，`restore`（恢复指定会话）只在本进程首次 boot 时返回一次。
4. **`app.relaunch()` 会叠实例**：除 `relaunching` 守卫外，验证时注意 `Get-Process electron` 计数，正常应为 4（主进程 + 渲染 + GPU + 工具）。
5. **自检内容会被历史渲染覆盖**：`renderHistory` 里有 `clearStream()`。所以自检钩子要等 `window.__ready`（启动 IIFE 末尾置位）之后再注入，注入后还要手动滚到底。
6. **探针必须在截图之后算**：否则计数和画面对不上时间点。现在钩子是「注入 → 等 1.5s → 截图 → 算计数」。
7. **preload 必须是 `.cjs`**：`package.json` 里 `"type": "module"` 会让 `.js` 被当 ESM，preload 里 `require` 会挂。
8. **`file://` 不支持 ES module**：这就是为什么要 `app://` 协议。`loadURL("app://bundle/index.html")`。
9. **`app.getPath` / 路径拼接**：Windows 路径统一用 `join()`，比较前先 `toLowerCase()`。

## 9. 已从 DSH 抄过的源码位置（要扩展就继续抄这些）

仓库 `deepseek-ai/deepseek-harness`（MIT），用 `raw.githubusercontent.com` 直连抓。

| 包 | 文件 | 抄了什么 |
|---|---|---|
| `packages/client/ui-primitives/src/markdown/` | `file-link.ts` `windows-path-destinations.ts` | `isExplicitFilePath`、`parseFileLink` 的规则 |
| 同上 | `highlight.ts` `useViewportHighlighting.ts` | 只高亮视口内的策略 |
| 同上 | `cjkFriendlyStrong.ts` | **不需要抄**：它补的是 CommonMark 对 CJK 加粗的解析缺陷，本项目用正则不用 CommonMark |
| `packages/client/ui-primitives/src/` | `DisclosureRow.tsx` `.module.css` | 24px 行高、hover 变色、`previewChevron`、键盘切换 |
| 同上 | `AnimatedRows.tsx` `.module.css` | `ROW_FADE_MS=100` / `ROW_GLIDE_MS=200`、armed 后才动画、尊重 reduced-motion |
| 同上 | `ReadBlock.tsx` `SearchBlock.tsx` `Pill.tsx` `PathLabel.tsx` `CodeToolbar.tsx` | 读/搜索/胶囊/路径/代码块工具条的结构 |
| `packages/client/ui-tool/src/` | `contract/slots.ts` `tool/` | 按工具名注册视图的契约（本项目用 `toolSpec` 的 switch 等价实现） |
| `apps/desktop/README.md` | — | Electron 壳的安全模型：不开端口、`dsh-app://`、IPC 传启动注入 |

**注意**：以上 raw 抓取偶发 HTTP 000/超时，重试或改用 anysearch `extract`。

## 10. 验收标准

改完任何一项，必须做到：

1. `node --check` 通过所有改动的 js
2. 热重载日志无 `[renderer:error]`
3. `printf 'diff' > shot.request` 后读 `live.png` 肉眼确认
4. DOM 计数与预期一致（不要只看图，两者要同时对得上）
5. 不新增运行时依赖（shiki 之外）
6. 不改 `styles/base.css` 以外的方式污染全局样式（功能模块自带 CSS）

## 11. 统计

- 代码 2396 行（重构前），现拆分为 `src/app.js` + `src/features/*`
- 运行时依赖：electron 45.2.1、shiki 4.x
- `node_modules` 389MB
