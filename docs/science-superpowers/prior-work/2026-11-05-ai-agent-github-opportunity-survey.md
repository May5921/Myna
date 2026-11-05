# AI Agent 工具机会地图：先验调研笔记

## 已知生态

- GitHub 的 2025 Octoverse 报告显示，AI 相关仓库已超过 430 万，公开仓库中使用 LLM SDK 的数量增长显著；六个增长最快的十个项目属于 AI 基础设施。2026 报告进一步显示，带 Agent 配置文件的新仓库平均提交量约为没有该文件仓库的 8 倍，超过 40% 的 Pull Request 在 2026 年 9 月由 Agent 开始。这说明 Agent 工具仍是高活跃方向，但不说明任一新产品会成功。
- Langfuse、DeepEval、OpenTelemetry GenAI semantic conventions 等已经覆盖追踪、评测、提示管理和标准化事件。重复做一个通用观察面板或全量评测平台，差异化不足。
- GitHub 官方将 Star 描述为方便以后找回仓库的收藏和兴趣信号。增长判断需要配合 clone、下载、Fork、外部贡献者、Issue/PR 和发布后重复使用信号。

## 反复出现的痛点

1. Agent 失败的首错位置、根因和恢复步骤难以定位；现有工具多停在记录轨迹。
2. 不同框架、MCP server、CLI 和宿主之间的工具配置、启动和能力发现不可靠。
3. 权限审批、工具滥用、供应链和间接 Prompt Injection 使 Agent 难以安全上线。
4. 长上下文压缩会丢失任务状态、决策和验证检查点，工具与指令会争夺有限上下文。
5. 工具循环可能不收敛，重复调用和重试会烧掉 token 与时间。
6. 现有评测常只看最终成功率，忽略环境、部署、成本、延迟、人工介入和组件归因。
7. 多 Agent 的生命周期、Heartbeat、取消和共享工件同步仍不稳定。

## 可用的公开证据

- [Stack Overflow agent systems empirical study](https://arxiv.org/abs/2510.25423)：将问题归纳为运行时集成、依赖管理、编排复杂度和评测可靠性等七大类、77 个技术挑战。
- [AgentDebugX](https://arxiv.org/abs/2607.18754)：将 Agent 调试明确为 Detect → Attribute → Recover → Rerun 闭环，指出只记录轨迹不能完成根因归因与恢复。
- [OpenTelemetry GenAI agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)：定义 Agent、工作流、计划、工具、技能等 span，但规范仍在演进，且工具参数和结果可能包含敏感数据。
- [Agent injection benchmark](https://github.com/sentinelden/agent-injection-bench)：发布可复现数据集、测试 harness 和评分规则，说明安全问题可以被包装成可分享的 GitHub 工件。
- [Langfuse](https://github.com/langfuse/langfuse) 和 [DeepEval](https://github.com/clearsky-ai/deepeval)：说明通用可观测性和评测已有强竞争者。

## GitHub 原生增长的已知模式

- 首次成功路径本身是传播单元：安装、首个命令和可见结果应能在 15 分钟内复现。
- 可复跑、可外链、可 Fork 的结果资产比功能清单更有传播价值，例如排行榜、Benchmark YAML、Trace、Dataset、评测报告和 CI 回归结果。
- 插件、Skill、MCP 或模板目录能把贡献变成可安装资产，但需要可验证元数据和审核流程。
- 多入口适配可以扩大分发面，但会快速增加维护矩阵。
- 高频发布能缩短贡献反馈回路，但发布频率本身不能证明持续价值。

## 方法与限制

本轮是探索性先验调研，不估计 TAM、付费意愿或成功概率。公开 Issue 可能受少数高活跃用户和版本热点影响；Star 可能只是收藏；论文、仓库自述和案例页存在选择偏差。下一轮应对候选方向做固定时间窗口的公开信号快照，并把所有方向的结果一起报告。

## 初步判断

最值得验证的是“跨运行时可复现、可审计、可 Fork 的 Agent 工件”，尤其是 Replay Capsule 与 Trajectory Mutation Eval 的窄组合。能力锁文件、Skill 验证和记忆投毒治理是相邻方向；通用 Agent 框架、纯观察面板和普通 Memory DB 暂缓。
