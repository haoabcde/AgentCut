# 19 AgentCut 协议化重构总体计划

## 0. 大目标（北极星，2026-09-06 确立）

> **让"任何 AI Agent 安全地驱动任何视频编辑器"成为行业默认能力，AgentCut 协议成为这件事的开放标准。**

类比：LSP 之于编程语言（一个协议打通所有编辑器 × 所有语言），OTIO 之于剪辑软件交换。视频剪辑今天处在"LSP 之前"——每个 AI 剪辑产品都在造绑死自家 UI 的私有协议，剪辑能力本该是所有 Agent × 所有宿主编辑器共享的基础设施。

这个大目标用来筛选决策，不是口号。它的可验证终点：

1. **规范冻结**：协议规范发布 1.0，进入只增不毁的兼容期。
2. **多宿主**：≥2 个独立宿主实现通过 conformance 套件（TalkCut + 至少一个非本仓库的实现或 adapter）。
3. **多 Agent**：≥3 个主流 Agent 宿主（Claude Code / Codex / Cursor 级别）经 MCP 零定制完成完整剪辑会话。
4. **被采纳**：至少一个既有开源编辑器或 Agent 项目原生实现或对接本协议（adapter 计入）。

对应的反目标（大目标同样用来排除）：

- 不做编辑器产品的市场份额（那是 TalkCut 和别人的战场）；
- 不做模型、不做云渲染、不做内容平台；
- 不把"AgentCut 品牌被广泛使用"当目标——协议被 fork、被吸收、被写进别人的实现，都算赢。

衡量节奏：以上 4 条全部达成前不宣布 1.0；若 2027 年中仍无第二个宿主实现的迹象，按本文 §6 的退路重新评估（包括向既有项目贡献协议能力）。

> 依据：`docs/18-strategy-review-2026-09.md`（战略复盘）与 2026-09-06 实测的包依赖关系。已决前提：核心包 MIT 开源；不推倒重建、不 fork 外部底座；两条设计原则（轻量化、模型演进免疫）见 docs/18 §3–4；复用优先政策见本文 §2.1。
>
> 时间用相对工程周，只表示依赖顺序与工作量，不是发布日期承诺。

## 1. 终态

```text
AgentCut（MIT 开源，协议仓库）
├── 核心：timeline-schema / timeline-engine / edit-commands / project-store
├── 协议面：agent-client（纯协议客户端）/ mcp-server
├── reference-host：最小参考宿主（无媒体管线，证明协议可独立实现）
├── conformance：协议一致性测试套件（任何宿主实现可跑）
└── interop：OTIO adapter（导出优先，带 loss report）

TalkCut（私有，首个宿主产品）
└── studio / local-daemon / asr / candidate / render / alpha-gate …
    在其 CI 中跑 AgentCut conformance 套件，防止协议漂移
```

第三方编辑器（OpenChatCut、OpenCut 或任何新宿主）可以实现同一协议；AgentCut 不卖编辑器，卖"任何 Agent 都能安全驱动任何宿主"的标准。

## 2. 实测依赖事实（2026-09-06）

- `agent-client` 零内部依赖（纯协议客户端）、`mcp-server` 只依赖 `agent-client`——协议面已经与产品实现解耦，这是最有利的事实。
- `timeline-schema` 零依赖，但**内含产品概念**（`alpha-trial.ts`、`preview-proxy.ts`），是内核解耦的第一对象。
- 产品层（alpha-gate、asr-engine、candidate-engine、media-ingest、render-engine、review-projection、rough-cut-workflow、apps/studio、apps/local-daemon）单向依赖内核，没有反向依赖——**剥离不需要改内核调用方，主要是删除与迁移**。
- 当前 agent-client/MCP 工具面混有口播专有方法（rough-cut generate、semantic analyze/propose 等）——协议分层时必须把"通用协议方法"与"宿主扩展命名空间"分开。

## 2.1 复用优先政策（Adopt-first，2026-09-06 用户确立）

**默认动作是接入别人的开源项目并在此基础上修改，自建是例外、需要举证。** 但"复用"指**作为依赖集成 + adapter 包裹 + 优先向上游贡献补丁**，不是把整个仓库 fork 进来当底座——fork 会让内核继承对方的状态模型与维护节奏，7 月调研已证明没有底座能满足事务/审计语义。

逐层结论：

| 层 | 复用什么 | 自建/修改什么 |
|---|---|---|
| 内核 IR/事务/审计 | **无**（两轮调研确认不存在同时满足事务+审计+协议的项目） | 已有 6 包只收敛不重写，这是唯一自研层 |
| 协议传输 | MCP 官方 TypeScript SDK（已在用） | 仅 schema 绑定 |
| 参考宿主 | 从自身 `local-daemon` 抽取（自有代码复用优先于外部） | 薄壳，无媒体管线 |
| 浏览器预览 | Remotion Player / WebCodecs（置 adapter 后） | 不建 |
| 渲染/自动粗剪执行 | FFmpeg（已在用）；auto-editor 可作为 Agent 可调用的外部工具接入 | 不建渲染器 |
| ASR/VAD/分离 | FunASR / Whisper / SenseVoice / pyannote（已有 adapter 模式） | 不建 |
| OTIO 互操作 | **OTIO 官方库（Apache-2.0）读写，不自写解析器** | 仅 IR↔OTIO 映射 + loss report |
| 镜头检测 | PySceneDetect（TalkCut 侧） | 不建 |
| 演示宿主 UI（若需要） | Twick / OpenVideo 组件（adapter 后） | 不建时间线 UI |
| 一致性测试套件 | 无现成 | 自建——这本身就是差异化资产 |

**许可证滤网**：MIT 内核只直接依赖 MIT/Apache-2.0/BSD/Unlicense 组件；AGPL（OpenChatCut）/GPL 组件只许作为外部进程调用或仅参考思想，**代码不得进入内核**；PolyForm Noncommercial（video-talkcraft）任何商业路径都不可用。每个新依赖进仓库前过此滤网并记入开发记录。

## 3. 阶段计划

### P0 归属清理与冻结（约 1 周）

**交付**

- AgentCut 工作区未 commit 的口播改动全部归属 TalkCut（patch 移交或重放），AgentCut 工作区回到干净状态。
- 逐包核对 TalkCut 副本与 AgentCut 的产品层代码一致（内容 hash 对比），确认删除 AgentCut 侧不丢任何东西。
- 冻结 AgentCut 产品层：自此口播功能只在 TalkCut 演进。

**Gate P0**：`git status` 干净；TalkCut `pnpm check` 全绿且与 AgentCut 产品层无差异；双方 README 写明归属边界。

### P1 内核解耦与参考宿主（约 2–3 周）

**交付**

- `timeline-schema` 摘除 `alpha-trial`、`preview-proxy` 等产品概念（迁往 TalkCut 或转为 metadata 命名空间约定）；schema `$id` 与既有数据键**保持不变**（沿用 TalkCut 拆分时的决定：生产者/校验器不对称改名比保留旧键更危险）。
- 从 `local-daemon` 抽离 `@agentcut/reference-host`：只含 project 生命周期、timeline transaction、version/diff、capability session——**不含**媒体导入、ASR、候选、渲染、导出。它是"协议可以被独立实现"的活证据，也是 conformance 套件的陪跑宿主。
- 协议表面分层：`core.*`（project/timeline/version/diff/capability）与扩展命名空间（`analysis.*`、`candidate.*`、`export.*` 由宿主声明）写进协议规范；agent-client/mcp-server 只内置 core，扩展走通用调用通道。

**Gate P1**：reference-host 独立通过现有 project-store 全部持久化/崩溃恢复测试；mcp-server 对 reference-host 完成 core 方法 E2E；TalkCut daemon 以扩展命名空间方式暴露原有口播方法，行为不变（TalkCut 测试全绿）。

### P2 协议硬化与规范文档（约 2 周）

**交付**

- 按模型演进免疫原则落地四个协议改造（docs/18 §4）：开放 metadata 命名空间、风险/审批策略改为宿主经 capability 声明的配置、写入路径接受任意通过校验的 transaction 组合（罐装工作流降级为便捷入口）、感知按需拉取（transcript 分页/artifact select 已有，补按需视觉抽样接口定义）。
- 《Agent 剪辑协议规范 v0.1》：schema、命令语义、错误码、revision/幂等/冲突契约、会话与审批、版本化与迁移规则。中英双语（英文为主，协议受众是全球 Agent 生态）。
- ADR：为什么内部 IR 不是 OTIO + 扩展。
- 语义化版本与 changesets；`0.x` 期间明确破坏性变更政策。

**Gate P2**：规范文档与实现逐条对账（每个契约条款有可指向的测试）；破坏性变更全部走 deprecation 周期。

### P3 一致性测试套件与真实 Agent E2E（约 2 周）

**交付**

- `@agentcut/conformance`：任何宿主实现可运行的协议一致性测试（事务、幂等、冲突、审批、会话撤销、崩溃恢复语义），输出机器可读报告。
- 真实外部 Agent E2E：Codex 与 Claude Code 各经 MCP 完成一次完整剪辑会话（读工程→分析→proposal→审批→应用→diff 续跑），录为可回放脚本。
- 补齐 2026-08 遗留的真实 Codex 宿主矩阵（原 G3 补跑 runbook，迁至协议语境）。

**Gate P3**：reference-host 与 TalkCut daemon 双双通过 conformance；两个真实 Agent 的 E2E 脚本可重复通过。

### P4 互操作：OTIO adapter（约 2 周）

**交付**

- `interop/otio`：基于 **OTIO 官方库**（Apache-2.0，不自写解析器）实现 Timeline IR → OTIO 导出（首版只导出），附 loss report（哪些 AgentCut 语义无法表达）；OTIO → IR 导入作为第二优先级。
- 导出结果在至少一个真实 NLE（DaVinci 免费版即可）中打开验证。
- FCPXML 明确延后到有真实用户需求时。

**Gate P4**：10 分钟规模工程 OTIO round-trip 的时间线结构等价（loss report 之外零差异）；NLE 实测记录进文档。

### P5 开源发布（约 1–2 周）

**交付**

- MIT LICENSE、英文 README（含 3 分钟 quickstart：reference-host + 任意 MCP 客户端跑通一次提案-审阅-提交）、CONTRIBUTING、安全政策。
- 《AgentCut vs OpenChatCut/Pireel/video-use 协议对比》公开文档（先克隆 OpenChatCut 逐条读 schema，纠正 docs/18 中未验证的假设后再发布）。
- 仓库转公开、首次 tag、发布公告素材（协议动机 + conformance 报告 + 真实 Agent 录屏）。

**Gate P5**：全新机器按 README 15 分钟内跑通 quickstart；对比文档中每条差异都有源码/测试引用。

### P6 TalkCut 交接（与 P1 并行启动，持续）

- G5 及全部口播证据体系归 TalkCut；AgentCut 侧 alpha-gate 随产品层一并剥离。
- TalkCut CI 接入 conformance 套件（P3 交付后），作为"首个第三方宿主"长期验证协议。

## 4. 总量与顺序

P0(1) → P1(2–3) → P2(2) → P3(2) → P4(2) → P5(1–2)，约 **10–12 个工程周**；P6 并行。P4 可与 P3 互换，但开源发布（P5）必须在规范文档、conformance、对比文档齐备之后——空壳发布会浪费唯一的"首次亮相"。

## 5. 明确不做

- 不重写内核、不换语言、不引入 Rust。
- 不做编辑器 UI、不做云托管、不做账号体系。
- 不发 1.0：协议经至少一个外部宿主（TalkCut 之外的第二个实现出现）验证前保持 0.x。
- 不追求工具数量：协议价值在语义正确，不在方法清单长度。

## 6. 主要风险与对策

| 风险 | 对策 |
|---|---|
| OpenCut Rust 重写落地 MCP，凭体量占据心智 | 防御点是协议深度与 conformance 证据；P5 发布材料直接回答差异；持续雷达，必要时评估为其编写 adapter 而非对抗 |
| reference-host 与 TalkCut daemon 各自漂移 | 双方 CI 都跑同一 conformance 套件；协议变更必须套件先行 |
| 单人维护开源仓库的响应成本 | 范围克制（§5）；issue 模板与 docs 先行；0.x 期间不承诺 SLA |
| docs/18 对 OpenChatCut 的判断基于未深验的二手信息 | P5 前完成克隆逐条对比，若发现其协议已足够通用，重新评估"独立协议"是否仍成立——最坏情况是转为向其贡献，这也是可接受的结局 |
| MIT 下第三方闭源 Fork | 已接受：协议的价值来自网络效应，不在代码保护 |
