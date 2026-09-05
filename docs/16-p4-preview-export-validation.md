# P4 剪后预览与可靠导出验证

> 状态：2026-08-10 实现、自动化协议、崩溃窗口恢复和真实 libass 成片机器 Gate 已通过；人工完整听审 cut 边界仍待完成，不据此宣称主观质量 Gate 通过。

## 1. 验证边界

本轮只验证单一 Transcript 绑定视频素材和一条启用的主视频轨。Timeline IR/SQLite 是唯一真相源；Preview 与 Render 不读取前端临时删除状态，也不支持多素材、B-roll、转场、time warp 或多轨混音。

## 2. 共享时间线求值

`evaluateTimelineSegments` 负责校验：恰好一条启用视频轨、连续且从零开始的 clip、source/timeline duration 相同、素材绑定 Transcript、无 transition/effect/time warp。RenderPlan 在该结果上补媒体路径、stream ordinal、字幕 cue 和 plan hash；daemon 则只投影为秒制 `PreviewSegment`。

固定映射用例：

```text
timeline 0–3 s  -> source 0–3 s
timeline 3–8 s  -> source 5–10 s
source 3–5 s    -> 已删除
```

测试确认 timeline seek 4 秒定位 source 6 秒；第一段播放到 source 3 秒后跳到 source 5 秒；最终 timeline duration 为 8 秒。候选循环试听绕开该控制器，继续使用 source time。

Studio 的紧凑时间线同样只使用 canonical PreviewPlan 坐标：总时长取 `preview.durationSeconds`，播放头在当前初剪模式直接使用 timeline time，在原片或只读虚拟删除预览中则先恢复 source position、再投影回 canonical timeline。候选标记也把 source range 两端投影到 timeline；已经删除的 source 区间折叠到右侧 cut boundary（尾部删除折叠到 timeline end），不会继续占据可播放时长。时间线点击 seek 始终退出虚拟预览并定位 canonical PreviewPlan，候选原片循环试听仍明确保留 source time。

### 2.1 浏览器兼容代理不改变剪辑身份

- H.264/AAC MP4/M4V 视为当前 HTML video 的直接播放白名单，不生成代理；HEVC、MOV 等其他组合保守进入本地 FFmpeg 代理路径。
- 代理固定为 `browser-h264-aac-1280-v1`，最大边 1280、保持显示比例、H.264 Main/yuv420p + AAC 48 kHz stereo。临时文件经 codec、音轨和时长差 `<=40 ms` 验证后，才在同一目录无覆盖原子发布；同 source/profile 续跑会验证并收养既有文件。
- Timeline 以版本化 metadata 记录代理绑定：source Asset ID、source content hash 与 profile。代理自身是 `generated Asset`；validator 拒绝 source hash 漂移、错误 Asset kind、自引用和重复 profile。
- daemon 的 `/api/review.media.assetId` 仍返回 Transcript 所属 source Asset；只有 `media.url` 和 `media.playback.assetId` 可指向代理。Preview segments、clip、Transcript、候选、锁和 RenderPlan 全部继续返回 source Asset ID，Studio 同时显示“本地兼容代理 · 时间与剪辑仍绑定原片”。
- 自动化用真实 FFmpeg 合成 HEVC/hvc1 MOV，完成代理生成、建项事务、ASR 假执行、SQLite 重开和同目录幂等续跑；它是离线工程 fixture，不是授权真实 Alpha 项目，也不证明 HDR 色彩或主观画质 Gate。

## 3. 持久化导出协议

- `POST /api/exports` 绑定 `baseRevision + requestId`，只接受 `rough_cut_ready` 工程。
- job 创建前运行 FFmpeg doctor；ASS、H.264、AAC、PingFang 或磁盘任一能力缺失均拒绝排队并返回完整 missing 列表。
- `runPersistedRenderJob` 先写 `.work-*`，生成烧录字幕 MP4 和 SRT；ffprobe 检查时长误差不超过 40 ms、原始尺寸和音轨，随后才原子移动并登记 output asset、caption artifact 与 render report。
- runner 在 FFmpeg 开始前和输出发布前重算所有实际引用输入的 SHA-256，并与 Asset registry 的 `contentHash` 比较；崩溃恢复收养成片前执行同一校验。缺失素材返回 `SOURCE_NOT_FOUND`，字节漂移返回不可重试的 `SOURCE_INTEGRITY_FAILED`，不登记错误 provenance，也不覆盖已有文件。
- 成功文件名绑定 project、revision 和 plan hash；已有输出不会被覆盖。
- daemon 重启会继续 pending job；running job 若已完整登记 output/report 则幂等标记成功。若 MP4/SRT 已发布但 Timeline 登记尚未发生，daemon 会重建同 revision RenderPlan，逐一验证确定性文件名、SRT 字节、ffprobe 质量、尺寸、音轨、时长和文件 hash，匹配后收养文件并补交 output/caption/report 事务。
- 若只剩单边文件或文件与当前 plan 不匹配，原文件进入保留状态而不覆盖，job 标记 `outcome_unknown`。用户用新 requestId 安全重试时，runner 会再次尝试收养完整匹配对；不能收养则写入带 job hash 的 `safe-retry-*` 新文件名，旧文件原样保留。
- `POST /api/exports/:jobId/cancel` 与 Agent 映射路由使用稳定 request ID。pending job 立即 cancelled；running job 先持久化 `cancelRequested`、发出 AbortSignal，再由 render workflow 在规划、源校验、FFmpeg、质量校验和发布前边界收敛为 cancelled。若 job 已 succeeded，取消只记录 `changed=false` 审计，不删除已发布成片。
- `GET /api/exports/:jobId` 是开始/取消响应丢失后的权威结果查询，显式返回 `cancelRequested + canCancel`。重启会保留 cancelled；只有没有取消请求、也无法收养匹配 MP4/SRT 的 interrupted running job 才进入 `outcome_unknown`。

## 4. 当前自动化证据

- render doctor：完整工具链通过、缺少 ASS 明确失败、一次报告全部缺项、macOS MobileAsset PingFang 可发现。
- Render/Preview：共享 Timeline evaluator 和稳定 timeline/source segment projection 通过。
- daemon：export preflight、revision-bound job、状态查询、FFmpeg 缺项、pending 重启、完整已发布输出收养与 interrupted running 诊断通过。
- Studio：初剪未完成时导出禁用；running 显示进度；succeeded 提供 MP4 与 SRT 入口。
- `/api/review.exports` 从 SQLite 投影持久化任务；Studio 刷新后会恢复最新 job，而不是依赖页面内存。
- renderer workflow 测试覆盖真实 H.264/AAC、烧录字幕、SRT、尺寸、音轨、时长差、输入/输出哈希、默认冲突拒绝、匹配输出收养、源字节漂移拒绝、残缺文件保留、替代文件安全重试和失败清理。

## 5. 真实素材 Gate 结果

工程：`/private/tmp/agentcut-roughcut-gate-20260728`；输入为用户提供的 78.766667 秒 1280×720 H.264/AAC 中文口播。

| 检查 | 实际结果 |
|---|---|
| 工具链 | `ffmpeg-full 8.1.2_1`，ASS/H.264/AAC doctor 通过 |
| Canonical 初剪 | revision 4，3 个 retained segment，Timeline 74.623750 秒 |
| 自动决定边界 | 仅删除 2 个 low-risk silence，共 4.142917 秒 |
| 高风险保护 | 3 个 medium silence + 1 个 high repetition 未自动删除，后写 source-range keep locks |
| 输出 | `agentcut-project_e536a169baaaf1e62462c9b0-r4-2014a2e0586c.mp4/.srt` |
| 媒体质量 | H.264/AAC、1280×720、74.590 秒、6,798,249 bytes、20 cue、误差 33.75 ms、passed |
| 字幕 | SRT 独立生成；12 秒抽帧可见白字深描边底部烧录字幕，画面无拉伸 |
| 源文件保护 | 原片和 managed copy SHA-256 同为 `e536a169…cf64` |
| 重启恢复 | `/api/review` 恢复 succeeded job/quality/MP4/SRT；媒体 206，SRT 200 |
| 浏览器刷新 | REV 5、待审 0 / 保留 4 / 删除 2、MP4/SRT 链接恢复；当前初剪为 1:14；warning/error 0 |
| 全仓验证 | 带上述 ffmpeg/ffprobe 环境变量的 `pnpm check`，145/145 tests passed |

导出 job 绑定 source revision 4；登记 output asset、caption 和 render report 后工程 revision 为 5，这是输出登记事务，不会改变 revision 4 的 RenderPlan。

## 6. 尚待人工关闭的质量项

- 从头听完 74.59 秒成片，重点听 50.891021 秒和剪后 64.487041 秒两个 Ripple 边界，记录吞字、截断音节和音画同步听感。
- 对照原文人工标记误删/漏删；当前 ASR 将“土木”“世界级”“攻关”等专名识别为近音字，字幕逐字纠错本阶段明确不做，不能把 ASR 文本当人工 gold。
- “恢复至少一次删除事务”已有既有 API/真实副本与自动化证据，但本次 Gate 为保留最终输出，没有在成功导出后改写工程 revision；恢复不会被用作破坏当前成片的演示动作。
