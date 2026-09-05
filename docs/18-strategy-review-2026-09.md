# 战略复盘 2026-09：协议定位、轻量化与模型演进免疫

> 触发：TalkCut 拆分（2026-09-02）后 AgentCut 需要重新回答"我是谁"；用户提出是否应基于现有开源视频架构（OpenShorts、video-talkcraft 等）重建。本文记录 2026-09-06 的前沿调研结论与由此确定的战略方向。竞品 stars/活跃度为该日抓取快照，会随时间变化，不作为长期依据。

## 1. 结论

**不推倒重建，不 fork 任何开源项目做底座；重构的是产品的存在形态，不是代码底座。**

- 已建成的内核（timeline-schema / edit-commands / project-store / agent-client / mcp-server，约 3.4 万行 TypeScript、429 项测试）覆盖的事务、幂等、崩溃恢复、revision 冲突语义，是全部竞品都不具备且最难复制的资产。fork 任何开源编辑器等于用这份正确性去换别人的 star 数。
- 7 月调研（docs/01）"不自研就没有 IR"的前提已部分失效：OpenChatCut、Pireel 等已开始做"时间线命令层 + Agent 协议"。但它们的协议绑定自家编辑器、无版本化迁移、无审计纪律；**"不绑定任何编辑器 UI 的、文档化的、可校验的时间线 IR + 命令协议"这一位置仍为空**。这才是 AgentCut 的定位。
- Alpha G5 卡在 3/20 授权素材是人工数据瓶颈，换任何架构都解决不了；且口播证据已随产品归属 TalkCut，不再作为 AgentCut 的前进定义。

## 2. 竞品格局快照（2026-09-06）

| 项目 | 形态 | 与 AgentCut 的关系 |
|---|---|---|
| OpenChatCut（~1.6k stars，AGPL-3.0） | 不可变时间线 + 命令层（EditorCore）+ 草稿会话协议，Remotion 预览 + FFmpeg 导出 | **最同构的直接竞品**；协议私有、绑自家 UI、无 schema 迁移/审计 |
| Pireel（~915 stars，部分 AGPL） | 纯浏览器编辑器，画布/时间线/Chat/MCP 共享同一状态 | 同方向，单体产品绑定 |
| video-use（~24.1k stars，MIT） | 转录文本 + 按需视觉抽样 → LLM 输出 EDL → FFmpeg 确定性执行 | 验证了"LLM 不看视频、按文本决策"的成本最优感知路线；无时间线真相源，是粗剪协议 |
| OpenShorts（~3.9k stars，MIT） | 长视频→竖版短片流水线，MCP 只暴露作业级操作 | 无时间线模型，不构成协议层竞争 |
| OpenCut（~8 万+ stars，MIT） | Rust 重写中，MCP server + 无头渲染列为一级特性 | **最大威胁**：若落地将凭体量占据"开源 MCP 剪辑"心智 |
| ChatCut（闭源，$21–25/月） | 对话驱动真实多轨时间线，XML 导出到 Premiere/DaVinci/FCP | 验证了付费市场；闭源、云端、绑自家模型恰是 AgentCut 的反面定位 |
| video-talkcraft（PolyForm 非商业许可） | Remotion 动效包装 Skill（SHOTBOOK + 字级锚点） | 是"生成包装层"不是"剪辑决策层"；商用需授权；注意与 TalkCut 命名混淆 |
| Descript / CapCut / VEED | 截至 2026-09 均无 MCP/Agent 接口 | 巨头未动，开源窗口期真实存在但在收窄 |

关键趋势：业界正向 OTIO/FCPXML 既有标准 IR 靠拢（OTIO v0.16 加入实验性编辑命令），"提案-审阅-原子提交"正成为 Agent 剪辑的共识交互模式——这验证了 AgentCut 的 proposal/review 方向，同时要求公开回答"为什么不是 OTIO + 扩展"。

## 3. 设计原则一：轻量化——站在巨人肩膀上

核心保持小而硬，其余全部是带可替换实现的 adapter。**自研的只有别人做不了的部分，能买/能借的一律不自研。**

| 能力 | 策略 | 说明 |
|---|---|---|
| Timeline IR / 命令 / 事务 / 审计 | **自研（唯一内核）** | 护城河与一致性核心，约 5 个包 |
| 媒体探测/代理/最终渲染 | 复用 FFmpeg | 已有，渲染编译器是唯一命令生成者 |
| 浏览器预览 | 复用 WebCodecs / Remotion Player（adapter 后） | 参考 OpenChatCut 的"Remotion 预览 + FFmpeg 导出"混合模式 |
| ASR/VAD/说话人分离 | Provider adapter（FunASR/Whisper/云） | 已有；模型迭代快，绝不锁定 |
| 专业 NLE 互操作 | 复用 OTIO/FCPXML adapter（导入导出 + loss report） | 不自创第三方格式，也不让 OTIO 成为内部真相源 |
| 动效/程序化合成 | 可选 Remotion 插件 | 不进入 Timeline IR |
| 编辑器产品 UI / 口播业务 | **归 TalkCut 演进** | 从 AgentCut 主干剥离，消除双仓漂移 |

AgentCut 主干收敛为：timeline-schema、edit-commands、project-store、agent-client、mcp-server（含 validate/migrate）。参考宿主可以极薄；重产品表面由 TalkCut 或第三方编辑器承担。

## 4. 设计原则二：模型演进免疫——硬限制只守在完整性上

历史教训：许多 Skill/工具因编码了"当前模型做不到的事"而被模型能力提升淘汰（如补全 prompt 技巧、固定思维链模板）。应用于本项目，必须把设计分成两层：

**物理层（完整性硬限制）——模型再强也不过时，且越值钱：**

- 单写者、事务、幂等、revision 冲突、源素材不可变、undo/redo、审计日志。
- 这些不是"补模型的短板"，是"保证任何写作者（人或 AI）不破坏真相"的物理定律。模型自主性越强，**可验证、可恢复、可解释就越重要**——这是 AgentCut 对抗模型演进的护城河方向，而不是会被吃掉的部分。

**智能层（判断软默认）——会被模型能力吃掉，必须可绕过：**

- 停顿阈值、口头禅表、重复检测启发式、固定粗剪工作流、内置语义分析管线——这些编码的是"当前如何做剪辑判断"，正是最容易被更强模型淘汰的部分。
- 策略：降级为**默认可替换工具/参考实现**。协议不编码"什么是好剪辑"，只编码"任何剪辑决定如何安全、可审计地提交"。

由此得出协议设计的具体要求：

1. **写入路径只有一条，但通过校验的 transaction 内容不设白名单上限**：Agent 可以提交任意合法的 typed operations 组合，而不是只能调用几个罐装工作流（rough-cut generate 等只是便捷入口，不是唯一路径）。
2. **扩展走开放命名空间而非 schema 枚举**：候选类型、分析产物、风格约束等写入 `metadata` 命名空间（借鉴 OTIO metadata 模式），新增判断维度不需要 schema 迁移。
3. **风险/审批策略是宿主声明的配置，不是协议常量**：通过 capability discovery 暴露（"本宿主要求高风险删除需审批"），而不是写死在协议里。TalkCut 的"高风险必须双重确认"是 TalkCut 的产品策略，不是协议的限制。
4. **感知按需拉取，不预消化**：transcript 分页、artifact select、按需视觉抽样（video-use 模式），让模型自己决定看什么、看多少，而不是只给预烤好的候选集。
5. **协议版本化 + 迁移保持严格**——这是模型无法替代、竞品普遍缺失的部分，持续投入。

## 5. 行动项（按优先级）

1. **开源决策（阻塞项，需用户决定）**：协议路线与私有仓库自相矛盾——协议的价值来自被采纳。若走协议路线，核心包应以 MIT/Apache-2.0 开源；若不开源，则协议定位不成立，应改为把 AgentCut 作为 TalkCut 内部模块维护。
2. **OpenChatCut 逐条对比**：克隆仓库读其 schema 与会话协议，产出公开对比文档。直接吸收其已验证设计（draft session 隔离草稿、原子提交为单个 undo、不暴露不可回滚工具）；把 AgentCut 的差异（版本化迁移、验证器、审计、capability session）写成定位资产。
3. **Gate 重构**：Alpha G5（20 授权素材人工听审）整体移交 TalkCut；AgentCut 改用协议级 Gate——真实外部 Agent 经 MCP 完成完整剪辑会话、schema 迁移回归、OTIO round-trip，全部机器可验证，不依赖人工素材。
4. **OTIO/FCPXML adapter + ADR**：实现双向 adapter（导出带 loss report），并写 ADR 公开回答"为什么内部 IR 不是 OTIO + 扩展"。
5. **代码剥离**：制定 studio/asr/candidate-engine/render-engine/alpha-gate 从主干剥离的计划；当前 AgentCut 工作区未 commit 的口播改动先归属清楚（大概率属于 TalkCut）。
6. **对 OpenCut 保持雷达**，不建立依赖；其 MCP 落地时重新评估差异化是否仍成立。

## 6. 风险与未确认

- OpenChatCut/Pireel 均为 2026 年新项目，其协议完备性未深入验证（行动项 2 消除此不确定性）。
- 开源意味着维护与社区成本；单人维护的开放协议有被更大项目（OpenCut）吸收心智的风险——防御点是协议深度而非功能数量。
- 调研快照中部分 stars/commit 数据来自二手聚合站，未经逐一核实。
- 若公开发布 TalkCut，需注意与第三方 video-talkcraft 的命名混淆。
