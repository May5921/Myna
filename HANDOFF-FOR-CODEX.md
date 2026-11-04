# myna 当前交接

> 更新：2026-11-04
> 仓库：`C:\Users\Luke\projects\pi-mini`
> 分支：`feat/complete-v1`
> 应用名：**myna**（目录和远端仍沿用 pi-mini）

## 产品边界

myna 是 pi CLI 的 Electron GUI，只把 pi TUI 已有的会话、回合、消息、思考、工具、队列和桌面壳能力做成图形界面。

- 只支持 pi；不接 OpenCode，不接 OMP。
- 保留会话、流式消息、思考、工具卡、队列、右栏、归档、托盘、turn rail、设置和终端。
- 视觉方向是 myna 自己的：安静中性、回合状态优先、工具结果可追溯；外部项目只作研究资料。
- 不新增 Todo、子代理、Ask、Plan/Goal、`/btw` 等 pi TUI 没有的产品能力。
- 现有功能只能优化和修 bug；删文件前先送入 Windows 回收站。
- 不新增运行时依赖；当前依赖白名单是 Electron + shiki。
- 应用运行时改文件前先确认根目录 `.dev-quiet`，不要随意重载正在使用的 Electron。
- 中文沟通，称用户为“主人”；结论先行，证据不足就明确说未验证。

## 当前代码骨架

- `main.js`：Electron 主进程、pi RPC、会话/模型/文件/终端/托盘 IPC。
- `preload.cjs`：只暴露 `window.pi`；没有后端切换 API。
- `src/app.js`：pi 事件消费、消息渲染、会话列表、队列入口、滚动和 TPS。
- `src/core/turn-model.js`：pi 回合生命周期 `idle → running → settled`，记录开始时间、assistant 消息数、工具数、结果和回合内 assistant 消息快照；回合结束会统一结算整轮未结算消息。
- `src/core/assistant-message.js`：当前 assistant 消息的纯状态 reducer，收拢 thinking/text 增量、pi 终稿、显示文本进度和工具结果；DOM 吐字动画仍由 `app.js` 消费。
- `src/core/session-groups.js`：工作区、会话、归档过滤和置顶排序的纯函数。
- `src/core/metrics.js`、`fork-target.js`、`prefs.js`、`content-images.js`：独立纯逻辑。
- `src/features/settings.js`：设置弹窗；当前为内容驱动高度、扁平分组、可滚动窄窗口导航。
- `src/features/omp-todo.js`、`omp-tasks.js`：按“现有文件别删”保留，但不在 `FEATURES` 加载，且不属于产品范围。

## 已完成的结构收敛

- 主进程和 preload 已经是 pi-only 运行路径。
- 旧的 IR/adapter 架构已确认没有运行路径引用，以下文件已送入回收站：
  - `docs/ADAPTER-CONTRACT.md`
  - `src/core/adapters/index.js`
  - `src/core/adapters/pi.js`
  - `src/core/ir.js`
  - `src/core/legacy-projection.js`
  - `tests/legacy-projection.test.mjs`
  - `tests/pi-adapter.test.mjs`
- assistant 消息模型已覆盖实时与历史的 thinking、正文、吐字缓冲、终稿和工具结果；工具 DOM 仍保留增量更新层。
- 设置页已完成一轮视觉收敛：减少死白、降低卡片层级、扩大控件命中区、补窄窗口导航。
- 会话列表已抽出纯函数；图片 content 解析已抽出并测试；TPS 已把 thinking 纳入 output 统计。

## 当前验证

最近一次本地验证：

```powershell
npm test       # 59/59 通过
npm run check  # 33 个源文件通过 node --check
git diff --check
node scripts/probe-pi-rpc.mjs  # 只读 state/models/commands，不发 prompt
```

当前源码测试为 `59/59`；新增 pi-only 边界、工具 partialResult、嵌套调用和回合工具状态测试。

另有一次进程级只读 pi RPC 探针成功：`node scripts/probe-pi-rpc.mjs` 临时启动 `pi --mode rpc`，连续发送 `get_state`、
`get_available_models` 和 `get_commands`，分别收到状态字段、37 个模型和 17 个命令（来源为 extension/skill）；
探针子进程清除了当前 shell 的无效代理环境变量，未发送模型 prompt。
`main.js` 已在 pi 子进程启动时自动丢弃无协议的代理变量，避免重启 Electron 后复现同一启动失败。
这些结果不等于 Electron 视觉回归，也不等于真实 pi reasoning 回合验证。

## 未完成和风险

1. assistant 的正文、吐字缓冲和终稿已进入消息模型；`app.js` 仍保留 DOM 吐字控制器，下一刀应继续减少渲染层兼容分支。
2. 工具状态已覆盖 start/update/end、最新 partialResult 和嵌套调用过滤；历史工具 DOM 仍是增量补写，需要继续补工具归属、乱序事件和历史快照测试。
3. 已做 Electron 实机截图验证：设置通用页和行为页均能打开；开发探针等待 `__piSettingsDemo` 就绪后截图。当前运行通过 `PI_MINI_DEV=1` 启动，`.dev-quiet` 仍阻止普通文件改动自动重载。
4. 未用真实 reasoning 回合复验 TPS；未实际点击托盘关闭、退出确认、外链、会话切换和归档撤销。
5. 工作区仍有未提交 WIP，不要擅自提交、推送或改配置。
6. 个别源码注释仍保留外部实现的来源说明，产品行为以当前源码和测试为准。

## 下一步顺序

1. 让 `finalizeAssistant()` 和历史渲染消费模型快照，继续减少 DOM 反向作为状态源。
2. 补工具归属、乱序事件、终稿先到和多 assistant 消息的集成测试。
3. 检查 pi TUI 真实语义，逐项校准队列、插话、思考和会话切换边界。
4. 在不增加能力的前提下继续统一 myna 的视觉 token 和交互语言。
5. 补 Electron 运行和真实 pi 回合证据后，再形成可回滚提交。

## 常用命令

```powershell
cd C:\Users\Luke\projects\pi-mini
npm test
npm run check
git diff --check
git status --short
```

不要把旧截图、旧交接文字或单纯源码测试当成当前运行事实；每次状态结论都要重新检查工作区和对应工具输出。
