# 技术验证进展与决策记录

## 1. 当前结论

截至 2026-07-18，TV-1 已形成可执行基线，TV-2 的内存事务子集已通过 1,000 次随机 trim/inverse round-trip，TV-3 的最小 SQLite/进程崩溃恢复 Gate 已通过；技术验证总 Gate **尚未通过**。缺口主要是完整 typed operation 混合 replay、schema migration/旧版本保护、长项目与断电级恢复、预览/导出 parity、中文 ASR benchmark 和 MCP contract test。

这批实现的目的不是提前开发编辑器，而是用真实代码验证三个高风险判断：

1. Timeline IR 可以在不使用浮点秒的前提下表达 29.97 fps、毫秒和 48 kHz 音频时间。
2. Agent 编辑可以受 revision、前置条件、幂等键、轨道锁和语义锁约束，不需要暴露任意 JSON Patch。
3. 多操作事务可以先在副本执行，全部验证后再提交，并保存 inverse operations；失败不会污染当前快照。

## 2. 已落地的可执行资产

| 资产 | 路径 | 已验证内容 |
|---|---|---|
| IR 0.1 JSON Schema | `packages/timeline-schema/schema/timeline-project-0.1.schema.json` | 结构、精确时间、media/nestedSequence 条件字段、锁 scope、history |
| TypeScript 领域类型 | `packages/timeline-schema/src/types.ts` | Project、Sequence、Track、Clip、Lock、Provenance |
| 结构与语义验证器 | `packages/timeline-schema/src/validate.ts` | dangling reference、全局重复 ID、轨道/clip 兼容、revision 一致性、正 duration |
| Golden fixture | `packages/timeline-schema/fixtures/minimal-project.json` | 29.97 fps 中文口播最小项目 |
| 精确时间引擎 | `packages/timeline-engine/src/time.ts` | BigInt rational、比较、转换、加减、半开区间 overlap |
| 内存事务内核 | `packages/edit-commands/src/engine.ts` | 原子提交、optimistic revision、幂等、precondition、锁、inverse、undo、history hash |
| Typed operations | `packages/edit-commands/src/types.ts` | track add/remove、clip insert/remove/move/trim/replace/update、lock add/remove |
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
- SQLite 使用 WAL + `synchronous=FULL`；两个连接基于同一 revision 写入时只有首个成功，后一个显式收到 `REVISION_CONFLICT`。
- 在 begin、apply、command insert、state update、checkpoint、commit 前和 commit 后分别杀死真实子进程；commit 前恢复 revision 0 且无 command，commit 后恢复 revision 1 且 command 可 replay。
- 幂等 payload hash、command record、inverse、current snapshot 与 checkpoint 在同一数据库事务中提交；关闭并重开后重复请求不产生第二次提交。

本地统一验证命令：

```bash
pnpm install
pnpm check
```

`pnpm check` 依次执行 workspace build、TypeScript strict typecheck 和 Vitest。构建配置排除测试文件，测试只扫描 `src`，避免生成目录造成重复计数。

## 4. 当前没有证明什么

以下能力仍是设计，不应被描述成“已经完成”：

- 当前 crash harness 证明进程 `SIGKILL` 和双连接抢写下无半提交；它不等于断电/磁盘损坏证明，尚未做 WAL 字节破坏、磁盘写满和真实掉电测试。
- 当前只实现 10 种核心 operation，未实现 split、ripple range delete、caption/transition 专用命令。
- 重启后的 undo/replay 已覆盖单一 fixture；尚未覆盖全部 operation 混合序列、10 分钟项目规模和跨 schema 版本 replay。
- JSON Schema 能验证结构与部分引用，但尚无 schema migration runner、旧 major 只读模式和 bundle round-trip。
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

## 6. 下一批实施顺序

1. 将当前 1,000 次 property test 扩展到全部 operation 混合序列，并用 DB replay 验证 hash。
2. 补 `clip.split`、`range.delete(ripple)`、caption/transition 专用命令及锁交叉测试。
3. 实现 0.1 -> 下一 fixture 的纯 migration runner、dry-run report 和未知 major 只读保护。
4. 增加 10 分钟项目、磁盘写满/WAL 损坏等恢复测试，明确 SQLite 可靠性结论的边界。
5. 完成上述数据正确性 Gate 后，再启动 PreviewAdapter/FFmpeg parity 与 MCP contract spike。

TV-3 的最小进程崩溃 Gate 已通过，但只有第 1–4 项继续通过，数据正确性 Gate 才能整体关闭；本文件不会把 `SIGKILL` 测试外推成断电或存储损坏可靠性结论。
