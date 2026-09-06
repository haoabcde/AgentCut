# Changesets

本目录由 [@changesets/cli](https://github.com/changesets/changesets) 管理协议包的版本演进。

约定（与 docs/protocol/versioning.md 一致）：

- 内核六包（timeline-schema / timeline-engine / edit-commands / project-store / agent-client / mcp-server）`fixed` 联动：协议面任何变更，六包同号发布，避免出现"半新协议"。
- 0.x 期间 minor 可含破坏性变更，但必须先经 deprecation 周期（见 versioning.md §3）；patch 只允许兼容修复。
- 所有包 `access: restricted`（private 标记保留）；转公开发布属于 P5，需用户显式确认。
- 写 changeset 时说明：协议面影响（core/扩展/无）、是否破坏性、弃用窗口。
