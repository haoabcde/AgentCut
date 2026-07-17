# AgentCut 调研报告

> 调研快照：2026-07-17。仓库活跃度以本轮读取的默认分支最新提交为准；功能与许可优先采用源码、官方文档和仓库许可证。Stars、价格和产品功能会变化，不作为架构承诺。

## 1. 结论先行

AgentCut 不应从任何现有编辑器 fork 出发。推荐采用“自有 Timeline IR + 单写者本地服务 + 可替换预览/渲染/模型适配器”，选择性吸收以下成果：

- OpenTimelineIO：只做交换层，不做内部真相源。
- FFmpeg：媒体探测、代理、波形、最终渲染；只能由渲染编译器生成命令。
- FunASR/SenseVoice/WhisperX：作为可替换 ASR 实验候选；首发中文基线优先 FunASR，云 ASR 作为质量/低配置回退。
- PySceneDetect：镜头边界分析；pyannote.audio：访谈说话人分离候选。
- Chengfeng skills：吸收“错删代价高于漏删、删除风险分层、剪后重转写”的工作流方法，不复用其目录/脚本为产品核心。
- OpenMontage：吸收产物契约、Provider 注册、成本记录、检查点和质量门；它不是交互式 NLE 内核。
- OpenReel：可作为浏览器预览和可逆 action 的技术验证样本；当前 schema、迁移和事务能力不足以直接成为 AgentCut 核心。
- Remotion：只允许作为动态视觉插件；当前许可与供应商绑定使其不适合成为唯一渲染器。

现阶段没有一个项目同时满足：稳定 Timeline IR、中文语义剪辑、通用 Agent 协议、本地多轨人工编辑、可审计撤销、预览/导出一致性。因此产品机会存在，但工程难点主要是“正确且可恢复地修改时间线”，不是“接一个 LLM”。

## 2. 证据标签

- **事实**：本轮由源码、许可证或官方文档确认。
- **推断**：基于事实推导，仍需技术验证或用户研究。
- **建议**：本项目应采取的选择。
- **未确认**：缺少稳定公开证据，不能作为承诺。

## 3. 指定开源项目

### 3.1 Agentchengfeng/chengfeng-videocut-skills

- **定位/技术栈（事实）**：Apache-2.0；Agent Skill + Node/Shell/HTML 审核页 + FFmpeg + 火山 ASR。最新抽样提交 `d626a7d`（2026-06-26）。源码见[仓库](https://github.com/Agentchengfeng/chengfeng-videocut-skills)。
- **核心能力（事实）**：词级转写、静音/重复/残句/口头禅候选、网页人工确认、剪后再次转写和字幕校对；规则明确区分低风险与高风险删除。
- **架构特点（事实）**：知识和流程主要在 Skill Markdown；中间产物是目录中的 JSON/HTML/SRT；脚本直接调用 FFmpeg 与特定 ASR。
- **可复用**：删除风险分层、候选原因、人工确认、剪后重转写、逐帧 seek 的可确定视觉模块契约。
- **只能参考**：硬编码目录、单 Provider、shell 编排、HTML 审核状态、按文件约定拼接流程。
- **风险（推断）**：缺少稳定 Timeline IR、事务、并发控制和通用 SDK；无法直接承载 Web NLE。
- **关系（建议）**：将其方法写入 talking-head workflow 与 benchmark，不把脚本当核心依赖。

### 3.2 calesthio/OpenMontage

- **定位/技术栈（事实）**：AGPL-3.0；Python 工具、YAML pipeline、Markdown skills、JSON Schema、FFmpeg、Remotion/HyperFrames。最新抽样提交 `f8d9463`（2026-07-12）。见[仓库](https://github.com/calesthio/OpenMontage)与[Provider 文档](https://github.com/calesthio/OpenMontage/blob/main/docs/PROVIDERS.md)。
- **核心能力（事实）**：多条视频生产 pipeline、工具注册、成本日志、决策日志、检查点、参考视频分析、素材/生成 Provider。
- **架构特点（事实）**：Agent 是 orchestrator；Python 负责工具和持久化；creative decision 多在 skills；产物按 stage 验证。
- **可复用**：artifact contract、provider capability discovery、preflight、cost ledger、checkpoint、quality gate 的思想或独立实现。
- **只能参考**：整个 AGPL 代码若与闭源产品深度组合会带来许可义务；其“Agent 读技能驱动工具”也不能替代事务型时间线内核。
- **风险（事实/推断）**：talking-head pipeline 标为 beta；多 Provider 和 500+ skills 会放大回归面；偏生产流水线而非人工多轨编辑。
- **关系（建议）**：工作流层的重要对标，不作为编辑内核。

### 3.3 OpenCut

- **定位/技术栈（事实）**：MIT；公开定位为 Web/桌面/移动开源剪辑器。README 描述 Rust compositor 迁移，但本轮默认分支 `bab8af8`（2026-07-10，rewrite 合并）实际只保留 Vite Web 骨架、Cloudflare API 骨架和 GPUI desktop 入口，尚无可见 Timeline/renderer 核心。见[固定提交树](https://github.com/OpenCut-app/OpenCut/tree/bab8af831b354a0b5a98a4a6e818ab7d633b94df)与[项目文档](https://opencut.dev/)。
- **核心能力（未确认）**：README 宣称的时间线、GPU 合成和导出不能从当前 `main` 源码确认。
- **可复用**：当前仅可参考产品目标、工程组织和社区反馈。
- **风险（事实）**：正在快速重写；README 与源码阶段不一致。
- **关系（建议）**：列为持续观察对象，不建立代码依赖。

### 3.4 OpenTimelineIO（OTIO）

- **定位/技术栈（事实）**：ASWF 项目，Apache-2.0；C++ core + Python binding；最新抽样提交 `0eebd21`（2026-07-14）。核心有 Timeline、Track、Stack、Clip、Transition、MediaReference、RationalTime、metadata 与 adapter。见[仓库](https://github.com/AcademySoftwareFoundation/OpenTimelineIO)、[文件格式规范](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/main/docs/tutorials/otio-file-format-specification.md)和[Adapters](https://opentimelineio.readthedocs.io/en/v0.15/tutorials/adapters.html)。
- **可直接兼容**：序列/轨道/Clip、源区间、Gap、Transition、Marker、基础 time effect、media reference、metadata。
- **必须扩展**：字幕逐字时间戳、Transcript、StyleSpec、语义删除候选、用户锁、Agent reason/confidence、EditCommand、Provider cost、approval、项目权限、图形语义、导出预设。
- **风险（事实）**：adapter 是有损交换；canonical OTIO JSON 只保证 OTIO schema 的无损，不保证 AgentCut 扩展在第三方 NLE 中保留。
- **关系（建议）**：内部 IR + OTIO adapter。扩展可写入 `metadata.agentcut`，但导出必须生成 capability/loss report 和 sidecar，不依赖第三方保留 metadata。

### 3.5 DesignCombo React Video Editor / OpenVideo

- **定位/技术栈（事实）**：当前仓库已“migrate to openvideo”；React/Next.js，依赖 `@openvideo/core`、`@openvideo/engine-pixi`、`@openvideo/timeline`、Mediabunny、PixiJS。固定提交 `9a8c529`（2026-06-29）。见[仓库](https://github.com/designcombo/react-video-editor)与[SDK 概览](https://designcombo.dev/framework/getting-started)。
- **许可证（事实）**：当前 `LICENSE` 是 OpenVideo 双层许可；个人/不超过 3 人公司免费，更大营利组织需公司许可，且禁止为销售衍生 OpenVideo 而复制/修改。不是 MIT。
- **可复用**：在许可审核通过后可做 UI/预览 spike；它的 timeline/canvas/event 划分值得参考。
- **风险**：核心通过版本化包消费，许可与 API 迁移都可能绑定供应商。
- **关系（建议）**：不作为默认内核；只作为封装在 `PreviewAdapter` 后的备选实验。

### 3.6 OpenReel Video

- **定位/技术栈（事实）**：MIT；React/TypeScript、Mediabunny、WebCodecs/WebGPU/Canvas2D、FFmpeg.wasm、IndexedDB。最新抽样提交 `5711925`（2026-06-01）。见[仓库](https://github.com/Augani/openreel-video)。
- **核心能力（事实）**：`packages/core` 中存在 Project/Timeline/Action 类型、validator、inverse action、history、serializer、WebGPU/Canvas fallback、音频与导出模块。
- **可复用**：Action/Inverse Action 的原型、renderer factory、device capability、frame cache 与 browser engine 测试思路。
- **风险（源码事实）**：Action 只有宽泛 `Record<string, unknown>`；`executeMany` 在中途失败时不回滚；schema migration 目前直接返回旧 project；媒体类型含 Blob/FileHandle，不是跨进程稳定 IR；core 包是 private。
- **关系（建议）**：技术验证对象和参考代码，不 fork 为 AgentCut 基础。

### 3.7 Diffusion Studio Core

- **定位/技术栈（事实）**：MPL-2.0；npm 当前公开包说明为 TypeScript + Mediabunny + WebCodecs + Canvas2D，支持交互播放和浏览器渲染。见[npm 包](https://www.npmjs.com/package/@diffusionstudio/core)和[Composition 文档](https://github.com/diffusionstudio/core/wiki/03-Composition)。
- **源码状态（事实）**：本轮默认分支 `4e784a7`（2025-11-18）主要含 docs/playground，根 package 依赖已发布的 `@diffusionstudio/core`，没有本轮可核验的 v4 引擎源码目录。
- **可复用**：API/性能 spike；Composition/Layer/Clip 抽象和 WebCodecs 渲染经验。
- **风险**：源码可得性与发布包对应关系需法律/供应链复核；MPL 文件级义务；API 已经历多次大版本迁移。
- **关系（建议）**：PoC 候选，不做真相源或强绑定。

### 3.8 Auto-Editor

- **定位/技术栈（事实）**：Unlicense；当前核心已是 Nim，使用音量、运动、字幕表达式自动剪辑，并可导出 JSON、OTIO、FCP、MLT、Kdenlive/Shotcut。最新抽样提交 `1333858`（2026-07-17）。见[官网](https://auto-editor.com/)和[actions 文档](https://auto-editor.com/docs/actions)。
- **可复用**：分析表达式、CLI 语义、NLE 导出测试样本。
- **只能参考**：静音/运动阈值式 cut 不满足中文语义判断；其 timeline 不承载 Agent 审计和人工锁。
- **关系（建议）**：作为 baseline：AgentCut 的自动删减必须显著优于它的 silence/motion 规则。

### 3.9 FunASR 与 SenseVoice

- **FunASR（事实）**：代码 MIT，模型另受 `MODEL_LICENSE` 1.1 约束；Python 工具箱包含 ASR、VAD、标点、timestamp、speaker 等。最新抽样提交 `33b0403`（2026-07-16）。见[仓库](https://github.com/modelscope/FunASR)与[官方功能说明](https://github.com/modelscope/FunASR/blob/main/README.md)。
- **SenseVoice（事实）**：仓库代码 MIT；提供 ASR、语言/情感/音频事件理解，最新抽样提交 `fbf91f3`（2026-07-14）。见[仓库](https://github.com/FunAudioLLM/SenseVoice)。具体模型权重仍需逐模型审核。
- **可复用**：本地中文 ASR/VAD/标点基线、情感/事件辅助特征。
- **风险**：代码许可不等于模型许可；GPU/CPU、Windows 打包、长音频时间戳和专名准确率必须用真实中文语料评估。
- **关系（建议）**：Provider adapter；V0.1 默认本地 FunASR，云 Provider 做可选回退，禁止把内部输出格式泄漏到 Timeline IR。

### 3.10 WhisperX 与 pyannote.audio

- **WhisperX（事实）**：BSD-2-Clause；Whisper ASR + VAD + forced alignment 提供词级时间戳，并可接 diarization。最新抽样提交 `2cfd7b7`（2026-07-13）。见[仓库](https://github.com/m-bain/whisperX)与[论文](https://arxiv.org/abs/2303.00747)。
- **pyannote.audio（事实）**：MIT Python toolkit；提供 VAD、说话人变化、重叠语音、embedding、diarization pipeline。最新抽样提交 `b749285`（2026-06-30）。见[仓库](https://github.com/pyannote/pyannote-audio)。部分预训练模型需要 Hugging Face 条款/访问，工具还包含可选 telemetry。
- **可复用**：WhisperX 作为多语言回退；pyannote 用于访谈 diarization。
- **风险**：中文对齐、重叠说话、远场音频、Windows/GPU 安装和模型条款；说话人识别不等于说话人命名。
- **关系（建议）**：V0.3 访谈模块的 provider，V0.1 不强制安装。

### 3.11 PySceneDetect

- **事实**：BSD-3-Clause，Python；最新抽样提交 `73bbf8b`（2026-07-15）。官方提供 Content、Threshold、Adaptive 等 detector，输出 timecode ranges；切分仍依赖 FFmpeg/mkvmerge。见[文档](https://www.scenedetect.com/docs/latest/)与[算法说明](https://www.scenedetect.com/docs/api/detectors.html)。
- **可复用**：参考视频 shot boundary、B-roll 比例和切换频率特征。
- **风险**：镜头变化不等于语义场景；快速运动、屏幕录制、字幕闪动会误检。
- **建议**：作为 feature provider，不直接生成 edit decision。

### 3.12 FFmpeg

- **事实**：C/C++ 成熟跨平台媒体底座；本轮 GitHub 元数据在 2026-07-17 仍有默认分支更新，活跃。大部分为 LGPL-2.1+，启用特定 GPL 组件后整体适用 GPL；编解码专利是独立问题。见[官方源码镜像](https://github.com/FFmpeg/FFmpeg)、[官方许可](https://ffmpeg.org/doxygen/trunk/md_LICENSE.html)和[法律清单](https://www.ffmpeg.org/legal.html)。
- **可复用**：ffprobe、代理/缩略图/波形、trim/concat、滤镜、音频混合、字幕、稳定导出、硬件编码探测。
- **风险**：平台构建矩阵、硬编兼容、VFR/旋转元数据/色彩/HDR、命令注入、GPL 构建分发。
- **建议**：V0.1 主渲染器；固定受审计 binary manifest；Agent 不得提交任意 FFmpeg 命令。

### 3.13 Remotion

- **事实**：React/TypeScript programmatic video；最新抽样提交 `8a827d3`（2026-07-17）。当前许可对个人和不超过 3 人公司免费，更大营利组织需公司许可，并限制为销售衍生 Remotion 而复制/修改。官方另按自动化 render 计费，条款会变化。见[仓库许可](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)与[商业许可](https://www.remotion.pro/license)。
- **可复用**：动态字幕、信息图、模板化 motion graphic 的可选 renderer。
- **风险**：许可/计费、Chromium 渲染成本、字体/浏览器差异、将 React composition 误作 Timeline truth。
- **建议**：插件；复杂输出先渲染为带透明通道的资产或由 adapter 编译，Timeline IR 不出现 React component 名。

### 3.14 MLT

- **事实**：C/C++ 多轨媒体框架，核心/libmlt++ LGPL-2.1，`melt` 等应用可为 GPL；最新抽样提交 `8166aab`（2026-07-16）。见[官网](https://mltframework.org/)与[版权政策](https://www.mltframework.org/docs/copyrightpolicy/)。
- **可复用**：成熟多轨合成、消费/生产者模型、与 Kdenlive/Shotcut 生态。
- **风险**：跨平台打包、绑定层、效果语义和浏览器预览不一致；引入第二套工程模型。
- **建议**：V0.1 不采用；若 FFmpeg filtergraph 复杂度失控或需要成熟 NLE effects，再以独立 RenderAdapter 复评。

## 4. 主动发现的相关项目

| 项目 | 已验证价值 | 处理建议 |
|---|---|---|
| [FireRed-OpenStoryline](https://github.com/FireRedTeam/FireRed-OpenStoryline) | Agent、Style Skills、HITL 的方向高度相近 | 深入复评其协议与许可证；当前仅做竞品雷达 |
| [Monet](https://github.com/Monet-AI-Editor/Monet) | Claude/Codex + Electron/CLI/MCP + Remotion | 对比 Agent 工具表面；避免继承 Remotion 绑定 |
| [vibeframe](https://github.com/vericontext/vibeframe) | CLI-first、MCP-ready、dry-run、cost cap、deterministic repair | 借鉴 CLI 和报告语义 |
| [Kaestral](https://github.com/prabindersinghh/kaestral-pro) | Windows、MCP-first 的新项目 | 新且证据不足，持续观察 |
| [Twick](https://github.com/ncounterspecialist/twick) | React timeline/canvas/caption SDK | 做 UI spike 候选，不做 IR |
| [Mediabunny](https://mediabunny.dev/) | 浏览器媒体 demux/mux/codec 工具 | 建议作为 browser media adapter 的首选技术验证 |

## 5. 闭源产品对标

闭源产品只分析公开功能和交互，不推断内部实现。

| 产品 | 官方可验证能力 | 值得学习 | AgentCut 不应复制的边界 |
|---|---|---|---|
| ChatCut | AI panel、素材库、Transcript、预览、多时间线、版本、导出；文字删除同步时间线。见[编辑器概览](https://chatcut.io/docs/editor-overview)与[AI 编辑](https://chatcut.io/features/ai-video-editor) | Agent 与可见时间线协作、@引用、生成确认、版本入口 | 不绑定自有 Agent；不把云项目作为唯一形态 |
| Descript | Script editor + Scene editor + Timeline；文本式编辑、filler removal、AI co-editor。见[界面说明](https://help.descript.com/hc/en-us/articles/37585546799757-The-editor-interface) | transcript-first 与传统 timeline 并存 | 中文语义、开放协议和本地优先应更深 |
| OpusClip | 长视频切片、自动 caption、layout/reframe、active speaker tracking、Virality Score。见[官网](https://www.opus.pro/)与[重构图](https://help.opus.pro/docs/article/layout-and-reframing) | 候选排序、传播完整性、批量变体 | 不把“爆款分”包装为事实；必须展示证据和上下文完整度 |
| CapCut/剪映 | 多轨 NLE、Auto Captions、Auto Reframe、Script-to-Video 等。见[桌面 AI](https://www.capcut.com/tools/desktop-ai-power) | 中文素材/模板/平台工作流成熟度 | V0.1 不正面对打完整 NLE/素材生态 |
| Captions | AI Trim、caption、eye contact、AI Edit 可加入 B-roll/音乐/motion。见[AI Edit](https://help.captions.ai/docs/project/ai-edit)和[AI Trim](https://captions.ai/help/docs/timeline/trim) | 单人口播的低摩擦自动成片 | 不把一次性风格黑箱当可编辑计划 |
| VEED | Web editor、text-based editing、auto edits、clips、caption、音频清理。见[编辑器](https://www.veed.io/tools/video-editor) | Web 上的完整任务闭环 | AgentCut 不做云协作/全套营销套件首发 |
| Runway | 生成式视频编辑与 Edit Studio。见[AI Video Editor](https://runwayml.com/product/ai-video-editor) | 生成式修改作为独立素材能力 | 不把生成模型当 NLE truth；V0.1 不自研生成模型 |
| Shotstack | 云 REST + JSON timeline + 异步渲染。见[架构](https://shotstack.io/docs/guide/) | JSON API、job/status、规模化渲染语义 | 其 JSON 适合 render request，不足以覆盖人工编辑、语义审计和本地版本 |
| Creatomate | RenderScript + template editor；元素有 time/duration/track。见[Timeline](https://creatomate.com/docs/api/render-script/the-timeline) | 模板参数化和交互/JSON 联动 | 不把模板 render schema 当通用剪辑 IR |

## 6. 关键横向判断

### 6.1 Timeline 与 Agent

- **事实**：现有浏览器编辑器多把 UI store/Composition 当项目模型；Agent 项目多把 YAML/JSON artifact 或脚本当真相源。
- **推断**：若 AgentCut 复制任一侧，人工修改后 Agent 接管、事务撤销和跨 renderer 一致性会最先失效。
- **建议**：Timeline IR 与 EditCommand 是独立产品；UI、MCP、CLI、预览、FFmpeg 都是 adapter。

### 6.2 中文口播差异化

- **事实**：ASR、静音删除、字幕已商品化。
- **推断**：单纯“中文识别更准”不是长期壁垒；真正可积累的是中文口语错误 taxonomy、用户保留偏好、删除风险校准、术语词典、逐字时间边界和可解释修订数据。
- **建议**：建立“错删率优先”的 benchmark；对确定删除/建议删除/建议保留分别校准 precision，而非只看总体 F1。

### 6.3 浏览器预览

- **事实**：WebCodecs 提供低层 frame 编解码，但规范不保证任何特定 codec；设备/浏览器可支持不同子集。见[W3C 规范](https://www.w3.org/TR/webcodecs/)与[MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)。
- **建议**：WebCodecs 只是一种 capability；必须保留 `<video>`/Canvas fallback、代理生成和 FFmpeg 最终导出。

## 7. 采购、复用、自研边界

| 能力 | 结论 | 理由 |
|---|---|---|
| Timeline IR / command / history / locks | 自研 | 产品护城河和一致性核心 |
| Web timeline UI | 复用交互组件/参考实现，自持 store 与 command adapter | 避免第三方内部状态成为 truth |
| ASR/VLM/LLM/TTS/生成 | Provider 化购买或开源部署 | 模型变化快，不应锁定 |
| FFmpeg binary | 合规分发或让用户安装；固定版本清单 | 自研无价值，许可/codec 要可审计 |
| Scene detection/diarization | 复用 PySceneDetect/pyannote 或云服务 | 成熟但需 benchmark |
| 动态视觉 | 先购买/适配 Remotion 等，保留无它的主路径 | 非首发核心且许可变化快 |
| 专业 NLE interchange | OTIO + 专用 adapter + 回归样例 | 不自创第三方格式 |

## 8. 本轮未确认信息

- 各云 ASR 对真实中文口播的词边界、专名和成本排序；必须用同一数据集跑 blind benchmark。
- OpenReel、Diffusion Studio、OpenVideo 在 30–60 分钟、多轨、4K、VFR、低内存 Windows 设备上的稳定性。
- Premiere 当前对 OTIO 的官方、无插件支持范围；在承诺导出前必须用目标版本实测。
- 参考视频 StyleSpec 是否能稳定提升用户“像但不抄”的主观评分；需用户实验。
- 通用 Agent 用户愿意为“开放接入”付费的比例；需访谈和行为数据。

## 9. 研究转化为架构决策

1. 使用 TypeScript 主 monorepo；Python 仅做可替换分析 worker；Rust 延后到性能或桌面化证据出现后。
2. 内部 IR 不继承 OTIO；提供双向 adapter 和 loss report。
3. FFmpeg 是 V0.1 最终 renderer；浏览器仅预览，不负责所有 codec 的稳定交付。
4. Remotion、OpenVideo、Diffusion Studio、OpenReel 均置于 adapter 边界后，不成为不可替换核心。
5. 首发质量指标是“高风险错删率、人工修正时间、预览/导出差异、撤销可恢复性”，不是生成炫技数量。
