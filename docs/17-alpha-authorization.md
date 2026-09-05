# Alpha 正式样本素材授权登记

Alpha Gate G5 要求不少于 20 个授权真实项目。本文件是授权登记索引；`alpha:collect --authorization-evidence` 应引用 `docs/alpha-authorizations/` 下对应 cohort 的独立记录。只有索引与独立记录中的素材来源、授权范围和确认方式都属实，项目才能进入正式 manifest。

## 授权等级说明

- `user_supplied_for_testing`：用户本人提供本人素材，授权用于 AgentCut 本地 Alpha 测试与质量评估；不上传媒体，不产生公开分发。
- 设计伙伴素材需要在条目中注明伙伴代号、素材数量与授权确认方式（聊天/邮件/口头+记录人）。

## 登记条目

| 日期 | 素材 | 来源 | 授权范围 | 确认方式 | 对应 cohort |
|---|---|---|---|---|---|
| 2026-07-18 | 录屏2026-04-24 21.53.13.mov（241s 屏幕录制口播） | 用户本人 | Alpha 本地测试与评估 | 用户在开发会话中提供 | sample_01_screen_recording（2026-08-11 补登记入 manifest，coverage: screen-recording） |
| 2026-07-18 | 91.73s 正面口播 MP4（sample-02） | 用户本人 | Alpha 本地测试与评估 | 用户在开发会话中提供 | project_p1_real_dogfood_sample_02 |
| 2026-07-18 | 78.77s 正面口播 MP4（sample-03，8be1…46e.mp4） | 用户本人 | Alpha 本地测试与评估 | 用户在开发会话中提供 | project_p1_real_dogfood_sample_03 |

每条已登记素材另有一份不可混写的独立授权记录，包含来源、范围、确认方式和 cohort/source 隐藏标记；manifest 固化整份记录的 SHA-256：

- [`sample_01_screen_recording`](./alpha-authorizations/sample_01_screen_recording.md)
- [`project_p1_real_dogfood_sample_02`](./alpha-authorizations/project_p1_real_dogfood_sample_02.md)
- [`project_p1_real_dogfood_sample_03`](./alpha-authorizations/project_p1_real_dogfood_sample_03.md)

## 待补缺口（G5 阻塞项）

- 至少 15 条新的授权真实口播素材（普通话、口音、中英混说、专名数字、快语速、背景音乐、VFR、录屏口播等覆盖）。
- 至少 5 位设计伙伴参与；每位需记录配对手工粗剪基线。
- 新样本必须从未审阅状态开始建项，并按 README 固定顺序完成计时、取舍、导出、标注与 `alpha:collect`。
- 建项摩擦已降低：`pnpm alpha:new-sample -- <视频> --cohort-id <id> --name "正式样本 NN" [--coverage-classes <逗号分隔>]` 一次完成素材 SHA-256、manifest 重复素材/cohort 冲突检查、`--alpha-trial` 建项，并打印授权记录文件模板（含精确 cohort 标记行）与 collect 命令。`--dry-run` 只计算并打印，不建项。授权记录文件仍必须由用户本人确认来源、授权范围与确认方式后落盘，脚本不代写授权。
- `alpha:collect` 支持可选 `--coverage-classes <逗号分隔>`（允许值：mandarin, accent, code-switch, proper-noun-number, fast-speech, background-music, vfr, screen-recording），用于登记该样本覆盖的素材类别；gate 在凑满 20 个授权项目后强制 8 类全覆盖，未记录类别按缺失计。登记时应按素材实际形态如实填写。既有 cohort 可用同一命令、同一授权证据文件幂等补登类别（2026-08-14 已为 sample-02/03 补登 `mandarin`，转写为纯中文口播，机器可验证）。
- `--authorization-evidence` 相对 Alpha manifest 所在目录解析；每个 cohort 必须使用独立文件，例如 `../../docs/alpha-authorizations/<cohort-id>.md`。`alpha:collect` 把整文件 SHA-256 写入 manifest，`alpha:gate` 重新计算并逐字节核对；错路径、丢失或登记后改写都按输入错误退出。
- 每个新增 cohort 必须在独立文件中加入独占一行 `<!-- agentcut-alpha-authorization: <cohort-id> <source-sha256> -->`；cohort 或素材 hash 任一不匹配时同样拒绝，防止复用无关项目或错素材的授权文档。若授权范围确需变化，应保留旧记录和 manifest 历史，通过明确的新审查流程更新，不得静默覆盖。
