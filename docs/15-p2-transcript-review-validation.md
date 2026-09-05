# P2 真实候选删除与文字审阅首轮验证

> 状态：2026-07-18 已用 P1 的 241 秒真实中文素材完成候选生成、原子应用、Undo、再次应用、SQLite replay、本地 API 和桌面浏览器审阅。当前只验证一条素材和停顿类别，不能宣称 G2 通过。

## 1. 本轮回答的问题

1. Candidate 是否来自稳定 Transcript/媒体分析，而不是 Provider 临时 JSON。
2. 候选、Proposal 和时间线修改能否在同一 revision 原子提交。
3. UI 是否严格区分“Agent 候选”和“已提交删除”。
4. 已删除内容能否从文字表面恢复，并由 SQLite transaction 持久化。
5. 真实 MOV、746-token 文稿和审阅状态能否由本地 daemon 驱动浏览器。

## 2. 数据与删除策略

FFmpeg `silencedetect` 在真实素材中给出 9 个原始静音区间。检测器结合 Transcript 词边界和 150 ms 边界 handles 后产出 5 个候选：

| 类别 | 数量 | 决策 |
|---|---:|---|
| 大于等于 800 ms 的安全停顿 | 1 | 修复前 `definite_remove` / low risk（2026-08-11 起停顿一律 `suggest_remove` / medium，见开发记录同日条目） |
| 约 381–450 ms 的短停顿 | 4 | `suggest_remove` / medium risk |
| 可安全删除的语气词 | 0 | 不为凑数量扩大词表 |

自动选中的唯一停顿从 source 24.275833 s 开始，持续 1.574167 s。策略保持“错删成本高于漏删”：短停顿只进入审阅，不自动改时间线；`啊` 仅允许在上下文明确时成为候选。

## 3. 原子提交、Undo 与重放

CandidateSet、EditProposal 和 `range.deleteRipple` 被编译为一个 revision-bound transaction。Ripple operation 记录 `proposalId`，因此审阅投影可以从 command record 反查真正提交它的 transaction，而不是把“被 Agent 标过”误当成“已经删除”。

真实工程执行结果：

- 首次应用后 revision 3；Undo 后 revision 4，editable state 与应用前一致。
- 重新生成候选并再次应用后 revision 5。
- 主轨从 1 个 clip 变成 2 个 clip；尾部前移，时间线从 241.388333 s 变为 239.814166 s。
- SQLite 从 genesis 重放 5 条 command 到 head，hash 一致。

## 4. 审阅投影语义

`@agentcut/review-projection` 只读取最新 ProjectDocument 和持久化 command records：

- `candidate_remove` / `candidate_keep`：背景提示，不加删除线，不可伪装为已修改。
- `committed_deleted`：删除线或已删除停顿 chip，绑定 `proposalId`、`transactionId` 和 `restorable`。
- Undo 后原 bundle 的 artifact 与 Ripple 一起逆转，投影不再显示 committed deletion。

真实 revision 5 投影为 746 个 normal token、4 个 candidate gap、1 个 committed gap。当前提交一次只选择一个 gap，但协议允许一个 Proposal 包含多个范围，所以恢复文案使用“恢复本次提交”，明确 transaction 级语义。

## 5. Local daemon 与 Studio

本地 daemon 是当前唯一写入面，提供：

- `GET /api/health`：project/revision 健康检查。
- `GET /api/review`：Project、Transcript、媒体 URL、审阅投影和 job 状态。
- `POST /api/restore`：提交目标 command 的 inverse operations；`requestId` 映射到 idempotency key。
- `GET /media/:assetId`：限制在 project root 内的媒体读取，并支持单一显式 byte range。

React Studio 使用 SWR 读取 daemon 状态。左侧播放原片，右侧显示同步文稿、候选/已删除统计和筛选；点击文字按 rational source time seek。组件按 Header、Player、Transcript、Token、Gap 单文件职责拆分，没有在浏览器复制 edit engine。

## 6. 实际验证证据

执行的门禁：

```bash
CI=true pnpm check
git diff --check
```

最新结果：10 个 workspace project build、strict typecheck 全通过，共 99 项测试通过；ASR strict JSON 的 Python unittest 另行通过。

额外真实运行验证：

- `/api/health` 返回 `project_p1_real_dogfood`、revision 5。
- `/api/review` 返回 746/4/1 的 normal/candidate/committed 分布。
- 视频 Range 请求返回 `206 Partial Content`、`Content-Range: bytes 0-1023/765669362`，payload 为 1,024 字节 QuickTime header。
- Chrome 桌面页显示真实工程名、ASR succeeded、REV 5、4 个待审阅和 1 个已删除；视频 metadata 为 4:01。
- 点击文稿词后播放器 seek 到约 2:03 并开始播放，源媒体与 Transcript 同步成立。
- 浏览器无 Vite error overlay；daemon/Vite 终端没有新增运行错误。
- Daemon 测试经过真实 JSON request body、ProjectStore 和 inverse commit；相同 restore request 重放不增加 revision。

## 7. 未通过项

- 只有 1 条真实素材，且本轮没有命中可安全删除的 filler、重复或重说。
- UI 已实现逐项接受/保留、前后文循环试听、source lock、revision conflict、完整单项键盘审阅和高风险显式确认；批量决策和整条素材人工验收仍未完成。
- 当前只有 transaction 级恢复，没有从多范围 Proposal 中拆出单范围恢复。
- 视觉验收只覆盖 Chrome 桌面视口；当前环境缺少 `agent-browser` CLI，未自动捕获 console，也未验证移动端布局。
- 浏览器直接播放当前 H.264/AAC MOV 成功，但更多 codec/VFR 仍需要统一 proxy 矩阵。

因此 P2 仍处于进行中；下一批推进整条素材人工验收、重复/重说候选、批量审阅效率与第二条真实素材，不扩张到完整多轨时间线。

## 8. 第二轮：持久化人工决策与 Source Lock

第一轮暴露出一个产品级数据问题：若“用户决定保留”的锁只记录时间线坐标，前方发生 Ripple 后锁会漂移，后续 Agent 仍可能删到用户保留的原片内容。因此新增 `source_range` lock scope，绑定 `assetId + source range`。Engine 在 Ripple、remove、trim、replace 等破坏性操作上把当前 timeline slice 映射回 source time；只有自动 Agent/workflow 被 `deny_agent` 阻止，用户仍可重新审阅。

候选接受也不能直接执行历史 Proposal。第一次删除会把原 clip 分片，旧 CandidateSet 的 `clipId/projectRevision` 已过期。Review workflow 会在最新 ProjectDocument 中定位仍包含候选 source range 的当前 clip，构造单候选 CandidateSet/Proposal，并与 Ripple edit 原子提交。找不到完整 source range 时返回 `CANDIDATE_UNAVAILABLE`，不会猜测边界。

真实工程副本 API 验证：

```text
REV 5  原始审阅状态：4 candidate gaps / 1 committed gap
REV 6  keep：3 candidate / 1 reviewed_keep / 1 committed
HTTP 409 stale accept：expected 6, received 5
REV 7  unlock：4 candidate / 0 reviewed_keep / 1 committed
REV 8  accept：3 candidate / 0 reviewed_keep / 2 committed
REV 8  同一 requestId 重放：revision 不增加
REV 9  restore：4 candidate / 0 reviewed_keep / 1 committed
```

Chrome UI 在该副本上继续验证：

- 选择 421 ms medium-risk 停顿后显示原因、150 ms handles、85% 置信度和三项操作。
- 循环试听从约 35 秒开始，播放器显示“循环试听上下文”，可显式停止。
- 保留并锁定：REV 9 -> 10，按钮变为“重新审阅”，显示 Agent 不可覆盖通知。
- 重新审阅：REV 10 -> 11，候选回到黄色待审阅状态。
- 删除此段：REV 11 -> 12，待审阅从 4 变 3，已删除从 1 变 2，按钮变为“恢复本次提交”。
- 恢复：REV 12 -> 13，统计回到 4/1，候选重新可审阅。

所有 UI 写入只发生在 `/tmp` 数据库副本；`.agentcut/dogfood/project-review` 基准工程保持 revision 5。

## 9. 第三轮：Canonical Candidate Queue、键盘审阅与高风险门禁

文字 token 是候选的视觉投影，不是候选本体。同一多词候选会覆盖多个 token；若 Studio 从用户刚点击的 token 反推 source range，循环试听会错误地只覆盖一个词。因此 `/api/review` 现在额外返回 canonical `candidates`：按稳定 `candidateId` 去重、按 source time 排序，并携带完整 word/gap target、source range、risk、decision state、transaction 或 lock binding。文字和停顿按钮只负责选择这个队列中的候选。

队列之上新增可发现的键盘操作：

- Left/Right：循环切换上一个/下一个候选。
- Space：启动或停止前后文循环试听。
- D：删除待审阅候选；成功后自动前进到下一个待审阅项。
- K：保留并写 source lock；成功后自动前进。
- U：对已删除项恢复 transaction，或对已保留项解除 lock 重新审阅。

输入框、复选框、媒体控件、组合键和 key repeat 不会被全局快捷键劫持。按钮同时声明 `aria-keyshortcuts`，Inspector 显示候选序号和快捷键提示，状态不依赖颜色表达。

高风险候选有三层一致门禁：checkbox 未勾选时删除按钮禁用；D 只提示确认而不自动勾选；即使绕过 UI，daemon 也要求请求体 `confirmHighRisk: true`。集成测试中，无确认请求返回 `HIGH_RISK_CONFIRMATION_REQUIRED` 且 revision 保持 0；显式确认后才提交到 revision 1。

真实 241 秒工程的第二个 `/tmp` 副本完成纯键盘验证：

```text
REV 5  Right 切换 2/5 -> 3/5；Space 在约 63.7 秒循环试听
REV 6  Left + K：保留 2/5，并自动前进到 3/5
REV 7  Left + U：解除 2/5 的保护，回到待审阅
REV 8  D：提交删除，并自动前进到 3/5
REV 9  Left + U：恢复删除，统计回到 4 candidate / 1 committed
```

Chrome accessibility tree 和截图确认候选序号、快捷键说明、真实视频、通知和 revision 同步显示；daemon/Vite 日志无新增错误。环境仍没有 `agent-browser` CLI，因此无法声称自动 console 捕获；本轮使用 Computer Use 和终端日志作为替代验证。基准 SQLite 再次核对为 revision 5。

## 10. 第四轮：真实正面口播、精确重复与低置信风险升级

用户提供的两段短口播在 ingest/ASR 后以只写 CandidateSet、不自动应用删除的方式完成分析：

| 样本 | 停顿候选 | 精确重复 | low-risk definite | medium/high suggest |
|---|---:|---:|---:|---:|
| 91.73 秒 | 13 | “第三个是” 1.52 秒 | 4（修复前分类；2026-08-11 起停顿不再 definite） | 9 medium + 1 high |
| 78.77 秒 | 5 | “下边这个我再看一下” 2.08 秒 | 2（修复前分类） | 3 medium + 1 high |

精确重复检测只处理无标点阻隔的相邻完全重复，不标记单字叠词，并始终保留后一份。两条真实重复的最小 ASR confidence 分别只有 0.407 和 0.041，可能混入识别错误或 fallback，因此 detector 0.2 把低于 0.6 的重复升级为 high risk，绝不生成 `definite_remove`。

同一工程保留 0.1/0.2 两版 CandidateSet 时，浏览器验证暴露出 Inspector 采用最新版 HIGH、word token 仍从旧版显示 medium 的不一致。Review projection 现按 `candidateId` 和状态优先级统一覆盖同状态 metadata，并新增回归测试；修复后 Inspector 与 6 个相关 token 均显示 high。

78.77 秒样本的干净 `/tmp` 副本完成 API 闭环：

```text
REV 4  正式候选工程副本：5 gap + 1 high-risk repetition
HTTP 409  不带 confirmHighRisk：HIGH_RISK_CONFIRMATION_REQUIRED，revision 保持 4
REV 5  显式 confirmHighRisk：6 个重复词 committed_deleted，可恢复
REV 6  restore：6 个词回到 candidate_remove，0 deleted token
```

Chrome accessibility tree 同时确认：候选 6/6 自动滚动到文稿末尾、完整“下边这个我再看一下”范围被选中、checkbox 未选时删除按钮 disabled、词元无障碍提示为 risk high。播放器按 16:9 展示真实 1280×720 人像素材，首帧人物与用户提供截图的构图一致；媒体 Range 返回 `206 Partial Content` 和 `Content-Range: bytes 0-1023/3006928`。

浏览器 Computer Use 的 element index 在快速多次状态切换时出现过旧映射，导致一个废弃 `/tmp` 副本收到意外审阅请求；正式 dogfood SQLite 未受影响。最终写入闭环改用新的干净副本和直接 API 验证，保留失败现象但不把自动点击结果当产品证据。

## 11. 第五轮：本地 AI 长句重说、改口证据门与单进程 Studio

机械 detector 能可靠发现相邻完全重复，却无法识别“前一遍说残、停顿、后一遍从相同开头完整重说”。sample-03 在 43.78 秒出现第一遍“引导青年学子…为国家发展、作识”，53.28 秒后从“引导青年学子”重新说出更完整版本，是本轮语义 dogfood 的目标正例。

本地语义 Provider 只允许 loopback HTTP，并使用 LM Studio strict JSON Schema；默认协议不上传 Transcript。第一次调用把每个词写成完整 JSON，243 词提示约 14k token，真实模型因 `n_ctx: 4096` 返回 HTTP 400。协议随后改为按标点、700 ms 停顿或 30 词边界整理的紧凑阅读行，行边界使用 `w数字` 短 ID；默认 500 词窗口使本样本只需一次调用。

模型输出不是删除事实。候选进入工程前还必须经过以下确定性检查：

- remove/keep ID 必须存在、连续、前删后留，任一范围不超过 80 词。
- repetition/restatement 必须存在足够的字符序列相似度；correction 必须含“不对/错了/应该是”等明确证据或同等重说证据。
- false_start/incomplete 后必须存在至少 450 ms 的真实停顿。
- 重叠候选只保留高置信的一条；正常句内拆词、倒置 keep、虚构 ID 全部拒绝。
- 若模型把正常前导词带入重说范围，用后一遍共同四字开头把 remove 起点收紧到真实重说处。

小模型真实调用能产生结构化 JSON，但没有命中目标且提出“传统学/科”“多担当”等错误拆词；证据门将其全部拒绝。较大的本地模型在一窗中返回 3 条 finding，其中 2 条因边界/证据不合法被拒绝，唯一接受项经收紧后为：

```text
source 43.78 s, duration 7.02 s
remove: 引导青年学子树立将论文写在祖国大地上的理念为国家发展、作识
keep:   53.28 s 开始的后一遍完整重说
risk:   high
reason: restatement
```

`POST /api/analyze-semantic` 绑定 `baseRevision + requestId`，先建立持久化 `transcript.semantic-review` job，模型完成后再基于同一 revision 原子写 CandidateSet；revision 漂移则停止提交。sample-03 正式工程从 REV 4 推进到 REV 5，job attempt 1 succeeded，SQLite replay/integrity 为 ok，没有自动应用删除。

502 的根因是旧开发方式同时运行 Vite 与 daemon：daemon 测试结束后 Vite 页面仍存在，代理请求才返回 502。`pnpm studio -- <project-directory>` 现在先 build，再由同一个 daemon 服务 Studio、API 和媒体；LM Studio 不可用时 Studio 仍能打开，但 AI 操作明确禁用。Chrome 在 `127.0.0.1:4317` 实测显示 REV 5 和“AI 检查重复与改口”；点击候选 seek 到 43.78 秒，Inspector 显示 `重说 / 7.02 秒 / HIGH`，试听 checkbox 未选时删除按钮保持禁用。

本轮关闭了“语义能力完全缺失”和“502 无法诊断”两个缺口，但没有关闭 G2：真实明确改口/误启动样本仍不足，26B 模型单次约 64 秒，整条候选人工验收与批量审阅尚未完成。

## 12. 第六轮：可完成内容取舍与剪后时间映射

2026-07-28 的初剪实现把此前逐项审阅扩展为三个明确结束路径：低风险确定停顿随“生成初剪”作为单一可恢复事务提交；高风险重复/重说继续强制试听确认；AI 漏项可由连续 word range 生成人工 CandidateSet/Proposal，再走同一 Ripple compiler。用户还可把全部剩余候选写为 source-range locks，使 `roughCutStatus` 从 `reviewing` 进入 `rough_cut_ready`，而不是依赖“看起来审完了”的前端临时状态。

Preview 不再按原片时钟假装剪后结果。daemon 与 renderer 共用 `evaluateTimelineSegments`，返回 revision-bound timeline/source segments；Studio 当前初剪播放到 clip source end 时跳到下一 retained source start，时间线和正常文字 seek 使用 timeline time，候选循环试听仍使用 source time。纯映射测试覆盖 0–3 秒保留、3–5 秒删除、5–10 秒保留的例子：timeline 4 秒映射 source 6 秒，source 3 秒边界跳到 source 5 秒，最终 timeline duration 为 8 秒。

当前证据证明状态和时间映射协议成立，不等于 cut 听感已过 Gate。`sample-03` 的所有机械/语义边界仍需逐一听审并记录吞字、截断、误删与漏删，之后才能更新 G2。

## 13. 第七轮：真实初剪决策闭环与高风险零自动错删

78.77 秒真实口播通过正式 `pnpm roughcut` 入口建立 `/private/tmp/agentcut-roughcut-gate-20260728`。同一命令再次运行返回 `resumed: true`，项目 revision、Transcript ID 和源素材 hash 均不变；不同素材覆盖由工作流拒绝。

`POST /api/rough-cut/generate` 基于 revision 2 生成 6 个机械候选，只把以下两个 `low + definite_remove` 停顿作为一个 transaction 提交到 revision 3（注：2026-08-11 起停顿候选一律 suggest_remove，不再自动提交，见开发记录同日条目；此处保留的是修复前的历史行为记录）：

```text
source 50.891021 s, duration 2.507396 s
source 66.994437 s, duration 1.635521 s
total deleted 4.142917 s
```

三段 0.401/0.764/0.660 秒 medium-risk 停顿继续待审；末尾“下边这个我再看一下”重复因 ASR confidence 只有 0.041，保持 high risk 且没有自动删除。真实结果因此满足“高风险自动错删目标为 0”，不是靠测试 fixture 推断。

本轮为了验证明确结束审阅，没有替用户武断删除高风险内容，而是调用“保留全部剩余项”：四个 source-range locks 在 revision 4 写入，pending candidates 从 4 变 0，`roughCutStatus` 进入 `rough_cut_ready`，Preview 保留 3 个 segment、总长 74.623750 秒。随后持久化 export job 成功，daemon 重启后仍可从 `/api/review.exports` 重建成片与字幕链接。

机器证据关闭了状态机、零高风险自动删除、Timeline/Render 一致和重启重建缺口；两个真实 Ripple 边界尚未完成全程人工听审，G2 的主观吞字/截断/漏删指标继续保持待验证。

## 14. 第八轮：批量审阅（2026-08-14）

G2 缺口「批量审阅」落地为工程能力：candidate-engine `compileCandidateAcceptBatch` 把 N 个低/中风险候选编译为一个含多候选 CandidateSet + 多选中 Proposal + 合并范围 Ripple 删除的单事务（复用初剪生成的既有语义，不是新的时间线模型），重叠组主项同事务写入组员替代锁。daemon `POST /api/candidates/batch-accept` 走与单项路径一致的幂等/计时/revision/重叠门禁；high 风险候选在编译层 fail closed，组员在投影门禁层 `CANDIDATE_OVERLAP_ANCHOR_REQUIRED`。Studio 队列提供逐项勾选、全选、清空与「删除选中 N 项」，恢复按钮明示整批还原语义。candidate-engine 29/29、local-daemon 37/37、Studio 89/89、全仓 398/398；未触碰正式工程与 Gate 证据。

由此 14 个未决候选（sample-02）或 4 个未决候选（sample-03）的机械重复点击可降为「逐项勾选 + 一次提交」，但勾选前仍建议逐项试听；本能力不替代人工验收，G2 的整条素材人工验收与真实改口/误启动样本缺口不变。

## 15. 审阅速查（sample-01/02/03 待人工听审候选，2026-08-11）

两个已授权正式工程仍未完成人工审阅（`review.completed=false`、无通过质量门的导出，故审阅导出 0/20）。以下速查表把每个待审候选映射到原片时间与文字位置，供用户在 Studio「Alpha 验收」面板逐项试听时快速定位；**标签与取舍决定必须由用户做出，本表不构成任何结论**。标注顺序：全部取舍完成后生成初剪并导出（quality passed），再写最终候选/边界标签；sample-02/03 的 firstHumanDecisionRevision 已过，不能进入配对计时分母，只能作辅助听审。

### sample-02（REV 4，241s 屏幕录制口播，14 候选）

原片总长约 4:01。候选多为 380–590ms 短停顿（现分类 suggest_remove/medium，2026-08-11 起不再 definite）；4 个 927–1946ms 长停顿在历史工程中为修复前分类 definite_remove/low，按同日规则一律以 suggest 试听。1 条 1.52s 精确重复（high，绝不自动删）。

| # | 原片时刻 | 时长 | 上下文（前→后） | 现分类 | 试听定位 |
|---|---|---:|---|---|---|
| 1 | 4.82s | 590ms | 教→过 | suggest/medium | 开头附近 |
| 2 | 12.49s | 434ms | 念→就是 | suggest/medium | 约 0:12 |
| 3 | 20.12s | 442ms | 理→得 | suggest/medium | 约 0:20 |
| 4 | 26.74s | 1860ms | 障→利 | suggest/medium（历史 definite/low） | 0:26–0:29，最长停顿 |
| 5 | 29.46s | 581ms | 障→得 | suggest/medium | 约 0:29 |
| 6 | 31.53s | 927ms | 是→业 | suggest/medium（历史 definite/low） | 约 0:31–0:32 |
| 7 | 34.81s | 416ms | 基→和 | suggest/medium | 约 0:35 |
| 8 | 39.17s | 384ms | 障→业 | suggest/medium | 约 0:39 |
| 9 | 46.73s | 399ms | 度→待 | suggest/medium | 约 0:47 |
| 10 | 54.05s | 583ms | 才→学 | suggest/medium | 约 0:54 |
| 11 | 73.38s | 1946ms | 的→把 | suggest/medium（历史 definite/low） | 1:13–1:15 |
| 12 | 83.45s | 1377ms | 展→第三 | suggest/medium（历史 definite/low） | 1:23–1:25 |
| 13 | 85.62s | 536ms | 展→第三 | suggest/medium | 紧邻 #12 之后 |
| 14 | 86.44s | 1520ms | “第三个是”（精确重复） | suggest/high | 1:26–1:28，ASR conf 0.407 |

### sample-01（REV 5，241s 屏幕录制口播，5 候选，1 边界）

2026-08-11 从历史工程 `.agentcut/dogfood/project-full-job` 补登记入 manifest（coverage: `screen-recording`）。它从早期流程建项（非 `--alpha-trial`），`firstHumanDecisionRevision` 为空，理论上仍可进入配对计时分母；候选为修复前分类，按同日规则一律以 suggest 试听。5 个候选均为停顿，其中 1.57s 长停顿为历史 definite（现按 suggest）。

| # | 原片时刻 | 时长 | 决策 | 现分类 | 试听定位 |
|---|---|---:|---|---|---|
| 1 | 24.28s | 1574ms | definite_remove/low（历史） | 按 suggest 试听 | 0:24–0:26 |
| 2 | 36.58s | 421ms | suggest/medium | suggest/medium | 约 0:37 |
| 3 | 65.22s | 426ms | suggest/medium | suggest/medium | 约 1:05 |
| 4 | 149.47s | 381ms | suggest/medium | suggest/medium | 2:29 附近 |
| 5 | 207.63s | 450ms | suggest/medium | suggest/medium | 3:28 附近 |

已提交边界（听审重点：吞字、截断、音画同步）：

| 边界 | 时间线时刻 | 删除时长 | 关联候选 |
|---|---|---|---|
| 1 | 24.28s | 1.574s 停顿 | 候选 1 |

### sample-03（REV 9，78.77s 正面口播，7 候选，3 边界）

两个长停顿与一条 7.02s 重说已在历史流程提交删除（`committed_deleted`，共 4 个已删项、3 个真实剪切边界）。**待用户试听确认**：1 条 2.08s 精确重复（high）、3 条 401–764ms 停顿（medium），以及 3 个边界的吞字/截断/听感。

| # | 原片时刻 | 时长 | 上下文（前→后） | 现分类 | 试听定位 |
|---|---|---:|---|---|---|
| 1 | 13.21s | 401ms | 势→的 | suggest/medium | 约 0:13 |
| 2 | 68.99s | 764ms | 当→最 | suggest/medium | 1:09 附近 |
| 3 | 73.73s | 660ms | 这个→边 | suggest/medium | 约 1:14 |
| 4 | 74.28s | 2080ms | “下边这个我再看一下”（精确重复） | suggest/high | 1:14–1:16，ASR conf 0.041，试听确认非识别错误 |

已提交边界（听审重点：吞字、截断、音画同步）：

| 边界 | 时间线时刻 | 删除时长 | 关联候选 |
|---|---|---|---|
| 1 | 43.78s | 7.02s 重说（引导青年学子…） | 已删 |
| 2 | 43.87s | 2.507s 停顿 | 已删 |
| 3 | 57.47s | 1.636s 停顿 | 已删 |
