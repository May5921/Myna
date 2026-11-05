# Myna

**给 [pi](https://github.com/earendil-works/pi) 编程 agent 做的桌面客户端。** 核心只有一件事：把 pi 的思考、工具调用和会话，变成一屏能读懂的界面。

![Myna 主界面](docs/images/main.png)

[English README](README.en.md)

> Myna 是 [pi CLI](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的图形前端 —— 一个安静、克制、几乎不打断你的桌面客户端。

---

## 为什么做这个

终端里的 pi 很强，但一屏塞满思考流、工具输出、diff 和回答时，"刚才它到底干了什么"就变得难读。

Myna 只有四条原则：

1. **不重写 agent。** pi 是唯一的 agent 运行时，Myna 只做桌面层。桌面侧会补 pi TUI 没有的辅助能力（文件预览、内嵌浏览器、命令终端、文档抽取），但不碰模型、会话和工具语义。
2. **一轮一屏。** 一轮结束后，思考和工具调用收进一个可展开的「过程」块，最终回答留在外面。想追溯细节，点开就是原始记录。
3. **状态真实。** 回合落定后优先用 pi `usage` 里的 token 数计算 tok/s；流式期间显示的是按字符估算的实时值，落定后校正。耗时与 TTFT 来自真实时间戳。不伪造成功状态。
4. **不打断。** pi 崩了自动按原 session 续跑；启动时先用本地会话文件把历史画出来，不让窗口白屏等 4 秒。

## 特性

**对话**
- 整轮折叠：`过程 · 3 次思考 · 5 个工具 · 12.4s · 48 tok/s`，点开是完整时间线
- 流式吐字、思考折叠行、Markdown + GFM 表格、shiki 代码高亮
- 工具卡片：运行微光、耗时、diff、JSON 折叠树、图片缩略图与全屏预览
- 历史分页（默认最近 80 条，向上加载更早）

**输入**
- 图片粘贴 / 拖拽（走 `prompt.images`）
- **文档拖入**：PDF、Word、PPT、Excel、Markdown 自动抽成纯文本随消息发出（Markdown 保留原文；PDF/Office 不保留排版、不做 OCR）
- `@` 文件引用、`/` 斜杠命令、按会话持久化的草稿
- 运行中 Enter 排队、Ctrl+Enter 插话（走 pi 的 `steer`）

**工作区**
- 首次启动引导：工作区 → 模型 → 测试消息（失败给可读原因）
- 会话按工作区分组、搜索、置顶、重命名、归档
- 其他 pi 进程在工作区里新建的会话会自动出现（约 2.5s 内）
- 左栏可拖宽（双击复位）
- 右栏：文件树预览、diff、会话树、内嵌浏览器（仅 http/https）、命令终端（非 PTY，执行单条命令）
- `Ctrl/Cmd+K` 命令面板，`Ctrl/Cmd+/` 快捷键总览

**工程**
- 零构建、原生 ES module；运行时依赖只有 `shiki`、`fflate`、`pdfjs-dist`
- `npm test` 99 个单元测试；`npm run e2e` 在真 Electron 里跑 17 个场景，断言数随本地历史数据变化（本次 136 条，不调用模型）
- CI 在 Ubuntu 与 Windows 双平台跑单元测试和语法/契约检查

## 边界与非目标

- 只支持 pi；不接 OpenCode / OMP。
- 不重写 agent，不模拟 pi 没有的会话或队列协议。
- 不内置 subagent / Todo / Plan 面板；`extensions/subagent` 只作参考资料，不进入安装包。
- 扩展兼容取决于宿主 pi：系统 pi 可用依赖 SDK 的扩展；内置 bundle 只保证不依赖 SDK 的扩展。设置 → 关于会显示当前用的是哪一种。
- 内置终端执行单条 PowerShell 命令，不是 PTY，不能替代交互式 shell。
- 不做代码签名，Windows 会提示未知发布者；更新只提示新版本，不静默替换文件。
- 内部标识（仓库目录、部分 localStorage 键、浏览器 partition）仍沿用 `pi-mini`，以保留已有用户数据。环境变量优先读 `MYNA_*`，并兼容旧的 `PI_MINI_*`。

## 什么时候选 Myna

- **选 Myna**：你在 Windows 上，想双击安装、不装 Node、不开本地服务；你更在意“一轮到底做了什么”的可读性，以及本机优先。
- **不选 Myna**：你需要手机/浏览器远程访问、macOS/Linux、静默自动更新或已签名的安装包。这些是当前明确的非目标。
- **和 pi-web 的关系**：pi-web 强在持久服务器会话和多设备浏览器访问；Myna 强在 Windows 本机零依赖和整轮阅读。两者是互补，不是同一场景的替代品。

## 给 AI agent / 自动化索引

- [`llms.txt`](llms.txt)：给 AI 助手和检索系统的事实摘要、安装方式与不能声称的能力。
- [`AGENTS.md`](AGENTS.md)：给编码 agent 的项目结构、命令和修改约束。
- [`CHANGELOG.md`](CHANGELOG.md)、[`CONTRIBUTING.md`](CONTRIBUTING.md)。

如果你在写评测或推荐：请以 `llms.txt` 和 latest release 为准，不要替 Myna 声称 macOS/Linux、远程访问、自动更新或代码签名。

## 安装

### 方式一：安装包（推荐）

1. 从 [Releases](../../releases/latest) 下载 `Myna-Setup-*.exe`
2. 双击安装，装完桌面就有 Myna 图标，双击即可打开

安装包里内置了一份 pi（约 12 MB）作为兜底，所以**不装 Node/pi 也能用**。

但如果你本机已经装了完整的 pi（npm 全局安装，≥ 1.5.0），Myna 会**优先使用系统 pi**。这是推荐路径：扩展（尤其是 subagent 这类依赖 `@earendil-works/pi-*` 的扩展）只有系统 pi 才有完整的 npm 包依赖；内置 bundle 只保证基础会话、工具和 UI 协议。

> Windows 可能提示「未知发布者」：这是未签名 exe 的默认行为，点「更多信息 → 仍要运行」即可。
> 卸载走「设置 → 应用」，或开始菜单里的卸载项。

### 方式二：便携版

下载 `Myna-*-win64.zip`，解压后双击 `Myna/Myna.exe`，不写注册表、不建快捷方式，删除即卸载。

### 方式三：从源码跑

```powershell
npm install
npm start
```

要求 Node 20+。从源码跑需要全局安装的 pi（便携版不需要）：

```powershell
npm install -g @earendil-works/pi-coding-agent
```

## 配置

Myna 读写的就是 pi 自己的配置，没有另一套平行世界：

| 内容 | 位置 |
|---|---|
| 会话 | `~/.pi/agent/sessions/` |
| 模型与提供商 | `~/.pi/agent/models.json` |
| 设置 | `~/.pi/agent/settings.json` |
| 扩展 / 技能 / MCP | `~/.pi/agent/` |

在 Myna 设置页里改提供商或 MCP，写之前会自动备份原文件。

## 快捷键

| 操作 | 快捷键 |
|---|---|
| 命令面板 | `Ctrl/Cmd+K` |
| 快捷键总览 | `Ctrl/Cmd+/` |
| 发送 | `Enter` |
| 换行 | `Shift+Enter` |
| 排队 | 生成中 `Enter` |
| 插话 | 生成中 `Ctrl+Enter` |
| 停止生成 | `Esc` |
| 切换左栏 | `Ctrl/Cmd+B` |

## 开发

```powershell
npm test          # 单元测试
npm run check     # 语法与契约检查
npm run e2e       # 端到端（真 Electron，默认隐藏窗口；MYNA_E2E_SHOW=1 可显示）
npm run build:portable   # 生成 dist/Myna/Myna.exe
npm run build:zip        # 打包 dist/Myna-*.zip
npm run release 0.1.2    # 一键发版：改版本 → 测试 → 打包 → 打 tag → 上传 Release
npm run release 0.1.2 -- --dry  # 只做测试/检查，不改文件、不构建、不提交
```

开发模式（热重载）：

```powershell
$env:MYNA_DEV = 1
npm start
```

旧的 `PI_MINI_DEV=1` 仍然兼容。日志固定写到 `%LOCALAPPDATA%\Temp\myna.log`。

架构说明见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，视觉规范见 [`docs/STYLE.md`](docs/STYLE.md)。

## License

MIT。第三方组件与架构参考项目的许可见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

---

## English

Myna is a Windows desktop client for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). It folds each turn's reasoning and tool calls into a single expandable block, uses pi-reported usage after a turn settles (streaming tok/s is an estimate), and restores a crashed pi on the same session.

- **Choose Myna** if you are on Windows and want a local, double-click install with pi bundled.
- **Do not choose Myna** for macOS/Linux, mobile or browser access, silent auto-update, or a signed installer; those are current non-goals.
- pi-web is complementary: it is built for persistent server-side sessions and access from any browser. Myna is built for a local Windows desktop and turn-level readability.

Read [`llms.txt`](llms.txt) for canonical facts and [`AGENTS.md`](AGENTS.md) for the repository guide. Zero build step, plain ES modules, three runtime dependencies. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for licenses.
