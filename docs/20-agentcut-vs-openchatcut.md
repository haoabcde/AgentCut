# AgentCut vs OpenChatCut：协议对比（P5 发布前置文档）

> 对应 docs/19 §3 P5："先克隆 OpenChatCut 逐条读 schema，纠正 docs/18 中未验证的假设后再发布"；docs/19 §6 风险表"若发现其协议已足够通用，重新评估'独立协议'是否仍成立"。
>
> 对象：`0xsline/OpenChatCut`，克隆于 commit `19cba6e1a70a3e589545ce02de975f6494c918f6`（v0.2.14，2026-09-04），AGPL-3.0-or-later。本文所有 OpenChatCut 事实均给出对方仓库内 `文件:行号` 引用；AgentCut 事实给出本仓库 `文件:行号` 或协议规范条款。对比日期：2026-09-06。

## 1. 一句话定位

- **OpenChatCut**：一个开源 AGPL AI 视频编辑器（Electron + React + Remotion），其"对外协议"是**这个编辑器的 MCP 工具面**——Agent 驱动 OpenChatCut 很好，但工具语义、草稿会话、审批门禁都与自家 EditorCore 和浏览器 UI 绑定。
- **AgentCut**：一个**不绑定任何编辑器**的开放协议（时间线 IR + 命令协议 + 参考宿主 + 一致性套件）——任何宿主实现协议、任何 Agent 驱动宿主，编辑器只是宿主的一层。

两者在"Agent 安全驱动视频编辑"问题上高度同构（draft 隔离、原子提交、revision 并发控制、审计），但**产品形态不同**：一个是带开放 API 的编辑器，一个是编辑器无关的协议标准。独立协议定位**成立**，依据见 §6。

## 2. docs/18 假设修正（对抗性核实结果）

docs/18 §对比表称 OpenChatCut "协议私有、绑自家 UI、无 schema 迁移/审计"。逐条克隆核实后：

| docs/18 假设 | 核实结果 | 证据 |
|---|---|---|
| 无 schema 迁移 | **不成立**：有完整的持久化文档迁移 runner（v1→v3 + 开发期版本合并） | `src/persist/migrations/index.ts:21-131`；`migrateProjectDoc` 是唯一持久化边界（`src/persist/projectStore.ts:94-97`）；`CURRENT_PROJECT_VERSION = 3`（`shared/project-version.ts:2`） |
| 无审计 | **部分不成立**：有 per-project 外部提案记录、agent 变更日志（回滚窗口守卫）、run ledger（含 `stale/aborted_before_side_effect/outcome_unknown/terminal_failure` 结果分类）、一次性审批门禁（consume-once） | `src/persist/externalProposalStore.ts:15-38`；`src/agent/changeLog.ts:6-47,82-84`；`src/agent/external-run-ledger.ts:38-89`；`src/agent/external-approval-gate.ts:38-82`。但**无跨会话的 actor 身份审计**——变更日志按 agent 会话而非用户身份记账 |
| 绑自家 UI | **大体成立（约 85% 工具）**：浏览器模式是主路径，MCP 服务器只排队调用，由已连接编辑器长轮询结算；但存在离线服务端直连子集（7 读 + 15 编辑工具），数据面操作可脱离其 UI | `server/external-agent/broker.ts:290-416`；`server/external-agent/offline-tools.ts:57-64`；`src/agent/external-tool-policy.ts:85-91`（新工具默认 browser-only） |

另：网上流传的工具清单（`project_read`/`timeline_edit`/`media_manage`/`effect_apply`）**在代码中不存在**，实际面为 5 控制工具 + 6 会话工具 + 浏览器注册的 ~113 编辑器工具（`assets/agent/openchatcut-tool-schemas.json`），并带渐进披露（ToolSearch/load_skill + `tools/list_changed`，`server/external-agent/mcp-tool-exposure.ts:37-57`）。

## 3. 协议机制逐项对比

| 维度 | OpenChatCut | AgentCut | 评估 |
|---|---|---|---|
| IR 规范形态 | `ProjectDoc` v3，TS 类型 + 运行时 normalizer，无独立规范文档、无 JSON Schema | Timeline IR 0.1 有 JSON Schema（`packages/timeline-schema/schema/`）+ 迁移（`migrate.ts`）+ 版本化政策 | AgentCut 的 IR 是"可被第三方实现的契约"；OpenChatCut 的 IR 是实现细节 |
| 时间语义 | 整数帧（项目 fps 为准），秒/毫秒只在工具边界出现 | 有理数 `value·denominator/numerator`（微秒 canonical 读） | 等价能力；AgentCut 表达 NTSC 类非整帧率更精确 |
| 传输 | Streamable HTTP only（`server/external-agent/mcp.ts:394-404`），无 stdio | HTTP（core 面）+ MCP stdio（16 工具）| AgentCut 多一种本地嵌入路径 |
| 认证 | 单一静态 Bearer token（env 或 `~/.openchatcut/mcp-token`，timing-safe 比较；`server/editor-auth.ts:46-48`） | bootstrap token → 限时、capability 范围化、可撤销 session；路由级 capability 门禁（`apps/reference-host/src/server.ts:154-161`） | AgentCut 有 per-agent 最小权限与撤销；对方单 token 全权 |
| 并发控制 | 内容哈希 revision `v{version}-{fnv1a}`；drift 即以 `stale` 取消在途调用；`expectedRevision` 守卫提交（`server/external-agent/external-edit-session.ts:69-93`；`broker.ts:146-152`） | 整数 revision + `REVISION_CONFLICT`；重放语义：同键同载荷返回原结果（`packages/project-store/src/project-store.ts:1159-1170`） | 同构；内容哈希 revision 是值得借鉴的检测面（见 §5） |
| 幂等 | 上传收据 claim/commit/abort 幂等（`import-token.ts:233-325`）；rerun 拒绝歧义前缀；审批一次性消费 | 一切写路径统一 idempotencyKey + `x-agentcut-request-id`；同键异载荷 `IDEMPOTENCY_CONFLICT`（§7.4） | 双方都认真做了幂等；AgentCut 覆盖面统一、协议级强制 |
| 原子提交 | approve 时单次重放 store actions + 失败回滚 + 提交前自动快照（`external-proposal-apply.ts:127-175`） | 事务原子（混合有效/无效操作不部分生效，conformance 钉住） | 等价 |
| 错误模型 | `{outcome: rejected\|cancelled\|stale\|failed, message}` + 每工具恢复策略；不可逆/付费工具永不自动重试（`mcp-result.ts:53-64`；`execution-policy.ts:8-18`） | 机器可读错误码 + 一个错误模型（规范 §9），conformance 钉住 | 双方相近；对方的 per-tool 恢复策略分类（`pure/idempotent/resume/outcome_unknown`）值得吸收 |
| 崩溃恢复 | 每调用 draft checkpoint、孤儿会话恢复声明（单 claimer）、跨重载提案存储（`edit-session-ownership.ts:74-114`） | SQLite WAL + 重启后 revision/幂等账本/diff 存续（conformance crash 检查） | AgentCut 恢复验证是协议级的（任何宿主必须过同一检查） |
| 一致性验证 | 自有 verify 脚本矩阵（真实 MCP SDK 客户端，`verify:mcp`），但不对外发布 | `@agentcut/conformance`：23 检查、逐条挂规范条款、机器可读报告、第三方宿主可直接运行 | **核心差异**：AgentCut 的"协议正确"是第三方可独立验证的 |
| 宿主可移植性 | 工具面即产品面；新工具默认 browser-only | IR + 协议 + conformance 独立于任何编辑器；OTIO 边界适配（loss report + round-trip 自验证） | 核心差异 |

## 4. OpenChatCut 做得好的地方（AgentCut 应当吸收，clean-room）

按 docs/18 行动项"直接吸收其已验证设计"：

1. **渐进式工具披露**：boot 集 9 工具 + ToolSearch/load_skill 按需激活 + `tools/list_changed`（`mcp-tool-exposure.ts:37-57`）。AgentCut 0.1 仅 16 工具暂不需要，但协议扩到几十个工具时应采用同款模式（可作 0.2 候选条款）。
2. **per-tool 恢复策略与不可逆工具禁自动重试**：`ToolEffect` 四分类 + `ToolRecoveryPolicy` 四分类（`execution-policy.ts:8-18,51-54`）。AgentCut 的导出类扩展工具应显式声明 `outcome_unknown` 语义（与现有"导出取消后用 get 查询同一 job"的产品层实践一致，可协议化）。
3. **审批一次性消费**：确认绑定 session+run+tool+args digest，用后即焚，"Historical approvals never restore access"（`external-approval-gate.ts:38-82`）。AgentCut 审批域在宿主扩展侧（规范 §10/§11），该绑定方式可写进扩展规范建议。
4. **revision-drift 即取消在途调用**：并发变化时以 `stale` 主动取消 broker 在途调用（`broker.ts:146-152`），比"提交时才发现过期"更早失败。AgentCut 可在 agent-client 层做同款前置检测（可选优化，不改协议）。
5. **内容哈希 revision**：`v{version}-{fnv1a}` 让"内容未变则 revision 不变"成为可检测事实。AgentCut 已有 afterHash 链（§6.5 diff），无需改动；此处仅确认设计殊途同归。

以上均为思想吸收，不复制 AGPL 代码（CONTRIBUTING 的许可纪律）。

## 5. 对方欠缺、AgentCut 定位所依

- 无独立 IR 规范/JSON Schema/公开 conformance kit——第三方宿主无法凭其代码实现"另一个 OpenChatCut 兼容宿主"，也无法独立验证其协议行为；其"协议"事实上是产品 API。
- 无 OTIO 适配；有 FCPXML/EDL/剪映 draft 导出（`src/export/fcpxml.ts:1-4`；`jianying-export.ts:1-4`）但都是单向格式导出，非开放 IR。
- 无协议版本协商（仅 MCP server version "1.0.0" 字符串 + skill baseline 常量，`mcp.ts:60,249-255`）；无弃用窗口政策。
- 单一 Bearer token 全权；无 per-agent capability 范围、无撤销语义的协议化。
- AGPL-3.0：对"想在其上构建闭源/宽松许可宿主"的生态是硬摩擦，也使 AgentCut 不能复用其代码。

## 6. 结论：独立协议是否仍成立

**成立。** OpenChatCut 验证了"Agent 经结构化会话安全驱动时间线编辑"的产品可行性与多数工程语义（draft 隔离、原子提交、revision 并发、幂等恢复），但它没有也不会在可预见版本内提供"不绑定编辑器的、文档化的、可由第三方宿主实现并通过一致性验证的协议"。最坏情形（其协议已足够通用以致独立协议无价值）未发生；docs/18 预设的退路（"转为向其贡献"）因此不需要触发。行动结论：按 docs/19 继续 P5 发布准备；§4 的四项吸收项进入协议 0.2 候选清单（`docs/protocol/versioning.md` 记录的 0.2 议题），发布材料（对比文档、conformance 报告）以此文为准。

## 7. 引用索引

OpenChatCut（commit `19cba6e`）：§2 表内三条 + §3 表内各行 + §4/§5 各条，均已在行内给出 `文件:行号`。
AgentCut：`packages/project-store/src/project-store.ts:1159-1170`（幂等先于 revision）、`apps/reference-host/src/server.ts:154-161,379`（capability 门禁与 actor 强制）、协议规范 §6–§9、`packages/conformance/README.md`（23 检查清单）、`packages/otio-interop/README.md`（OTIO 边界与 loss 分类学）、`docs/protocol/versioning.md`（0.x 弃用窗口）。
