# 技术验证进展与决策记录

## 1. 当前结论

截至 2026-07-28，TV-1/TV-2 已形成可执行基线，TV-3 已通过最小 SQLite/进程崩溃恢复、全 operation replay、10 分钟规模与可诊断容量/逻辑损坏测试；真实媒体/ASR、一键建项、剪后 PreviewPlan 和持久化导出 job 也已进入实现。P0 数据正确性工程 Gate 已关闭，技术验证总 Gate **尚未通过**；当前主要缺口收敛为 libass 真实成片 parity、全部 cut 边界听审与 MCP contract。

这批实现的目的不是提前开发编辑器，而是用真实代码验证三个高风险判断：

1. Timeline IR 可以在不使用浮点秒的前提下表达 29.97 fps、毫秒和 48 kHz 音频时间。
2. Agent 编辑可以受 revision、前置条件、幂等键、轨道锁和语义锁约束，不需要暴露任意 JSON Patch。
3. 多操作事务可以先在副本执行，全部验证后再提交，并保存 inverse operations；失败不会污染当前快照。

## 2. 已落地的可执行资产

| 资产 | 路径 | 已验证内容 |
|---|---|---|
| IR 0.1 JSON Schema | `packages/timeline-schema/schema/timeline-project-0.1.schema.json` | 结构、精确时间、media/nestedSequence 条件字段、锁 scope、history |
| TypeScript 领域类型 | `packages/timeline-schema/src/types.ts` | Project、Sequence、Track、Clip、Lock、Transcript、Candidate、Proposal、Provenance |
| 结构与语义验证器 | `packages/timeline-schema/src/validate.ts` | dangling reference、稳定 word/candidate identity、source/revision binding、轨道/clip 兼容 |
| Golden + migration fixture | `packages/timeline-schema/fixtures/` | 29.97 fps 中文口播 typed artifacts、合成旧格式迁移 |
| Migration runner | `packages/timeline-schema/src/migrate.ts` | 纯迁移、dry-run report、输入不变、未知/更新 schema 只读保护 |
| 精确时间引擎 | `packages/timeline-engine/src/time.ts` | BigInt rational、比较、转换、加减、半开区间 overlap |
| 内存事务内核 | `packages/edit-commands/src/engine.ts` | 原子提交、optimistic revision、幂等、precondition、锁、inverse、undo、history hash |
| Typed operations | `packages/edit-commands/src/types.ts` | artifact、track、clip split/move/trim/replace/update、Ripple delete、lock |
| Proposal compiler | `packages/edit-commands/src/proposal.ts` | revision/hash 校验、ASR 边界吸附、区间合并、右到左 Ripple transaction |
| SQLite project store | `packages/project-store/src/project-store.ts` | WAL、`BEGIN IMMEDIATE`、revision/command/inverse/idempotency/checkpoint 原子提交、重启 replay 验证 |
| Crash harness | `packages/project-store/test-fixtures/crash-worker.mjs` | 事务 7 个边界真实 `SIGKILL`，重启只暴露最后完整 revision |

`transform`、`content`、effect/provider artifact 的内部字段暂保留为扩展对象。这是有意的边界：它们需要 preview/export parity 和 Provider contract 证据后再冻结，当前 schema 不应伪造尚未验证的稳定性。

## 3. 已验证行为

自动化测试覆盖：

- 合法 golden fixture 通过，fractional time、dangling asset、revision drift、无效 lock reference 被拒绝。
- `30000/1001` 帧率保留为 rational；毫秒、音频 sample 与视频帧可做精确比较。
- 不可精确转换默认报错，只有调用者显式选择 `floor`、`ceil` 或 `nearest` 才允许取整。
- 不同 time rate 的半开区间可直接比较，不强制转成会丢精度的公共 rate。
- 一个事务内的多项修改只产生一个 revision；后续操作或最终 schema 失败时原快照保持不变。
- stale `baseRevision` 被拒绝；同一 idempotency key 重放不会二次提交。
- `deny_agent` range lock 同时阻止 agent/workflow；property lock 只阻止相交字段，不冻结无关字段。
- inverse 作为新事务执行，保留审计历史而不是回写旧 revision。
- 1,000 组随机 start/duration 的 trim -> undo 恢复可编辑状态。
- Proposal payload 被 hash 绑定；毫秒 ASR 范围显式吸附到素材时间单位，相邻删除合并，多个区间从右向左编译。
- split/Ripple 同步维护 timeline/source range；中段删除生成稳定的新 clip ID，后续 clip 前移，锁冲突与 Undo 可验证。
- SQLite 使用 WAL + `synchronous=FULL`；两个连接基于同一 revision 写入时只有首个成功，后一个显式收到 `REVISION_CONFLICT`。
- 在 begin、apply、command insert、state update、checkpoint、commit 前和 commit 后分别杀死真实子进程；commit 前恢复 revision 0 且无 command，commit 后恢复 revision 1 且 command 可 replay。
- 幂等 payload hash、command record、inverse、current snapshot 与 checkpoint 在同一数据库事务中提交；关闭并重开后重复请求不产生第二次提交。
- 14 次混合提交覆盖 0.1 全部 edit operation；SQLite 当场 replay 和关闭重开后的 replay/hash 与 head 一致。
- 合成 `0.0.0` fixture 可纯迁移到 0.1；dry-run 不修改输入，未知 major 与更新 minor 返回只读结果。
- 100 轮随机 split/Ripple 参数与全 operation 生命周期均可逆序 Undo 回初始可编辑状态。
- 10 分钟、1,798 词、90 个候选范围可编译为单个 Proposal transaction，并在 SQLite 重启后 replay/hash 一致。
- `SQLITE_FULL` 容量模拟无半提交并返回 `STORE_CAPACITY`；非法 document JSON 与 state hash 漂移在打开数据库时返回 `STORE_CORRUPT`。

本地统一验证命令：

```bash
pnpm install
pnpm check
```

`pnpm check` 依次执行 workspace build、TypeScript strict typecheck 和 Vitest。构建配置排除测试文件，测试只扫描 `src`，避免生成目录造成重复计数。

## 4. 当前没有证明什么

以下能力仍是设计，不应被描述成“已经完成”：

- 当前 crash harness 证明进程 `SIGKILL` 和双连接抢写下无半提交；它不等于断电/磁盘损坏证明，尚未做 WAL 字节破坏、磁盘写满和真实掉电测试。
- 当前已实现第一阶段需要的 split/Ripple，但尚未实现 caption/transition 专用命令；随机测试覆盖内存生命周期，SQLite 覆盖确定性全 operation 与 10 分钟 Proposal，不等于穷举任意合法命令序列。
- 容量不足由 SQLite page 上限稳定触发，不等于真实宿主磁盘写满；损坏副本覆盖 JSON/hash 漂移，尚未进行原始 WAL 字节注入。
- migration runner 当前只验证合成旧 fixture；尚无已发布旧版、下一真实 schema 迁移和 bundle round-trip。
- 尚未用真实 10 分钟/长 GOP/VFR/多声道素材验证性能、边界和 A/V sync。
- 尚未启动浏览器 preview adapter、FFmpeg compiler、OTIO、ASR 和 MCP 的实测。

## 5. 新增技术决策

### TD-001：时间转换默认必须精确

隐式 rounding 会把剪切边界误差扩散到字幕、锁和渲染。所有转换默认 `exact`；只有 adapter 边界可以显式选择 rounding mode，并必须在 quality report 留痕。

### TD-002：区间采用半开语义

所有 timeline range 使用 `[start, end)`。相邻 clip 在同一边界接触不算 overlap，可避免 delete/lock/transition 出现双重归属。

### TD-003：undo 是新事务

撤销不降低 revision，不抹除旧 history。inverse operations 以新 transaction 提交，使 Agent 行为、人工恢复和冲突都可审计。

### TD-004：property lock 必须按路径相交判断

锁 `/content` 不应阻止移动 `/timelineRange/start`。删除/替换对象视为触及全部属性；move、trim、update 则只检查实际改变的领域路径。

### TD-005：FFmpeg 开发环境与分发构建分离

当前机器的 Homebrew FFmpeg 8.1.1 启用了 GPL 编码器，只可作为本地验证环境。产品分发前必须单独决定 codec 子集、动态/静态链接和许可证履约方案，不能直接打包当前二进制。

### TD-006：command、inverse、head 与 checkpoint 必须同事务提交

SQLite store 采用 WAL、`BEGIN IMMEDIATE` 和唯一 revision/idempotency 约束。任何 command 只有两种外部可见状态：完整提交，或完全不存在。checkpoint 是恢复加速结构，不是第二份领域真相；恢复后仍用 genesis + command replay/hash 对 head 做一致性验证。

### TD-007：ASR 时间不能直接当 Timeline 帧

Transcript 保留 Provider 的精确 source range；提交 Proposal 时才在 adapter 边界显式使用 `nearest` 吸附到绑定 clip 的 source rate，并从 source offset 映射到 timeline。吸附策略必须进入后续 quality report，不能把取整伪装成精确对齐。

### TD-008：Candidate binding 是 revision 快照，不是永久实时外键

Candidate set 在其 `projectRevision` 等于 head 时必须解析到同一 sequence/clip/source asset；Timeline 提交后它成为历史证据，不再要求旧 source range 仍包含于已经裁切的当前 clip。否则任何合法 trim/Ripple 都会使历史 artifact 反向破坏当前文档有效性。

## 6. 下一批实施顺序

1. 启动 P1 ingest/ASR benchmark，用真实中文口播验证 source time、帧吸附和 Ripple cut 质量。
2. 增加 bundle round-trip 和未来真实 schema fixture；在出现真实 0.2 前不夸大合成迁移证明。
3. 在后续硬化阶段补真实临时卷容量限制和原始 WAL 字节损坏，不把当前模拟外推为硬件断电证明。
4. P1 选出默认 ASR 路径后启动 Transcript 审阅壳；PreviewAdapter/FFmpeg parity 与 MCP 按长程 Gate 顺序推进。

P0 数据正确性工程 Gate 已关闭，但本文件不会把 `SIGKILL`、SQLite page 上限和逻辑损坏副本测试外推成真实断电、物理介质损坏或任意命令穷举证明。
