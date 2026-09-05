---
format: 1080x1920
duration: 60s
message: "DeepSeek-V4-Flash-Vision-Exp 的权重与推理代码已经开放，但接近 Opus-4.8 只是 DeepSeek 官方多模态 Agent 基准结论"
arc: story-explainer
audience: "关注 AI 模型与 Agent 工具的中文开发者和创作者"
mode: autonomous
music: none
captions: true
---

## Video direction

- palette: 全片使用 `frame.md` 的深海蓝 `ink-black` 作为画布、青色 `fire-orange` 作为唯一强调色、偏白 `cream` 承载正文、灰蓝 `cream-muted` 承载注释；不使用官方 Logo，只用抽象仓库、视觉编码与工具节点。
- typography: 中文显示与正文均使用 display/body 角色，技术标签与基准名使用 mono 角色；每帧只保留一个 40–60% 画幅的主视觉，竖屏中心锚在画面约 42% 高度。
- motion: 所有元素按旁白语义逐项出现，主要揭示分布在镜头后半段；默认长尾平滑收束，冲击感来自硬切、尺度反差和青色切口，不依赖弹跳。所有连续动作有限、确定、可 seek。
- rhythm: Frame 1 与 Frame 4 是高能信息峰；Frame 3 在“看完还能行动”处短暂锁定；Frame 5 是刻意降速的审慎停顿；Frame 6 在闭环完成后静止持读。
- caption keep-out: 主要文字、数字与节点全部限制在画面顶部约 83%，底部 17% 只允许背景纹理穿过。
- negative: 不出现品牌 Logo、假浏览器窗口、紫蓝 AI 渐变、发光球堆砌、圆角卡片海、无限循环、随机粒子、懒惰呼吸、后半段慢推镜头；避免 slideshow 式前置倾倒与 screensaver 式各自漂浮。

## Frame 1 — 不只是 API

- scene: “API ONLY”被青色数据切口撕开，露出巨大的“OPEN SOURCE”与模型仓库脉冲
- voiceover: "这不是又一个只存在 API 里的模型。DeepSeek 刚把它的眼睛和大脑，一起放进了开源仓库。"
- duration: 7s
- poster: 4.2s
- transition_in: cut
- status: animated
- src: compositions/frames/01-open-source.html
- type: hook
- persuasion: Common-belief vs reality
- beat: surprise + recognition
- blueprint: kinetic-type-beats (Adapt)
- rules: kinetic-beat-slam
- focal: 被青色切口撕开的 “API ONLY” 与最终锁定的 “OPEN SOURCE”
- roles: 巨型英雄字 = foreground subject · 青色扫描切口与仓库脉冲 = supporting · 深海蓝网格场 = background
- sfx: impact-digital, whoosh-sharp

narrativeRole: 用“只开放 API”与“真正开放权重”的反差，立即解释这条新闻为什么值得关注。
keyMessage: 这次变化的核心不是新增一个接口，而是模型能力进入了可下载、可检查的开源仓库。

Adapt: 保留多拍巨型文字与最终持读的 signature move；把品牌揭示改为不使用 Logo 的开源仓库脉冲，并以硬切和切口完成语义升级。
Scene 1 (0.0–1.5s): 深海蓝全幅场只出现巨型 “API ONLY”，从画面上三分之一落下并硬锁定；细网格与两条 mono 坐标线构成 layered-depth，主字占画面约 55%，底部字幕带保持空净。动作使用 kinetic beat-slam，平滑落定。
Scene 2 (1.5–4.5s): 旁白说“眼睛和大脑”时，青色水平数据切口从中轴撕过 “API ONLY”，字符沿切口 deterministic slice 位移并迅速归零；“VISION”与“AGENT”两词在同一中心槽位依次 hard-cut，背景仓库路径线逐段自绘。动作使用 hard-cut word-swap 与 chromatic slice。
Scene 3 (4.5–7.0s): “开源仓库”出现时，切口扩大成青色仓库门形框，巨大 “OPEN / SOURCE” 两行从框内逐词组装并占据画面 60%；模型节点脉冲一次后停止，最终画面静止持读。动作使用 per-word reveal 与一次 ambient bloom。

## Frame 2 — 开放了什么

- scene: 一个开源仓库清单逐项生成：WEIGHTS、ENCODING、INFERENCE、MIT，305B 作为底部尺度
- voiceover: "它叫 DeepSeek V4 Flash Vision Exp。官方仓库开放了权重、提示编码和最小推理实现，许可证是 MIT。"
- duration: 9s
- poster: 5.2s
- transition_in: push-slide LEFT
- status: animated
- src: compositions/frames/02-repository.html
- type: product_intro
- persuasion: Progressive disclosure + Citation
- beat: clarity + orientation
- blueprint: grid-card-assemble (Adapt)
- rules: center-outward-expansion
- focal: 依次完成的 WEIGHTS / ENCODING / INFERENCE / MIT 开源清单
- roles: 四条清单与完成刻度 = foreground subject · 305B 尺度线 = supporting · 仓库目录网格 = background
- sfx: tick-mechanical, data-pop

narrativeRole: 把“开源”拆成可验证的具体内容，避免只重复标题。
keyMessage: 官方仓库不仅有说明文档，也包含模型权重和最低可运行的推理参考。

Adapt: 保留条目逐项 assemble 的 signature move；将卡片网格压成适合竖屏的四条锐角仓库清单，每条只用顶部细线而非圆角容器。
Scene 1 (0.0–2.2s): 上部 mono 型号名 “DEEPSEEK V4 / FLASH VISION EXP” 分两拍解码，只有第一条 WEIGHTS 进入竖向全宽清单；asymmetric vertical 70/30，标题为主、目录索引为支撑。动作使用 3D char flip-decode 与 direct-to-slot assemble。
Scene 2 (2.2–6.8s): 随旁白依次说到权重、提示编码、最小推理，ENCODING 与 INFERENCE 两条从各自短路径进入槽位；每条右端的青色完成刻度在词被说出时画满，已有条目保持静止。动作使用 stagger assemble 与 progress fill。
Scene 3 (6.8–9.0s): “MIT”作为第四条在青色全宽带中落定；画面底部安全区上方出现细尺度线与 “≈305B PARAMETERS” mono 注记，仅作为规模语境，不抢主标题。所有条目静止持读，不做浮动。

## Frame 3 — 看见，然后行动

- scene: 图片、截图和图表进入视觉编码器，经过模型核心后分流到浏览器、代码和文件工具
- voiceover: "它能读截图、图表和图片，再继续调用工具完成任务。重点不是会看图，而是看完之后还能行动。"
- duration: 10s
- poster: 6.0s
- transition_in: crossfade
- status: animated
- src: compositions/frames/03-agent-loop.html
- type: feature_showcase
- persuasion: Causal chain + Distillation
- beat: comprehension + aha
- blueprint: agent-progress-theater (Adapt)
- rules: svg-path-draw
- focal: 从 IMAGE INPUT 穿过 VISION CORE 到 BROWSER / CODE / FILE 的行动流水线
- roles: 视觉核心与行动路径 = foreground subject · 三类输入与三类工具 = supporting · 扫描栅格 = background
- sfx: scan-short, confirm-soft

narrativeRole: 解释“多模态 Agent”不是视觉问答，而是视觉理解进入工具调用闭环。
keyMessage: 图像理解只是输入，真正的 Agent 价值来自理解之后继续操作工具。

Adapt: 保留机器“正在工作并交付结果”的 signature move；去掉 UI、光标和圆角面板，用抽象节点、状态行和完成回执表达真正的多模态 Agent 流程。
Scene 1 (0.0–2.6s): SCREENSHOT、CHART、IMAGE 三个竖向输入条只在被旁白点名时依次亮起，沿细线汇入中央 VISION CORE；layered-depth 垂直路径占画面约 55%。动作使用 node stagger 的平滑无弹跳寄存器与 connector self-draw。
Scene 2 (2.6–6.5s): 中央核心显示有限帧扫描弧与状态词 “SEE → REASON”；状态槽按旁白切换，脉冲是叙事状态而非装饰，完成后立即停止。动作使用 state swap 与有限 SVG internals。
Scene 3 (6.5–8.8s): “调用工具”出现时，输出路径向上方安全区内的 BROWSER、CODE、FILE 三站依次自绘，每一站收到一次青色完成标记；竖向全宽流水线保持单一视觉焦点。动作使用 path draw 与 receipt mutation。
Scene 4 (8.8–10.0s): 巨型短句 “看完 / 还能行动”在核心上方分两拍落定，所有工作状态停下，工具闭环保持静止持读。

## Frame 4 — 接近，到底多近

- scene: 四组基准数字沿同一坐标轴展开，DeepSeek 与 Opus 4.8 的差值被青色游标逐项扫过
- voiceover: "官方自测中，ApexBench 是三十六点五对三十九点四，Chartography 是六十四点三对六十五；另外两项，DeepSeek 还略高。"
- duration: 13s
- poster: 8.0s
- transition_in: push-slide LEFT
- status: animated
- src: compositions/frames/04-benchmarks.html
- type: social_proof
- persuasion: Statistical proof + Comparison of two options
- beat: fascination + conviction
- blueprint: dataviz-countup (Adapt)
- rules: stat-bars-and-fills
- focal: 四组 DeepSeek 与 Opus 4.8 的官方自测分数差值
- roles: 四组数字与差值游标 = foreground subject · 同轴刻度与基准名 = supporting · 低对比技术网格 = background
- sfx: tick-fast, sweep-data

narrativeRole: 用四项官方数据替代模糊的“接近”，让观众看见比较依据和差距方向。
keyMessage: “接近”来自多项基准中的相近分数，并不意味着所有能力全面相等。

Adapt: 保留数值 count-up 与游标穿行的 signature move；不做透视仪表盘，以竖屏同轴条带逐项揭示四组官方自测，避免数字太小。
Scene 1 (0.0–2.5s): 顶部出现“官方多模态 Agent 自测”限定语，ApexBench 先以 36.5 对 39.4 双数字 count-up 落定；两条同轴刻度从零填充，数字占当前画面 45%。动作使用 value count-up 与 bars fill。
Scene 2 (2.5–5.5s): Chartography 在第二条全宽条带中出现并计数到 64.3 对 65.0；青色差值游标从第一条扫到第二条，前一条降至 muted 但不消失。动作使用 progress fill 与一段 nudge-curve。
Scene 3 (5.5–9.5s): “另外两项略高”被旁白点名后，Agents’ Last Exam 27.3 对 25.7 与 ZeroBench P@5 35.0 对 34.0 逐条出现；DeepSeek 较高的一侧由青色短线标注 “+1.6” 与 “+1.0”，不可提前显示。动作使用 sequential count-up。
Scene 4 (9.5–13.0s): 四条结果压缩成同一竖向总览，巨型“接近 ≠ 全面相等”从上方落定；所有游标与计数停止，留出完整持读时间。

## Frame 5 — 两个限制

- scene: “官方自测”和“305B”分占上下两块压力面板，实验标签与本地设备轮廓形成规模反差
- voiceover: "但要注意：这是 DeepSeek 官方基准，不是第三方共识；它仍是实验模型，约三千零五十亿参数，开源也不等于普通电脑能轻松运行。"
- duration: 11s
- poster: 6.6s
- transition_in: squeeze
- status: animated
- src: compositions/frames/05-caveats.html
- type: pain_point
- persuasion: Counterexample + Subtractive framing
- beat: skepticism + foresight
- blueprint: comparison-split (Adapt)
- rules: split-tilt-cards
- focal: “官方自测”与“≈305B”上下两块相互制约的限制面板
- roles: 两块压力面板 = foreground subject · EXPERIMENTAL 与 LOCAL 设备线稿 = supporting · 深海蓝双区场 = background
- sfx: low-hit, warning-tick

narrativeRole: 主动收紧结论，防止把官方发布口径制作成没有限定的性能宣传。
keyMessage: 权重开放提高了可检查性，但不能消除评测偏差和算力门槛。

Adapt: 保留成对面板从相反方向进入、相互平衡的 signature move；将横向 split 改为竖屏上下堆叠，并取消持续浮动和不同色相，仅用同一青色强调。
Scene 1 (0.0–2.2s): “但要注意”作为单一大字从上方短距下落，随即让位给上半区“官方自测”；面板从左侧进入并轻微朝中心倾斜，旁边 mono 注记 “NOT THIRD-PARTY CONSENSUS” 按词揭示。动作使用 smooth slide-down 与 mirrored tilt 的上半变体。
Scene 2 (2.2–6.5s): 旁白说“实验模型”时 EXPERIMENTAL 条形印章硬切落下；已有上半区停止运动，画面形成约 50/50 上下张力。
Scene 3 (6.5–9.3s): “约三千零五十亿参数”出现时，下半区“≈305B”从右侧进入并朝中心反向倾斜；普通电脑线稿在数字下方按路径自绘并被一条细青色尺度线压住。动作使用 opposite-wing entry 与 SVG self-draw。
Scene 4 (9.3–11.0s): 两个内侧限制标签“评测偏差”“算力门槛”先后落定，面板完全静止；以安静持读完成审慎转折。

## Frame 6 — 真正的变化

- scene: EYES、TOOLS、ACTION 三个节点接入同一个开源核心，最终锁定“可检查 · 可改造 · 可部署”
- voiceover: "真正重要的是，顶级多模态 Agent 正从封闭接口走向可检查、可改造、可部署。下一场竞争，是谁能把眼睛、工具和行动连成闭环。"
- duration: 10s
- poster: 6.2s
- transition_in: blur-crossfade
- status: animated
- src: compositions/frames/06-meaning.html
- type: branding
- persuasion: Generalization + Rule of three
- beat: clarity + resolve
- blueprint: constellation-hub (Adapt)
- rules: svg-path-draw
- focal: EYES / TOOLS / ACTION 三节点连成的开放核心闭环
- roles: OPEN CORE 与三节点闭环 = foreground subject · 可检查/可改造/可部署 = supporting · 稀疏坐标场 = background
- sfx: line-connect, resolve-hit

narrativeRole: 从单一模型发布上升到行业趋势，同时回扣“看见之后行动”的核心隐喻。
keyMessage: 开源多模态 Agent 的价值在于让视觉、工具和行动闭环成为可构建基础设施。

Adapt: 保留节点围绕核心并以连线完成闭环的 signature move；使用三节点锐角环而非 Logo 生态圈，取消无限公转，闭环完成后全部静止。
Scene 1 (0.0–2.6s): “从封闭接口”先以一条封闭矩形线框出现，OPEN CORE 在中心由小到大平滑落定并切开矩形一侧；centered layered-depth，核心约占画面 45%。动作使用 scale-swap 与一次青色 bloom。
Scene 2 (2.6–6.2s): 旁白依次说“可检查、可改造、可部署”时，三条支持语沿核心外侧逐条落定；EYES、TOOLS、ACTION 三节点随后从预设位置进入，始终保持直立无公转。动作使用 stagger node entrance 的平滑寄存器。
Scene 3 (6.2–8.8s): 三条连接线按 EYES → TOOLS → ACTION → OPEN CORE 的顺序自绘，最后一段回到 EYES 形成闭环；核心在闭环瞬间短暂增亮，背景坐标线收暗。动作使用 connector draw 与 focus falloff。
Scene 4 (8.8–10.0s): 最终短句“看见 · 调用 · 行动”锁定在核心下方、字幕安全区上方；所有节点与线停止，结尾保持静止，不再退出。
