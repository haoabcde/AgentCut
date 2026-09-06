# @agentcut/otio-interop

AgentCut Timeline IR ↔ OTIO 边界适配器（ADR-001：IR 是唯一事实源，OTIO 只出现在边界，序列化/解析一律走 [OpenTimelineIO 官方库](https://github.com/AcademySoftwareFoundation/OpenTimelineIO)，不自写解析器）。首版只做 **导出**（IR → .otio），导入为第二优先级。

## 依赖

- Node 侧：`@agentcut/timeline-schema`（workspace）。
- Python 侧：`python3` + 官方库 `opentimelineio`（≥ 0.18，开发与验证基线 0.18.1）：

  ```bash
  python3 -m pip install --user opentimelineio
  ```

官方库缺失时 `exportTimeline` 抛出带安装提示的错误；集成测试自动 skip 并在报告中保留 skip 原因。

## 用法

```ts
import { exportTimeline } from "@agentcut/otio-interop";

const result = exportTimeline(document, {
  outPath: "out/timeline.otio",
  projectRoot: "/path/to/project", // 可选：把工程相对 asset URI 解析为 file:// URL
});
result.otioPath;            // 写出的 .otio 文件
result.lossReport;          // 机器可读 loss report（JSON）
result.lossReportMarkdown;  // 人类可读 loss report（Markdown 表格）
```

重新生成可审阅样例（`samples/`）：`pnpm --filter @agentcut/otio-interop samples`。

## 架构：语义全部在 TS，Python 只做哑构造

```
IR document ──buildExportPlan(TS)──> ExportPlan(JSON) ──otio_write.py──> .otio
      │                                                            │
      └── loss 记账（TS）                    otio_read.py（官方库读回）──┘
                            comparePlanToReadback(TS) → 等价/分歧
```

- `src/plan.ts` 完成全部 IR→OTIO 语义决策（gap 插入、loss 分类、metadata 编码）；`tools/otio_write.py` 只把 plan 逐字段构造成官方库对象，`tools/otio_read.py` 只做读回归一化。Python 端不做任何语义判断——OTIO 语义知识集中在一处，官方库升级时只需回归测试，不需双语义同步。
- 每次导出自动执行 round-trip 验证：官方库读回后与 plan 逐项对比（时间按"同值同率逐位一致、跨值按秒 1e-6 容差"；metadata 按 key 排序后比较——OTIO C++ 核心不保留 key 顺序）。分歧逐条列出路径，绝不让"写坏了"静默通过。

## IR → OTIO 映射表

| IR | OTIO | 说明 |
|---|---|---|
| 活动 sequence | `Timeline` | 只导出活动 sequence；其余 sequence 进 loss report |
| `track.kind: video/audio` | `Track(kind: Video/Audio)` | caption/graphic 轨：丢弃 + loss |
| media clip（asset 可解析） | `Clip` + `ExternalReference` | `sourceRange` 缺省时确定性推导为零起点等长 |
| 非 media clip / asset 缺失 | `Gap` + loss | 保时间、丢内容 |
| clip 间空位 | `Gap` | IR 按位置摆放 → OTIO 顺序排列，由 plan 插入 gap |
| clip 重叠 | 跳过后者 + loss | OTIO stack 无法表达重叠 |
| `enabled:false`、非 0 `streamIndex`、clip.metadata | clip `metadata["agentcut"]` | NLE 不可见，round-trip 可恢复，记 metadata-encoded loss |
| `track.locked/enabled/muted/order` | track `metadata["agentcut"]` | 同上（非默认时记 loss） |
| `{name, start, duration?}` 形状 marker | `Marker`（挂在 Stack 上） | OTIO 的 Timeline 无 markers，时间线级 marker 属 Stack |
| 其他形状 marker、locks、transitions、artifacts、provenance/history、styleSpecs/exportPresets | — | 丢弃 + loss 逐项记账 |
| transform/audio/effects/animations/content | — | 宿主渲染语义，丢弃 + loss（`clip-render-properties`） |
| projectId/revision/sequenceId/canvas/frameRate | timeline `metadata["agentcut"]` | 追溯信息，不参与等价判定 |

时间语义：IR `seconds = value·denominator/numerator`，OTIO `RationalTime: seconds = value/rate`，故 `rate = numerator/denominator` 直线映射，值逐位保留。

## Loss report 两级语义

- **`dropped`**：无法映射，从导出中丢弃，loss report 逐项列出（类别、数量、明细）。
- **`metadata-encoded`**：以 `metadata["agentcut"]` 编码保留，round-trip 可恢复，但 NLE 不识别（不渲染、不参与剪辑行为）。

判定标准：**loss report 之外零差异**——凡不在报告中的信息必须逐位 round-trip。

## 真实 NLE 验证 runbook

`samples/ten-minute.otio`（10 分钟规模、含 gap/禁用 clip/锁定轨/marker）是人工验证素材：

1. **DaVinci Resolve（免费版即可）**：新建工程 → Timelines 面板右键 → Import → Timeline… → 选择 `.otio`（Resolve ≥ 17 原生支持）。核对：2 条轨（Video/Audio）、clip 顺序与命名（`a.mp4`/`b.mp4`/`voice.wav`）、75–90s 处 15 秒空位、360–380s 处 20 秒空位（shape clip 降级）、两条 marker（"开场口误" 48s、"章节二" 150s）、总时长 600s。媒体离线属预期（URI 指向不存在的样例文件），结构正确即可。
2. **Premiere Pro**：经 OTIO 插件/转换工具导入，同样核对结构。
3. 结果（打开是否成功、结构是否一致、截图）记入开发日志并更新本节的验证状态。

**当前状态（2026-09-06）**：开发机未安装任何 NLE，真实打开验证待人工执行；round-trip 等价已由官方库读回自动验证（`src/roundtrip.test.ts`，含篡改必报分歧的负向用例）。
