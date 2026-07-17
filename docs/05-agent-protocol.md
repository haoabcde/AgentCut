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

## 5. CLI

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

默认 MCP session：`project:read asset:import analysis:local timeline:read timeline:write:low_risk_only preview:render`。网络、付费、导出覆盖和锁绕过不默认授予。

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
