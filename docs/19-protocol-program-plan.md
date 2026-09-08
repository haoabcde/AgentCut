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

- `@agentcut/conformance`：任何宿主实现可运行的协议一致性测试，输出机器可读报告（CLI + 库 API）。范围随协议规范 v0.1 冻结结果收敛为 **core 面**：会话（bootstrap、严格校验、幂等重放）、core 读（project/writePolicy、transcript、timeline §6.4 发现读）、事务（201/200 幂等重放、IDEMPOTENCY_CONFLICT、REVISION_CONFLICT、未知 operation、原子性、未知对象、capability 门禁、actor 强制、协议版本拒绝、审计头）、diff、错误模型、崩溃恢复（需宿主重启 controller）。审批与会话撤销在 0.1 中属宿主扩展域（§10/§11），不进 core conformance；扩展一致性测试随扩展规范另行定义。
- 真实外部 Agent E2E：`scripts/agent-e2e.mjs`——Codex 与 Claude Code 各经 MCP 对真实 reference-host 完成一次完整会话（读工程 → timeline 发现 → transcript → 原子事务 → diff 确认），宿主状态独立验收（不信任 agent 自述），会话日志与报告落盘、可重复执行。
- 补齐 2026-08 遗留的真实 Codex 宿主矩阵：协议语境下由 agent-e2e 承接（接管读取、事务提交、diff 恢复、actor 审计）；原产品语境条目（Studio 审批 UI、handoff 文件、撤销矩阵）仍属 TalkCut 产品域，不在本仓库 Gate 内。

**Gate P3**：reference-host 与 TalkCut daemon（本仓库内以 `apps/local-daemon/src/conformance.test.ts` 同模式承接；TalkCut 私有仓库迁移待用户确认）双双通过 conformance；两个真实 Agent 的 E2E 脚本可重复通过。

### P4 互操作：OTIO adapter（约 2 周）

**交付**

- `@agentcut/otio-interop`（packages/otio-interop）：基于 **OTIO 官方库**（Apache-2.0，不自写解析器）实现 Timeline IR → OTIO 导出（首版只导出），附 loss report（哪些 AgentCut 语义无法表达）与官方库读回 round-trip 等价验证；OTIO → IR 导入作为第二优先级。可审阅样例与 NLE runbook 见包 README 与 `samples/`。
- 导出结果在至少一个真实 NLE（DaVinci 免费版即可）中打开验证。
- FCPXML 明确延后到有真实用户需求时。

**Gate P4**：10 分钟规模工程 OTIO round-trip 的时间线结构等价（loss report 之外零差异）；NLE 实测记录进文档。

### P5 开源发布（约 1–2 周）

**交付**

- MIT LICENSE、英文 README（含 3 分钟 quickstart：reference-host + 任意 MCP 客户端跑通一次提案-审阅-提交）、CONTRIBUTING、安全政策。
- 《AgentCut vs OpenChatCut 协议对比》公开文档（先克隆 OpenChatCut 逐条读 schema，纠正 docs/18 中未验证的假设后再发布）——已完成初稿 [docs/20](./20-agentcut-vs-openchatcut.md)（commit `19cba6e` 核实）；Pireel/video-use 维持 docs/18 的"非协议层竞争"判断（无时间线真相源/单体绑定），如发布材料需要再补克隆级证据。
- 仓库转公开、首次 tag、发布公告素材（协议动机 + conformance 报告 + 真实 Agent 录屏）——公告文稿初稿已备（[docs/21](./21-release-announcement-draft.md)，英文，含动机/证据/对比/quickstart/0.x 诚实声明；真实 Agent 录屏需人工录制，仓库 URL/tag 为占位）。三步公开动作均**待用户明确确认**。

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

## 7. 阶段状态（活文档，随 Gate 关闭更新）

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 归属清理与冻结 | ✅ 关闭（2026-09-06） | 快照提交 `09997d2`；三方比对零迁移；429/429 测试基线。 |
| P1 内核解耦与参考宿主 | ✅ AgentCut 侧关闭（2026-09-06） | host-extensions 迁移 + 扩展校验器钩子 + reference-host + core 读写路径 + MCP core 工具 + MCP↔reference-host E2E + daemon core 路由测试全部落盘；`pnpm check` exit 0、443/443 测试通过。发现并修复两类测试前不可见的问题：宿主级 revision 预检破坏幂等重放、alpha 门对未登记工程的形状崩溃。协议规范 v0.1 草案与 OTIO ADR 一并产出（原属 P2，提前）。TalkCut 侧"以扩展命名空间暴露原有方法"需触碰 `~/Developer/talkcut`，按 GOAL.md 规则待用户确认，不阻塞本仓库后续阶段。 |
| P2 协议硬化与规范 | ✅ AgentCut 侧关闭（2026-09-06） | 四项协议改造全部落地：开放 metadata 命名空间（extensionValidators 钩子）✅、风险/审批策略 capability 声明化（`writePolicy.timelineTransactions`，宿主声明语义、协议不编码风险定义）✅、任意合法 transaction 写路径 ✅、按需感知（transcript 分页已有；视觉抽样接口形状定义进规范 §13，0.2 候选，无媒体管线需求前维持定义态）✅。规范 v0.1 ✅、OTIO ADR ✅、changesets + `docs/protocol/versioning.md`（0.x 三版弃用窗口政策）✅。Gate 对账：规范 §12 条款↔测试映射复核完成，补齐违例/session 严格校验两组测试（445/445 绿）；P1–P2 协议面变更均为只增兼容，无破坏性变更需要走弃用窗口。对账属持续义务：今后每处协议面变更必须同步 §12 映射。 |
| P3 conformance 与真实 Agent E2E | ✅ AgentCut 侧关闭（2026-09-06） | `@agentcut/conformance`（22 core 检查 + 崩溃恢复，逐条挂规范条款，机器可读报告，CLI + 库 API）落地并对 reference-host 与 local-daemon 双双全绿（各 25/25，含重启后 revision/幂等账本/diff 存续证据）；TalkCut 私有仓库迁移按 GOAL.md 待用户确认。真实 Agent E2E 落地并通过：Claude Code（50.8s）与 Codex（57.2s）经 MCP 对真实 reference-host 完成读工程→timeline 发现→transcript→原子事务→diff 确认，宿主状态独立验收（脚本 `scripts/agent-e2e.mjs` 可重复）。过程中发现协议缺口并以只增兼容方式补 core 路由 `GET /api/agent/timeline`（§6.4，五层同步：规范/双宿主/agent-client/MCP 工具），并修正 daemon `/api/health` 不符 §6.1 的漂移。`pnpm check` exit 0、451/451 测试通过。 |
| P4 OTIO adapter | 🟡 代码侧关闭（2026-09-06），NLE 实测待人工 | `@agentcut/otio-interop` 落地（ADR-001：语义全在 TS plan 构建器，官方库 0.18.1 只做哑序列化/读回）：导出 + 两级 loss report（dropped/metadata-encoded）+ 每次导出自动 round-trip 等价验证（官方库读回逐项对比，篡改必报，含负向用例）。10 分钟规模合成工程 round-trip **equivalent**、7 类 loss 全部记账——Gate 的等价条款关闭。对抗性审查修复 5 处：非法 ClipKind 夹具、NTSC 累积漂移致亚帧重叠、streamIndex 静默丢失、OTIO 两处真实 API 漂移（Timeline 无 markers→Stack；AnyDictionary 不可直序列化且 key 序不保留）。`pnpm check` exit 0、477/477 测试通过。样例与映射表/loss 分类学见 `packages/otio-interop/README.md` 与 `samples/`。**NLE 实测**：开发机无任何 NLE，runbook 已备（README「真实 NLE 验证 runbook」），待人工执行后回填。 |
| P5 开源发布 | 🟡 代码与材料全部关闭（2026-09-08，提交 `9bd172b`），公开动作待用户确认 | 已提交：MIT `LICENSE`、英文 `README.md`（协议门面 + quickstart，中文原版迁 `README.zh-CN.md`）、`CONTRIBUTING.md`、`SECURITY.md`、`pnpm quickstart` + `pnpm quickstart:verify`。**验收**：quickstart 活体验证六段断言全绿（含 actor 冒充被宿主强制、幂等重放不推进 revision）；全新克隆到 /tmp → install → build → verify 总耗时 8 秒，远低于 Gate 的 15 分钟标准（本机 store 热，真实新机留有余量，发布前建议真机冒烟）。另修复 Homebrew Python 升级致 OTIO round-trip 静默 skip（`AGENTCUT_OTIO_PYTHON` 覆盖），带覆盖 check 479/479、0 skip。OpenChatCut 克隆逐条对比完成（[docs/20](./20-agentcut-vs-openchatcut.md)，commit `19cba6e` 逐条 file:line 引用）：docs/18 两处假设修正；独立协议定位成立；四项设计吸收进 0.2 候选。公告初稿 [docs/21](./21-release-announcement-draft.md)。**未执行且待用户明确确认**：仓库转公开、首次 tag、发布公告。 |
