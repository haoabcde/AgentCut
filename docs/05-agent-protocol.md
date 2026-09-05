# Agent 接入协议

## 1. 目标

- 同一能力通过 MCP、CLI、TypeScript SDK 暴露。
- 工具数量稳定，不随每个时间线操作无限膨胀。
- 所有写入具备 revision、幂等、事务、权限、锁与审计。
- 长任务采用 job；需要用户决定时采用 approval，不假装同步完成。
- Agent 从不直接接触前端 store、SQLite 或 raw FFmpeg。

## 2. 命名分层

canonical method ID 使用 `domain.verb`；MCP 为兼容严格客户端使用下划线编码。

| Canonical | MCP tool | CLI | SDK |
|---|---|---|---|
| `project.create` | `agentcut_project_create` | `agentcut project create` | `client.project.create()` |
| `timeline.applyTransaction` | `agentcut_timeline_apply_transaction` | `agentcut timeline apply` | `client.timeline.applyTransaction()` |
| `analysis.start` | `agentcut_analysis_start` | `agentcut analysis start` | `client.analysis.start()` |

不将 `split_clip`、`move_clip` 等全部做成 MCP tool。它们是 `timeline.applyTransaction.operations` 中的 typed operation。这样 Agent 能原子提交组合编辑，协议也不会出现数百个工具。

## 3. 通用 Envelope

### 3.1 请求

```json
{
  "protocolVersion": "0.1.0",
  "requestId": "req_01",
  "client": { "id": "codex", "version": "2026.7", "sessionId": "session_7" },
  "projectId": "project_demo_001",
  "idempotencyKey": "session_7:req_01",
  "params": {}
}
```

### 3.2 成功

```json
{
  "ok": true,
  "requestId": "req_01",
  "data": {},
  "meta": {
    "projectRevision": 12,
    "warnings": [],
    "auditId": "audit_01"
  }
}
```

### 3.3 错误

```json
{
  "ok": false,
  "requestId": "req_01",
  "error": {
    "code": "APPROVAL_REQUIRED",
    "message": "This operation uploads media to a paid provider.",
    "retryable": true,
    "details": { "approvalId": "approval_01", "estimatedCost": { "currency": "USD", "max": 0.42 } },
    "suggestion": "Ask the user to approve or select local_only."
  }
}
```

## 4. 工具清单

### 4.1 Discovery 与 Project

| Method | 用途 | 关键参数 | 返回 |
|---|---|---|---|
| `system.getCapabilities` | 发现 daemon、renderer、codec、provider、权限 | `projectId?` | capability manifest、限制、版本 |
| `system.doctor` | 只读环境诊断 | `checks?` | FFmpeg/Node/Python/模型/路径结果 |
| `project.create` | 在已授权 root 创建项目 | `root,name,settings` | project descriptor、revision 0 |
| `project.open` | 打开并获取 session | `root,mode=read_write|read_only` | projectId、session、lock owner |
| `project.get` | 项目摘要 | `include?` | settings、activeSequence、revision、jobs |
| `project.close` | 释放当前 session | `sessionId` | closed |
| `project.diff` | 查询两个 revision 或自某 revision 的变化 | `fromRevision,toRevision?` | changed IDs、command summaries |

`project.create/open` 的 root 必须来自启动工作目录或用户已授权路径；MCP 不能借此任意浏览磁盘。

### 4.2 Asset

| Method | 用途 | 关键参数 | 返回 |
|---|---|---|---|
| `asset.import` | 导入/原位引用本地文件 | `paths,mode=copy|reference,role` | asset IDs、probe jobs |
| `asset.list` | 查询素材 | filter、cursor | paged descriptors |
| `asset.get` | 媒体/stream/derivative 信息 | `assetId` | descriptor，不默认暴露绝对路径 |
| `asset.relink` | 重链接 offline asset | `assetId,path,expectedHash` | new availability |
| `asset.ensureDerivative` | 生成 proxy/waveform/thumbnail | `assetId,kinds,profile` | jobId 或 cache hit |

不提供 `media.analyze`：分析属于独立异步域，不与导入/探测混在一起。

### 4.3 Analysis 与 Style

| Method | 用途 | 关键参数 | 返回 |
|---|---|---|---|
| `analysis.start` | 启动 versioned 分析 | `kind,assetIds,providerPolicy,options,budget` | jobId、cost/privacy plan |
| `analysis.get` | 读取 job/artifact 状态 | `jobId` | progress、artifact refs、error |
| `analysis.cancel` | 尽力取消 | `jobId` | cancellation state |
| `artifact.get` | 读取结构化 artifact | `artifactId,select?` | schemaVersion、payload/provenance |
| `style.createFromReference` | 参考视频分析的高层入口 | `assetId,dimensions,providerPolicy` | jobId |
| `style.get` | 读取 StyleSpec | `styleSpecId` | observations/rules/confidence |
| `style.applyProposal` | 生成应用建议，不直接写 timeline | `styleSpecId,sequenceId,dimensions` | transaction proposal + preview plan |

`analysis.start.kind` 首批：`transcript`、`talking_head_candidates`、`scene_analysis`、`reference_style`；V0.3 增加 `speaker_diarization`、`topic_segments`、`clip_candidates`。

### 4.4 Workflow

| Method | 用途 | 关键参数 | 返回 |
|---|---|---|---|
| `workflow.start` | 启动可恢复工作流 | `workflowId,inputs,mode,policy` | runId、stage、approval |
| `workflow.get` | 查询 stage/artifact/decision | `runId` | state、nextActions |
| `workflow.resume` | 输入用户决定后续跑 | `runId,approvalId?` | state |
| `workflow.cancel` | 取消未提交后续步骤 | `runId` | state |
| `workflow.getProposal` | 获取 edit plan | `runId,proposalId` | operations、reasons、risk/cost |
| `workflow.applyProposal` | 事务应用已确认 proposal | `proposalId,baseRevision,selection` | commit result |

高层 workflow 适合 Agent；低层 analysis + timeline 适合自定义编排。两者最终都只能通过 transaction 修改 Timeline。

### 4.5 Timeline

| Method | 用途 | 关键参数 | 返回 |
|---|---|---|---|
| `timeline.getSnapshot` | 读取 sequence 或选定窗口 | `sequenceId,revision?,select?` | validated IR、hash |
| `timeline.query` | 按 ID/range/kind 查询，避免拉全量 | `sequenceId,range?,trackIds?,kinds?` | objects + revision |
| `timeline.validateTransaction` | dry-run | `transaction` | errors、warnings、computed diff、approval |
| `timeline.applyTransaction` | 原子写入 | `transaction` | revision、commitId、diff、inverse summary |
| `timeline.undo` | 撤销当前 actor/指定 commit | `baseRevision,commitId?,scope` | 新 commit |
| `timeline.redo` | 重做可重做事务 | `baseRevision,commitId` | 新 commit |

operation 类型以 [Timeline IR](./04-timeline-ir.md) 为准。服务负责 clip ID 解析、ripple、transition handle、字幕跟随、锁和 inverse；Agent 不手算衍生数组。

### 4.6 Version、Approval、Preview、Export

| Method | 用途 | 关键参数 | 返回 |
|---|---|---|---|
| `version.create` | 命名当前 revision | `name,note,artifactIds?` | versionId、revision |
| `version.list` | 列版本 | cursor | versions |
| `version.restore` | 以新事务恢复 | `versionId,baseRevision` | proposal/commit |
| `approval.get` | 读取待确认项 | `approvalId` | risks、cost、privacy、choices、UI URL |
| `approval.resolve` | 仅用户/授权 UI 解决 | `approvalId,decision,selection` | approval token/state |
| `preview.renderFrame` | 精确帧或缩略图 | `sequenceId,revision,at,size` | image ref + parity warnings |
| `preview.renderRange` | 异步预览片段 | `range,profile` | jobId |
| `quality.run` | 运行结构/媒体/视觉检查 | `sequenceId,revision,profile` | jobId/report |
| `export.start` | 最终导出 | `sequenceId,revision,presetId,output` | preflight/approval/jobId |
| `export.get` | 查询导出 | `jobId` | progress、render report、output |
| `export.cancel` | 取消导出 | `jobId` | state |

MCP Agent 不能自行调用 `approval.resolve` 模拟用户同意；只有 UI session、交互式 CLI 或明确授予 `approve:*` capability 的宿主可用。

### 4.7 当前 MCP stdio 子集

> 2026-08-10 实施状态：已落地 `@agentcut/mcp-server`，使用官方 TypeScript SDK v2 的 `McpServer` 与 `serveStdio`。官方说明要求 stdio server 的 stdout 只承载协议，应用日志写入 stderr；项目 launcher 对构建输出也执行同一隔离。[Server 概览](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md) · [stdio 指南](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md)

| MCP tool | 类型 | 当前行为 |
|---|---|---|
| `agentcut_project_status` | read | 返回紧凑 project/revision、rough-cut、候选计数、job/export 与本地能力 |
| `agentcut_candidates_list` | read | 返回稳定 candidate 文本、source timing、risk、reason、confidence、状态，以及重复/改口/说错的结构化保留段证据 |
| `agentcut_transcript_get` | read | 分页返回稳定 word ID、文本、source timing、ASR confidence 与素材 hash；不返回绝对路径 |
| `agentcut_project_diff` | read | 返回有界 revision 间的 transaction 摘要、operation/object ID 与前后 hash；不返回全文或源路径 |
| `agentcut_candidate_approval_request` | guarded write | 为一条 high-risk candidate 创建 revision/payload-bound 待批准项，不编辑 Timeline |
| `agentcut_approval_get` | read | 查询批准状态；仅批准且未漂移时返回一次性精确 token |
| `agentcut_approval_apply` | guarded write | 使用 token 应用原批准 payload；stale/deny/expire/change 均拒绝 |
| `agentcut_rough_cut_generate` | guarded write | 生成候选，只提交 `low + definite_remove`（2026-08-11 起该集合仅含高置信填充词，停顿一律 `suggest_remove`，见开发记录同日条目）；其余留给人审 |
| `agentcut_semantic_analyze` | guarded write | 运行本地语义候选分析，不批准高风险删除 |
| `agentcut_semantic_findings_propose` | guarded write | 接收外部 Agent 的 revision-bound 语义发现；daemon 二次验证后仅持久化 high-risk 建议，不删除内容 |
| `agentcut_export_start` | guarded write | 在审阅完成后创建精确 revision-bound 本地导出 job |
| `agentcut_export_get` | read | 查询进度、终态、质量报告与本地产物 URL |
| `agentcut_export_cancel` | guarded destructive write | 用稳定 request ID 请求取消 pending/running 导出；成功终态不回滚，响应丢失后查询原 job |

写工具输入都必须包含非负 `baseRevision` 和 1–128 字符的调用者自有稳定 `requestId`。服务不替 Agent 生成幂等键；相同意图重试才复用 ID，revision conflict 后必须重新读取有界 diff 与 status 并重新规划。成功的 `structuredContent` 使用 `status`、`candidates`、`diff` 或 `export` envelope，失败使用 `error` envelope 并保留 daemon 的 HTTP status、code、message、details。

MCP 配置示例见仓库 README。Studio 为每个工程创建 mode-0600 bootstrap credential；launcher 通过 `AGENTCUT_PROJECT_ROOT`/`AGENTCUT_AGENT_CREDENTIALS` 读取它，daemon 只持久化 session token hash。每个 session 绑定 project、client、过期时间与显式 capability；当前默认集合为 `project:read`、`transcript:read`、`analysis:local`、`analysis:propose`、`timeline:write:low_risk_only`、`approval:request`、`timeline:write:approved`、`export:write`。受保护 Agent route 的允许和拒绝均追加到 SQLite access audit，但不会推进 Timeline revision。

`transcript:read` 与 `analysis:propose` 刻意拆分：只读 Agent 可分页检查文稿但不能制造候选；提交 Agent 也必须使用当前 `baseRevision + requestId`。提交体必须包含 1–100 项，每项只接受既定语义分类、稳定 word range、0–1 confidence 与 500 字以内说明。daemon 不信任 MCP/CLI 的前置 schema：它独立检查字段、Transcript ID 是否存在、范围顺序、前后保留关系、重复/改口文本证据和候选重叠；没有任何 finding 通过时拒绝且不推进 revision，通过时也只写 `artifact.put`，没有 `range.deleteRipple`，所以任何高风险内容仍须进入 Studio 试听/批准流程。对于 repetition/restatement/correction，通过门禁的 keep range 会原样写成 `retained_comparison` 证据；后续 Studio 与 Agent 查询直接读取该结构，不从 `explanationZh` 抽取范围。

候选生成器在 CandidateSet 上持久化 `evidenceContracts: ["retained-comparison-v1"]`，使证据保证不随 detector 改名或升级丢失；候选读取另返回 `evidenceStatus`。声明该 contract 的对照型候选只能是 `structured`；历史 artifact 没有持久化保留段时返回 `legacy_missing`，Studio 明示用户按原片上下文和删除效果试听，Agent 也不得把中文说明当作可机器核验的范围。

候选读取还可能返回 `overlapCandidateIds`、`overlapDecisionAnchorId` 和决定后的 `overlapResolvedByCandidateId`。这不是提示性元数据：同一连通重叠组只有 anchor 可提交；daemon 对 UI 与 Agent approval/apply 都重新计算并强制检查。anchor 的单次 transaction 会把非主项登记为 source-bound 替代锁，恢复 anchor 时整组恢复。Agent 不得把非主项拆成多个请求，也不得把 overlap-resolved 状态解释为该候选被单独删除。

Studio 用户面会投影不含 token/token hash 的 session 元数据与访问计数，并能撤销有效 session。撤销使用调用者 request ID 幂等记录 append-only lifecycle event；session 的 `revoked_at` 与事件在同一个 SQLite transaction 内持久化。随后任何能力请求都以 `revoked` 拒绝并追加 access audit，关闭重启不会恢复权限。Agent CLI/MCP 不暴露 list/revoke 管理工具，避免 Agent 自行清理审计或撤销竞争者。

跨任务交接复用同一 session 状态机，不增加第二套 ticket 真相源。`agentcut-agent handoff create` 用永久 bootstrap 只做一次 session 签发，再把 daemon loopback origin、公开 session descriptor 与 access token 原子发布到调用者指定的 mode-`0600` 文件。命令要求显式 client ID、一个或多个最小 capability、稳定 request ID、TTL 和输出路径；stdout 只返回文件路径、session ID、到期时间与 SHA-256 指纹。后续 CLI/MCP 读取该文件后直接使用 delegated session，不再读取 bootstrap，也不会再次调用 `/api/agent/sessions`。相同签发请求和相同文件可幂等恢复；不同内容拒绝覆盖，非 loopback URL、宽松文件权限或篡改 schema 均 fail closed。文件不是新真相源：SQLite session 的 expiry/revocation/access audit 仍是权威状态，daemon 重启后继续执行。

当前 server 只连接一个已启动的本地 daemon，不接收源媒体路径、不上传文件、不暴露 SQL/JSON Patch/raw FFmpeg，也没有候选接受、保留、连续文字删除或高风险确认工具。后四类决定仍只能由 Studio 用户完成。Studio 私有读取与写入路由要求由独立 mode-0600 UI bootstrap 换取的签名 HttpOnly cookie：工程/文稿/Alpha API、源媒体 Range、字幕/成片下载和所有用户写入均受保护，静态 shell、配对状态与最小 health 除外。配对、写入允许、缺失、伪造、过期及被拒绝的私有读取写入 SQLite `ui_access_events`，不推进 Timeline revision；成功媒体 Range 不逐块记录，避免长视频播放制造无界审计噪声。Agent 映射路由继续只看 capability session，不接受 UI cookie 代替 Agent 授权。导出取消同时开放给 Studio 和持有 `export:write` 的 Agent，但只改变 job/work artifact，不提供 Timeline 或已成功产物的回滚旁路。

该浏览器 session 防止未配对 loopback 调用直接冒充 Studio 用户，但不是同一账号下恶意本地进程的系统级沙箱：能读取工程 `.agentcut-runtime/ui-access.json` 的进程仍可重新配对。启动器把含 secret fragment 的配对 URL 打印到本地终端；页面换取 cookie 后立即清理地址栏，且不写 localStorage。

UI bootstrap 现支持本地用户轮换。正式 daemon 使用 credential path 而不是启动时复制一份永不变化的环境变量；credential 文件以同目录临时文件、`fsync`、原子 rename 和 mode `0600` 发布下一代，Cookie HMAC 随新 secret 变化，所以其他浏览器旧 Cookie 立即失效。轮换响应直接给当前浏览器签发新 Cookie，不把新 bootstrap 放进 JSON。文件内只保留旧/新 SHA-256 指纹、代次、request ID 与时间，SQLite `ui_credential_rotations` 幂等记录同一元数据；文件发布后若进程中断，下一请求/重启会从 `lastRotation` 补审计。重复 request ID 不生成第二个 secret，Timeline revision 与 Agent sessions 均不改变。

已验证边界：官方 MCP client 可通过根 launcher 完成 stdio 初始化、既有 11-tool discovery、能力会话创建、只读 diff、revision-bound 写调用、结构化冲突、approval request/get/apply 和导出取消；第二个独立 MCP stdio host 也可只凭 mode-`0600` delegated session 文件读取同一 daemon，全程不触发 bootstrap session 创建。新增 Transcript/语义提交后工具面为 13 项；官方 client 的纯内存 contract 已实测 13-tool discovery、分页参数、语义提交透传与 schema 拒绝，typed client 与 daemon 集成测试另覆盖路径隔离、独立 capability、high-risk-only、幂等、payload 冲突和 stale revision。本批完整 stdio + HTTP 假 daemon E2E 因执行环境拒绝临时 loopback 监听而待补跑。未知/过期/权限不足/已撤销的 session 会拒绝并留下审计事件。浏览器写路径另行覆盖无 cookie、伪造/过期 cookie、HttpOnly 配对、原子 bootstrap 轮换、旧 Cookie 失效、重复请求、发布后崩溃补审计和跨 daemon 重启；Agent 映射写无需、也不能借用 UI cookie。导出 job 已覆盖 pending/running 取消、AbortSignal、成功竞态、稳定 request ID 审计、重启保持 cancelled，以及 interrupted job 的 verified adoption 或 `outcome_unknown` 查询。临时工程还验证了不同 CLI session 的批准接力、apply 后 daemon 重启持久化，以及 commit 后/consume 前崩溃的幂等收敛。自动化跨宿主读取已覆盖，但仍缺一个用户可见的真实新 Codex 任务用交接文件恢复并完成冲突/撤销矩阵，因此不能把此子集写成完整 G3。

## 5. CLI

> 2026-08-10 实施状态：已落地 daemon-backed JSON 子集 `status`、`candidates`、`transcript get`、`project diff`、`rough-cut generate`、`semantic analyze|propose`、`export start|get|cancel`，以及不输出 secret 的 `handoff create`。它通过工程 bootstrap 换取限时 capability session，或直接消费已签发的 delegated session 文件；revision-bound 写入要求 `baseRevision + requestId`，取消要求 `jobId + requestId`，并保留 daemon 的结构化错误与退出码。`semantic propose` 只读取显式 JSON 文件，不把自由文本直接拼入命令或 Timeline。候选人工接受、保留、连续文字补删和高风险确认暂不暴露给 Agent CLI，仍必须在 Studio 完成。下列完整命令面仍是 P3 目标，不应误写为已全部实现。

```text
agentcut init [DIR] --name NAME
agentcut open [DIR] [--no-browser] [--readonly]
agentcut doctor [--json]
agentcut project info|diff|versions
agentcut asset import FILE... [--copy|--reference] [--role main|broll|reference]
agentcut asset list|get|relink|proxy
agentcut analysis start|get|cancel --kind KIND
agentcut workflow start|get|resume|cancel --workflow talking-head
agentcut timeline get|query|validate|apply|undo|redo
agentcut style analyze|get|propose
agentcut preview frame|range
agentcut quality run
agentcut export start|get|cancel --preset vertical-1080p
```

要求：

- 所有命令支持 `--json`，stdout 只输出协议 JSON；日志到 stderr。
- 写命令要求 `--base-revision` 或 transaction 文件中的 revision。
- `--dry-run` 映射到 validate/preflight。
- CLI 不暴露 raw SQL、raw FFmpeg 或直接编辑 project JSON。
- exit code：0 成功，2 validation，3 conflict，4 approval，5 capability，6 job failed，7 internal。

已实施子集使用同一退出码，并可通过 `AGENTCUT_DAEMON_URL` 或 `--url` 指向当前单工程 daemon；`AGENTCUT_PROJECT_ROOT` 指向 Studio 工程 bootstrap，`AGENTCUT_AGENT_CREDENTIALS` 既可指向 bootstrap，也可指向 `handoff create` 生成的 delegated session 文件。通过 pnpm 调用时使用 `pnpm --silent agent -- ...` 保持 stdout 为单一 JSON。`status` 不返回完整逐词 Transcript；`candidates` 使用审计投影返回稳定文本、源时间、风险、原因和状态，`project diff` 只返回有界事务元数据，避免 Agent 依赖 Studio 内部对象。`SEMANTIC_REVIEW_UNAVAILABLE`/`PROVIDER_UNAVAILABLE` 归入 capability=5；缺少/无效凭据、宽松的交接文件权限和失效 session 也 fail closed 为 5；`export get` 即使 HTTP 查询成功，只要 job 已 `failed/cancelled/outcome_unknown` 仍返回 job-failed=6，不能误报成功。

## 6. TypeScript SDK

```ts
const client = await AgentCutClient.connect({ projectRoot: process.cwd() });

const snapshot = await client.timeline.getSnapshot({
  sequenceId: "sequence_main",
  select: { tracks: ["video", "caption"] }
});

const draft = {
  transactionId: createId(),
  idempotencyKey: "agent:remove-fillers:17",
  projectId: snapshot.projectId,
  sequenceId: snapshot.sequenceId,
  baseRevision: snapshot.revision,
  actor: { kind: "agent", id: "my-agent" },
  reason: "Apply user-approved low-risk filler removals",
  preconditions: [],
  operations: approvedCandidates.map(toDeleteRangeOperation)
};

const validation = await client.timeline.validateTransaction(draft);
if (validation.approvalRequired) {
  // Surface approval to the user; do not fake approval.
}
const commit = await client.timeline.applyTransaction(draft);
```

SDK 生成类型来自 protocol JSON Schema，并提供：分页、job polling/stream、abort signal、自动 request ID；默认不自动重试写请求，除非同一 idempotency key 且服务明确返回 retryable。

## 7. 幂等性

- 所有有副作用请求必须带 `idempotencyKey`；作用域为 project + client identity。
- 相同 key + 相同 canonical payload：返回原结果。
- 相同 key + 不同 payload：`IDEMPOTENCY_KEY_REUSED`。
- Job 重试沿用 job ID/attempt；付费 Provider 出现 outcome unknown 时禁止自动新建 attempt。
- 导入按 file identity + content hash 去重；用户可以显式选择创建第二个 logical asset。

## 8. 事务与撤销

- `timeline.applyTransaction` 全部 operation 原子成功或失败。
- validate 与 apply 之间仍需 apply 端重新校验 revision/locks。
- inverse 由服务根据 before state 生成；Agent 不能提供自称正确的 inverse。
- undo/redo 也是新 commit，因此保留审计和并发语义。
- batch 分析不应生成一个巨型不可审查 transaction；按语义 proposal 分组，但用户接受的一组必须原子。

## 9. 用户确认策略

Approval reason：

- `content_high_risk_delete`
- `user_lock_override`
- `paid_provider`
- `media_upload`
- `generated_asset`
- `large_batch_change`
- `destructive_version_restore`
- `final_export_overwrite`

每个 approval 包含：具体对象/范围、before/after 摘要、原因、风险、预算、Provider/数据上传、可选项、过期时间和绑定 payload hash。Token 只对同一 payload/revision/范围有效。

## 10. 权限模型

Capability 示例：

```text
project:read
asset:import
analysis:local
analysis:network
timeline:read
timeline:write
timeline:write:low_risk_only
version:write
preview:render
export:write
provider:paid
lock:override
approve:content
approve:cost
```

当前已实施 MCP session：`project:read analysis:local timeline:write:low_risk_only approval:request timeline:write:approved export:write`。`timeline:write:approved` 只能消费用户已在 Studio resolve、且 revision/payload hash 未变化的一次性批准，不能自行解决 approval。`export:write` 只允许不覆盖旧成片的 revision-bound 本地导出；网络、付费、媒体导入、任意 timeline 写、人工批准、导出覆盖和锁绕过均不授予。

## 11. 冲突处理

### 11.1 Revision conflict

返回：current revision、changed object IDs、conflicting operation indexes、可安全重放的 operation indexes。Agent 可：

1. `project.diff(fromRevision)`；
2. 重新读取受影响对象；
3. 仅重建冲突操作；
4. 用新 idempotency key 和 base revision 提交。

服务不能自动 rebase 涉及 ripple、split、range delete 或字幕时间映射的操作。

### 11.2 锁冲突

返回 lock owner/scope/note。Agent 应跳过或发起 `user_lock_override` approval，不能把 clip 复制到别处规避锁。

### 11.3 Job 与 revision 漂移

分析 artifact 绑定 asset hash，不因 timeline revision 漂移而失效；edit proposal 绑定 revision。应用旧 proposal 时必须重新校验 source mapping，并可能返回 `PROPOSAL_STALE`。

## 12. 错误码

| Code | Retry | 含义 |
|---|---:|---|
| `INVALID_ARGUMENT` | 否 | schema/字段错误 |
| `PROJECT_NOT_OPEN` | 条件 | session 或 daemon 状态 |
| `PROJECT_LOCKED` | 条件 | 另一 daemon 持有写锁 |
| `REVISION_CONFLICT` | 是 | base revision 过期 |
| `LOCK_CONFLICT` | 条件 | 命中用户锁 |
| `PRECONDITION_FAILED` | 是 | object hash/range/asset 状态变化 |
| `APPROVAL_REQUIRED` | 是 | 需要用户决定 |
| `APPROVAL_EXPIRED` | 是 | payload/revision 改变或超时 |
| `CAPABILITY_DENIED` | 否 | session 无权限 |
| `UNSUPPORTED_MEDIA` | 条件 | codec/container 不支持 |
| `UNSUPPORTED_OPERATION` | 条件 | renderer/版本无能力 |
| `ASSET_OFFLINE` | 是 | 需 relink |
| `PROPOSAL_STALE` | 是 | proposal 基于旧状态 |
| `BUDGET_EXCEEDED` | 条件 | 预算不足 |
| `PROVIDER_OUTCOME_UNKNOWN` | 否自动重试 | 可能已扣费 |
| `JOB_FAILED` | 见 details | 异步任务失败 |
| `INTERNAL_ERROR` | 条件 | 带 audit ID，不泄漏 secrets |

## 13. 工具表面验收

- Codex、Claude Code、OpenCode 至少各跑一次 MCP contract suite。
- CLI JSON 与 SDK result 对同一 fixture 完全等价。
- 重复请求、断线重试、两个 Agent 并发、审批过期、项目锁、崩溃恢复有自动测试。
- 恶意 transcript 中的“执行命令/上传文件”文本不能改变工具调用或权限。
- 任意 tool error 都能区分 validation、conflict、approval、capability、provider 和 internal。
