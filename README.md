# AgentCut

AgentCut 是一个正在规划中的、本地优先的 Agent 原生视频剪辑工具。外部通用 Agent 通过 MCP、CLI 或 SDK 进行分析和结构化编辑；本地 Web 编辑器负责预览、Transcript、多轨时间线、人工修改、版本与导出。

当前已完成产品/技术基线，并进入技术验证：仓库包含可执行 Timeline IR 0.1 schema、精确时间运算、typed transaction/冲突/语义锁/撤销内核，以及 SQLite WAL 持久化与进程级 crash-injection harness，但不包含完整编辑器。推荐先验证中文知识口播：自动修改必须可解释、可撤销、可审计，用户锁定内容不能被 Agent 擅自覆盖。

## 推荐架构

- 自有、版本化 Timeline IR 是唯一领域真相。
- TypeScript 主控制面，Python 分析 worker，FFmpeg 最终渲染。
- 本地 daemon 是唯一写入者；Web、MCP、CLI 共用 command/transaction 协议。
- OpenTimelineIO 只用于交换；Remotion 和浏览器编辑引擎均为可替换 adapter。
- V0.1 聚焦中文口播，访谈切片在 V0.3。

## 文档

1. [调研报告](./docs/01-research.md)
2. [产品定义](./docs/02-product-definition.md)
3. [总体架构](./docs/03-architecture.md)
4. [Timeline IR 草案](./docs/04-timeline-ir.md)
5. [Agent 接入协议](./docs/05-agent-protocol.md)
6. [中文知识口播工作流](./docs/06-talking-head-workflow.md)
7. [中文访谈切片工作流](./docs/07-interview-workflow.md)
8. [实施路线图](./docs/08-roadmap.md)
9. [对抗性风险审查](./docs/09-risk-review.md)
10. [技术验证进展与决策记录](./docs/10-technical-validation.md)
11. [开发记录](./docs/11-development-log.md)

## 下一步

继续完成数据正确性 Gate：扩展全部 operation 的数据库 replay/property test，并补齐 migration fixture、未知 major 只读保护和长项目恢复测试；随后推进中文口播 gold benchmark、浏览器预览 adapter 赛马、FFmpeg parity fixtures，以及 Codex/Claude Code/OpenCode 的 MCP contract test。通过 Gate 前不开发完整时间线 UI、访谈、多 Provider 大全、桌面壳或云端。
