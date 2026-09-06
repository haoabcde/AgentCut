---
"@agentcut/timeline-schema": minor
"@agentcut/timeline-engine": minor
"@agentcut/edit-commands": minor
"@agentcut/project-store": minor
"@agentcut/agent-client": minor
"@agentcut/mcp-server": minor
---

协议面（只增兼容）：core 新增 `GET /api/agent/timeline`（规范 §6.4）——分页时间线结构读取，让 Agent 无需宿主私有知识即可发现 transaction 可寻址的对象 ID；支持 sequenceId/fromMicros/toMicros 窗口与 offset/limit 分页，capability `project:read`。reference-host 与 daemon 双实现，agent-client 新增 `timeline()`，MCP 新增 `agentcut_timeline_get` 工具。原 diff 小节顺延为 §6.5。无破坏性变更。
