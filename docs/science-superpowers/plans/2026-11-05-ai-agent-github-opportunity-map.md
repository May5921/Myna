# AI Agent GitHub Opportunity Map Analysis Plan

> **For agentic workers:** REQUIRED SUB-SKILL: pre-register this plan with science-superpowers:preregistering-analysis BEFORE execution. Then use science-superpowers:subagent-driven-analysis (recommended) or science-superpowers:executing-analysis to run it step-by-step. Steps use checkbox (`- [ ]`) syntax for tracking.

**Question:** 面向 AI 开发者 / Agent 工程师，哪些尚未被充分满足的高频痛点最适合做成可演示、可复制并能形成 GitHub 自传播循环的开源工具？

**Design:** 探索性、多来源公开证据调查；以候选工具机会为单位，固定评分维度和时间窗口，不做因果推断。

**Data:** GitHub 仓库和 Issue/Discussion/PR、官方文档、公开论坛、论文与项目发布页；每个候选机会保存来源 URL、访问日期、证据摘录、反例和证据等级。

**Primary analysis:** 对 5–10 个候选机会按预先固定的五个维度 0–5 评分：痛点证据 30%、首次成功可行性 20%、可分享工件 20%、生态贡献面 20%、持续使用信号 10%。

**Decision rule:** 只有同时满足“至少 3 个独立公开来源支持痛点”“15 分钟内可演示”“至少一个可独立分享或 Fork 的工件”“2–4 周可完成本地 MVP”才进入首攻候选；最终只在满足条件的方向中选证据总分最高者，并报告所有并列和不满足者。

### Task 1: 固定候选方向和搜索词

**Artifacts:**
- Create: `docs/science-superpowers/evidence/2026-11-05-candidate-register.md`
- Reads: question document and prior-work note
- Writes: candidate IDs、搜索词、排除规则

- [ ] 列出 10 个候选方向，覆盖调研发现的失败归因、MCP 诊断、权限漂移、上下文检查点、循环止损、评测工件、Memory 治理和 Skill 供应链。
- [ ] 为每个候选锁定同一组搜索词和同一观察窗口，禁止根据结果临时替换候选。
- [ ] 记录排除通用 Agent 框架、纯 Dashboard、普通 Memory DB 的理由。

### Task 2: 采集公开证据

**Artifacts:**
- Create: `docs/science-superpowers/evidence/2026-11-05-source-snapshot.jsonl`
- Reads: public URLs only
- Writes: one JSON object per source with candidate ID, source type, date, URL, evidence excerpt, and counterevidence

- [ ] 对每个候选至少采集三个独立来源，其中至少一个是 Issue/Discussion/论坛中的用户问题，至少一个是实现或规范来源。
- [ ] 记录项目自述与独立证据的区别，禁止把仓库 README 的愿景直接当作用户结果。
- [ ] 记录当前的安装步骤、首个成功输出、凭据要求和可分享产物。

### Task 3: 评分与稳健性检查

**Artifacts:**
- Create: `docs/science-superpowers/evidence/2026-11-05-opportunity-scores.csv`
- Writes: fixed 0–5 scores, rationale, missing evidence, and confidence

- [ ] 由两次独立阅读分别评分同一候选，再记录分歧；不以“星标最高”替代综合评分。
- [ ] 对每个方向写一个最强反例，说明如果反例成立会使哪一项降分。
- [ ] 做一次“删除最强单一来源”的敏感性检查，并报告排序是否改变。

### Task 4: 形成机会地图和首个验证实验

**Artifacts:**
- Create: `docs/science-superpowers/reports/2026-11-05-ai-agent-github-opportunity-map.md`
- Writes: 5–10 个候选、证据等级、首攻方向、暂缓理由和 2 周 MVP 验证任务

- [ ] 为首攻方向写出一个不依赖付费 API、真实用户数据或生产部署的本地演示。
- [ ] 定义首个验证实验的通过条件：安装成功、15 分钟首个结果、可脱敏导出、可重复运行、可被 GitHub Action 调用。
- [ ] 将全部候选及其不确定性一起报告，不把探索性排序写成成功承诺。
