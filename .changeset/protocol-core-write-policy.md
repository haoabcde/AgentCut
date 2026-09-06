---
"@agentcut/timeline-schema": minor
"@agentcut/timeline-engine": minor
"@agentcut/edit-commands": minor
"@agentcut/project-store": minor
"@agentcut/agent-client": minor
"@agentcut/mcp-server": minor
---

协议面：core 新增 `GET /api/agent/project` 与 `POST /api/agent/timeline/transactions`（P1）；工程概要 `capabilities` 增加 `writePolicy.timelineTransactions` 声明（只增兼容变更）。内核：`validateProjectDocument` 新增可选 `extensionValidators` 钩子（向后兼容，宿主侧注册扩展语义校验）。无破坏性变更，无弃用窗口需求。
