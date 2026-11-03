# myna — Codex 交接文档

> 生成时间：2026-11-04
> 仓库：`C:\Users\Luke\projects\pi-mini`
> 分支：`feat/complete-v1`
> 应用显示名：**myna**（历史名 pi-mini，目录和 GitHub remote 还没改）
> 状态：应用正在运行，用户正在使用；工作区有大量未提交改动。

---

## 0. 给 Codex 的阅读顺序

1. 先读本文档，理解“只做 pi TUI 的 GUI、现有功能不删、只优化”的产品原则。
2. 再读 `README.md`、`HANDOFF.md`、`docs/ARCHITECTURE.md`、`docs/RPC-MATRIX.md`。
3. 代码入口：
   - `main.js`：Electron 主进程 + pi RPC 桥 + 托盘/窗口/后端生命周期
   - `preload.cjs`：`window.pi` / `window.agentBackend` 暴露面
   - `src/app.js`：渲染层状态机 + 消息流 + 会话列表 + 队列/指标
   - `src/features/*.js`：独立功能模块，导出 `init(ctx)`
   - `src/core/*.js`：纯函数（metrics、fork-target、prefs、content-images、IR/projection）
   - `tests/*.test.mjs`：Node 内置 test runner

---

## 1. 项目是什么

myna 是一个给 **pi CLI** 用的极简 Electron 桌面 GUI：

- 零构建：没有 bundler，Electron 直接加载 `index.html` + ESM。
- 运行时依赖只有 `electron` 和 `shiki`。
- pi 通过 `pi --mode rpc` 子进程接入，JSONL 协议。
- 视觉语言对齐 Codex：浅色、窄侧栏、无气泡 assistant、右侧动作、底部 composer。
- 数据与 pi 共用：`~/.pi/agent/sessions/*.jsonl`、`~/.pi/agent/models.json`、`mcp.json`。

启动：

```powershell
cd C:\Users\Luke\projects\pi-mini
npm install
npm start
# 开发热重载（会监听文件；用 .dev-quiet 可关闭）
$env:PI_MINI_DEV=1; npm start
```

日志：`C:\Users\Luke\AppData\Local\Temp\pi-mini.log`

---

## 2. 用户与产品原则（非常重要）

用户原话与结论：

- “我们只做 tui 的 gui，tui 没有的我们就不要扩展。”
- “是 pi 的 TUI。”
- “不要 omp，我们只要 pi。”
- “现在有的就别删了，好用就继续做，我需要的是优化，功能越多 bug 越多。”
- “一口气全做完 p123。”（P0–P3，已完成一轮）
- “所有的上下文，我给 codex。”（本文档的由来）

因此：

1. **判断标准**：pi TUI 有对应命令/组件，才允许做 GUI 化；pi TUI 没有的，不再新增。
2. **OMP 已放弃**：不做 OMP 后端、不做 OMP 的 Todo/子代理/Ask/Plan/Goal/`/btw`。
3. **现有功能不删**：右栏文件/浏览器/侧聊、归档、置顶、托盘、turn rail、Mod+P 都保留；可以优化、修 bug，不要以“范围”为由删除。
4. **只优化，不加新功能**：后续优先修 bug、性能、暗色一致性、测试、文档。
5. **不要打断用户正在用的 pi**：改文件前确认 `.dev-quiet` 存在；不要随意重载/重启应用。
6. **改配置、装依赖先说再做，改配置前备份。**
7. 用户偏好：中文、称“主人”、结论先行、不附和、不确定就明说。

### 已知的用户痛点

- 开发热重载会在用户使用 pi 时刷新界面，用户明确抱怨过。
  - 解决：仓库根目录放 `.dev-quiet` 后，`main.js` 的 dev watcher 只响应 `shot.request` 自截屏，不再 reload/relaunch。
  - Codex 接手时：**先检查 `.dev-quiet` 是否存在**；如果不存在，用户可能正在被热重载打断。
- 用户不喜欢蓝色用户气泡。已从 `#edf3fe` 改回 `var(--side)` + `1px var(--line)`。
- 用户对“假速度”敏感：tok/s 必须反映真实 output（含 reasoning），不能只算正文。

---

## 3. 当前范围

### 允许/已实现（pi TUI 有对应）

- 会话：新建、恢复、切换、重命名、会话树、fork、clone、分页、搜索
- 消息：流式、思考、工具卡、diff、Markdown、shiki、图片、停止、复制、完成摘要
- 队列/插话：本地队列、编辑、删除、steer、自动发送
- 模型/思考档位、压缩、上下文环、会话统计
- 设置：主题/字号/字体、提供商/模型、行为、MCP/技能、扩展、关于、快捷操作
- `@` 文件引用、`/` 斜杠命令、图片粘贴/拖拽
- 终端（一次性命令，非 PTY）
- 快捷键帮助（Mod+/）
- 托盘/关窗隐藏/退出确认/后台完成通知（属于桌面壳，用户要求保留）

### 明确不做

- OMP 后端及 OMP 独有 UI（Todo、Subagent、Ask、Plan/Goal、`/btw`）
- DSH 对标式扩展（插件市场、自动化任务、Goal、Trajectory、多面板 dock、多工作区树）
- 新的大功能；除非用户明确要求

### 保留但不投入的“越界”功能

- 右栏文件树/预览、浏览器 tab、侧聊
- 归档/置顶/三态筛选/撤销/拖拽（拖拽未实现）
- turn rail
- Mod+P 快速打开
- Markdown 导出
- opencode 后端（半成品，用户之前暂停；目前仍保留在设置里）

---

## 4. 架构与关键文件

### 主进程

- `main.js`（约 2970 行）
  - pi 直连桥：`startPi`、`command`、`send`、`ensureReady`、`stopPi`
  - 会话列表/历史/模型/搜索/导出/预览/MCP/提供商 IPC
  - 后端选择：`BACKENDS = ["pi", "opencode"]`，pi 走旧直连桥，opencode 走 `src/core/adapters`
  - 托盘：`createTray`、`destroyTray`、`showMainWindow`、`notifyHiddenToTray`
  - 退出：`beginQuit`、`rendererIsStreaming`、`confirmQuitWhileStreaming`
  - dev watcher：`startDevWatch`；`.dev-quiet` 存在时只回应 `shot.request`
- `preload.cjs`
  - `window.pi`：command/sessions/switchSession/newSession/setCwd/models/export/search/highlight/readFile/openPath/openExternal/termRun/termKill/onEvent/onStderr...
  - `window.agentBackend`：info/list/set

### 渲染层

- `src/app.js`（约 3700 行）
  - 状态 `state`、消息流、会话列表、草稿、滚动、指标、队列入口、事件处理
  - 关键函数：`addUser`、`addAssistantRow`、`finalizeAssistant`、`renderHistory`、`paintHistory`、`renderSessions`、`refreshState`、`submit`、`setStreaming`
  - TPS：`estimateTokens`、`markOutputTokens`、`tpsTick`、`settleRunStatus`
  - `window.__piui = ctx`、`window.__selftest`、各种 demo hook
- `src/theme.js`
  - 主题/字号/字体；`initTheme`、`applyTheme`、`setThemePref`、`setFontSize`、`setFontFamily`
  - dev hook：`window.__mynaSetTheme(pref)`
- `src/theme-boot.js`
  - 首屏前同步套主题/字号，避免暗色闪白；逻辑与 `src/theme.js` 重复，改动两边同步
- `src/features/*`
  - `settings.js`：设置弹窗（外观、提供商、行为、统计、MCP/技能、关于）
  - `queue.js`：本地队列 dock（从 DSH QueueDock 移植）
  - `right-panel.js`：文件/变更/会话/浏览器/对话五个固定 tab；Mod+P；预览重载
  - `shortcuts.js`：命令面板（Ctrl+K）+ 快捷键帮助（Mod+/）
  - `terminal.js`：底部终端，一次性 PowerShell/sh 命令
  - `turn-rail.js`：右侧每轮用户消息刻度
  - `extension-ui.js`：pi 扩展 select/confirm/input/editor/notify/status/widget
  - 其余：attachments、message-actions、message-fork、message-retry、context-meter、json-view、image-preview、export-html、input-trigger、code-toolbar、empty-chips

### 纯函数

- `src/core/metrics.js`：TTFT/tok-s 统计、localStorage 分桶
- `src/core/fork-target.js`：扁平 entries → 树、活动链、fork 目标匹配
- `src/core/prefs.js`：主题解析、字号夹取、字体清洗（有测试）
- `src/core/content-images.js`：从消息 content 提取图片（有测试）
- `src/core/ir.js` / `legacy-projection.js` / `adapters/*`：opencode 路的 IR；pi 不用，属于半死代码

### 测试

```powershell
npm test          # 52 tests
npm run check     # node --check 全部源文件
git diff --check
```

当前：**52/52 通过，34 文件语法通过，diff 干净。**

---

## 5. 本轮已完成的关键改动（按时间）

### 5.1 改名与品牌

- 应用名改 **myna**，`package.json` name=myna；窗口标题/设置/README 同步。
- `userData` 保留旧 `%APPDATA%\pi-mini`；状态文件 `~/.myna.json` 首次从 `~/.pi-mini.json` 复制，旧文件保留作备份。
- localStorage 键仍是 `pi-mini.*`，不要改，否则草稿/队列/统计丢失。
- 新图标来自用户提供的 myna 鸟图：
  - `assets/icon-source.png` 原图
  - `scripts/make-icon.py` 去白底透明、生成 `icon.png`/`icon-256.png`/`brand.png`/多尺寸 `icon.ico`
  - `index.html` 左上角用 `<img class="brand-mark" src="./assets/brand.png">`
  - `.gitignore` 给 `assets/*.png` 加了白名单
- **注意**：本地目录、GitHub remote 仍是 `pi-mini`；用户提过改名，但 GitHub 当前不可达、`gh` token 失效，没改。

### 5.2 主题/字号

- 设置 → 通用 → 外观：主题（跟随系统/浅色/深色）、正文字号 10–22、代码 9–20、终端 9–20、界面字体、代码/终端字体。
- 暗色覆盖：设置导航、提供商按钮、右栏 diff、代码块背景、队列滚动条、turn rail、用户气泡。
- shiki 支持 `github-light`/`github-dark`；主题切换只对明暗变化重高亮。
- 用户气泡最终：`background: var(--side); border: 1px solid var(--line);`（不是蓝色）。

### 5.3 TPS 假速度修复（最近）

问题：截图出现 781 tok/s，用户说“根本没有那么快”。

根因：
- 旧逻辑只在 `text_delta` 记 `firstToken`，思考阶段不算；
- reasoning-heavy 回答里，思考 325 tokens、正文 ~85 tokens，分母只有正文解码的零点几秒 → 781。

修复：
- 新增 `markOutputTokens(delta)`：思考与正文都计入 `state.liveTokens`，`firstToken` 从第一段思考/正文开始。
- 实时窗口至少 0.5s，避免首包整段到达除以几十毫秒。
- 首 token 后不足 0.8s 且不足 12 token 不显示仪表。
- 最终平均仍优先 `usage.output` / 解码时间；分母现在包含思考时间。
- **尚未用真实 reasoning 回合复验**；下一条带思考的回答应回到几十 tok/s。

### 5.4 用户图片

- `addUser(text, images)` 渲染 `.user-imgs > .tool-img`，点击走现有灯箱。
- 历史 `imagesFromContent` 兼容 `{type:"image",data,mimeType}` 与 `{source:{data,media_type}}`。
- 单测：`tests/content-images.test.mjs`。
- 队列图片仅内存，持久化只存文本；重试明确不支持图片。

### 5.5 会话列表

- 归档三态筛选：隐藏归档 / 显示全部 / 仅归档；按钮在「工作区」标题行的漏斗图标。
- 归档/取消归档带「撤销」toast。
- 会话菜单：置顶、重命名、复制会话 ID、导出 Markdown（仅当前会话）、归档。
- 性能：`renderSessions` 增加签名，模型/流式状态变化但侧栏内容未变时跳过整树重建。
- 搜索仍有：标题过滤 + `pi:search-sessions` 全文搜索。

### 5.6 历史渲染

- `paintHistory` 批量渲染时 `state.paintingHistory=true`，`follow()` 直接 return；整段画完只滚一次。
- 分页「加载更早」保留锚点。

### 5.7 右栏

- 五个固定 tab：文件/变更/会话/浏览器/对话。
- 文件树点击预览（shiki/图片/二进制提示），工作区外回退系统程序。
- 变更 tab：staged/unstaged + 每文件展开 diff。
- 会话 tab：`get_tree`，大会话爆栈时退 `get_entries + treeFromEntries`。
- 浏览器 tab：`<webview>`，仅 http/https。
- 侧聊：独立 pi RPC 进程，可流式/停止/清空；不显示工具行（用户要求）。
- Mod+P 快速打开：文件索引缓存 5s，子序列匹配，最多 50 行。
- 预览工具栏有「重新加载」。
- 右栏缓存按 cwd 隔离，切换工作区丢弃旧请求结果。

### 5.8 队列

- 从 DSH QueueDock 移植：单条显示、多条折叠“N 条排队”、行内编辑、删除、插话、pending「发送中…」。
- Enter 排队 / Ctrl+Enter 插话；设置可交换。
- 空闲自动 dispatch，失败指数退避 5/10/20/30s。
- 本地持久化 `pi-mini.queue.<sessionFile>`，只存文本；图片只在内存。
- **没有**使用 pi 的 `follow_up`/`clear_queue` RPC；只发 `steer`。

### 5.9 托盘/桌面壳

- Windows 托盘：`assets/icon.ico`、显示主窗口、退出。
- 关窗收进托盘（仅当 tray 创建成功），首次提示“仍在后台运行”。
- 真退出：`beginQuit` 确认流式回合（`window.__piStreaming`），取消/仍然退出，清理 pi/side/opencode 子进程。
- 后台完成通知：渲染层 HTML5 Notification，`document.hidden` 时触发，6s 节流。
- 单实例：第二个实例拉回隐藏窗口。

### 5.10 快捷键/命令面板

- Ctrl/Cmd+K 命令面板：打开设置、切换右栏、聚焦输入、新建会话、压缩、复制上一条、打开终端、导出 HTML。
- Ctrl/Cmd+/ 快捷键帮助：搜索、分组、键盘导航、焦点陷阱，只列实际存在的快捷键。

### 5.11 turn rail

- `src/features/turn-rail.js`：每个 `.row.mine` 一个刻度，按内容真实位置映射，hover 摘要，点击滚动，当前轮高亮。
- 深色下刻度已加对比度（`--faint` + opacity）。

### 5.12 其他修复

- 外链 `.xlink` 点击：`window.pi.openExternal`。
- 用户消息图片回显。
- 终端 `__piTermAPI.isOpen` 是 getter 不是函数；截图清理里调用 `.isOpen()` 会抛 TypeError，已修。
- `theme.js` 从 `features/` 移到 `src/theme.js`，修复 contract test。
- OMP 半接线移除：`BACKENDS` 回到 `pi/opencode`，设置去掉 omp；`omp-todo/omp-tasks` 文件保留但不在 FEATURES 加载。
- README/RPC-MATRIX 失真描述修正。

---

## 6. 当前工作区状态（重要）

`git status --short` 有 41 行：

- 22 个已跟踪文件修改，约 `+4545 / -666`
- 未跟踪：`assets/*.png`、`docs/ADAPTER-CONTRACT.md`、`scripts/make-icon.py`、`src/core/`、`src/theme.js`、`src/theme-boot.js`、`src/features/turn-rail.js`、`src/features/omp-todo.js`、`src/features/omp-tasks.js`、多个 tests。

**没有提交。** 上一轮用户明确说不要删现有功能，所以 OMP 文件保留但死着；opencode 后端也保留但半成品。

建议 Codex 接手第一件事：**先向用户确认是否提交 WIP 基线**，不要在 4.5k 行未提交改动上继续叠功能。

---

## 7. 当前运行状态

- 应用在运行；`.dev-quiet` 存在；改文件不会自动 reload/relaunch。
- 后端：pi；主题：跟随系统（当前浅色）；归档筛选：隐藏归档。
- 当前 myna 会话 context 约 14.8%，模型 DeepSeek V4.1 Flash。
- 当前会话里有一条测试误发的 prompt：`read C:/Users/Luke/projects/pi-mini/live.png 并只回复这个词：ok`（只读 live.png，回了 ok，没有改文件）。
- 应用最后一次重载是 19:18，加载了 TPS 修复；之后没有再改运行代码。
- 用户可能在应用里继续发消息；**不要随意重载**。

### dev 截图/调试工具

- `shot.request` 文件写在仓库根目录，内容为关键词；dev watcher 会自截屏到 `live.png` 并写日志。
- 常用关键词：`diff`、`settings`、`queue`、`term`、`cmdk`、`rp-files`、`rp-tree`、`theme-dark`、`theme-light`、`theme-system`、`perf`、`dumprows`、`attach`、`sock` 等（以 `main.js` 里 `want.includes(...)` 为准）。
- 截图前先确认应用 boot 完成（日志 `window ready`），否则会截到空状态。
- 主题 dev hook：`window.__mynaSetTheme("dark"|"light"|"system")`（`src/theme.js` 里注册）。
- 日志：`C:\Users\Luke\AppData\Local\Temp\pi-mini.log`

---

## 8. 已验证 / 未验证

### 已验证（实机 + 日志/截图）

- 浅色/深色/跟随系统切换
- 深色设置弹窗、代码块、右栏、队列、命令面板
- 用户图片注入渲染 + 灯箱（`images:1, box:true, hidden:false`）
- Mod+P 打开 50 行文件结果
- 命令面板 8 项
- 队列 2 条排队
- 终端 `echo pi-mini terminal` 输出/退出码
- 右栏会话树、文件预览（`code:true, chars:133`）
- 归档筛选 hide→all→only→hide
- turn rail 11 个刻度
- 性能：IPC 0.85ms/次，DOM 2986 节点，渲染层 heap 8.6MB，主进程 RSS 45MB

### 未验证 / 风险

- **TPS 修复未用真实 reasoning 回合复验**。
- 托盘关闭/退出确认只做了代码核对，没实际点关闭。
- 外链没有实际点击（会拉起系统浏览器）。
- 会话切换/归档撤销没有完整走一遍（会动真实数据）。
- 工作区 4.5k 行未提交，没有干净基线。
- `src/features/omp-*` 是死代码，不影响运行。
- `HANDOFF.md` 和部分 docs 可能仍有过时描述；README/RPC-MATRIX 本轮修过。
- `settings.js` 的 provider 密钥明文存 `models.json`，UI 只做掩码。
- 终端是非 PTY，一次性命令。
- 文件索引上限 2000；大仓库可能截断。
- 历史默认 80 条/页；超大 session 切换有成本。

---

## 9. 建议下一步（按优先级）

1. **先让用户确认提交 WIP 基线**；不要直接在 4.5k 行未提交改动上继续。
2. 用一条真实 reasoning 消息验证 TPS：应显示几十 tok/s，不再出现 781。
3. 跑一遍托盘关闭/退出确认（用户不用时），确认 pi/opencode 子进程无孤儿。
4. 决定 opencode：保留、隐藏、还是彻底移除。用户目前说“只要 pi”，但也说过“现有别删”。
5. 清理死代码：
   - `src/features/omp-todo.js`、`omp-tasks.js`（未加载）
   - `src/core/adapters/`、`ir.js`、`legacy-projection.js`（pi 不用）
   - 但删除前必须先确认用户同意，因为“现有别删”。
6. 继续只做优化：暗色一致性、性能、测试、文档；不要加新功能。
7. 如需改本地目录/远端名：先关应用，再改名；GitHub 需要用户恢复网络/gh 登录。

---

## 10. 禁止事项（Codex 必读）

- 不要在用户使用 pi 时随意 reload/relaunch；动文件前确认 `.dev-quiet` 存在。
- 不要删用户现有功能；不要以“范围”为由移除右栏/侧聊/归档/托盘/turn rail。
- 不要接 OMP；不要加 Todo/Subagent/Ask/Plan/Goal。
- 不要新增运行时依赖；Electron + shiki 是白名单。
- 不要改 `window.pi` 的既有 API 形状；需要加方法时同步 `preload.cjs` 和 contract test。
- 不要改 deploy/install 脚本，除非用户明确要求。
- 不要提交 commit / push，除非用户明确要求。
- 不要发真实模型 prompt 做测试而不告诉用户；会产生费用并污染当前会话。
- 改配置前备份；改 `~/.pi/agent/*.json` 必须备份 + 原子写。

---

## 11. 关键路径速查

```text
C:\Users\Luke\projects\pi-mini\           项目根
  main.js                                 Electron 主进程 / pi RPC / 托盘 / 退出
  preload.cjs                             window.pi / window.agentBackend
  index.html                              app://bundle 入口，CSP script-src 'self'
  src\app.js                              渲染层状态机 / 消息流 / 会话列表 / TPS
  src\theme.js                            主题/字号/字体
  src\theme-boot.js                       首屏防闪白
  src\features\settings.js                设置弹窗
  src\features\queue.js                   本地队列 dock
  src\features\right-panel.js             右栏五 tab / Mod+P / 预览
  src\features\shortcuts.js               命令面板 / 快捷键帮助
  src\features\terminal.js                底部终端
  src\features\turn-rail.js               轮次导轨
  src\core\metrics.js                     TPS/统计
  src\core\fork-target.js                 fork/树
  src\core\prefs.js                       主题纯函数（有测试）
  src\core\content-images.js              图片解析（有测试）
  tests\*.test.mjs                        node:test
  docs\RPC-MATRIX.md                      pi RPC 覆盖（本轮修过）
  HANDOFF.md                              早期交接（部分过时）
```

### 常用命令

```powershell
cd C:\Users\Luke\projects\pi-mini
npm test
npm run check
git diff --check
git status --short

# 启动（会开 dev watcher）
$env:PI_MINI_DEV=1; npm start

# 暂停热重载（用户正在用时）
ni .dev-quiet -Force

# 恢复热重载
Remove-Item .dev-quiet
```

---

## 12. 一句话总结

myna 现在是一个“功能已经够多、范围刚收回 pi TUI、但基线未提交”的 Electron pi 客户端。Codex 接手时不要加功能，先把 WIP 基线落住，验证 TPS，处理托盘/opencode/死代码，再继续做优化。
