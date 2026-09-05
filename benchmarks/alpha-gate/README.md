# AgentCut Alpha Gate Benchmark

本目录只保存可审计的验收统计和证据引用，不保存原始媒体、项目 SQLite 或用户隐私数据。剪辑状态仍以各工程的 Timeline IR/SQLite 为唯一真相源；本 manifest 不能反向修改项目。

运行：

```bash
pnpm alpha:audit -- /path/to/project --output benchmarks/alpha-gate/audits/project-r1.draft.json
pnpm alpha:verify -- /path/to/project --request-id project-r1-correctness-v1
pnpm alpha:evidence -- /path/to/project --output benchmarks/alpha-gate/bundles/project-r1.evidence.json
pnpm alpha:collect -- /path/to/project \
  --cohort-id project-real-001 \
  --authorization-basis user_supplied_for_testing \
  --authorization-evidence ../../docs/alpha-authorizations/project-real-001.md
pnpm alpha:gate
pnpm alpha:gate -- benchmarks/alpha-gate/manifest.json --json
```

运行 `alpha:collect` 前，授权证据文件除人工可读的来源、范围和确认方式外，还必须单独包含一行精确 cohort 标记：

```html
<!-- agentcut-alpha-authorization: project-real-001 sha256:<64位源媒体hash> -->
```

标记中的 ID 必须与 `--cohort-id` 完全一致，SHA-256 必须与建项后 canonical Asset/Transcript 的源媒体 hash 完全一致；相似前缀、其他项目标记、错素材 hash 或正文里偶然出现的 ID 均不算授权绑定。

`alpha:audit` 只读打开项目 SQLite，按当前 revision 自动提取候选、提交 actor、待审状态、实际 Timeline source discontinuity 和 RenderReport，并通过临时文件加硬链接原子发布草稿。目标文件已存在时拒绝覆盖，避免抹掉人工标签。

草稿绑定工程 revision、素材 hash 和 Transcript，所有人工字段都为 `null`。它只负责把 canonical state 变成可审计输入，不代表已经完成人工审阅，也不能直接计入 precision 或边界可用率。当前 `audits/` 中的两份真实草稿分别对应 sample-02 revision 4 与 sample-03 revision 9。

日常标注不再要求手改草稿。启动 `pnpm studio -- <工程目录>` 后，先完成内容取舍和当前初剪导出，再在编辑助手的“Alpha 验收”面板中判断候选正确性，并逐个试听、标记实际剪切边界。人工事件写入 `<工程目录>/alpha-evidence.sqlite`：它是与 Timeline IR 分离的 append-only 证据侧车，任何标注都不会改变工程 revision 或剪辑结果。

候选、边界和 correctness 事件精确绑定 project ID、当前 revision、source SHA-256 和目标 ID；revision 或素材发生变化后，旧质量标签不会投影到新审计。最终候选/边界标注只能在所有内容取舍完成、当前初剪成功导出且 quality passed 后写入。导出登记本身会推进一次 revision，因此提前标注会被 API、Studio 和 bundle 校验共同拒绝，避免用户刚标完就因输出登记使结论整体失效。

一条正式样本的固定顺序为：审阅前点击“登记对照并开始计时”（baseline + first start 原子提交）→ 内容取舍 → 导出并等待 succeeded/quality passed → 暂停活跃计时 → 在该接受 revision finish timing → 最终候选/边界标注 → `alpha:collect`。finish 只在内容全部决定且当前 revision 有通过质量检查的导出时开放；最终标注不计入粗剪活跃时间，但仍精确绑定 finish 所在 revision。任何后续内容修改或重新导出都会使旧的最终标签与已完成 timing 失效，必须恢复同一 run，在新的接受 revision 重新完成并试听。首次动作使用调用者稳定 request ID；响应丢失后重试不会留下重复 baseline 或第二个 start。

成对计时只接受建项时已写入 Timeline extension 的 `--alpha-trial` 工程；普通/历史工程不能启动计时。每个 baseline 还必须带操作者代号的 SHA-256 和独立手工剪辑证据文件 SHA-256，源媒体 hash 不能复用。Studio 默认在浏览器内以 4 MiB 分块计算所选私有文件的 hash，只把 hash 交给 API；文件内容、文件名和原始代号不写入 SQLite 或 bundle，手工粘贴 hash 仅作为恢复入口。baseline 与首个 AgentCut start 原子提交，把同一操作者/对照来源 commitment 绑定到本次 run。bundle 将这些字段与 `{mode:"formal", enrolledAt}` 一并纳入 canonical payload 和双层 hash，缺少前瞻登记或基线来源的 timing bundle 会 fail closed，不进入中位数。20 个配对项目还必须覆盖至少 5 个不同 `operatorIdHash`，避免单人重复样本冒充设计伙伴验证。Studio 在所有标签完成后明确显示“本 revision 已可收集”，但 `alpha:collect` 仍由 Codex/终端执行并要求授权证据、cohort ID 和真实覆盖类别。

活跃计时是唯一允许跨 revision 延续的事件链，因为一次真实粗剪本身就会产生多个 Timeline revision。它仍严格绑定同一 project ID 与 source SHA-256，事件 revision 必须单调且不能超过最终 bundle revision；候选、边界和 correctness 不享受这项放宽。手工基线和第一次 AgentCut 计时启动都必须早于首个人工内容取舍 revision；删除、保留或恢复已经发生后，不允许事后补录正式计时。计时完成后如果 Timeline 又发生修改，该时间证据会自动退回未完成，操作者必须继续原 run 并在最新 revision 再次完成。request ID 为全部事件提供幂等保护，daemon 仍拒绝 stale 当前写入和错误素材 hash。

Studio 中填满质量标注进度后仍必须通过 `alpha:evidence` 生成并登记不可覆盖的版本化 bundle，才能进入 Gate。

Studio 的最终候选标签会在成功后自动前进到下一条未标项；所有标签、内容取舍、恢复、审批、导出和计时控制都使用界面持有的稳定 request ID。网络响应未知时先重新读取 SQLite，无法读取才保留原 ID 供同 payload 重试；同一对象不能在未知结果下改发矛盾决定。该恢复机制不替用户判断标签，也不会把候选批量标成同一结论。

`alpha:evidence` 将当前审计与侧车事件导出为隐私最小化 bundle：不包含完整 Transcript、媒体路径、项目 SQLite 或自由备注正文，备注只保留 SHA-256 commitment；命令拒绝覆盖已有文件。同一 project revision 和事件集会产生相同字节；命令输出整文件 SHA-256，bundle 内还保存 canonical payload SHA-256。

`alpha:verify` 不在正式工程上制造探针 transaction。它用 SQLite online backup 创建临时副本，在副本中依次验证真实 transaction undo、关闭重开、同 payload 幂等重放和 stale revision 无写入拒绝，再把绑定 source state hash 的结果追加到正式工程的证据侧车。重复同一 request ID 幂等；工程在验证期间变化时不记录结果。

日常 cohort 登记优先使用 `alpha:collect`，不再手工运行 correctness、复制 bundle hash 和编辑 manifest。该命令先校验现有 manifest 与授权证据文件，再在临时 SQLite backup 上运行四类正确性验证，生成以整文件 hash 命名的不可变 bundle，并用 compare-before-swap 原子更新 manifest。完全相同的重跑复用同一 correctness event、同一 bundle 和同一 manifest 字节；同一素材换 cohort ID、同一 cohort 换素材或静默替换授权依据都会在写入侧车前拒绝。`alpha:gate` 也会在聚合前重新确认每条 `confirmed` 授权引用是相对路径，且当前仍指向非空普通文件；路径写错或证据文件丢失按输入错误退出，不计入授权项目数。

`--authorization-evidence` 相对 manifest 所在目录解析，每个 cohort 必须使用一份独立、非空的普通文件，并含上述精确 cohort 标记。manifest 同时保存相对引用和整文件 SHA-256；Gate 每次按原始字节重算，保留标记但替换来源、范围或确认方式正文同样会 fail closed。若 bundle 已安全发布后 manifest 被另一进程抢先修改，命令保留内容寻址 bundle但拒绝覆盖 manifest，重跑即可恢复登记。该流程不会修改 Timeline revision、命令历史或源媒体。

这项 hash 约束用于发现登记后的文件漂移，不是第三方数字签名：若有人同时改写授权文件和 manifest hash，必须依靠 Git 历史/评审发现。设计伙伴阶段如需要独立法律或身份保证，应另接外部签署记录；不能把仓库内 SHA-256 描述成对人类同意的密码学证明。

manifest 的 `evidenceBundle` descriptor 保存相对路径、整文件 hash、canonical project ID 和 project revision。Gate 会验证双层 hash、事件/标签/进度一致性、source hash 和 revision，然后直接派生候选 precision 分子分母、边界可用数、高风险自动删除、审阅完成度和最小导出证据；manifest 中旧的手工汇总不能覆盖 bundle 事实。bundle 路径必须位于 manifest 目录内，篡改、错绑或目录逃逸返回输入错误。

当前 sample-02 revision 4 与 sample-03 revision 9 的正式 correctness bundle 已接入 manifest，四项机制为 `2/2 across 2/2 projects`。两者的人工标签仍为空；sample-03 为候选 0/7、边界 0/3 且还有 4 个未决候选，所以仍不进入候选/边界分母或完整审阅数。这是有意保留的真实空证据状态，不是失败后回填的演示数据。Gate 还会拒绝不同 project ID 复用同一 source SHA-256，避免同一素材重复凑足 20 项目。

退出码：

- `0`：全部 Alpha Gate 通过。
- `1`：真实指标失败或证据不足。
- `2`：manifest 非法、文件不可读或参数错误。

每个项目必须记录：

- 素材 SHA-256、授权依据和证据路径。
- 是否完成整条审阅，以及成功导出的 artifact hash/quality report。
- `definite_remove` 预测数、人工真阳性数和标注证据。
- 高风险自动删除数；任何大于 0 的结果直接失败。
- 人工听审的剪切边界总数、可用数和标注证据。
- undo、restart、idempotency、revision conflict 的逐项目机器检查；同一项目重复运行最多贡献一个项目覆盖。
- 同项目手工基线与 AgentCut 人工有效时间；缺少配对时间不进入中位数。
- 手工基线必须能回到同一操作者代号 commitment 和一份私有录屏/编辑器日志/秒表记录的 SHA-256；优先由 Studio 本地分块计算并核对显示值，文件不得上传。hash 证明登记后引用未漂移，不自动证明文件内容或人类身份真实。

缺少分母会得到 `insufficient_evidence`，不会被当作 100%；已观察到低于阈值或高风险自动错删会得到 `failed`。只有不少于 20 个授权项目均具备完整证据时，报告才可能通过。
