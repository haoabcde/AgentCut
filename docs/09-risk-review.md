# 对抗性风险审查

## 0. 审查结论

这是一个值得做技术验证、但不值得立即做完整产品的方向。

成立的最窄命题不是“Agent 能剪任何视频”，而是：

> 对中文知识口播，结构化 Agent + 可见 Timeline 能在不提高错删风险的前提下，显著缩短从原片到可发布初剪的人工时间。

如果 4–6 周技术验证不能证明这个命题，应停止扩大 UI/Provider/场景，而不是继续用更多模型和特效掩盖核心失败。

## 1. 当前最没有把握的部分

### 1.1 自动删减的可信度

ASR 可用不等于剪切可用。词边界偏差、呼吸、辅音起止、语义重说和用户刻意停顿都会让“文字正确”变成“剪出来难听”。最大未知是：在真实中文口播中，能否把 `definite_remove` precision 做到接近 100%，同时仍节省足够时间。

### 1.2 浏览器预览与最终导出的一致性

浏览器 codec、字体、Canvas/WebGPU、FFmpeg filtergraph 是不同实现。只要 V0.1 效果子集不够窄，就会出现“预览能看、导出变样”。

### 1.3 通用 Agent 接入的真实需求

开放协议对开发者很有吸引力，但普通创作者可能只想打开一个 app。外部 Agent 可能增加安装、授权、上下文和错误恢复成本，而非降低成本。

## 2. 最大遗漏

1. **可用训练/评测数据**：没有中文口播 gold dataset，所有“智能删除”都是演示。
2. **媒体兼容矩阵**：手机 VFR、HDR、旋转、长 GOP、多音轨、中文路径、损坏文件才是真实世界。
3. **分发许可**：FFmpeg build、codec 专利、模型权重、字体、贴纸、stock 素材、Remotion/OpenVideo 都需独立审查。
4. **诊断体验**：本地工具一旦失败，用户必须知道是素材、codec、Provider、模型、权限还是磁盘。
5. **项目备份与 relink**：本地优先的代价是文件移动、外接盘、磁盘损坏和跨机器迁移。
6. **可访问性与快捷键**：时间线工具只靠鼠标会让高频用户很快流失。
7. **用户研究**：目标用户是否真的已使用 coding Agent，还是团队想象出来的交集。

## 3. 哪些前提可能不成立

| 前提 | 反例 | 验证方式 | 失败后的动作 |
|---|---|---|---|
| 用户愿意使用外部 Agent | 创作者不想配置 MCP/CLI | 15–20 位目标访谈 + onboarding task | 桌面内置轻量 Agent 前置，但仍走同协议 |
| 本地优先是优势 | 模型/codec 安装和机器性能拖垮体验 | clean-machine benchmark | 默认云分析、媒体仍本地；或缩小本地模型承诺 |
| 中文口播可形成壁垒 | 剪映/ChatCut 很快达到同等正确性 | blind benchmark + 留存 | 转向开放 SDK/工作流可编程性，或停止 |
| StyleSpec 可复用 | 风格高度依赖内容和具体资产 | 参考视频用户实验 | 只保留描述/分析，不承诺自动应用 |
| Agent 能安全操作多轨 | LLM 经常产生过期/互相冲突操作 | contract/fuzz/adversarial tests | 提高 workflow abstraction，限制低层写工具 |
| Web 编辑器足够 | 浏览器内存/codec/多轨性能不足 | 30/60 分钟低配 Windows 测试 | 提前桌面化或缩减同时解码轨数 |
| Provider 可替换 | 输出语义、时间戳、价格差异过大 | 同 schema adapter conformance | 暴露 capability 差异，不承诺无损互换 |

## 4. Timeline IR 是否设计过度

有明显风险。当前草案包含 StyleSpec、锁、provenance、animation、effects、versions、export。若一次实现全部，会在没有用户证据时复制一个 NLE 平台。

控制方式：

- V0.1 实现子集：Project/Asset/Sequence/Track/Media Clip/Caption Clip/Graphic primitive/Range/Transform/basic audio/basic transition/Lock/Provenance。
- AnalysisArtifact、History、Version 在 DB 中引用，不把所有 payload 塞进 snapshot。
- 不实现通用 effect graph、任意关键帧 property、compound/multicam，直到具体用例出现。
- 每新增字段必须回答：哪个 command 使用、哪个 renderer 保证、哪个 fixture 验证、导出如何降级。
- schema RFC 要求删除一个字段与新增一个字段同样容易；不要把“未来可能用”当理由。

危险信号：

- IR 出现 React component、FFmpeg filter、Provider model 名。
- 为适配一个 renderer 改核心语义。
- `metadata` 变成绕过 schema 的垃圾桶。
- 每个 UI 控件都要求持久化字段。

## 5. 如何避免预览与最终渲染不一致

不能完全避免，只能通过产品边界和验证控制：

1. 共享 Timeline Evaluator/Scene Evaluation Graph，而非共享 renderer。
2. 发布明确的 parity 子集；其余显示 approximate/unsupported。
3. 同一字体文件、时间映射、色彩/rotation metadata、safe area。
4. 对每类素材/操作做 browser vs FFmpeg golden frame/audio diff。
5. 用户在导出前看到 FFmpeg 生成的短 preview，而不是只看 browser preview。
6. 最终导出 preflight 列出所有降级；不允许静默 fallback。
7. 对动态视觉优先烘焙为资产，牺牲部分可编辑性换确定性。

若团队没有维护 parity corpus 的纪律，Web NLE 不应上线。

## 6. 中文口播是否足够形成壁垒

单独不够。

ASR、字幕、静音删除已经商品化，模型能力会继续趋同。可能形成壁垒的是一个复合系统：

- 删除候选的真实接受/拒绝/恢复数据。
- 分原因/风险校准的错删 benchmark。
- 用户可携带的术语和剪辑偏好。
- Transcript evidence 到 Timeline command 的精确映射。
- 任意 Agent 可用、人工可接管、操作可解释。

如果用户只感知到“字幕更准一点”，壁垒不成立。如果用户感知到“我敢让它自动剪，而且随时能接回”，才有产品价值。

## 7. 为什么不直接使用剪映、ChatCut 或 Descript

必须有清晰答案，否则不该做：

- 用户需要本地素材和可替换模型/Agent。
- 用户希望工作流可编程、可纳入现有 repo/内容流水线。
- 用户需要审计、版本、锁、reason/confidence，而非黑箱结果。
- 中文口播错删控制和用户偏好比通用模板/特效更重要。
- 用户需要开放 CLI/MCP/SDK，把视频编辑变成基础设施。

这些理由只覆盖一小部分市场。对需要手机模板、素材生态、社交发布和完整特效的人，剪映更好；对重视成熟 transcript editing 的英文团队，Descript 更好；对想立即用云端 Agent 成片的人，ChatCut 更直接。AgentCut 不应假装全面更优。

## 8. 通用 Agent 是否真的比内置 Agent 更有价值

对开发者和高度定制工作流，是；对普通创作者，未必。

开放 Agent 的真实价值：

- 用户已有内容上下文、repo、脚本、品牌规则和工具链。
- 同一协议能被不同模型/宿主调用，避免产品绑死一个推理层。
- AgentCut 团队专注可验证的编辑基础设施，不需要首发承担通用 Agent 产品。

成本：

- 每个 Agent 的 MCP 行为、上下文长度、approval UX 不同。
- 用户会把 Agent 的规划错误归因给编辑器。
- 安装与权限更复杂，客服边界模糊。

推荐：外部 Agent 是架构原则，不是唯一 UI。Web 编辑器应能独立完成手动和预设工作流；未来内置 Agent 只是同协议客户端。

## 9. 第一版最容易失控的范围

按危险程度排序：

1. 自建“专业多轨编辑器”而不是最小口播时间线。
2. 参考视频全维度分析和自动风格复刻。
3. B-roll/AI 图片/AI 视频/TTS/音乐 Provider 大全。
4. 人物跟踪、智能构图与复杂动画。
5. 同时支持访谈、多机位、Vlog 和广告。
6. 桌面壳、云同步、账户/协作。
7. 为展示效果堆模板，掩盖 IR/撤销/恢复未完成。

范围守门规则：如果功能不直接改善“口播初剪正确性、人工修订时间、Agent/人工连续协作、稳定导出”四项之一，V0.1 不做。

## 10. 哪些应购买、复用或外包

| 模块 | 自研/复用 | 原因 |
|---|---|---|
| Timeline IR/commands/locks/history | 自研 | 核心差异和安全边界 |
| ASR/diarization/VLM/LLM | 复用/购买 | 快速演进、训练成本高 |
| FFmpeg/OTIO/PySceneDetect | 复用 | 成熟基础能力 |
| Web timeline rendering widgets | 购买/参考/局部复用 | 交互成本高，但 store/command 自持 |
| 动态视觉/模板 | 购买或插件 | 非首发护城河；注意许可 |
| 字体/贴纸/stock media | 正规授权采购 | 版权风险高 |
| 许可与 codec 专利审查 | 外部法律顾问 | 不能由工程猜测 |
| Windows/macOS 安装签名/更新 | 可外包专项 | 平台工程但需内部验收 |
| 中文口播标注 | 受控外包 + 内部抽检 | 需要规模，同时含隐私与一致性风险 |

不应外包：schema/command 设计、benchmark 定义、删除风险政策、数据恢复和安全边界。

## 11. 最可能造成重构的技术选择

1. **把第三方 UI store 当 IR**：后续 Agent/CLI/云端全部重写。
2. **以浮点秒为时间真相**：长项目、29.97、VFR、词级映射出现漂移。
3. **直接暴露 FFmpeg/SQL/JSON Patch**：无法撤销、校验和迁移。
4. **Provider 输出直写 Timeline**：换模型即 schema 迁移。
5. **Remotion 作为全局 composition truth**：许可、性能和非 React renderer 被锁死。
6. **文件 JSON + 多进程直接写**：并发/崩溃后数据损坏。
7. **过早 Rust 化**：跨语言边界增多、产品验证变慢。
8. **一开始云 authoritative、后来补本地**：隐私/离线/路径语义难倒推。
9. **先 Electron/Tauri 后 daemon protocol**：桌面壳变业务核心。
10. **字幕等同 transcript**：人工改字、时间映射、重新转写互相污染。

## 12. 最小技术验证

### 12.1 样本

- 20–30 段 2–10 分钟中文口播，至少 5 位说话者。
- 人工标注 words、应删/可删/应留、原因、风险、理想 cut boundary。
- 5 个媒体压力样本：VFR、29.97、旋转、HDR/色彩、长 GOP/多音轨。

### 12.2 原型范围

- 无完整 Web UI；只有 transcript/candidate inspector 和简易 timeline。
- 10 种以内 command；SQLite revision/history；MCP/CLI。
- 一个本地 ASR、一个云 ASR；机械 detector + 一个 LLM reviewer。
- browser preview 支持一条主视频、caption/graphic；FFmpeg final。

### 12.3 实验

1. Auto-Editor silence baseline vs AgentCut candidate pipeline。
2. 纯 ASR 时间边界 vs 声学吸附后的吞字/自然度。
3. 自动模式（低风险）与导演模式的人工时间。
4. 两个 Agent 并发和人工修改后 replan。
5. 1000 次随机 command + inverse；100 次 crash injection。
6. browser/FFmpeg golden diff。
7. 新用户在 30 分钟内完成 init/import/Agent edit/review/export。

### 12.4 Go/No-Go

Go：

- `definite_remove` precision ≥ 98%，高风险无自动错删。
- 相比手动基线，人工有效编辑时间中位数下降至少 40%。
- 边界可用率 ≥ 95%，主要失败可解释并可修。
- command/recovery/parity gate 通过。
- 至少 60% 目标用户愿意再次用同一流程，且开放 Agent 不是主要阻力。

No-Go 或 pivot：

- 为达到 precision 只能几乎不删，时间节省 < 20%。
- 用户仍需逐项检查所有低风险候选，信任无法建立。
- preview/export 差异迫使每次全量渲染。
- MCP/onboarding 成为主要失败点，目标用户不在乎可替换 Agent。
- 真实项目的素材兼容/本地安装成本超过剪辑节省。

Pivot 选项：

- 只做 headless edit engine/SDK，而非终端用户编辑器。
- 只做中文 transcript/candidate review，导出到 Premiere/Resolve/剪映可接收格式。
- 只做 ChatCut/现有 NLE 的开放 Agent bridge（前提是授权和稳定 API）。

## 13. 投资人视角

### 可取之处

- 生成视频拥挤，可靠“编辑已有真实素材”仍有空间。
- 开放 Agent + local-first 是清晰架构差异。
- 中文口播有高频、可度量、可逐步扩展到访谈的入口。
- Timeline command/audit 层可成为 B2B 基础设施。

### 主要质疑

- 市场是否太窄：会用 coding Agent 的中文创作者交集有限。
- 大厂编辑器可快速复制功能，模型本身不是防御。
- 本地多媒体工程与 Web NLE 的成本远高于普通 AI SaaS。
- 开放协议可能促进采用，也可能让产品难以捕获模型层价值。
- “更开放”不是付费理由，必须转化为时间、正确性和工作流复用。

### 建议融资/投入门槛

在技术验证和 20 位设计伙伴数据前，不应按“通用 Agent 视频平台”配置大团队。先用小团队拿到：可重复的时间节省、极低错删、真实复用、至少一个可付费用户群，再决定扩展 NLE/访谈/云端。

## 14. 最终建议

继续，但只批准技术验证与 V0.1 口播核心；冻结以下工作：完整编辑器、访谈实现、生成 Provider 大全、桌面壳和云端。

下一个不可跳过的产物不是 UI mockup，而是：

1. 可执行 IR schema + fixtures。
2. command/inverse/crash test harness。
3. 中文口播 gold dataset + baseline 报告。
4. preview adapter 赛马与 parity 报告。
5. 真实外部 Agent 的 contract test。

五项中任何一项没有数据，就不能声称架构已被验证。
