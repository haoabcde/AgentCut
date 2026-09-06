# AgentCut 版本化与破坏性变更政策（0.x）

> 关联：docs/protocol/agentcut-protocol-0.1.md §4（版本化）、`.changeset/`（执行工具）、GOAL.md（停下请示项之一：超出本政策的破坏性变更）。

## 1. 版本对象

两层版本，分别管理：

- **协议版本**（`protocolVersion`，wire 上）：当前 `"0.1.0"`。宿主在 `GET /api/health` 与每个 core 响应中声明；事务请求必须携带。
- **包版本**（npm semver）：内核六包（timeline-schema / timeline-engine / edit-commands / project-store / agent-client / mcp-server）`fixed` 联动发布。协议面变更必须六包同号，避免"半新协议"。

规则：**协议 minor 变化 ⟺ 内核包 minor bump**；纯实现修复（不改 wire 契约）= patch。

## 2. 0.x 期间承诺

- minor 版本**可以**包含破坏性变更，但必须满足 §3 的弃用周期；patch 只允许向后兼容修复。
- 1.0 在 docs/19 §0 的四条北极星终点达成前**不发布**；1.0 之后进入只增不毁的兼容期。

## 3. 弃用周期（deprecation policy）

对 wire 契约的任何破坏性变更（路由语义、请求/响应必填字段、错误码、capability 语义、事务操作语义）：

1. **公告版（N）**：文档标注 deprecated + 实现同时接受新旧两种形态；旧形态在响应中附加机器可读提示（`deprecations` 字段，见协议规范 §4 预留）。
2. **过渡版（N+1 及以后，至少一个 minor）**：宿主继续接受旧 protocolVersion 的同路由请求；Agent 实现有完整窗口迁移。
3. **移除版（≥ N+2 的 minor）**：旧形态移除，宿主对旧请求返回机器可读错误（`410` 或 `400 INVALID_REQUEST` 带 `supportedProtocolVersions` 详情）。

例外（无需弃用窗口，但须记 changeset）：

- 新增路由、新增可选字段、新增错误码详情字段（向后兼容的"只增"变更）。
- 明确标注为 draft/experimental 的扩展命名空间。

超出本政策的破坏性变更（如：无弃用窗口直接移除 core 路由、修改审计哈希语义）**必须先停下请示用户**（GOAL.md）。

## 4. Changesets 工作流

- 任何触及协议面或内核包的改动，提交时附 `.changeset/*.md`：说明协议面影响（core/扩展/无）、破坏性、弃用窗口。
- `pnpm changeset version` 只在发布前执行（P5）；平时不消费 changeset，仅积累。
- `changelog: false`：变更说明以 changeset 原文为准，发布时由维护者汇总进英文 release notes。
