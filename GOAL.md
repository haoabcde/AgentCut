# AgentCut 长程 Goal（协议路线，2026-09 起生效）

> 本文件是给任何进入本仓库的 Agent（Claude Code / Codex 等）的长程目标。它会跨多个 session 生效：新 session 先读本文件、`docs/19` 当前状态、`docs/11` 最近条目和 `git log`，再继续工作，不依赖对话记忆。

## 北极星

让"任何 AI Agent 安全地驱动任何视频编辑器"成为行业默认能力，AgentCut 协议成为这件事的开放标准（类比 LSP 之于编程语言）。被 fork、被吸收、被写进别人的实现都算赢；不以品牌使用率为目标。

## 任务范围

按 `docs/19-protocol-program-plan.md` 执行 **P1 → P5**（P0 已于 2026-09-06 完成；P6 TalkCut 交接中属于本仓库的部分随阶段顺带完成）。完成的定义是逐阶段 Gate 全部关闭，不是时间消耗或功能数量。

## 自主推进规则

1. **Gate 驱动接力**：每阶段以 docs/19 的 Gate 为唯一完成标准；Gate 关闭后直接进入下一阶段，不需要等待用户确认。
2. **计划是活文档**：每关闭一个阶段就更新 docs/19 的状态；发现计划与现实冲突时，先修订计划（写明理由）再动手，不允许默默偏离。
3. **每阶段结束的固定产出**：更新 docs/11 开发记录 → 本地 commit → 给用户一段可验证汇报（改了什么、跑了哪些测试、什么仍未验证）。
4. **不确定性处理**：优先用最低成本的实验/阅读消除；消除不了的不确定性写入开发记录并在阶段汇报中显式列出，不得掩盖。

## 必须停下请示用户的点（仅此几类，其余自主）

- 把仓库转公开、push 到任何远端、发布 release（**P5 的最后一步必须显式确认**，此前所有发布材料可以准备好待审）；
- 任何读写 `~/Developer/talkcut` 的操作（TalkCut 是独立演进的产品，同构代码极易误伤）；
- 引入 AGPL / GPL / 非商业许可依赖，或变更 MIT 决定；
- 发现 OpenChatCut / OpenCut 等已使独立协议定位不成立——执行 docs/19 §6 退路前必须汇报评估；
- 超出 deprecation 政策的协议破坏性变更；
- 需要付费的外部服务或上传用户素材。

## 硬约束（全期有效，违反即返工）

1. **内核只收敛不重写**：timeline-schema / timeline-engine / edit-commands / project-store / agent-client / mcp-server 是护城河，正确性语义只可加强不可削弱。
2. **复用优先 + 许可证滤网**：默认接入并修改现有开源项目（FFmpeg、MCP 官方 SDK、OTIO 官方库等），自建需举证；MIT 内核不得直接依赖 AGPL/GPL 代码，OpenChatCut 只可参考思想。
3. **模型演进免疫**：硬限制只守完整性层（事务、幂等、revision 冲突、审计、源素材不可变）；判断层（启发式候选、固定工作流）做成可绕过的默认工具。协议永远不编码"什么是好剪辑"，写入路径接受任意通过校验的 transaction；扩展走开放 metadata 命名空间，风险/审批策略由宿主经 capability 声明。
4. **口播产品需求不在本仓库实现**（UI、ASR、候选、alpha-gate 归 TalkCut）；本仓库产品层代码是拆分快照，只做减法不做加法。
5. **验证纪律**：`pnpm check` 全绿才提交；测试总数只允许增加、减少必须附理由；未验证的能力写"待验证"；失败结果保留并记录。

## 阶段 Gate 速查（与 docs/19 冲突时以 docs/19 为准）

- **P1 内核解耦与参考宿主**：reference-host 独立通过 project-store 全部持久化/崩溃恢复测试；mcp-server 对 reference-host 完成 core 方法 E2E；TalkCut 行为不变。
- **P2 协议硬化与规范**：英文协议规范 v0.1（中英双语）；规范每条契约都有可指向的测试；OTIO 决策 ADR 落盘。
- **P3 一致性套件**：reference-host 与 TalkCut daemon 双双通过 conformance；Codex 与 Claude Code 各完成一次可回放的真实 MCP 剪辑会话。
- **P4 互操作**：基于 OTIO 官方库的导出 + loss report；10 分钟工程 round-trip 结构等价；DaVinci 实测记录。
- **P5 开源发布**：LICENSE(MIT)、英文 README、quickstart 全新机器 15 分钟跑通、OpenChatCut 逐条对比文档——**材料齐备后停下，等用户确认再公开**。

## 成功汇报的格式

每次向用户汇报时按此顺序：结论（Gate 是否关闭）→ 证据（测试数、命令、产物路径）→ 风险与未验证项 → 下一阶段的第一件事。
