# Myna 验收矩阵

这份矩阵只记录当前工作区已经拿到的证据。`代码核对` 不等于 `实机通过`，`Electron E2E` 也不等于真实模型调用。

| 范围 | 当前状态 | 证据 | 仍缺什么 |
|---|---|---|---|
| pi-only 运行时 | 已证实 | `npm test` 中的运行时边界契约；只读 pi RPC 探针返回 state / 40 models / 47 commands | 无产品边界缺口；需保持回归 |
| 会话、工作区、恢复 | 已增强 | 全量 Electron E2E 17 个场景；断言数随本地历史数据变化，本次为 136；session epoch、工作区失败回滚、首轮 session 指针同步 | 真实用户切换与崩溃后的人工确认 |
| 流式、思考、工具、队列、右栏、附件 | Electron 已证实 | 全量 E2E、99/99 单测、真实 DOM 断言 | Myna UI 的真实 reasoning 回合 TPS 与思考展示 |
| 首次成功引导 | Electron 已证实 | onboarding E2E；进程退出、provider error、aborted 均有失败路径 | 一次真实模型测试消息 |
| 真实 pi 回合 | 直接 RPC 已证实 | `MYNA_REAL_TURN=1 node scripts/real-turn-probe.mjs`；活动会话追加 `只回复 ok` → `ok`，`stopReason=stop`，`agent_settled` 正常 | 本次无 thinking 内容；尚未从 Myna renderer 记录 TPS |
| 本机终端与文件工作流 | Electron 已证实 | terminal、rightpanel、doc、attach、realHistory 场景 | 托盘、外链和系统程序打开的人工回归 |
| 诊断与错误恢复 | 代码 + Electron 已证实 | pi stderr 脱敏摘要、process_exit、重启提示、诊断复制；crashRecovery 场景 | 真实 provider 错误样本 |
| 安装与分发 | 已构建 | 便携版、160 MB zip、123 MB NSIS；包内代码已核对 | 代码签名、真实安装/卸载体验 |
| 更新 | 代码核对 | GitHub Release 选择、SHA256 校验、用户触发安装、流式期间阻止安装 | 真实 Release 资产下载与安装 |
| 回滚 | 文档已建立 | `docs/ROLLBACK.md`；发布失败恢复版本文件和暂存项 | 形成一个可回滚提交 |
| 发布 | 未完成 | 版本 0.1.1 本地构建成功 | 干净工作区、签名凭据、正式 Release |

## 当前硬缺口

1. Myna renderer 的真实 reasoning 回合：直接 pi 回合已完成，但本次没有 thinking 内容；仍需从 Myna UI 记录首 token、thinking 和 output tok/s。
2. Windows 桌面人工路径：托盘收起/恢复、退出确认、外链、会话切换、归档撤销、安装卸载。
3. 分发信任：安装包当前 `NotSigned`，尚无真实签名凭据。
4. 可发布状态：工作区仍有未提交 WIP，不能运行正式 release。
