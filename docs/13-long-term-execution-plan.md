# 可信中文口播 Alpha 长程执行计划

## 1. 长程目标

完成 AgentCut 的可信中文口播 Alpha：让真实中文口播素材完成本地导入与转写、Agent 删除方案、删除线审阅与恢复、非破坏时间线提交、字幕与预览、MP4 导出，并通过数据正确性、质量、MCP 合约和真实项目 dogfood Gate。

Alpha 结束时，用户应能完成以下闭环：

```text
真实口播原片
  -> 本地项目与媒体探测
  -> 逐词 Transcript
  -> Agent 删除方案
  -> 文字候选/删除线审阅
  -> 原子应用、恢复、锁定
  -> 剪后字幕与质量检查
  -> 预览和 MP4 导出
  -> 关闭并重启后继续编辑
```

这不是“具备若干视频能力”的演示。闭环中任何一步依赖假数据、不可恢复的文件覆盖、手工改 JSON 或不可解释的删除，都不算完成。

## 2. 约束原则

1. **真实素材优先**：每个阶段至少用一条真实口播推进，不等所有模块完成后才做 E2E。
2. **通用工作区、Transcript-first 能力**：从第一阶段就保留编辑助手、素材/文稿、Viewer 和时间线的通用布局；当前只把同步文字稿与口播清理做深，不提前实现完整多轨 NLE。
3. **源素材不可变**：所有删除是 Timeline transaction；MP4、代理和字幕都是派生产物。
4. **确定性写入**：Agent/Skill 生成判断与 proposal，project store/runtime 是唯一写入者。
5. **错删成本高于漏删**：高风险自动删除为 0；不确定内容默认保留。
6. **一条默认路径**：先支持 macOS、Codex 和一个经过 benchmark 的 ASR 路径，再扩展矩阵。
7. **Gate 而非功能计数**：阶段必须用可运行产物、测试数据和失败样本关闭。

## 3. 总体节奏

时间使用相对工程周，只表示依赖顺序和工作量，不是发布日期承诺。

| 阶段 | 建议量级 | 阶段结果 | 退出 Gate |
|---|---:|---|---|
| P0 契约与数据正确性 | 1–2 周 | Transcript/candidate/command/store 可冻结到 0.1 | 混合 replay、migration、恢复全部通过 |
| P1 真实媒体与 ASR | 2–3 周 | 原片可变成带稳定 wordId 的可审阅 Transcript | 5 条真实素材完成 ingest/ASR/对齐 |
| P2 文字删除审阅 | 3–4 周 | 用户能通过候选和删除线完成初剪取舍 | 应用、试听、恢复、锁和重启一致 |
| P3 Agent 工作流 | 2–3 周 | Codex 可经 MCP/CLI 安全推进同一项目 | 合约、审批、冲突、断点续跑通过 |
| P4 预览、字幕与导出 | 3–4 周 | 16:9/9:16 初剪可预览并导出 MP4 | parity、音画同步、失败不覆盖通过 |
| P5 Benchmark 与 Alpha | 3–4 周 | 真实项目证明节省时间且不损害信任 | 质量指标、dogfood、P0 缺陷清零 |

顺序总量约 14–20 个工程周。可并行准备语料和媒体 fixtures，但领域契约、UI 状态、MCP 和渲染不得各自发明第二套时间模型。

## 4. P0：契约与数据正确性

### 目标

让后续 ASR、UI、MCP 和渲染共享同一组可持久化语义，避免产品做到一半再重写项目格式。

### 交付

- Transcript/word schema：稳定 `wordId`、原文、规范化文字、speaker、confidence、精确 source range、ASR provenance。
- Candidate schema：`reasonCodes`、risk、confidence、evidence word IDs、alternatives、source revision。
- Proposal schema：候选选择、预计删除时长、payload hash、project/candidate revision、approval binding。
- 增加 `clip.split`、`range.delete(ripple)` 与 Transcript/caption 必要 typed commands。
- 0.1 migration runner、dry-run report、未知 major 只读保护。
- 全 operation 混合 property test、SQLite replay/hash、10 分钟规模 fixture。
- 磁盘写满、损坏数据库副本和恢复失败的可诊断测试；不伪装成真实断电证明。

### Gate G0

- 任意合法 command 序列在内存、SQLite replay 和重启后 hash 等价。
- migration 可重复、可 dry-run，失败不覆盖原项目。
- 已审阅的 word/candidate identity 不因文本纠错或排序改变。
- 所有失败返回结构化错误且没有半提交。

### 2026-07-18 进展

Transcript/Candidate/Proposal schema、source/revision binding、`clip.split`、`range.deleteRipple`、Proposal compiler、合成迁移 fixture、未知版本只读保护、100 轮随机全 operation 生命周期、全 operation SQLite replay、10 分钟规模 Proposal、容量不足和逻辑损坏诊断均已落地。G0 工程 Gate 已关闭，边界是尚未模拟真实宿主磁盘写满或注入原始 WAL 字节损坏；这些不阻塞 P1，但必须在发布硬化前补测。

## 5. P1：真实媒体与中文 ASR

### 目标

把真实本地视频稳定转换为可播放、可定位、可复现的 Transcript，而不是把某个 Provider 的 JSON 当领域模型。

### 交付

- Asset registry、content hash、`ffprobe` metadata、音频抽取、proxy、waveform 与派生缓存。
- 本地 job runner：状态、取消、重试、日志、artifact provenance。
- ASR adapter contract；通过 benchmark 选择一个默认本地路径，云 ASR 只作为对照或显式回退。
- 中文标点、专名词典、数字/中英规范化、VAD 与句子边界。
- 逐词结果映射到稳定 `wordId`，保存原始 Provider artifact 供诊断。
- 5 条 5–15 分钟真实素材的 gold 子集与错误标签。

### Gate G1

- 5/5 素材从文件进入项目并生成可 seek 的 Transcript。
- 词时间戳单调、在媒体时长内且重启后 identity 不变。
- ASR 失败、无音轨、不支持 codec、空间不足均可诊断并保持原项目有效。
- 默认流程不上传媒体；任何云路径在调用前展示数据范围与成本。

### 2026-07-18 进展

首条 241 秒真实中文讲解 MOV 已完成 content-addressed import、VFR/audio probe、MLX Whisper 完整转写、稳定 word ID 规范化、raw provenance、SQLite revision 2 持久化与 replay。另有两段约 79/92 秒的 1280×720 正面口播完成同一链路，并促成 strict JSON、provider fallback 幻觉过滤和媒体时长边界保护。当前共处理 3 条真实素材，但只有首条满足 5–15 分钟 Gate 时长，仍按 1/5 计；G1 继续进行中。

## 6. P2：Transcript-first 删除审阅

### 目标

实现第一阶段的核心价值：用户在看得懂的文字中审阅 Agent 的删除判断，而不是面对一条已经被黑箱切碎的时间线。

### 交付

- 本地 daemon/API 与最小 Web shell。
- 通用剪辑工作区壳：编辑助手、素材/文稿、Viewer 和时间线；当前激活“口播清理”。
- Viewer 与同步 Transcript 互相定位，时间线显示最小主画面轨和候选范围。
- 停顿、语气词、重复/重说分类计数与筛选。
- 候选用背景标记；只有 committed deletion 使用低对比度删除线。
- 点击文字 seek；候选支持前后文循环试听、原因、风险、置信度和预计缩短时长。
- 原子应用 proposal；删除线可试听原片、查看 transaction、恢复或锁定。
- 刷新、重启、其他 Agent 提交后的 revision conflict 和 UI 重建。
- 可访问性：状态不能只靠颜色，键盘可完成逐项审阅与恢复。

### Gate G2

- 一条真实素材可完全通过文字完成候选审阅、应用、恢复和再次应用。
- UI 展示状态与 project store 最新 revision 一致，没有仅存在于浏览器内的 canonical state。
- 高风险候选不会进入无确认批量删除。
- 用户恢复/拒绝/锁定后，后续 Agent 不得静默覆盖。

### 2026-07-18 进展

保守候选检测器、Candidate/Proposal 原子 bundle、真实素材停顿删除/Undo/再次应用、删除线审阅投影、本地 daemon 和 Transcript-first Studio 已落地。候选支持上下文循环试听、提交前删除效果试听、单项删除、保留并锁定、重新审阅和恢复，stale revision 会停止写入并刷新 UI；保留锁绑定 asset source range，不会因前方 Ripple 漂移。左右键/Space/B/D/K/U 已覆盖导航、原片试听、删除效果试听、删除、保留和恢复，高风险候选必须经过 checkbox 与 API flag 双重显式确认。相邻精确重复检测在两段真实短片各命中 1 条，因 ASR confidence 仅 0.407/0.041 均降级为 high risk；本地 AI 语义审阅又在 sample-03 命中 43.78 秒开始的 7.02 秒长句重说，并用独立文本/停顿证据门拒绝小模型拆词误判。Studio/API/media 已收敛到一个 daemon 进程，502 会给出可执行诊断。通用工作区在窄窗口加入助手/文稿/画面/时间线四个紧凑 Tab，Viewer 与时间线不再被横向裁出视口；时间线已经显示真实播放头并支持点击素材轨定位视频。G2 尚未关闭：仍缺整条真实素材全部候选人工验收、批量审阅和真实明确改口/误启动样本。

### 2026-08-14 进展

补齐 G2 的「批量审阅」工程缺口：低/中风险候选可在队列中逐项勾选，按一次可恢复事务成批删除（复用初剪生成的既有多次删除单事务机制）；高风险候选与重叠组非主项在服务端 fail closed，无法混入批量。恢复粒度 = 整个批量事务，UI 明示「批量 N 项，将一并恢复」。详见开发记录 2026-08-14。G2 其余两项（整条真实素材全部候选人工验收、真实明确改口/误启动样本）仍依赖授权素材与人工听审。

## 7. P3：Agent、MCP 与断点续跑

### 目标

让 Codex 成为第一个真实外部 Agent：它能理解项目、生成方案、等待审核并在最新 revision 上继续，而不是生成一次性脚本。

### 最小工具面

- `project.create/get/capabilities`
- `asset.import/get`
- `job.start/get/cancel`
- `transcript.get/query`
- `candidate.generate/get`
- `timeline.getSnapshot/applyTransaction`
- `project.diff`
- `version.create`
- `quality.run`
- `export.start/get`

### 交付

- MCP、CLI 共用 schema 与错误码；不暴露 raw SQL、JSON Patch 或任意 FFmpeg。
- resumable talking-head workflow，状态保存在项目而非对话记忆。
- review-ready 门禁；审批绑定 project/candidate revision 与 payload hash。
- 幂等重试、断线后 outcome 查询、两个 Agent 冲突和 stale proposal 处理。
- doctor、capability discovery、diagnostics bundle。

### Gate G3

- Codex 在一个新项目中完成导入、分析、proposal、等待用户、应用和恢复。
- 重复 MCP 请求不产生重复 command；未知 outcome 可查询。
- 审批后 revision 漂移必定停止执行并返回审阅。
- 关闭对话后，另一个任务能从项目 workflow state 继续。

### 2026-08-11 进展

G3 真实接管矩阵在 sample-03 隔离副本上端到端完成：4 能力 delegated handoff session 经 CLI 完成接管读取、故意 stale conflict（exit 3）、project diff 恢复、本地语义分析 job（REV 9→10）与 2 条带 wordId 证据的语义建议（daemon 证据门接受 1 条，REV 10→11，候选 +1 high-risk）；同 requestId 重放幂等、换 payload 拒绝；CLI 与 MCP 两侧越权写均 `CAPABILITY_DENIED`；MCP stdio 恰好 13 工具且无 accept/approve/resolve/confirm/delete/keep 命名；用户配对 UI Cookie 撤销 session 后，daemon 完整重启仍按 revoked 拒绝。逐字段 handoff 测试确认 `transcript:write` 从未存在于可授予能力集合。真实 Codex 宿主因账号额度（2026-08-16 恢复）未能补跑，G3 关闭仍需：真实 Codex 在全新授权素材上完成同一矩阵，且用户实际处理其高风险建议。

### G3 真实 Codex 宿主补跑 runbook（2026-08-16 额度恢复后执行）

先决条件：一条新授权口播素材（docs/17 登记）、本机 LM Studio 已启动（127.0.0.1:1234，语义分析必需）。

1. 建项（必须从未审阅状态开始，同一素材不得重复建项）：
   ```bash
   pnpm roughcut -- /path/to/素材.mp4 --project /path/to/g3-project --name "G3 真实接管" --alpha-trial
   ```
2. 启动 daemon + Studio（默认端口 4317，可 `AGENTCUT_PORT` 覆盖）：
   ```bash
   pnpm studio -- /path/to/g3-project
   ```
3. 当前任务签发最小权限 handoff（mode-0600 交接文件，stdout 不含 token）：
   ```bash
   pnpm --silent agent -- handoff create \
     --client-id codex-g3 \
     --capabilities project:read,transcript:read,analysis:local,analysis:propose,timeline:write:low_risk_only,approval:request,timeline:write:approved,export:write \
     --ttl-seconds 3600 --request-id handoff-g3-001
   ```
4. 真实 Codex 经 CLI 或 MCP launcher（`scripts/agentcut-agent.mjs` / `scripts/agentcut-mcp.mjs`）接管，逐项完成矩阵：
   - 读取 project status / transcript（分页 wordId）/ candidates；
   - `semantic analyze` 本地 job → `semantic propose --findings-file` 提交 2 条带 wordId 证据的语义建议（daemon 证据门独立验证，只持久化 high + suggest_remove）；
   - 故意用旧 baseRevision 提交写操作，确认返回 stale conflict（CLI exit 3）后 `project diff` 恢复；
   - 同 requestId 重放（幂等，revision 不增）；换 payload 重试（拒绝）；
   - 越权写（如未授予的能力）确认 `CAPABILITY_DENIED`；
   - 批准路径：`approval request` → `approval get` → `approval apply`，确认 revision/payload-bound。
5. 用户在 Studio 试听并实际处理其高风险建议（保留/删除/锁，不替用户决定）。
6. 用户撤销 handoff session 后完整重启 daemon，确认仍按 revoked 拒绝。
7. 该素材若同时用于 G5，继续走正式样本固定顺序（计时→取舍→导出→标注→collect，见 §8 runbook）。

### 2026-08-10 进展

新增 `@agentcut/agent-client` 与 `pnpm agent`，以当前单工程 daemon 为唯一写入端，提供 `status`、`candidates`、`transcript get`、`project diff`、`rough-cut generate`、`semantic analyze|propose`、`export start|get|cancel`。读命令输出紧凑、稳定 JSON；写命令必须由 Agent 显式携带 `baseRevision + requestId`，revision conflict、capability 缺失与 job failure 映射为协议退出码。CLI 刻意不开放人工候选接受、保留、连续文字补删或高风险确认，避免外部 Agent 冒充 UI 用户决定。

同日补齐 `@agentcut/mcp-server` 与根目录 `pnpm mcp` launcher，基于官方 TypeScript SDK v2 的 stdio transport 暴露安全子集。当前共 10 个工具：project status、candidate list、project diff、guarded rough-cut generate、local semantic analyze、revision-bound export start/get，以及 approval request/get/apply。MCP 成功结果使用稳定 structured-content envelope，daemon conflict 保留为 tool-level structured error；launcher 把构建信息送往 stderr，stdout 只留协议。官方客户端 E2E 已证明初始化、工具发现、读写、caller-owned revision/requestId、冲突传播与不存在 approval resolve/任意 accept/delete/confirm/keep 工具。

当前 daemon 已增加工程绑定的 capability session：Studio 在工程内维护 mode-0600 bootstrap credential，CLI/MCP launcher 用它换取最长 24 小时的 token，SQLite 只保存 token hash、capability、过期时间和允许/拒绝 access event。受保护 Agent 路由映射到 `project:read`、`analysis:local`、`timeline:write:low_risk_only`、`approval:request`、`timeline:write:approved`、`export:write` 六种能力；access side table 不改变 Timeline revision。新增只读 `project diff` 返回有界 transaction 摘要、对象 ID 与哈希，不复制文稿和源路径。

revision/payload-bound approval 已接通 Store、daemon、Studio、CLI 与 MCP：Agent 只能申请/查询/应用，resolve 仅在 Studio 用户面；token 绑定精确候选定义、revision 和过期时间，应用后 consumed。自动测试已覆盖 deny/expiry/stale、不同 session 接力与 commit 后/consume 前崩溃，临时工程也完成独立 CLI 进程和 daemon 重启验证。Studio 现可查看不含凭据的 session/访问摘要并持久化撤销；已撤销 token 在重启后仍按 `revoked` fail-closed。Studio 用户写 route 要求独立 UI bootstrap 换取的 7 天签名 HttpOnly cookie，未配对、伪造与过期请求 fail-closed 并进入 SQLite audit；bootstrap 已能原子轮换，旧 Cookie 立即失效，文件发布后/SQLite 审计前的崩溃由 `lastRotation` 在下一请求或重启时幂等补记。导出取消已接通同一 Store job、daemon AbortSignal、Studio、typed CLI 和第 11 个 MCP tool：pending 立即取消、running 安全停止、成功竞态不回滚、请求丢失后查询原 job、重启保持终态。

同日新增 `handoff create`：当前任务用永久 bootstrap 签发显式 capability/TTL 的 session，将其原子封装为 mode-`0600`、仅允许 loopback daemon 的本地交接文件；stdout 不含 access token。后续 CLI/MCP launcher 读取交接文件后直接复用该 session，不再读取 bootstrap 或创建新 session。测试已用第二个官方 MCP stdio host 证明只读接管，且 session 仍沿用现有撤销、过期、访问审计和重启语义。当前仍不是 G3 完成：自动 contract 已覆盖“两个宿主”，但还缺用户可见的真实新 Codex 任务接管，以及该任务参与一次 stale conflict、用户撤销与重启后拒绝的完整矩阵；在此之前不扩大任意 timeline 写工具。

同日补上 Agent 真正理解内容所缺的双向桥：`transcript:read` 可分页读取完整稳定 word IDs、source timing、confidence 和素材 hash，但不返回源路径；`analysis:propose` 可提交 1–100 条 repetition/restatement/correction/false-start/incomplete 发现。daemon 不信任外部判断，独立校验字段、revision、Transcript IDs、范围、保留段与文本证据；全部被拒时不写空 artifact、不推进 revision，通过时只保存 `high + suggest_remove` CandidateSet，transaction 不包含任何删除 operation。CLI/MCP 当前工具面因此增至 13 项。typed client 和 daemon 测试已覆盖分页、越权、合法改口、幂等重放、payload 冲突、stale revision、无证据 finding 与非法 confidence；官方 MCP client 的纯内存 contract 已验证 13-tool discovery、参数透传和 schema 拒绝，完整 stdio + HTTP E2E 因本轮执行环境不允许临时 loopback 监听而待补跑。G3 仍未关闭：还需真实 Codex 宿主用这两个能力审阅新素材，并由用户处理其建议后完成 conflict/撤销/重启矩阵。

## 8. P4：预览、字幕与 FFmpeg 导出

### 目标

把审阅结果转成可信媒体输出，并证明浏览器所见与最终 MP4 在首发子集内一致。

### 交付

- PreviewAdapter 决策与代理优先回退。
- Timeline evaluator：trim、split、ripple delete、基础 crop/scale、caption。
- 剪后 Transcript source mapping 与 cut-boundary QA；用 benchmark 决定全量或局部重新 ASR。
- Caption 分行、专名纠错、基础样式和安全区。
- FFmpeg compiler、预检、临时输出、原子完成、失败不覆盖旧导出。
- 16:9 和 9:16 基础 preset；人物跟踪不可靠时退回用户可调固定 crop。
- quality report：gap/overlap、吞字、音画同步、字体、字幕安全区和 approximation。

### Gate G4

- 固定素材矩阵导出成功率达到 100%，再扩大矩阵校准 99% 发布门槛。
- 首发效果子集几何误差不超过 1 px，音画偏差不超过 40 ms，或明确显示 approximation。
- 至少 95% 删除边界无吞字/截断音节。
- 导出失败保留上一产物和完整项目，可安全重试。

2026-08-10 补齐了导出发布与 Timeline 登记之间的崩溃窗口：重启时可验证并收养已经完整发布的 MP4/SRT；残缺或错配文件不覆盖，新请求改用确定性的 `safe-retry` 文件对继续导出。导出开始前和渲染完成后还会重算每个输入素材的 content hash，重启收养前同样校验；托管媒体缺失、损坏或被替换时拒绝渲染/收养，并保留已有成片。由此 UI 的“安全重试”和源素材不可变 provenance 都有可执行门禁，但 G4 的人工边界听审和扩大素材矩阵仍未完成。

2026-08-11 补齐 P4 的 9:16 竖屏导出 preset（全链路：schema/render-engine/daemon/Agent CLI/MCP）。`buildRenderPlan` 接受输出尺寸与 `fitMode`（contain/cover）覆盖并纳入 planHash，同 revision 的横竖导出产物互不覆盖；cover 仅中心裁切、无人物跟踪，质量报告强制 `fitModeApproximate: true`。preset 存于导出 job payload 而非 Timeline mutation，参与幂等：同 requestId 换 preset 拒绝 `IDEMPOTENCY_CONFLICT`，旧 job 缺省按 source 解释。真实 sample-03 一次性副本上完成 1080×1920 真实渲染（succeeded、probe 尺寸复核、抽帧目检人像充满竖幅、字幕完整烧入）与幂等/冲突行为验证，副本随后删除，正式工程未被触碰。同日 Studio UI 补齐 preset 选择器：导出控件提供「导出成片 / 导出 9:16 竖屏」双入口，运行与成功态均标注 preset，`fitModeApproximate` 时展示“中心裁切近似取景，请目检构图”警示，用户路径与 Agent 路径在协议层一致。同日新增离线素材矩阵（render-engine `media-matrix.test.ts`，12 条程序化合成形态：基准 CFR、HEVC、VFR 混合帧率、4K、60fps、竖幅、单声道、96kHz、快速运动、旋转竖拍、anamorphic SAR、HDR PQ）全部走过 daemon 同款持久化渲染与质量门，成功率 100%，把 G4「扩大矩阵」推进到机器可重复的离线一半；无声轨形态刻意不进矩阵，留待真实素材听审暴露后按规变成 fixture/回归。同日修复/标记三处媒体元数据保真问题：旋转元数据竖拍（误建横幅画布导致 pillarbox，probe 现暴露 `rotation` 与显示宽高）；非方形像素 SAR（旧式宽银幕按存储宽高比压缩变形，现读 `sample_aspect_ratio` 并在渲染前归一化为显示尺寸）；HDR 源（PQ/HLG 不色调映射会保留 PQ 标签导致 bt709 播放器失真，现检测并给质量报告加 `colorApproximate: true` 诚实标记 + 中文告警，色调映射因依赖 libzimg 且有损而留作后续单独立项）。剩余缺口：主体感知取景（若未来需要）单独立项；正式矩阵分母仍是授权真实项目（当前 2/20；当日稍后补登记 sample_01_screen_recording 后为 3/20，见开发记录同日条目）。

2026-08-13 将“代理优先回退”从规划变成 source-bound 实现。H.264/AAC MP4/M4V 继续直读源素材；其余输入在建项时生成固定 `browser-h264-aac-1280-v1` 代理，按 source hash 确定文件名、验证 H.264/AAC 与时长差 `<=40 ms` 后无覆盖原子发布，并作为 generated Asset 与 source ID/hash 精确绑定。Viewer 可读取代理，但主轨 clip、Transcript、PreviewPlan、候选与导出仍绑定源 Asset；服务端与 Studio 均显式披露这种解码降级。真实 HEVC 浏览器项目尚未进入授权 Alpha 分母，当前证据是程序化 HEVC 建项/续跑、服务端投影和组件测试；G4/G5 仍需真实设备素材与人工听审。

## 9. P5：Benchmark、Dogfood 与 Alpha Gate

### 目标

证明 AgentCut 不只是技术闭环，而是能够减少真实创作者的有效粗剪时间，同时维持信任。

### 数据与试用

- 至少 20 条授权真实项目，覆盖普通话、口音、中英混说、专名数字、快语速、背景音乐、VFR 与录屏口播。
- 至少 5 位设计伙伴；记录从导入到接受版本的人工有效编辑时间。
- 保存候选接受/拒绝/恢复与边界修正，但不把原始媒体上传为遥测。
- 建立失败样本集，每个 P0/P1 缺陷变成 fixture 或自动化回归。

### Alpha Gate G5

- 高风险自动错删为 0。
- `definite_remove` precision 不低于 98%（跨项目聚合），且每个已标注项目不低于 90% 单项目底线（2026-08-11 起强制，防聚合稀释）。
- 边界可用率不低于 95%（跨项目聚合），且每个已标注项目不低于 80% 单项目底线（2026-08-11 起强制，防聚合稀释）。
- undo/restart/idempotency/revision conflict 正确率 100%。
- 20/20 项目完成审阅和 MP4 导出；P0 数据损坏、静默覆盖、不可恢复错删为 0。
- 相比同一创作者手工粗剪，人工有效编辑时间中位数至少下降 30%。
- 设计伙伴能解释任一删除并独立恢复，不依赖开发者改数据库或 JSON。

若指标未通过，继续收缩自动删除范围或改进边界，不通过降低测试难度来宣布 Alpha。

### 2026-07-31 进展

新增 `@agentcut/alpha-gate`、`pnpm alpha:gate` 与 `pnpm alpha:audit`，把 G5 的 20 个授权项目、20/20 审阅导出、高风险自动错删、`definite_remove` precision、边界可用率、四类正确性和人工有效时间中位数变成确定性报告。验收 manifest 只保存 hash、统计与证据引用，不保存原始媒体，也不能修改 Timeline IR/SQLite；审计命令只读 ProjectStore，并从 canonical timeline 和 command records 生成禁止覆盖的 revision-bound 草稿。

当前基线诚实返回 `insufficient_evidence`：登记 2/20 个用户提供的授权口播，但持久化审阅导出仍为 0/20，高风险自动错删为 0。sample-02 revision 4 草稿有 14 个未决候选、0 个实际剪切边界；sample-03 revision 9 草稿有 4 个未决候选、3 个实际剪切边界。曾完成机器导出的临时工程已经不存在，历史记录不再计入当前 Gate。候选真阳性、人工边界听审、配对时间和四类逐项目正确性仍无合格分母；命令退出码为 1，防止 CI 或开发者把“尚未测量”解释为 100%。

同日新增本地人工证据侧车、daemon API 和 Studio“Alpha 验收”面板。标注事件绑定 project revision、source hash 和目标 ID，写入独立 SQLite，不改变 Timeline revision；旧 revision 的判断不会沿用到新审计。sample-03 正式工程已验证 7 个候选、3 个真实边界可以在通用工作区内逐项抵达，第一个边界可以用当前初剪试听，但没有替用户写入任何人工结论。下一步先把侧车确定性导出为带 hash 的 evidence bundle 并接入 Gate 聚合，再由用户实际听审、记录配对时间并逐步扩充到 20 个项目。

该 evidence bundle 链路现已落地：`alpha:evidence` 从当前 ProjectStore 与侧车导出确定性、不可覆盖、隐私最小化的 JSON，内部 payload hash 与 manifest 文件 hash 双重校验；Gate 直接从验证后的 bundle 派生候选、边界、审阅和导出汇总。sample-03 revision 9 的正式空标签 bundle 已登记，仍诚实保持候选 0/7、边界 0/3、审阅未完成。下一步从“建设证据管道”转为“采集真实证据”：先由用户完成 sample-03 全量听审，同时把四类正确性和配对人工时间也收敛为机器可校验事件，再扩充项目 cohort。

四类正确性现已进一步收敛为临时 SQLite backup 上的真实机制验证：每个项目分别执行可逆 transaction、幂等重放、关闭重开、stale revision 拒绝和 undo 领域状态比较，正式 ProjectStore 全程只读。sample-02/sample-03 均已生成绑定 state hash 的 run，Gate 为 `2/2 across 2/2 projects`。Gate 同时修复按总次数而非项目覆盖判定的问题，同一项目重复运行不再能替代其他项目。下一步剩余两条关键证据链是正式人工候选/边界听审，以及可暂停恢复的 AgentCut active-time 与同创作者手工基线配对。

可暂停 active-time 与人工基线现已进入同一 append-only sidecar 和 bundle，后台、空闲与服务中断不计时；正式项目仍未录入任何虚构基线。cohort 采集也收敛为 `alpha:collect`：一次完成临时副本 correctness、内容寻址 bundle 和 manifest 原子登记，幂等重跑不增加项目或事件，并在写证据前拒绝重复素材、cohort/source 冲突和授权依据替换。由此后续新增真实项目不再需要人工计算 hash 或编辑 JSON，但 G5 仍必须依靠真实操作者完成听审、导出和配对时间，当前不能据此增加 2/20 的样本数（当日稍后补登记 sample_01_screen_recording 后为 3/20，见开发记录同日条目）。

随后修正了 active-time 的关键口径漏洞：粗剪期间的删除、保留和恢复必然推进 Timeline revision，计时不能像候选质量标签一样只投影到单一 revision。现在同 project/source 的 timing 事件可随 revision 单调延续，最终 bundle 逐事件验证其 revision 不倒退且不超过接受版本；其他人工标签与 correctness 仍严格绑定最终 revision。若完成计时后继续编辑，旧时间自动退回未完成并允许续计。为防止先剪完再补录时间，审计从 append-only CommandRecord 推导首个人工删除、保留或恢复 revision；正式基线和首次 start 必须发生在该 revision 之前，之后只能恢复此前已启动的同一 run。Studio 与 daemon 同时禁止事后启动正式计时，也禁止在内容取舍未结束时写最终候选/边界结论。

2026-08-10 又关闭了首次计时的两步窗口：`AlphaEvidenceStore.beginTiming` 在一个 `BEGIN IMMEDIATE` transaction 内顺序追加 baseline 与 start，两个 child event 使用同一父 request ID 派生且共享 server timestamp；全有则幂等重放，部分存在或 payload 改变则冲突，校验失败不会留下半条 baseline。Studio 首次按钮改为“登记对照并开始计时”，用 React ref 跨不确定响应保留父 request ID；暂停后的继续仍走既有 start。审阅前 sample-03 副本真实验证首次/重放均只有两条事件、Timeline REV 2 不变，daemon 重启后 baseline 持久化且运行态按停机规则自动暂停。

2026-08-13 将同一结果未知语义扩展到 Studio 全部有副作用用户路径，而不只首次 timing/cancel/rotation。UI 现在强制调用者自有 requestId，按逻辑 scope 和 canonical payload 在页面生命周期保留 ticket；断连/5xx 后先重新读取 SQLite，读取失败才保留原 ID 等待同意图重试，并在此期间拒绝矛盾 payload。候选/文字编辑、恢复/锁、语义/初剪、审批/session、导出和 Alpha 标签/计时均接入；只读试听与 heartbeat 维持独立请求。该改动提升后续 20 项目实操的幂等可靠性，但没有替代真实 cohort：Gate 仍为 3/20 授权、0/20 审阅导出。

2026-08-10 进一步固定真实样本证据顺序：成功导出会通过 artifact transaction 推进一次 project revision，因此最终候选/边界标签必须在当前初剪导出且 deterministic quality passed 之后写入。EvidenceStore、Studio 和 bundle loader 都校验 `export.sourceRevision + 1 === accepted project revision`；缺导出、质量失败或导出后又修改内容时不能记录/接纳最终标签。计时仍从审阅前开始并跨该导出 revision 延续。

### G5 新样本 runbook（每条授权素材，按序执行）

素材先登记到 docs/17（来源、授权范围、确认方式、覆盖类别）；建项得到 canonical 源 hash 后，补入与计划 `--cohort-id` 和源 hash 完全一致的 `<!-- agentcut-alpha-authorization: <cohort-id> <source-sha256> -->` 独占行，再继续正式证据流程。建项推荐用辅助脚本（算 hash、查重复素材/cohort 冲突、打印授权模板与 collect 命令，授权文件仍由用户确认后落盘）：

```bash
pnpm alpha:new-sample -- /path/to/素材.mp4 --cohort-id <snake_case_id> --name "正式样本 NN" \
  [--coverage-classes <mandarin,accent,code-switch,proper-noun-number,fast-speech,background-music,vfr,screen-recording>]
```

也可沿用原始命令：

1. 建项（同一素材不得重复建项，会返回 `resumed` 或拒绝）：
   ```bash
   pnpm roughcut -- /path/to/素材.mp4 --project /path/to/formal-project --name "正式样本 NN" --alpha-trial
   ```
2. 启动 Studio 并打开「Alpha 验收」面板：
   ```bash
   pnpm studio -- /path/to/formal-project
   ```
3. 任何内容取舍**之前**：先由同一创作者完成一次手工初剪对照并保留私有录屏/编辑器日志/秒表记录；填写 `manualBaselineSeconds`、方法、稳定操作者代号，在 Studio 选择证据文件并等待浏览器本地分块计算 SHA-256 后，点击「登记对照并开始计时」。若文件选择或计算不可用，可手工粘贴已核对的 `sha256:<64位>`。同一设计伙伴跨项目必须使用同一不含个人信息的代号，使 Gate 能验证至少 5 位不同操作者；代号只保存单向 hash，文件内容和文件名不上传、不持久化，源媒体 hash 不得复用。该动作在单事务内写入带来源 commitment 的 baseline + 首个 active session；只有计时 running 时 daemon 才接受取舍、删除、恢复、语义分析、生成初剪、审批与导出。
   普通工程不提供也不接受该计时入口；正式身份随 evidence bundle 双层 hash 固化，loader 还会校验 `enrolledAt <= 首个 timing baseline createdAt`。无效时间、首条计时事件不是 baseline、或事后补写 formal 标记，即使重算 payload hash 也不能进入提效分母。
4. 内容取舍：按 README 固定顺序完成停顿/填充词/重复/重说审阅（高风险候选必须 checkbox + `confirmHighRisk: true` 双重确认）。注意 30 秒静止窗——CLI/脚本驱动的写操作间隔超过 30 秒会被 `ALPHA_TRIAL_TIMING_REQUIRED` 拒绝，需先「继续计时」再重试；导出失败后修正再导必须换新 requestId（同 ID 换 revision 返回 `IDEMPOTENCY_CONFLICT`）。
5. 全部取舍完成后生成初剪，导出 MP4 + SRT；quality gate 必须 `passed`（durationDelta ≤40ms；越尾素材带 `expectedOutputMicros` 披露属正常）。导出成功推进一次 revision。
6. 点击「暂停并完成计时」：正式基线/start 必须发生在首个人工编辑 revision 之前（audit 从 CommandRecord 推导），finish 时校验 `export.sourceRevision + 1 === 当前 revision`；完成后初剪结果封存，试听与最终质量标注仍可继续。
7. 最终标注（在当前初剪导出且 quality passed 之后）：逐候选标 `true_positive / false_positive`，逐边界标 usable + issue codes；旧 revision 的判断不会沿用到新审计。
8. Studio 出现“本 revision 已可收集”后登记 cohort（manifest 原子登记，幂等重跑不增加事件）：
   ```bash
   pnpm alpha:collect <项目目录> \
     --manifest benchmarks/alpha-gate/manifest.json \
     --cohort-id <snake_case_id> \
     --authorization-basis user_supplied_for_testing \
     --authorization-evidence ../../docs/alpha-authorizations/<cohort-id>.md \
     --coverage-classes <mandarin,accent,code-switch,proper-noun-number,fast-speech,background-music,vfr,screen-recording>
   ```
   `--coverage-classes` 按素材实际形态如实填写（允许值即上述 8 类；凑满 20 个项目后 gate 强制 8 类全覆盖，未记录按缺失计）。
9. 复核：`pnpm alpha:audit <项目目录> --output /tmp/audit-NN.json` 只读检查草稿；`pnpm alpha:gate` 看聚合进度。

计时口径提醒：计时随 revision 单调延续、完成后若再编辑会自动退回未完成；正式计时不可事后补录。sample-02/03 的 firstHumanDecisionRevision 已过，永远不能进入配对计时分母，只作辅助听审。

## 10. 并行工作流

以下工作可以并行，但共享同一 Gate：

| 工作流 | 持续产物 | 不允许发生 |
|---|---|---|
| 数据/Benchmark | gold transcript、候选标签、边界评分、失败样本 | 为通过指标删掉困难素材 |
| Core Runtime | schema、commands、store、jobs、migrations | UI/Skill 直接写项目文件 |
| Media | probe、proxy、ASR、preview、render、QC | Provider JSON 泄漏到 IR |
| Review UI | Transcript、proposal、删除线、恢复、锁 | 浏览器 store 成为第二真相源 |
| Agent Surface | MCP、CLI、workflow、approval、diagnostics | 任意 shell/SQL/FFmpeg 工具暴露给 Agent |

## 11. 降级与停止条件

- 本地 ASR 未过 Gate：保留手工导入 Transcript，并只提供明确授权的云回退；不伪造本地完成。
- 浏览器原 codec 预览不稳定：统一生成代理；不为“即时”牺牲一致性。
- 全量剪后 ASR 导致文本漂移：改为 source mapping + 边界局部 ASR，并在字幕报告标明来源。
- 时间线 UI 开始吞噬阶段资源：退回紧凑时间带，只保留 Transcript 闭环必需操作。
- MCP 客户端差异过大：Alpha 只支持 Codex，协议保持可扩展但不同时适配多个客户端。
- `definite_remove` 无法达到 98%：缩小自动集合，把更多候选降级为人工确认。

## 12. Alpha 之外

以下内容明确不在当前长程目标内：

- Windows 安装与桌面壳产品化。
- 完整多轨 NLE、复杂关键帧、调色与高级特效。
- StyleSpec、参考视频风格迁移、B-roll 和 AI 生成素材。
- 访谈 diarization、多候选短视频和多机位。
- 云项目同步、多人协作、账号、计费和团队权限。

只有 G5 通过后，才从实际 dogfood 数据决定先做平台化、视觉增强还是访谈，而不是按旧路线图自动进入下一版本。

## 13. 维护节奏

- 每批有效改动同步更新 `docs/11-development-log.md`。
- 每个 Gate 维护一份证据：命令、测试数、真实素材样本范围、失败案例和未验证项。
- 架构或产品边界改变时新增/更新 ADR，不把讨论结论只留在聊天中。
- 每阶段结束审查依赖、许可证、隐私、磁盘占用和降级路径。
- 未通过的验证必须保留真实失败结果；计划状态只按证据更新。
