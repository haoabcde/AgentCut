# P1 真实媒体与中文 ASR 首轮验证

> 状态：2026-07-18 已处理 3 条真实素材；其中 2 条新增素材只有约 79/92 秒，不满足 G1 的 5–15 分钟样本时长。Gate 仍按 1/5 计，不能据此冻结默认模型或宣称 G1 通过。

## 1. 验证问题

本轮只回答五个可执行问题：

1. 本机真实 MOV 能否无损进入 content-addressed managed media。
2. VFR 视频、音频 stream 和不一致的 container/stream duration 能否精确保存。
3. Apple Silicon 本地 ASR 能否给出中文逐 token 时间戳。
4. Provider 原始结果能否规范化为稳定 ID、单调 source range 的 Transcript。
5. Asset、raw artifact、Transcript 和 job 能否在同一项目中审计、重启和 replay。

## 2. 运行环境与一手依据

- macOS 26.5.2，Apple Silicon arm64。
- FFmpeg/ffprobe 8.1.1；本机 Homebrew 构建包含 GPL codec，只用于开发验证。
- `mlx-whisper==0.4.3`，隔离环境位于 `packages/asr-worker`。
- 模型：`mlx-community/whisper-large-v3-turbo`，本地缓存约 1.6 GB。
- MLX 官方示例明确支持 `word_timestamps=True`：[MLX Whisper README](https://github.com/ml-explore/mlx-examples/blob/main/whisper/README.md)。
- 依赖版本来自 [PyPI mlx-whisper 0.4.3](https://pypi.org/project/mlx-whisper/)，模型体积与文件来自 [Hugging Face model tree](https://huggingface.co/mlx-community/whisper-large-v3-turbo/tree/main)。

## 3. 真实素材

素材是本机已有的中文讲解屏幕录制，不是为测试合成的音频：

| 项目 | 实测值 |
|---|---:|
| Container duration | 241.434459 s |
| 文件大小 | 765,669,362 bytes |
| 视频 | H.264，2930×1738 |
| Nominal frame rate | 60/1 |
| Average frame rate | 5,113,800/144,839，约 35.3 fps |
| Video stream duration | 241.388333 s |
| 音频 | AAC，48 kHz，stereo |
| Audio stream duration | 241.378562 s |
| Managed SHA-256 | `9a2755b480047b80c21d0050fd214836674aaf33dfd168a2fff9393b28dd1ad2` |

素材证明不能用 `frameCount / nominalFPS` 或 container duration 替代真实 stream 时间；AgentCut 将 probe duration 保存为微秒 rational，并保留 nominal/average frame rate。

## 4. 真实转写结果

### 4.1 60 秒截断实验

- 首次模型下载约 3 分 46 秒；缓存后不再下载。
- 59.944 秒音频推理约 11 秒。
- Provider 返回 198 个 timestamp token；规范化输出 188 个，10 个零时长 token 被质量报告丢弃。
- 平均 Provider confidence：0.9710。
- 人为在 60 秒处截断后，尾部出现重复短语和 confidence 约 0.006 的 token。

结论：不能把固定整分钟硬切当默认 chunk 策略。后续长音频分块必须使用 VAD/句界、重叠窗口和低置信尾部处理。

### 4.2 完整 241 秒实验

- 模型已缓存，完整推理约 14.7 秒，约为 16× realtime；该值只代表当前机器和单条素材。
- Provider 返回 754 个 timestamp token；规范化输出 746 个，8 个零时长 token 被丢弃。
- 未发现需要 clamp 的重叠范围；输出 source range 单调。
- 平均 confidence：0.9696。
- 最后 token 结束于约 241.32 秒，没有越过 241.388333 秒的视频 stream。
- 项目写入 revision 2；asset/clip 和 raw ASR/Transcript 分两条 transaction 提交，SQLite 从 genesis replay 到 head hash 一致。

## 5. 已发现的质量问题

### 5.1 专名不能依赖通用模型自动纠正

画面标题可直接确认作品名是“华夏筑影”，ASR 识别为“华夏助影”。因此专名词典和人工纠错必须是 P1/P2 正式能力；纠错只改 Transcript 文本，稳定 word ID 和媒体范围不变。

### 5.2 中文 `word timestamp` 实际常是字粒度

Whisper 输出同时包含单字、标点和少量多字 token。当前 `TranscriptWord` 的 ID 实质是稳定时间 token，不应把一个 Provider token 等同于中文词法词。UI 需要按句/短语聚合显示，删除 Candidate 可以引用多个稳定 ID。

### 5.3 Provider confidence 不是删除置信度

ASR token probability 只表示识别可信度，不能直接推导“应该删除”。Candidate confidence 必须由独立的停顿/语气词/重复检测器产生，并保留不同 provenance。

### 5.4 Metal 是运行能力，不是隐含前提

MLX 在普通沙箱内返回 `No Metal device available`，在获准的本机进程中可运行。Runtime capability 必须显式报告 `metal_available`，job 失败要进入 retryable/diagnostic 状态。

## 6. 已形成的可执行资产

- `@agentcut/media-ingest`：probe、hash、原子 managed copy、dedupe。
- `@agentcut/asr-engine`：worker runner、Provider normalization、稳定 ID、质量报告、持久化 job orchestration。
- `packages/asr-worker`：固定 Python/MLX 依赖和原子 JSON 输出。
- `scripts/dogfood-ingest-asr.mjs`：把真实媒体和 raw ASR 组成可 replay 的 SQLite 项目。
- 本地忽略目录 `.agentcut/dogfood/project-full/`：真实 managed media、raw artifact、数据库和验证报告；不提交 730 MiB 用户媒体。

## 7. 当前决策

1. `mlx-community/whisper-large-v3-turbo` 保留为 P1 候选，不因单条样本直接成为默认模型。
2. 下一步建立 5 条真实中文口播 gold 子集，至少比较专名、数字、中英混说、停顿和尾部边界。
3. ASR job 先本地执行；默认不上传媒体。
4. Candidate detector 在稳定 Transcript 之上工作，不解析 MLX 原始 JSON。
5. P1 G1 仍未通过：目前是 1/5 素材，且还没有人工标注 CER/边界准确率。

## 8. 第二批：两段用户提供的正面口播 MP4

两段素材均为真实 1280×720 H.264 Main、30 fps CFR、AAC-LC 48 kHz stereo。用户同时提供 360×203 预览图和 1280×720 原图作为构图参照；画面为正面人物口播，右侧有前景植物。

| 项目 | `2f03…432.mp4` | `8be1…46e.mp4` |
|---|---:|---:|
| Container duration | 91.733333 s | 78.766667 s |
| Audio duration | 91.690 s | 78.720 s |
| 文件大小 | 3,414,565 bytes | 3,006,928 bytes |
| Managed SHA-256 | `88a47f…fd21` | `e536a1…cf64` |
| Provider / normalized token | 226 / 226 | 258 / 243 |
| 平均 confidence | 0.9588 | 0.9429 |
| 不可靠 segment / token | 0 / 0 | 5 / 15 |

第二段 raw worker 输出暴露两个必须修复的问题：Python `json.dump` 默认会写入非标准 `NaN`，Node `JSON.parse` 拒绝读取；模型在音频尾部还生成了高 temperature、高 compression 或极低 logprob 的 fallback 幻觉。Worker 现在递归把非有限浮点转换成 `null` 并使用 `allow_nan=False`，normalizer 会丢弃不可靠 provider segment，并使用实际音频时长丢弃或 clamp 越界 token。

修复后两段的最后 token 分别结束于 91.66 秒和 77.40 秒，均未越过音频 stream；没有 overlap clamp 或 out-of-bounds token。两个 ingest 工程都以 revision 2、2 条 command 完成 genesis replay。对应本地忽略目录为：

- `.agentcut/dogfood/sample-02-project/`
- `.agentcut/dogfood/sample-03-project/`

这些短片扩大了真实 codec、正面口播、低置信尾部和术语误识别覆盖，但不能替代 5–15 分钟 benchmark。视觉/听感还提示“图木工程”“事业级风动大平台”“公关”等疑似术语错误，下一步必须由人工 gold 确认，不能在 normalizer 中凭猜测改词。
