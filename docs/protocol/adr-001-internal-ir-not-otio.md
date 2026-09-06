# ADR-001：内部 IR 不采用 OTIO（OTIO 只作为边界互操作 adapter）

- 状态：Accepted（2026-09-06）
- 关联：docs/18 §3–4（轻量化与模型演进免疫）、docs/19 §1/§2.1（复用优先）、docs/04（Timeline IR 草案）、docs/protocol/agentcut-protocol-0.1.md（协议规范）

## 背景

AgentCut 的核心是一套供 AI Agent 驱动的时间线状态机：validated document + 原子事务 + revision/幂等/审计 + capability session。OpenTimelineIO（OTIO）是业界最成熟的时间线交换格式（Apache-2.0 官方库，Python/C++ 生态），其 v0.16 已加入实验性 edit commands。策略复盘（docs/18）因此要求公开回答：**为什么核心 IR 不直接用 OTIO + 扩展？**

按复用优先政策（docs/19 §2.1），"自建"是例外、需要举证。本 ADR 即该举证。

## 决策

**内部 IR（`@agentcut/timeline-schema` 的 Timeline IR 0.1）是唯一真相源；OTIO 只出现在仓库边界，作为 adapter（导出优先，附 loss report），使用官方 Apache-2.0 库实现，不 vendored、不 fork。**

## 论证

1. **协议层需要的是状态机，OTIO 提供的是交换格式。** OTIO 的核心产物是可序列化的时间线文档与读写库；AgentCut 内核的产物是"文档 + 事务日志 + 反向操作 + 审计哈希"的整体。事务原子性、revision 绑定、幂等重放、崩溃恢复（WAL 单写者）这些完整性语义在 OTIO 中不存在——v0.16 的实验性 edit commands 恰好证明社区也认为这是缺口。若以 OTIO 为真相源，这些语义仍须自建，且要寄生在别人的对象模型上，等于 fork OTIO 的演进节奏（正是 docs/19 §2.1 排除的做法）。

2. **审计要求确定性规范化，这部分必须自主可控。** 审计链的核心是 `beforeHash`/`afterHash` 与"genesis-to-head 重放哈希一致"。这要求文档规范化序列化完全确定、由我们定义、随协议版本冻结。依赖外部库的序列化顺序变化会静默破坏审计链。

3. **校验与扩展机制不同构。** AgentCut 的开放 metadata 命名空间 + 宿主侧 extensionValidators（协议规范 §10）需要"未知命名空间对 core 不透明、语义校验由宿主注册"的分层。OTIO metadata 是自由 JSON，但其 schema 校验体系并不提供"命名空间级插件校验"的等价物；靠 OTIO 实现等价机制仍是在改造它而非复用它。

4. **语言与运行时错配。** 内核是 TypeScript/NodeNext 严格类型工作区；OTIO 官方实现是 Python/C++（社区有 JS 绑定但非官方主线）。把内核真相源绑定到非主线绑定的稳定性风险，高于维护一个边界 adapter。

5. **OTIO 的定位验证而非否定本决策。** OTIO 是 NLE 之间的交换标准，专业 NLE 互操作（DaVinci 等）走 OTIO adapter 是正确路径（docs/18 §3 行动项）；docs/04 的 IR 在时间语义上（有理数、半开区间、显式取整）与 OTIO RationalTime 同构，双向映射是有损有限的、可清点的。

## 后果

- 正面：内核保持零外部状态模型依赖；完整性语义与审计确定性自主可控；OTIO 复用以最低摩擦方式满足（官方库、导出优先、loss report）。
- 代价：OTIO adapter 是长期维护面；每次 IR 演进需同步 adapter 映射表；loss report 必须逐字段诚实披露（不可映射项显式列出，禁止静默丢弃）。
- 重估触发条件：OTIO edit commands 转正并提供 JSON Schema 校验 + 确定性规范化 + 事务/审计等价物时，重新评估将事务层上移到 OTIO；或出现维护良好的官方 TS 实现时，重新评估 adapter 实现方式。
