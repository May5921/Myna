# Myna 当前交接

> 更新：2026-11-05
> 仓库：`C:\Users\Luke\projects\pi-mini`
> 分支：`main`（`feat/complete-v1` 已落后，不再作为工作分支）
> 应用名：**Myna**（仓库目录、远端 URL 和部分内部键仍沿用 pi-mini）

## 产品边界

Myna 是 pi CLI 的 Electron GUI：以 pi 为唯一 agent 运行时，桌面侧负责会话/回合渲染、输入、工作区，以及 pi TUI 没有的辅助能力（文件预览、内嵌浏览器、命令终端、文档抽取）。

- 只支持 pi；不接 OpenCode，不接 OMP。
- 保留会话、流式消息、思考、工具卡、队列、右栏、归档、托盘、turn rail、设置和终端。
- 视觉方向是 Myna 自己的：安静中性、回合状态优先、工具结果可追溯；外部项目只作研究资料。
- 不新增 Todo、子代理、Ask、Plan/Goal、`/btw` 等产品面板；`extensions/subagent` 只是参考资料，不打包。
- 现有功能只能优化和修 bug；删文件前先送入 Windows 回收站。
- 不新增运行时依赖；当前运行时依赖是 shiki、fflate、pdfjs-dist（开发依赖 electron / electron-builder / rcedit）。
- 应用运行时改文件前先确认根目录 `.dev-quiet`，不要随意重载正在使用的 Electron。
- 中文沟通，称用户为“主人”；结论先行，证据不足就明确说未验证。

## 当前代码骨架

- `main.js`：Electron 主进程、pi RPC、会话/模型/文件/终端/托盘 IPC。
- `preload.cjs`：只暴露 `window.pi`；没有后端切换 API。
- `src/app.js`：pi 事件消费、消息渲染、会话列表、队列入口、滚动和 TPS。
- `src/core/turn-model.js`：pi 回合生命周期 `idle → running → settled`，记录开始时间、assistant 消息数、工具数、结果和回合内 assistant 消息快照；回合结束会统一结算整轮未结算消息。
- `src/core/assistant-message.js`：当前 assistant 消息的纯状态 reducer，收拢 thinking/text 增量、pi 终稿、显示文本进度和工具结果；DOM 吐字动画仍由 `app.js` 消费。
- `src/core/session-groups.js`：工作区、会话、归档过滤和置顶排序的纯函数。
- `src/core/metrics.js`、`fork-target.js`、`prefs.js`、`content-images.js`、`provider-store.js`、`input-trigger.js`、`queue-store.js`：独立纯逻辑。provider-store 负责写 models.json 前的校验与字段保留；input-trigger 负责 @ / 触发与候选排序；queue-store 负责排队草稿持久化。
- `src/features/settings.js`：设置弹窗；当前为内容驱动高度、扁平分组、可滚动窄窗口导航。
- `src/features/onboarding.js`：首次启动三步引导；普通 E2E 跳过真实引导，`all` 通过拦截测试 prompt 的隔离场景覆盖三步 UI。
- 会话列表刷新：主进程每 2.5s 对比 sessions 目录的文件名指纹，外部 pi 进程新建/删除会话时推 `pi:sessions-changed`，渲染层防抖刷新。
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
npm test       # 99/99 通过（2026-11-05）
npm run check  # 43 个源文件通过 node --check
npm run e2e    # 17 场景；断言数随本地历史数据变化（本次 136），真 Electron，不调用模型
node scripts/build-portable.mjs  # 便携版 Myna.exe 构建成功
npm run build:zip                # 160.0 MB zip 构建成功
npm run build:installer          # 123.0 MB NSIS 构建成功，未签名
git diff --check
node scripts/probe-pi-rpc.mjs  # 只读 state/models/commands，不发 prompt
```

当前源码测试为 `99/99`；新增 provider 配置规整、@ / 触发与排序、排队草稿解析、右栏 URL 校验测试。
E2E 已新增 onboarding 与 queue 场景，当前为 17 个场景；断言数随本地历史数据变化，本次为 136。onboarding 只验证三步 UI 和 prompt 拦截，不代表真实模型成功。便携版、zip 和 NSIS 安装包均已在 Windows 构建成功。

另有一次进程级只读 pi RPC 探针成功：`node scripts/probe-pi-rpc.mjs` 临时启动 `pi --mode rpc`，连续发送 `get_state`、
`get_available_models` 和 `get_commands`，分别收到状态字段、40 个模型和 47 个命令（来源为 extension/skill/prompt）；
探针子进程清除了当前 shell 的无效代理环境变量，未发送模型 prompt。
`main.js` 已在 pi 子进程启动时自动丢弃无协议的代理变量，避免重启 Electron 后复现同一启动失败。
这些结果不等于 Electron 视觉回归，也不等于真实 pi reasoning 回合验证。

## 未完成和风险

1. assistant 的正文、吐字缓冲和终稿已进入消息模型；`app.js` 仍保留 DOM 吐字控制器，下一刀应继续减少渲染层兼容分支。
2. 工具状态已覆盖 start/update/end、最新 partialResult 和嵌套调用过滤；历史工具 DOM 仍是增量补写，需要继续补工具归属、乱序事件和历史快照测试。
3. 已做 Electron 实机截图验证：设置通用页和行为页均能打开；开发探针等待 `__piSettingsDemo` 就绪后截图。开发模式用 `MYNA_DEV=1`（旧的 `PI_MINI_DEV` 仍兼容），`.dev-quiet` 仍阻止普通文件改动自动重载。
4. 已用真实 pi RPC 回合验证活动会话追加 `只回复 ok` → `ok`、`stopReason=stop` 和 `agent_settled`；本次没有 thinking 内容，尚未从 Myna renderer 复验 TPS。仍未实际点击托盘关闭、退出确认、外链、会话切换和归档撤销。pi stderr 现在会以脱敏摘要进入退出提示和诊断复制，原始内容仍只写本地日志；首次引导的测试消息会立即处理进程退出、provider error 和 aborted。
5. 安装包当前未配置代码签名，会触发 Windows SmartScreen；签名流程已写入 `docs/SIGNING.md`，但没有真实签名凭据验证。
6. 本次文档/命名/测试/发布脚本改动尚未提交；不要擅自提交、推送或改配置。
7. 内部标识（仓库目录、部分 localStorage 键、浏览器 partition）仍保留 `pi-mini`，这是为已有用户数据做的兼容，不是遗漏。

## 下一步顺序

1. 让 `finalizeAssistant()` 和历史渲染消费模型快照，继续减少 DOM 反向作为状态源。
2. 补工具归属、乱序事件、终稿先到和多 assistant 消息的集成测试。
3. 检查 pi TUI 真实语义，逐项校准队列、插话、思考和会话切换边界。
4. 在不增加能力的前提下继续统一 Myna 的视觉 token 和交互语言。
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
