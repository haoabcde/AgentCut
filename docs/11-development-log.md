# AgentCut 开发记录

本文件记录已经实际落地的产品、架构和工程变更。每次有效修改都应同步更新，以便后续 Agent 和开发者区分已验证事实、执行假设与待完成事项。

## 2026-07-18：建立仓库级开发记录制度

### 目标

让开发历史成为版本化资产，避免计划、实现和验证状态在多轮 Agent 协作中失真。

### 实际改动

- 新增根目录 `AGENTS.md`，要求每批有效修改同步维护本文件。
- 在 README 文档索引中加入开发记录入口。
- 更新 `.gitignore`，避免提交本地 pnpm store、依赖目录、构建产物、覆盖率和日志。
- 准备将现有工作区初始化并发布为 GitHub 私有仓库。

### 验证

- 核对规则覆盖代码、测试、架构、依赖、配置和产品文档修改。
- GitHub 私有仓库创建与首次推送将在授权恢复后单独核验。

### 限制与后续

- 开发记录依赖提交者遵循仓库规则；后续可增加 CI 检查，验证功能提交是否同步触及本文件。

## 2026-07-18：SQLite 持久化与进程崩溃恢复 Gate

### 目标

把内存事务原型推进为可重启、可审计、无半提交的最小持久化实现。

### 实际改动

- 新增 `@agentcut/project-store`，使用 SQLite WAL、`BEGIN IMMEDIATE` 和 `synchronous=FULL`。
- 将 command、inverse、idempotency payload hash、current state 和 checkpoint 放入同一事务。
- 支持重启后 snapshot、history、undo、idempotent replay 与 genesis-to-head hash 验证。
- 新增真实子进程 `SIGKILL` harness，覆盖 begin、apply、command insert、state update、checkpoint、commit 前和 commit 后边界。

### 验证

- `pnpm check` 通过；4 个 workspace package 构建与严格类型检查通过，共 23 项测试通过。
- commit 前六个死亡点均恢复到 revision 0 且无 command；commit 后死亡恢复到 revision 1 且 command 可 replay。
- 两个数据库连接基于相同 revision 写入时，首个提交成功，第二个得到显式 `REVISION_CONFLICT`。

### 限制与后续

- 尚未覆盖真实断电、磁盘写满、WAL 字节损坏和长项目规模。
- migration runner、未知 major 只读保护和全部 operation 混合 replay 仍属于下一数据正确性 Gate。

## 2026-07-17：产品与技术验证基线

### 目标

在开发完整编辑器前，先定义 AgentCut 的产品边界并验证 Timeline IR、精确时间和受控编辑事务是否成立。

### 实际改动

- 完成调研、产品定义、总体架构、Timeline IR、Agent 接入协议、口播/访谈工作流、路线图和风险审查文档。
- 建立 Timeline IR 0.1 JSON Schema、TypeScript 领域类型和 golden fixture。
- 实现 BigInt rational 精确时间运算、半开区间语义与显式 rounding mode。
- 实现 typed edit operations、revision/precondition/semantic lock、inverse、undo 和内存幂等事务。

### 验证

- Golden fixture、结构语义验证和精确时间测试通过。
- 1,000 组随机 trim/inverse round-trip 通过。

### 限制与后续

- 当时的事务仅在内存中验证，不能证明跨进程恢复可靠性；该缺口已在 2026-07-18 的最小 SQLite Gate 中推进。
- 浏览器预览、FFmpeg parity、中文 ASR benchmark 与 MCP contract 尚未开始实测。
