# 性能体检（开源前基线）

测量环境：Windows 11，Electron 45，`MYNA_DEV=1`（旧名 `PI_MINI_DEV` 兼容），冷启动一次 + 空会话。
数据来源：`C:\Users\Luke\AppData\Local\Temp\myna.log` 的 `[perf]` 行与 `shot.request = perf`。

> 这组运行期基线采集于 2026-11-03（v0.1.1）；当前源码在 2026-11-05 之后又加入了 onboarding、队列和发布流程改动，数字不能直接当作当前版本的性能承诺，引用前请重新采集。

## 冷启动

| 阶段 | 耗时 |
| --- | --- |
| Electron 主进程 `app.whenReady` | 128–155 ms |
| `did-finish-load`（窗口可交互） | 1426–1710 ms |

窗口就绪时间主要花在 Chromium 首次加载 + 启动 pi 子进程（`pi --mode rpc`）。
`pi:boot` 现在会等 pi 的 `get_state` 成功才返回，所以 renderer 的 `__ready` 晚于窗口加载，但第一条命令不再撞上冷进程。

## 运行期

| 指标 | 数值 |
| --- | --- |
| `get_state` IPC 往返（20 次均值） | 0.55 ms |
| 渲染层 JS heap | 6.2 MB |
| 主进程 JS heap | 6 MB |
| 主进程 RSS（含 Electron 共享） | 170 MB |
| DOM 节点数（空会话） | 303 |

## 长会话

历史消息按页渲染（默认最近 80 条消息，向上点「加载更早」再加 80 条），避免一次把整份会话塞进 DOM。

| 场景 | 结果 |
| --- | --- |
| 合成 900 条消息（300 轮，含 Markdown 表格 + toolCall），首屏 | 54 行 DOM / 16 ms |
| 同上点一次「加载更早」 | 108 行 DOM，滚动位置保持 |
| 真实 44 轮会话（约 3.7 MB jsonl）切换 | 53 行 DOM；切换 + 渲染 648 ms（含 pi `switch_session` 往返） |
| 同会话加载更早一页 | 93 行 DOM，403 → 323 条剩余 |

DOM 规模与消息总数解耦，分页也能保证「切换会话」不会因为历史极长而卡死。

## 体积

| 项 | 大小 |
| --- | --- |
| 应用源码（当前门禁覆盖 43 个源文件，含 CSS） | 以当前工作区为准，未在本页重新测量 |
| `node_modules` | 402 MB（其中 Electron 本体占大头） |
| 运行时依赖 | `shiki`、`fflate`、`pdfjs-dist`；Electron 仅作为开发/打包依赖 |

## 未覆盖 / 已知偏差

- RSS 是主进程含共享库的粗值，不等于增量内存；Electron 基线本身约 120–150 MB。
- 长会话分页已量化（见上），但未测 1000+ 消息在单页内持续流式追加的帧率与高亮开销。
- 未测流式输出时的帧率与 IPC 压力。
- 冷启动数据是开发模式（`MYNA_DEV=1`，有 watcher），生产模式会略快。
