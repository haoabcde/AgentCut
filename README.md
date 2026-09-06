# AgentCut

> **大目标**：让"任何 AI Agent 安全地驱动任何视频编辑器"成为行业默认能力——本协议成为这件事的开放标准（类比 LSP 之于编程语言）。可验证终点与反目标见 docs/19 §0。
>
> 进入本仓库的 Agent 请先读 [GOAL.md](./GOAL.md)（长程目标与自主推进规则）。

> 2026-09-06 起本仓库转向 **Agent 剪辑协议** 路线：目标产物是 MIT 开源的、不绑定任何编辑器的时间线 IR + 命令协议、参考宿主与一致性测试套件。口播剪辑产品已拆分为独立的 **TalkCut**（`~/Developer/talkcut`，私有），本仓库中的 studio / asr / candidate / render / alpha-gate 等产品层代码为拆分时点快照，将按 [docs/19 协议化重构总体计划](./docs/19-protocol-program-plan.md) 剥离，不再演进。背景与竞品分析见 [docs/18 战略复盘](./docs/18-strategy-review-2026-09.md)。

AgentCut 是一个本地优先的 Agent 原生视频剪辑基础设施。外部通用 Agent 通过 MCP、CLI 或 SDK 进行分析和结构化编辑；本地 Web 编辑器负责预览、Transcript、多轨时间线、人工修改、版本与导出。

当前仓库快照包含 Timeline IR 0.1、精确时间、typed transaction、SQLite WAL、真实本地 ASR、保守删除候选、审阅投影、剪后 PreviewPlan 和会校验源素材 content hash、可在崩溃窗口收养成片或无覆盖安全重试的持久化 FFmpeg 导出 job。自动修改必须可解释、可撤销、可审计，用户锁定内容不能被 Agent 擅自覆盖。

从单条本地口播创建并转写工程：

```bash
pnpm roughcut -- /path/to/source.mp4 --project /path/to/project --name "项目名"
```

同素材和工程目录可幂等续跑；已有工程绑定不同 source hash 时会拒绝覆盖。建项会先探测浏览器播放兼容性：H.264/AAC 的 MP4/M4V 继续直接读取不可变原片；HEVC、MOV 等保守判定为不兼容的输入会在本地生成全长 H.264/AAC 代理，并以绑定 `source asset ID + source content hash + profile` 的 `generated Asset` 登记。主轨 clip、Transcript、候选、PreviewPlan 与最终导出仍只绑定原片，代理只替换 Viewer 的解码字节，不成为第二套剪辑真相源。之后用单进程方式启动：

需要计入正式 Alpha Gate 的新样本必须从建项时显式登记，且使用独立的新工程目录：

```bash
pnpm roughcut -- /path/to/source.mp4 --project /path/to/formal-project --name "正式样本 04" --alpha-trial
```

正式样本标记写入 Timeline 工程的版本化 `extensions`；普通工程和正式样本不能用同一目录相互切换，重跑时模式不一致会拒绝继续。

只有该前瞻 `--alpha-trial` 绑定的工程能启动成对提效计时；daemon 会拒绝普通工程的 begin/baseline/start/heartbeat/finish，evidence bundle 也保存并校验正式试验身份、有效登记时间和 `enrolledAt <= 首个 timing baseline`。即使重算 payload hash，审阅后补写 formal 标记或计时记录也不能进入 30% 提效分母。

```bash
pnpm studio -- .agentcut/dogfood/sample-03-project
```

Studio、API 和媒体都由 `127.0.0.1:4317` 提供。若 `127.0.0.1:1234` 上存在 LM Studio 模型服务，启动器会发现本地 chat model，并启用“AI 检查重复与改口”；语义候选始终是需要试听确认的 high-risk 建议。

Studio 启动时会在当前工程生成 `.agentcut-runtime/agent-access.json`（目录权限 `0700`、文件权限 `0600`），并只打印凭据文件路径、不打印 secret。CLI/MCP launcher 必须用 `AGENTCUT_PROJECT_ROOT` 或 `AGENTCUT_AGENT_CREDENTIALS` 指向它；daemon 再签发限时、工程绑定的 capability session。凭据文件与项目运行数据都被 Git 忽略。

启动器还会生成独立的 `.agentcut-runtime/ui-access.json`，并打印带 `#ui-bootstrap=…` fragment 的 Studio 配对链接。首次打开该链接后，页面用 fragment 换取 7 天有效的 `HttpOnly + SameSite=Strict` cookie，并立即从地址栏清除 fragment；后续工程/文稿/Alpha 数据读取、源视频 Range 播放、字幕与成片下载，以及删除、审批、标注、导出和 session 撤销都要求该 cookie。静态 Studio shell 与最小 `/api/health` 保持公开，便于启动诊断；Agent route 继续只接受独立 capability session。Agent bootstrap 不会发送给浏览器，UI bootstrap 也不会进入 MCP/CLI。

“Studio 浏览器授权”面板可原子轮换 UI bootstrap：凭据文件是当前密钥真相源，daemon 每次验证都读取当前代，因此旧浏览器 Cookie 立即失效，发起轮换的浏览器在同一响应中得到新 Cookie。文件保留不含旧 secret 的 `lastRotation` 恢复标记，SQLite 只记录指纹、代次和 request ID；若进程在文件发布后、审计提交前中断，下一次请求或重启会幂等补记，不推进 Timeline revision，也不撤销 Agent session。

Studio 的“Agent 会话”面板只展示 client、能力数、到期时间与允许/拒绝计数，不返回 token 或 token hash。用户可以立即撤销仍有效的 session；撤销事件与随后被拒绝的请求都写入 SQLite side table，不推进 Timeline revision，关闭并重启后仍生效。

把工程交给另一个 Codex 任务或 MCP host 时，不需要分享永久 bootstrap。先由持有工程凭据的当前任务签发一个限时、最小权限 session，并原子写入 mode-`0600` 交接文件；stdout 只返回路径、session 元数据和 token 指纹，不返回 access token：

```bash
export AGENTCUT_PROJECT_ROOT=/path/to/project
pnpm --silent agent -- handoff create \
  --client-id codex-followup \
  --capability project:read \
  --capability approval:request \
  --request-id handoff-followup-001 \
  --ttl-seconds 3600 \
  --out /private/tmp/agentcut-followup.json \
  --url http://127.0.0.1:4317

# 在后续任务或另一 MCP host 中只传交接文件，不传 project bootstrap：
export AGENTCUT_AGENT_CREDENTIALS=/private/tmp/agentcut-followup.json
pnpm --silent agent -- status
```

交接文件只接受 loopback daemon，父目录必须已存在；相同 request/session 可幂等重放，已有不同文件时拒绝覆盖。它本身是短期 secret，必须保持私有、不得提交 Git，用完后由 Studio 撤销对应 session 并删除文件。daemon 重启不改变 session 的权限、到期或撤销状态。

Codex/外部 Agent 可通过首批 typed JSON CLI 读取紧凑工程状态与候选，并触发低风险工作流或 revision-bound 导出；写命令必须显式提供稳定 request ID，不提供模拟用户高风险确认、SQL、JSON Patch 或 FFmpeg 旁路：

```bash
export AGENTCUT_PROJECT_ROOT=/path/to/project
export AGENTCUT_DAEMON_URL=http://127.0.0.1:4317
pnpm --silent agent -- status
pnpm --silent agent -- candidates
pnpm --silent agent -- transcript get --offset 0 --limit 200
pnpm --silent agent -- project diff --from-revision 2
pnpm --silent agent -- approval request candidate_high --base-revision 2 --request-id codex-approval-001
pnpm --silent agent -- approval get approval_123
pnpm --silent agent -- approval apply approval_123 --approval-token aga_xxx --base-revision 2 --request-id codex-apply-001
pnpm --silent agent -- rough-cut generate --base-revision 2 --request-id codex-roughcut-001
pnpm --silent agent -- semantic analyze --base-revision 3 --request-id codex-semantic-001
pnpm --silent agent -- semantic propose --findings-file /private/tmp/agentcut-findings.json --base-revision 3 --request-id codex-propose-001
pnpm --silent agent -- export start --base-revision 5 --request-id codex-export-001
pnpm --silent agent -- export cancel job_export_codex-export-001 --request-id codex-cancel-001
pnpm --silent agent -- export get job_export_codex-export-001
```

`transcript get` 每页最多返回 500 个带稳定 `wordId`、source timing 和置信度的词，不返回绝对媒体路径。`semantic propose` 的 JSON 文件格式为 `{"findings":[...]}`，每项用 `removeStartWordId/removeEndWordId` 与可空的 `keepStartWordId/keepEndWordId` 表达重复、重说、改口、误启动或未说完；daemon 会重新验证 ID、顺序、文本证据、重叠和 revision，只把成立的结果保存为 `high + suggest_remove` 候选，不直接删除。

使用上述 `pnpm --silent` 入口时，CLI stdout 只有一个协议 JSON 文档，构建日志与结构化错误写入 stderr。正式人工接受、保留、连续文字补删和高风险确认仍由 Studio 完成；Agent 只能读取完整文稿、生成/读取建议并在最新 revision 上继续。

同一安全子集也已通过本地 MCP stdio server 暴露。推荐让 MCP host 直接启动仓库 launcher；它会把构建日志写入 stderr，stdout 只承载 MCP 协议：

```json
{
  "mcpServers": {
    "agentcut": {
      "command": "node",
      "args": ["/Users/hao/Developer/AgentCut/scripts/agentcut-mcp.mjs"],
      "cwd": "/Users/hao/Developer/AgentCut",
      "env": {
        "AGENTCUT_AGENT_CREDENTIALS": "/private/tmp/agentcut-followup.json",
        "CI": "true"
      }
    }
  }
}
```

当前 13 个 MCP tools 在原有安全子集上增加 `agentcut_transcript_get` 与 `agentcut_semantic_findings_propose`。前者分页读取不含源路径的 Transcript，后者只能提交经 daemon 二次验证并固定为 high-risk 的语义建议。Agent 只能申请、读取和应用由 Studio 用户批准的精确 revision/payload；MCP 不提供 approval resolve、手工文字删除或未批准的高风险确认工具。导出取消需要稳定 request ID，pending job 立即进入 cancelled，running job 先持久化 `cancelRequested` 再中止 FFmpeg；响应丢失时用 export get 查询同一 job，不能把“不知道请求结果”当成成功或重复创建 job。每次 revision-bound 写入前先读取 status，并携带精确 revision 与稳定 `requestId`；冲突后先读取 diff 再重新规划。

正式 Alpha 样本必须用 `--alpha-trial` 新建，并在第一次内容取舍前打开“Alpha 验收”，填写同一创作者的手工初剪对照时间、操作者代号，并选择该次手工对照的录屏/编辑器日志/秒表记录。Studio 会在浏览器内以 4 MiB 分块计算 `sha256:<64位>`，只提交 hash；文件内容、文件名和原始操作者代号均不上传或持久化。源媒体自身的 hash 不能冒充对照证据。该动作在一个 SQLite transaction 中同时写入带来源承诺的 baseline 与首个 active session；只有计时为 running 时，daemon 才接受候选取舍、手工删除、恢复、语义分析、生成初剪、审批决定和新建导出，精确幂等重放仍可读取既有结果。daemon 重启、页面隐藏或长时间无活动会自动暂停并重新锁定初剪修改，不把停机和后台时间计入活跃用时。只有全部内容取舍完成、当前初剪成功导出且质量检查通过后才能完成计时；完成后初剪结果封存，但试听和最终质量标注仍可继续。

Studio 的所有用户写操作都由界面层持有稳定 requestId。若提交成功但响应断开，界面先重新读取 Timeline/证据 SQLite；重新读取也失败时，同一操作的下一次重试复用原 ID，并禁止在结果未知时对同一对象改发矛盾 payload。明确 4xx、成功响应或权威刷新会清理 pending intent。pending ID 只活在当前页面内存，不写 localStorage、不成为第二真相源；页面重启后仍以 daemon 投影恢复。最终候选质量标注成功后会自动前进到下一条未标项。

机械停顿和语义重复可能因 ASR 分段或呼吸余量形成 source-range 重叠。Studio/Agent 查询会把同一连通重叠组投影为 `overlapCandidateIds + overlapDecisionAnchorId`，并按 high > medium > low、完整文字 > gap 选出唯一冲突主项。非主项只能试听，不能先提交；主项的删除或保留会在同一可恢复 transaction 中把其余重叠项锁定为替代项，避免二次 Ripple、截断词首或把“保留”范围随后剪坏。daemon 会独立执行相同门禁，不能靠旧 UI、CLI 或 MCP 绕过。

默认直接在 Studio 选择本地证据文件；计算失败或需要复用已知 hash 时，仍可使用 `shasum -a 256 /path/to/manual-baseline-recording`，再在结果前加 `sha256:` 手工粘贴。该 commitment 用于后续找到并核对同一份私有证据，不会把证据文件复制到仓库，也不是第三方身份签名。

计时有一个 30 秒静止窗：距上次心跳超过 30 秒的写操作会被 `ALPHA_TRIAL_TIMING_REQUIRED` 拒绝。Studio 界面在计时运行时会自动持续心跳，浏览器操作不受影响；但 CLI/脚本驱动的流程（导出轮询等待、长时间人工试听）在两次写操作之间停顿超过 30 秒时，需要先重新“继续计时”再重试该写操作——被拒绝的写入不会产生任何副作用，重试安全。此外，导出 requestId 绑定首次提交时的 revision：导出失败后修正问题再导，必须换用新的 requestId（同 ID 换 revision 会返回 `IDEMPOTENCY_CONFLICT`）。

烧录中文字幕需要带 libass 的 FFmpeg。Homebrew 官方 `ffmpeg-full` 为 keg-only，可显式配置：

```bash
export AGENTCUT_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg
export AGENTCUT_FFPROBE_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffprobe
```

## 推荐架构

- 自有、版本化 Timeline IR 是唯一领域真相。
- TypeScript 主控制面，Python 分析 worker，FFmpeg 最终渲染。
- 本地 daemon 是唯一写入者；Web、MCP、CLI 共用 command/transaction 协议。
- OpenTimelineIO 只用于交换；Remotion 和浏览器编辑引擎均为可替换 adapter。
- V0.1 聚焦中文口播，访谈切片在 V0.3。

## 文档

1. [调研报告](./docs/01-research.md)
2. [产品定义](./docs/02-product-definition.md)
3. [总体架构](./docs/03-architecture.md)
4. [Timeline IR 草案](./docs/04-timeline-ir.md)
5. [Agent 接入协议](./docs/05-agent-protocol.md)
6. [中文知识口播工作流](./docs/06-talking-head-workflow.md)
7. [中文访谈切片工作流](./docs/07-interview-workflow.md)
8. [实施路线图](./docs/08-roadmap.md)
9. [对抗性风险审查](./docs/09-risk-review.md)
10. [技术验证进展与决策记录](./docs/10-technical-validation.md)
11. [开发记录](./docs/11-development-log.md)
12. [第一阶段：可信口播文字剪辑](./docs/12-phase-1-transcript-cut.md)
13. [可信中文口播 Alpha 长程执行计划](./docs/13-long-term-execution-plan.md)
14. [P1 真实媒体与中文 ASR 首轮验证](./docs/14-p1-media-asr-validation.md)
15. [P2 真实候选删除与文字审阅验证](./docs/15-p2-transcript-review-validation.md)
16. [P4 剪后预览与可靠导出验证](./docs/16-p4-preview-export-validation.md)
17. [Alpha 正式样本素材授权登记](./docs/17-alpha-authorization.md)
18. [战略复盘 2026-09：协议定位、轻量化与模型演进免疫](./docs/18-strategy-review-2026-09.md)
19. [协议化重构总体计划](./docs/19-protocol-program-plan.md)
20. [Agent 剪辑协议规范 v0.1（草案）](./docs/protocol/agentcut-protocol-0.1.md)
21. [ADR-001：内部 IR 不采用 OTIO](./docs/protocol/adr-001-internal-ir-not-otio.md)
20. [Alpha Gate Benchmark](./benchmarks/alpha-gate/README.md)

## 下一步

第一阶段的代码闭环和历史单条真实 MP4/SRT 机器验证已完成；typed CLI 与 MCP stdio server 已经使用工程绑定、可撤销的 capability session，且可将最小权限 session 封装为私有交接文件供第二个独立 host 使用。Studio 写操作要求可轮换的独立浏览器 session，并提供只读 project diff、revision/payload-bound approval 与可审计导出取消，但这不等于 P3/G3 已关闭。Studio 已提供 revision-bound Alpha 标注与可暂停的活跃时间入口，`pnpm alpha:collect` 会在临时 SQLite 副本验证四类正确性、生成内容寻址证据包并幂等登记 cohort，`pnpm alpha:gate` 再按唯一素材逐项目校验。正式样本按“审阅前开始计时 → 内容取舍 → 导出通过 → 暂停并完成计时 → 最终候选/边界标注 → collect”执行。sample-01/02/03 的四类正确性现为 `3/3 across 3/3 projects`，但正式人工候选和边界标签仍为空，因此当前 Gate 诚实保持 3/20 个授权项目、0/20 个完整审阅导出、配对时间 0/20。G3 接管矩阵已于 2026-08-11 在 sample-03 隔离副本上端到端完成（conflict/diff/语义建议/越权拒绝/撤销/重启后拒绝，CLI 与 MCP 双腿），真实 Codex 宿主因账号额度待 2026-08-16 后补跑；同日 9:16 竖屏导出 preset 全链路落地（Agent CLI/MCP、API 与 Studio UI 选择器齐备，真实 1080×1920 渲染在一次性副本验证，cover 中心裁切强制 `fitModeApproximate` 诚实标注并在 UI 上披露；详见开发记录）；同日新增离线素材矩阵（12 种程序化合成形态全部通过 daemon 同款质量门，覆盖 VFR/HEVC/4K/60fps/竖幅/单声道/96kHz/快速运动/旋转竖拍/anamorphic SAR/HDR PQ），把 G4「扩大矩阵」推进到机器可重复的离线一半；并系统性修复/标记三处媒体元数据保真问题：旋转竖拍误判横幅导致 pillarbox、非方形像素被按存储宽高比压缩变形、HDR 源不色调映射会失真——probe 现暴露旋转/SAR 调整后的显示宽高与色彩传递特性，画布与渲染适配按显示尺寸进行，HDR 导出带 `colorApproximate` 诚实标记与中文告警；同日用合成中文语音对正式样本协议做全流程彩排，又发现并修复导出管线一处 P0：末句词边界越过源媒体尾部时，`-shortest` 被 AAC priming/padding 拖短数百毫秒、去掉则视频流尾部拉伸溢出，两种行为都突破质量门 40ms 容差——现按流时长钳制末段请求并用显式 `-t` 截断，越尾导出带 `expectedOutputMicros` 披露与中文告警（详见开发记录）。当前最大缺口是 Alpha 素材：正式 cohort 仅 3/20（sample-01 已补登记，2026-08-11），需要至少 15 条新授权口播与 5 位设计伙伴（登记见 docs/17；`alpha:collect` 支持 `--coverage-classes` 登记素材类别，gate 凑满 20 个后强制 8 类全覆盖）。2026-08-14 批量审阅落地：低/中风险候选可在队列中逐项勾选、按一次可恢复事务成批删除（恢复即整批还原并在 UI 明示），高风险候选与重叠组非主项在服务端 fail closed；同日 sample-02/03 幂等补登 coverage `mandarin`，并新增 `pnpm alpha:new-sample` 建项辅助（算源素材 hash、查重复素材/cohort 冲突、打印授权文件模板与 collect 命令，不代写授权）。当前不开发多素材、完整多轨时间线、访谈、多 Provider 大全、桌面壳或云端。
