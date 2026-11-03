# pi-mini

给 pi CLI（npm 包 `@earendil-works/pi-coding-agent`）做的极简桌面前端：Electron + 原生 ES module，零构建，运行时只依赖 `electron` 和 `shiki`。

视觉参照 Codex，交互与技术实现参照 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）与 pi TUI。

## 运行

要求：Node 20+、全局安装 `pi`（`@earendil-works/pi-coding-agent`，有 `dist/cli.js`）。

```powershell
npm install
npm start
```

开发模式（热重载 + `shot.request` 截图钩子）：

```powershell
$env:PI_MINI_DEV = 1
npm start
```

日志固定写到 `%LOCALAPPDATA%\Temp\pi-mini.log`。

## 功能

- 会话：按工作区分组、手动绑定项目白名单、折叠状态与标题持久化、重启恢复上次会话、分页加载
- 输入框：`@` 文件引用、`/` 斜杠命令、图片粘贴/拖拽（`prompt.images`）
- 消息：流式文本、Markdown（含 GFM 表格）、shiki 懒高亮、工具卡片、diff、JSON 折叠树、工具图片缩略图与全屏预览
- 队列：运行中 Enter 排队 / Ctrl+Enter 插话，按 pi 的 `follow_up` / `steer` 语义
- 右栏：文件树、工作区变更（含 diff）、会话树
- 设置：模型与思考档位、自动压缩、队列模式、会话名、导出 HTML、复制/克隆/切换等快捷操作
- 模型菜单：按供应商分组、搜索、两级面板（模型 / 思考档位）
- 扩展 UI：pi 扩展的 select/confirm/input/editor、notify、status/widget

## 结构

```
main.js          主进程：窗口、app:// 协议、pi 子进程、IPC、截图钩子
preload.cjs      contextBridge → window.pi
index.html       单页骨架（CSP script-src 'self'）
styles/base.css  Codex 风格 token 与全局样式
src/app.js       状态、渲染、事件、启动；导出 ctx 给功能模块
src/features/     每个文件 export function init(ctx)，自带 CSS
docs/            STYLE.md / ARCHITECTURE.md / RPC-MATRIX.md / PERF.md
```

新增功能 = 建一个 `src/features/xxx.js`，导出 `init(ctx)`，在 `src/app.js` 的 `FEATURES` 里加一行；功能自带 `document.createElement("style")`，不改 `styles/base.css`。

pi 通过 `pi --mode rpc` 子进程接入，不监听 HTTP 端口；所有 RPC 覆盖情况见 [docs/RPC-MATRIX.md](docs/RPC-MATRIX.md)。

## 约束

- 不引入 React / 打包器 / TypeScript，保持零构建
- 渲染层不使用内联脚本（CSP）
- 不新增运行时依赖（electron + shiki 之外）
