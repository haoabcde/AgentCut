# 实施路线图

## 1. 路线原则

- 先证明 IR/command/recovery/preview parity，再做漂亮 UI。
- 先让一个 10 分钟中文口播可靠完成闭环，再扩展功能和场景。
- 每阶段以 gate 验收，不按“代码写了多少”判断完成。
- 时间估算用 3–5 人小团队的工程周范围，只用于排序；人员能力和全职程度变化时重估。

## 2. 总览

| 阶段 | 目标 | 预计量级 | 退出 Gate |
|---|---|---:|---|
| 技术验证 | 杀死最大技术假设 | 4–6 周 | IR/事务/预览/导出/ASR benchmark 有数据 |
| V0.1 | 中文口播端到端 alpha | 10–14 周 | 真实素材闭环、错删/恢复/导出门槛达标 |
| V0.2 | StyleSpec 与视觉增强 beta | 6–10 周 | 参考风格有可测提升且不破坏可控性 |
| V0.3 | 中文访谈切片 beta | 8–12 周 | 语义完整候选、多 sequence、基础 diarization |
| 桌面化 | 安装/权限/codec 产品化 | 6–10 周 | macOS/Windows 安装升级和崩溃恢复稳定 |
| 云端化 | 可选云任务与协作基础 | 10–16+ 周 | 本地 truth 不变、成本/隐私/租户隔离通过 |

阶段可部分并行，但 Timeline/command/protocol 未过 gate 前不得大规模开发 UI、模板和 Provider。

## 3. 技术验证

### 3.1 目标

用最小、可丢弃的 spike 回答 6 个问题：

1. IR 是否能无损表达口播初剪并 round-trip？
2. command/inverse/transaction 是否能在崩溃和并发下恢复？
3. 浏览器预览与 FFmpeg 导出能否在首发子集保持一致？
4. 中文 ASR + VAD +边界修正能否达到可剪精度？
5. WebCodecs/OpenReel/Diffusion/OpenVideo 哪种 preview path 最可控？
6. 外部 Agent 通过 MCP 操作结构化时间线是否比生成脚本可靠？

### 3.2 功能/实验

- 冻结 Timeline IR 0.1 RFC、JSON Schema、migration fixture。
- 实现内存版 timeline evaluator 与 8–10 种 typed operations。
- SQLite transaction log + revision + inverse + crash injection harness。
- 一个无复杂 UI 的 timeline inspector：导入、列表、split/trim/delete、JSON diff。
- 预览赛马：
  - A：Mediabunny/WebCodecs + Canvas2D/WebGL 自有 adapter。
  - B：OpenReel core adapter。
  - C：Diffusion Studio 或 OpenVideo adapter（仅在许可允许的评估环境）。
- FFmpeg compiler：trim/concat/crop/scale/text/caption/crossfade/audio。
- 20–30 段中文口播 benchmark：FunASR、SenseVoice/WhisperX、至少一个云 ASR。
- MCP contract spike：Codex、Claude Code、OpenCode 各完成同一事务。
- OTIO round-trip 与 loss report spike。

### 3.3 依赖

- 可公开/获授权的中文口播测试集和人工 gold labels。
- macOS Intel/Apple Silicon 与 Windows 至少各一台测试机。
- FFmpeg 合规构建方案；Remotion/OpenVideo 许可初审。

### 3.4 里程碑

- TV-1：Schema + fixtures + property tests。
- TV-2：1000 次随机 command/inverse round-trip。
- TV-3：进程 kill 后 DB 回到最后 commit。
- TV-4：5 类素材 preview/export golden diff。
- TV-5：ASR/candidate baseline 报告。
- TV-6：Preview adapter 决策 ADR。

### 3.5 风险

- WebCodecs codec/设备差异导致 preview 路径分裂。
- 词级时间戳足够转写但不足以直接剪切。
- JSON snapshot 在长项目上卡顿。
- MCP 客户端对大 schema/tool result 的兼容性不同。

### 3.6 验收

- 对 10 分钟 fixture，所有 edit operations 可 replay/undo，hash 等价。
- crash/concurrency 测试无半提交和静默覆盖。
- 首发效果子集 preview/export 通过阈值，或明确列出无法解决的差异。
- 至少一个本地和一个云 ASR 达到后续候选分析可用基线。
- 选出一个 preview path；若没有方案过 gate，缩减 preview 子集而不是假装完成。

## 4. V0.1：中文口播 Alpha

### 4.1 目标

一个外部 Agent 能从新项目到可导出中文口播初剪；用户可在 Web 中修改，Agent 能继续接管。

### 4.2 功能

**Core**

- 本地 daemon、project lock、SQLite store、schema migration。
- Asset/proxy/waveform/filmstrip。
- Timeline evaluator、command bus、undo/redo、versions、locks。
- Job scheduler、artifact store、audit log。

**分析/工作流**

- FunASR provider、一个云 ASR provider、VAD/标点/语义断句。
- silence/filler/stutter/repetition/false-start/restatement 候选。
- 三档风险、对抗复核、approval、talking-head resumable workflow。
- 字幕与 transcript 分离；专名校对。

**Web**

- 素材库、播放器、Transcript、基础多轨时间线。
- split/trim/move/delete/ripple、字幕编辑/样式、缩放、播放头。
- undo/redo、版本、Agent change inspector、approval UI。

**Agent/输出**

- MCP、CLI、TypeScript SDK 0.1。
- 16:9/9:16、固定/分段 crop、基础文字/贴纸、FFmpeg export。
- quality report、cost/privacy report、diagnostics bundle。

### 4.3 依赖

- 技术验证 Gate 全部通过，Timeline/command/protocol 0.1 已冻结。
- 中文口播 gold dataset、发布阈值和回归执行人明确。
- 选定 PreviewAdapter，FFmpeg 合规 build 与分发方式确认。
- 至少一个本地 ASR 和一个可选云 ASR 通过 provider contract。
- Web 交互范围已有可测试 wireflow，避免边做 UI 边改领域模型。

### 4.4 明确延后

高级 style imitation、自动 B-roll/生成、复杂动画、多说话人、多机位、云同步、桌面安装器。

### 4.5 里程碑

- V01-1：项目/素材/时间线/版本闭环。
- V01-2：Transcript + 人工文本剪辑闭环。
- V01-3：自动候选 + director approval。
- V01-4：MCP/CLI 结构化编辑 + conflict recovery。
- V01-5：caption/crop/preview/export。
- V01-6：20 位设计伙伴、50 个真实项目 dogfood。

### 4.6 风险

- 时间线 UI 吞噬资源；限制交互范围，不做特效面板大全。
- 自动剪辑看似可用但错删毁掉信任；默认保守。
- 本地依赖安装复杂；doctor 和 proxy 回退必须先做。
- 用户以为“AI 自动成片”包含 B-roll/生成；产品文案明确 alpha 边界。

### 4.7 验收

- [产品定义](./02-product-definition.md) 的 6 个 V0.1 场景全部通过。
- `definite_remove` precision、边界、恢复、并发、导出和隐私指标过门槛。
- 至少 80% 设计伙伴项目不离开 AgentCut 即可完成粗剪+字幕+基础竖屏版本；专业后期可导出 NLE interchange。
- P0 数据损坏/静默错删为 0；已知 preview approximation 全部可见。

## 5. V0.2：StyleSpec 与视觉增强 Beta

### 5.1 目标

让参考视频的可复用规律进入可解释的 StyleSpec，并在不牺牲内容正确性时提升成片完成度。

### 5.2 功能

- Reference analysis：shot、节奏、caption、highlight、graphic、zoom、B-roll、composition、music beat。
- StyleSpec inspector、维度选择、rule provenance、apply proposal、before/after preview。
- 人物跟踪、分段 crop keyframes、构图人工调整。
- 关键词高亮、重点文字、贴纸/图形受限 primitives。
- 素材策略 local/stock/generated/mixed；stock 与一个图片/视频生成 provider。
- 用户偏好：可查看规则、来源、接受/拒绝统计、重置。
- export presets 与多个平台变体。

### 5.3 依赖

- StyleSpec 主观评测设计；获得授权的参考视频集。
- face/subject tracking 方案；素材 Provider 的许可/归因策略。
- 可选动态视觉 adapter 的商业许可结论。

### 5.4 里程碑

- V02-1：StyleSpec 0.1 + analyzer benchmark。
- V02-2：rule -> transaction proposal + diff。
- V02-3：caption/graphic/crop 视觉子集 parity。
- V02-4：素材来源/预算/审批闭环。
- V02-5：A/B 用户盲评。

### 5.5 风险

- 风格分析输出空泛标签，不能转为操作。
- “像参考”诱导逐镜头复制或品牌侵权。
- 自动视觉装饰造成廉价感、信息过载。
- 生成素材成本和等待时间破坏本地工作流。

### 5.6 验收

- 至少 5 个 StyleSpec 维度能稳定生成 typed constraints/operations。
- 用户盲评中，StyleSpec 版本的“风格接近度/完成度”显著高于基础版，同时信息完整度不下降。
- 100% style-derived command 可回溯 rule/evidence。
- 默认 local-only 下无外部请求；生成成本事前可见、事后可核。

## 6. V0.3：中文访谈切片 Beta

### 6.1 目标

从长访谈生成少而精、语义完整、可追溯的短片候选，并支持单/多机位基础编辑。

### 6.2 功能

- diarization、speaker alias/role confirmation、overlap 标记。
- topic/discourse segmentation、claim/story/conflict/quote extraction。
- context/coreference reviewer、多维评分、diverse shortlist。
- source/generated-text Hook；主持人问题保留策略。
- 每个候选创建独立 sequence，共享 assets/artifacts。
- 单机位 reframe、双机位音频对齐与基础 active-speaker cut。
- speaker labels、dynamic captions、批量多平台 export。

### 6.3 依赖

- pyannote/FunASR/云 diarization benchmark 与模型许可。
- 访谈人工标注集、多机位同步 fixtures。
- nested/multi-sequence IR 扩展通过 RFC。

### 6.4 里程碑

- V03-1：speaker/topic artifacts。
- V03-2：grounded candidate + context verifier。
- V03-3：multi-sequence candidate UI。
- V03-4：single/multicam visual edit。
- V03-5：用户 shortlist study。

### 6.5 风险

- diarization 和姓名识别被混淆。
- 断章取义造成品牌/法律风险。
- 候选数量 KPI 迫使系统输出垃圾。
- 多机位与 nested sequence 让 IR 过度复杂。

### 6.6 验收

- [访谈工作流](./07-interview-workflow.md) 的 6 个验收场景通过。
- 硬阻断候选不进入自动 shortlist；generated Hook 100% 有 grounded evidence。
- 设计伙伴对候选的接受率和人工节省时间达到技术验证前设定阈值。

## 7. 桌面化

### 7.1 目标

把已经验证的 local daemon + Web 产品包装为可安装、可升级、可诊断的 macOS/Windows 桌面体验，不产生第二套业务核心。

### 7.2 进入条件

只有 Web+daemon 已证明价值，且安装、权限、codec、进程生命周期成为主要障碍时进入。优先评估 Tauri；Electron 仅在 Tauri 的 WebView/codec/插件限制不可接受时采用。

### 7.3 功能

- 签名安装器、自动更新、协议/文件关联。
- daemon/worker 生命周期、系统 keychain、文件选择权限。
- FFmpeg/模型组件按需安装与合规 notice。
- 崩溃收集（opt-in）、diagnostics export、无损回滚。
- Windows GPU/路径/杀毒软件与 macOS sandbox/notarization。

### 7.4 依赖

- V0.1/V0.2 的 daemon/protocol 稳定，桌面壳不需要访问内部 DB。
- Apple Developer ID、Windows code signing、更新发布基础设施。
- FFmpeg、Python runtime、模型和 WebView codec 的许可/体积清单。
- clean-machine 测试设备与崩溃诊断隐私政策。

### 7.5 里程碑

- D-1：Tauri/Electron codec、WebView、文件权限 spike 与 ADR。
- D-2：签名安装/卸载，不删除用户项目。
- D-3：daemon/worker lifecycle、keychain、file association。
- D-4：自动更新、失败回滚、diagnostics bundle。
- D-5：macOS/Windows 发布矩阵与外部 beta。

### 7.6 风险

- WebView codec 差异；原生 binary/模型安装体积；签名/更新失败。
- 桌面壳诱发提前写 Rust 双核心。

### 7.7 验收

- 两个平台 clean machine 安装、升级、降级恢复、卸载不删除用户项目。
- 30 分钟项目在 sleep/wake、崩溃、强退后恢复。
- CLI/MCP/Web 仍通过同一 daemon/protocol，不出现桌面专有 truth。

## 8. 云端化

### 8.1 目标

在不破坏本地项目 truth 的前提下，逐步提供远程分析/渲染、备份、跨设备和最终团队协作。

### 8.2 进入条件

用户明确需要远程渲染、跨设备或团队协作，且本地版留存成立。云端化不是“把 local daemon 放服务器上”，需要重新设计身份、租户、同步和媒体安全。

### 8.3 功能与分阶段

1. **云任务**：本地项目提交 content-addressed render/analysis job，结果回写 artifact；Timeline truth 仍本地。
2. **备份/跨设备**：加密 project bundle、冲突可见，不做实时协作。
3. **团队项目**：服务端 authoritative revision、ACL、branch/merge、media residency。
4. **内置 Agent**：作为一个 protocol client，不获特权写路径。

### 8.4 依赖

- 本地 content-addressed asset/artifact、version bundle 与 provider job protocol 稳定。
- 身份/租户/ACL、对象存储、队列、KMS、区域与删除策略完成安全设计。
- 云成本模型、媒体版权条款、Provider 数据保留和 DPA 明确。
- 冲突模型在“备份/跨设备”阶段先验证，再进入多人协作。

### 8.5 里程碑

- C-1：远程 render/analysis job，结果只作为 artifact 回写。
- C-2：端到端加密 project bundle 备份与恢复演练。
- C-3：跨设备显式冲突和 branch/version 选择。
- C-4：团队 authoritative revision、ACL、审计和 media residency。
- C-5：内置 Agent 通过与外部 Agent 相同的 contract suite。

### 8.6 风险

- 大媒体上传、带宽/存储/渲染成本。
- 数据驻留、内容版权、模型数据保留、密钥隔离。
- local/cloud 双 truth 和离线冲突。
- 多人实时协作远超 V0.1 command semantics。

### 8.7 验收

- 相同 protocol/IR；云任务不能直接改本地 DB。
- tenant isolation、signed URL、encryption、deletion、audit 通过安全审查。
- 成本上限、取消、outcome unknown 和 retry 可审计。
- 离线/冲突不会静默覆盖。

## 9. 测试金字塔与发布门

### 每次合并

- JSON Schema/type sync、migration fixtures。
- timeline property tests、command/inverse/replay。
- protocol contract、permission/lock/idempotency。
- 定向 renderer golden fixtures。

### 每周

- macOS/Windows media matrix。
- ASR/candidate benchmark regression。
- 30/60 分钟项目性能和内存。
- crash/fault injection、磁盘满、素材离线、Provider timeout。

### 发布候选

- 外部 Agent compatibility suite。
- 真实用户项目 shadow run 和人工复核。
- 许可/SBOM/FFmpeg build/provider privacy 审计。
- P0/P1 风险清零；未过 gate 的功能隐藏或降级，不以 beta 标签绕过数据安全。

## 10. 前 10 个工程任务

1. 建立 repo、pnpm/uv workspace 和 CI，但不建业务 UI。
2. 将 Timeline IR 0.1 写成可执行 JSON Schema 与 fixtures。
3. 实现有理时间库与 property tests。
4. 实现内存 command validator/inverse/replay。
5. 实现 SQLite revision store 和 crash injection。
6. 实现 ffprobe asset descriptor 与 derivative job。
7. 实现首个 Scene Evaluation Graph + FFmpeg compiler。
8. 并行完成三个 preview adapter spike 并写 ADR。
9. 建中文口播 gold dataset/评测脚本。
10. 实现最小 MCP/CLI contract suite，以真实 transaction 完成一次初剪。
