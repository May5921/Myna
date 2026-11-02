# 性能体检（开源前基线）

测量环境：Windows 11，Electron 45，`PI_MINI_DEV=1`，冷启动一次 + 空会话。
数据来源：`C:\Users\Luke\AppData\Local\Temp\pi-mini.log` 的 `[perf]` 行与 `shot.request = perf`。

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

## 体积

| 项 | 大小 |
| --- | --- |
| 自有源码（16 个文件） | 278 KB / 7587 行 |
| `node_modules` | 402 MB（其中 Electron 本体占大头） |
| 运行时依赖 | 仅 `electron`（dev）+ `shiki` |

## 未覆盖 / 已知偏差

- RSS 是主进程含共享库的粗值，不等于增量内存；Electron 基线本身约 120–150 MB。
- 未测长会话（1000+ 消息）滚动与高亮开销；懒高亮已有，但未量化。
- 未测流式输出时的帧率与 IPC 压力。
- 冷启动数据是开发模式（`PI_MINI_DEV=1`，有 watcher），生产模式会略快。
