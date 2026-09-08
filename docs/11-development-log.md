# AgentCut 开发记录

本文件记录已经实际落地的产品、架构和工程变更。每次有效修改都应同步更新，以便后续 Agent 和开发者区分已验证事实、执行假设与待完成事项。

## 2026-09-06：P5 准备——开源发布材料（LICENSE/英文 README/quickstart/CONTRIBUTING/SECURITY）与 OpenChatCut 克隆对比

### 目标

执行 docs/19 P5 中可自主推进的部分：发布材料落盘 + OpenChatCut 逐条克隆对比（公开动作——转公开仓库、tag、发布公告——按 GOAL.md 停止请示，不在本轮）。

### OpenChatCut 克隆对比（docs/20-agentcut-vs-openchatcut.md）

- 克隆 `0xsline/OpenChatCut` commit `19cba6e`（v0.2.14，AGPL-3.0-or-later）到 /tmp（不进本仓库，避免许可证污染），由子代理逐文件核实并给 `文件:行号` 引用；对比文档每条差异均可溯源。
- **docs/18 假设修正两处**（docs/18 已加修正注记，docs/20 §2 为完整证据）：其"无 schema 迁移"不成立（`src/persist/migrations/` 有 v1→v3 runner）；"无审计"部分不成立（外部提案存储/agent 变更日志/run ledger/一次性审批门禁，但无跨会话 actor 身份审计）。"绑自家 UI"大体成立（~85% 工具需浏览器长轮询，存在离线服务端数据面子集）。核心判断"协议私有、非开放标准"不变。
- 网传工具清单证伪：`project_read`/`timeline_edit` 等不存在；实际 = 5 控制 + 6 会话 + ~113 编辑器工具 + 渐进披露（ToolSearch/load_skill）。
- **独立协议定位经核实成立**：其协议即产品 API，无独立 IR 规范/JSON Schema/公开 conformance kit/协议版本协商；单 Bearer 全权、无 capability 范围化与撤销协议化；AGPL 与 MIT 复用互斥。
- 吸收清单（clean-room，进 0.2 候选）：渐进式工具披露、per-tool 恢复策略（`ToolEffect`/`ToolRecoveryPolicy` 四分类、不可逆工具禁自动重试）、审批一次性消费绑定 args digest、revision-drift 前置取消（agent-client 层可选优化）。

### 发布材料

- `LICENSE`（MIT，"AgentCut contributors"）；`CONTRIBUTING.md`（范围纪律、协议变更四步：规范先行→conformance 同步→版本政策→只增优先；完整性不变量清单；许可卫生）；`SECURITY.md`（loopback 信任模型、私有漏洞报告渠道、诚实限制清单）。
- README 重构为双语开源门面：新英文 `README.md`（协议定位 + 3 分钟 quickstart + 机制图 + monorepo 表 + conformance 使用 + 双语文档索引），原中文内容原样迁移至 `README.zh-CN.md`（顶部语言切换）。
- `scripts/quickstart.mjs` + 根 `pnpm quickstart`：seed 演示工程 → 起 reference-host（127.0.0.1:4318）→ 打印 MCP 配置（Claude Code/Codex/TOML）与纯 HTTP 全流程（bootstrap session → project/timeline 读 → 原子事务 → diff）。演示 DB 每次重建、token 随机、`.agentcut-quickstart/` 入 gitignore。首次运行即抓到模板字符串语法错（残留 `)`）并修复；16 MCP 工具与 23 conformance 检查等 README 断言已对照代码核实。

### 验证与待办

- **quickstart 活体验证通过（2026-09-08）**：新增 `scripts/verify-quickstart.mjs`（`pnpm quickstart:verify`）——启动 quickstart 宿主后按其打印的演练完整走 HTTP 并逐项断言宿主状态：health、bootstrap session（201 + `agc_` token + 3 capabilities）、project 读（revision 0）、timeline 发现读（`sequence_main`）、原子事务（revision 0→1，inverseOperations=1，**请求体故意冒充 user actor，宿主强制为 session 身份 `agent/quickstart-verify`**）、同 idempotencyKey 重放（200 replay=true 且 revision 不动）、diff（恰 1 条 clip.update/clip_take_1）。输出 `QUICKSTART VERIFY: ALL CHECKS PASSED`。演练 payload 已与 server.ts 逐字段核对（路由/capability 映射/事务体校验/`clip.update` patch 形状/fixture 三个 ID）。
- **OTIO 集成测试静默 skip 修复（2026-09-08）**：Homebrew 把 Python 升到 3.14 后 PATH 首个 `python3` 变化，otio 装在 `/usr/bin/python3`(3.9) 的用户 site，round-trip 集成测试从"执行"退化为 3 个 skip（无失败，易漏看）。`packages/otio-interop/src/python.ts` 三处硬编码 `python3` 收拢为 `resolvePython()`：默认 PATH `python3`，`AGENTCUT_OTIO_PYTHON` 显式覆盖（进程级缓存，README 已记）。带 `AGENTCUT_OTIO_PYTHON=/usr/bin/python3` 的全量 check exit 0、**479/479 通过、0 skip**（含 round-trip 官方库读写回验证）；不带该变量时 476 通过 + 3 skip、同样 exit 0——无 OTIO 的机器不阻塞。
- 待补：全新克隆（/tmp）跑通 Gate P5 的"15 分钟"验收 + 全量 check 后提交 P5 材料（权限分类器故障间歇阻塞非只读命令，恢复后补跑）。
- 公开三步（仓库转公开、首次 tag、发布公告）**未执行**，按 GOAL.md 等用户明确确认。

## 2026-09-06：P4 推进——OTIO 互操作适配器（导出优先 + loss report + round-trip 等价）

### 目标

执行 docs/19 P4：`interop/otio` 基于 OTIO 官方库实现 Timeline IR → OTIO 导出（首版只导出），附 loss report；Gate 要求 10 分钟规模工程 round-trip 时间线结构等价（loss report 之外零差异），NLE 实测记录进文档。

### 交付（packages/otio-interop）

- **架构（ADR-001 落地）**：IR 是唯一事实源，OTIO 只出现在边界。全部 IR→OTIO 语义决策集中在 TS `buildExportPlan`（gap 插入、loss 分类、metadata 编码、URL 解析）；`tools/otio_write.py`/`otio_read.py` 是哑序列化器/归一化器，只做官方库对象构造与读回，不做任何语义判断——OTIO 语义知识单点维护，官方库升级只需回归测试。官方库 0.18.1（`pip install --user opentimelineio`），不自写解析器。
- **映射表**（完整版在 `packages/otio-interop/README.md`）：活动 sequence→Timeline；video/audio 轨→Video/Audio；media clip→Clip+ExternalReference；clip 间空位与非 media clip→Gap（后者记 loss）；时间语义 `rate = numerator/denominator` 直线映射、值逐位保留；`enabled:false`/非 0 `streamIndex`/clip.metadata→`metadata["agentcut"]`（NLE 不可见、round-trip 可恢复、记 metadata-encoded loss）；`{name,start,duration?}` 形状 marker→Stack 上的 Marker；locks/transitions/artifacts/provenance/styleSpecs/渲染属性（transform/audio/effects 等）→逐项 dropped loss。Loss 两级语义：`dropped`（丢弃+记账）与 `metadata-encoded`（编码保留+记账）；判定标准是 **loss report 之外零差异**。
- **round-trip 验证**：每次导出自动用官方库读回并与 plan 逐项对比（时间：同值同率逐位一致、跨值按秒 1e-6 容差；metadata：key 排序后比较）；分歧逐条给路径，篡改必报（负向用例覆盖）。验证结果进 loss report（JSON + Markdown 表格）。
- **可审阅样例**：`pnpm --filter @agentcut/otio-interop samples` 重新生成 `samples/`（minimal-project 与 ten-minute 各一份 .otio + loss report .md/.json）；ten-minute 样例为 10 分钟规模合成工程（2 轨 10 clip——9 media + 1 非 media，含 15s 空位、禁用 clip、锁定轨、混合帧率 marker、不可映射 marker），导出结果 round-trip **equivalent**、7 类 loss 全部记账。

### 对抗性审查发现并已修复的问题

- **夹具用了不存在的 ClipKind**：`kind:"graphic"` 是 TrackKind 而非 ClipKind，cast 掩盖了 schema 非法——改 `shape`（合法的非 media clip，正好走"导出为 gap + loss"路径）。
- **NTSC 累积漂移**：夹具每个 clip 起止独立按 30000/1001 取整，名义相邻的 clip 在游标累积后产生亚帧重叠（240s 处重叠 20ms），会被 plan 按重叠丢弃而破坏 round-trip——夹具统一 30fps（秒边界逐位对齐），NTSC 映射由 minimal fixture（单 clip 连续）覆盖。
- **streamIndex 静默丢失**：media clip 的 `streamIndex`（多流素材选流）原本不进 OTIO 也不记账，违反"loss report 之外零差异"——现编码进 `metadata["agentcut"]`（非 0 时记 metadata-encoded loss）；同轮审查把 transform/audio/effects/animations/content 归为 `clip-render-properties` dropped loss。
- **OTIO API 两处真实漂移**（对 0.18.1 实测确认）：`Timeline` 没有 `markers`——时间线级 marker 属 Stack（`timeline.tracks.markers`）；官方库读回的 metadata 是 C++ `AnyDictionary`/`AnyVector`，不能直接 JSON 序列化且 **key 顺序不保留**（std::map 语义）——读回端递归 `to_plain`，比较端 metadata 改为 key 排序后比较（语义等价而非序列化顺序等价）。

### 验证

- `CI=true AGENTCUT_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg pnpm check` exit 0：**477/477 测试通过**（P3 的 451 + otio-interop 26 项：plan 纯映射 14、compare 8、round-trip 4——可用性探针 1 + 官方库集成 3）。
- round-trip 集成测试对两个夹具各跑一次"导出→官方库读回→逐项对比"，均 `equivalent`；篡改导出的 .otio（替换 target_url）必报 `tracks[0].items[0].mediaReference.targetUrl` 分歧——验证链路不是摆设。
- `samples/` 实跑输出：minimal-project equivalent（4 类 loss）、ten-minute equivalent（7 类 loss），OTIO 官方库版本 0.18.1。

### 限制与后续

- **NLE 实测待人工**：开发机未安装任何 NLE（DaVinci/Premiere/FCP 均无），无法在本轮完成"真实 NLE 打开验证"。`packages/otio-interop/README.md` 已给出逐步 runbook（DaVinci ≥17 原生导入 .otio，核对轨序/gap/marker/总时长；媒体离线属预期），执行后回填验证状态。Gate P4 的其余条款（10 分钟规模 round-trip 等价、loss report 之外零差异）已关闭。
- OTIO → IR 导入为第二优先级（docs/19 既定）；FCPXML 按计划继续延后。

## 2026-09-06：P3 推进——conformance 套件、timeline 发现读与真实 Agent E2E

### 目标

执行 docs/19 P3：`@agentcut/conformance` 便携一致性套件（协议规范的可执行定义）、真实 Agent（Claude Code / Codex）经 MCP 的可重复 E2E、reference-host 与 daemon 双宿主接线。

### 对抗性审查发现的协议缺口（先修协议，再写套件）

- **core 面缺时间线结构读**：0.1 已冻结的 6 条路由里，Agent 只能读工程概要/Transcript/diff——没有任何合规途径得知 transaction 可寻址的 `clipId`/`trackId`。两个宿主的既有测试全是硬编码 fixture ID 掩盖了这一点；真实 Agent E2E 会立即撞上（否则只能把 clipId 写进 prompt 作弊）。这正是"任何 Agent 驱动任何宿主"的硬前提，属协议级缺陷而非实现细节。
  - 修复（只增兼容）：新增 core 路由 `GET /api/agent/timeline`（规范 §6.4，原 diff 顺延 §6.5）——`sequenceId`/`fromMicros`/`toMicros` 窗口 + `offset`/`limit` 分页，capability `project:read`，排序（track.order, startMicros, clipId）稳定。五层同步落地：规范正文与 §12 映射、reference-host、daemon、agent-client `timeline()`、MCP 新工具 `agentcut_timeline_get`（16 工具）；§7.1 增补"对象 ID 必须来自 §6.4/§6.3 发现，不得猜测"。changeset `timeline-discovery-read.md`。
- **daemon `/api/health` 不符 §6.1**：返回 `{status:"ok", projectId, revision}` 而非契约的 `{ok:true, protocolVersion}`。改为契约字段 + 保留本地兼容字段，规范补注"宿主可加字段但不得含源路径/媒体 URL/用户内容"。conformance 套件首次运行前就抓到一个真实漂移——套件的存在价值当场兑现。

### @agentcut/conformance（packages/conformance，零运行时依赖）

- 22 项 core 检查 + 1 项崩溃恢复检查，逐条挂规范条款：会话（bootstrap 拒绝、严格校验、幂等重放）、core 读（概要/writePolicy、Transcript 分页一致性或如实 404、timeline 发现与窗口/参数规范性、timeline capability 门禁）、事务（201/200 重放、IDEMPOTENCY_CONFLICT、REVISION_CONFLICT、未知 operation 422、混合载荷原子性、未知对象 404、写门禁、actor 强制、协议版本拒绝、审计头限制）、diff（内容+afterHash、actor、非法窗口）、错误模型；`crash.recovery-state` 经 `HostController.restart()` 重启宿主后验证 revision/幂等账本/diff 历史存续。
- 报告 JSON：verdict + 逐条 pass/fail/skip（skip 分 `host-content`/`no-controller`/`prerequisite` 三类，前两类需 `--allow-skip` 许可或提供 controller，否则判 fail）；协议版本不匹配立即中止避免误导性级联。CLI `agentcut-conformance` + 库 API（宿主 CI 嵌入用）。
- 接线：reference-host（套件自带测试，含重启 controller 全绿）与 local-daemon（`apps/local-daemon/src/conformance.test.ts`，即 TalkCut CI 未来接入的模式）。
- 设计要点：幂等键按 runId 随机化可安全重跑；写探针指向已发现的 clip、无 clip 时事务组显式 skip；事务类探针显式指向当前 head，避免先撞 REVISION_CONFLICT 而测不到目标语义（engine 校验顺序：projectId→baseRevision→未知类型；store.commit 先幂等后 revision，同键异载荷探针因此必须保留过期 baseRevision——恰好钉住 §7.4 不变量）。

### 真实 Agent E2E（scripts/agent-e2e.mjs）

- 非交互驱动 `claude -p`（--mcp-config + --allowedTools）与 `codex exec`（-c mcp_servers.* TOML 覆盖，不动用户 CODEX_HOME 以保登录态）对真实 reference-host 进程完成：读工程 → timeline 发现 → transcript 采样 → 一次 clip.update 原子事务 → diff 确认 actor=agentcut-mcp。
- 验收以宿主状态为准（revision +1、diff 恰一条、actor/operation/objectIds、clip 已禁用），不信任 agent 自述；会话日志与验证报告落盘 /tmp/agent-e2e，脚本可重复（全新临时工程）。

### 验证

- `CI=true AGENTCUT_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg pnpm check` exit 0：**451/451 测试通过**（P2 的 447 + conformance 套件 3 项 + daemon 接线 1 项）。
- conformance 对 reference-host：25/25 检查通过（含 crash.recovery-state 重启证据）；对 local-daemon：25/25 全绿（`apps/local-daemon/src/conformance.test.ts`）；对故意不合规假宿主：逐条 fail 且报告给出可指向证据（阴性测试）。
- 真实 Agent E2E（2026-09-06 本机实跑）：Claude Code 50.8s 与 Codex 57.2s 各完成完整会话，宿主状态独立验收均 pass——revision 0→1、diff 恰一条 clip.update/clip_take_1、actor 强制为 agentcut-mcp、clip 已禁用；日志与报告在 /tmp/agentcut-agent-e2e/。
- 过程中发现并修复：conformance 测试 harness 首次启动时 `server?.close(cb)` 对 undefined 求值为 undefined 导致永不 resolve（纯 Node 下重启控制器路径正确，vitest 用例首次调用即暴露）；daemon 遗留 health 断言引用被替换的 `status:"ok"` 字段（改为断言契约字段）。

### 限制与后续

- TalkCut 私有仓库的 conformance 接入需触碰 `~/Developer/talkcut`，待用户确认；本仓库内以 daemon 同模式测试承接 Gate 的 AgentCut 侧。
- G3 产品语境遗留条目（Studio 审批 UI、handoff 文件、撤销矩阵）仍属 TalkCut 产品域（docs/19 §3 P3 已注明）。

## 2026-09-06：P2 推进——策略声明、对账测试与版本化工具

### 目标

执行 docs/19 P2 剩余交付：风险/审批策略 capability 声明化、按需视觉抽样接口定义、changesets/semver、规范与实现逐条对账。

### 实际改动

- **writePolicy 声明**：`GET /api/agent/project` 的 `capabilities` 新增 `writePolicy.timelineTransactions`（baseCapability 必填；approvalCapability/approvalExtension/notes 可选）。daemon 声明 talking-head-review 审批流，reference-host 声明最小开放策略。capability 名称仍是宿主词汇表（不破坏重命名），语义以声明为准——协议不编码"什么是高风险"。spec §6.2 正文、§13 相应条目毕业。只增兼容变更，无弃用窗口需求。
- **changesets/semver**：引入 `@changesets/cli`（复用优先，不自建）；内核六包 `fixed` 联动；新增 `docs/protocol/versioning.md`——0.x 破坏性变更政策（公告→过渡→移除三版窗口、例外清单）、协议版本与包版本的联动规则；README 索引第 22 项；首份 changeset 记录 P1+P2 协议面变更。
- **对账测试（spec §12 逐条映射的缺口补齐）**：reference-host 新增两个测试（+2）——protocolVersion 拒绝、未知 operation 拒绝、IDEMPOTENCY_CONFLICT、diff 窗口/规范性、审计头长度上限、无 Transcript 404、session 创建严格校验（未知/重复/空 capabilities、TTL 越界）；diff 断言钉住 actor 强制（请求体携带伪造 actor）。
- **按需视觉抽样**：接口形状定义进 spec §13（pull 语义、有界 count、内容寻址引用、无媒体管线宿主返回 404/422），0.2 候选，未实现。

### 对抗性审查发现并修复

- **engine 对未知 operation type 无运行时防线**：类型层穷尽但 wire 载荷来自外部；`affectedByOperation` 对未知 type 静默落到尾部返回 undefined 并在外层崩溃为 500。已在 `assertTransactionEnvelope` 增加已知类型集合校验（协议 §4 要求的显式 422 INVALID_OPERATION），`applyOperation` 增加 default 分支作为纵深防御。
- 审计头"前后空白"用例在 HTTP 传输层会被裁掉而不可测，改为长度超限用例（>128）。

### 验证

- `CI=true AGENTCUT_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg pnpm check` exit 0：**445/445 测试通过**（P1 的 443 + 2 对账测试）。

### 限制与后续

- P2 剩余：规范与实现的逐条对账属持续动作（每改一处协议面必须同步 §12 映射）；视觉抽样待 0.2 实现（无媒体管线需求出现前维持定义态）。TalkCut 侧扩展命名空间改造仍待用户确认。

## 2026-09-06：P1 内核解耦与参考宿主（代码完成）

### 目标

执行 docs/19 P1：把产品概念从内核摘除、以最小参考宿主证明协议可独立实现、在 MCP/客户端面建立 core 与宿主扩展的分层。

### 实际改动

- **`packages/host-extensions`（新包）**：`alpha-trial`、`preview-proxy`（含语义校验器 `validatePreviewProxyBindings` 与 `TALKING_HEAD_EXTENSION_VALIDATORS`）从 `timeline-schema` 迁入；数据键（`agentcut.alphaTrial`/`agentcut.previewProxy`）不变，既有 dogfood 工程仍可解析。
- **`timeline-schema` 扩展钩子**：`validateProjectDocument(value, {extensionValidators})` 新增可选扩展校验器参数；核心校验对未知命名空间不透明。`edit-commands`（engine/TransactionEngine）与 `project-store`（open/create 及全部 parse/replay 调用点）全链路透传该参数。
- **产品层注册校验器**：`local-daemon`（`openHostStore` 统一包装全部 `ProjectStore.open` 调用点）、`rough-cut-workflow`、`alpha-gate` 五个 CLI/模块、三个 dogfood 脚本恢复原有 preview-proxy 语义校验行为（若不注册，严格性会静默回退——这是本次对抗性审查发现并修复的主要遗漏）。
- **`apps/reference-host`（新包）**：最小协议宿主，仅实现 core 面（health/session/project/transcript/diff/timeline transactions）+ capability session，无任何媒体管线；依赖仅 project-store/edit-commands/timeline-schema。与 daemon 的核心路由逐项对齐（响应形状、错误码→HTTP 映射、1MB body 限制、TTL 边界、query 规范性、幂等/冲突语义、201/200 状态码约定）。
- **core 写路径**：daemon 与 reference-host 均新增 `POST /api/agent/timeline/transactions`（任意通过校验的 typed operation 组合、原子提交、revision 绑定、幂等重放、actor 强制为 session.clientId）；`GET /api/agent/project`（core 工程概要，`capabilities.extensions` 由宿主声明：daemon 为 `["talking-head-review"]`，reference-host 为 `[]`）。
- **`agent-client`/`mcp-server` core 方法**：client 新增 `project()`、`applyTimelineTransaction()`（operations 结构化透传，客户端不复制 operation schema）；MCP 新增 `agentcut_project_get`、`agentcut_timeline_apply_transaction` 两个 core 工具（工具面 13→15）；in-memory contract 同步。
- **E2E**：`apps/mcp-server/src/reference-host.e2e.test.ts`——打包后的 MCP stdio server 驱动真实 reference-host（HTTP wire），覆盖 core 读、事务应用/幂等重放/revision 冲突、diff、以及 product-only 工具在无扩展宿主上的诚实 404。
- **文档**：新增 `docs/protocol/agentcut-protocol-0.1.md`（英文为主的协议规范 v0.1 草案，含逐条-测试映射表与 0.2 规划）、`docs/protocol/adr-001-internal-ir-not-otio.md`（内部 IR 不采用 OTIO 的 ADR）；docs/05 头部标注被协议规范取代的范围；README 文档索引 20/21 项。

### 对抗性审查发现并修复

- reference-host 的 `toMicros` 时间换算写反（用了 `value·numerator/denominator`，IR 语义为 `seconds = value·denominator/numerator`，docs/04）；对 rate 1000/1 的素材会偏差 1000×，且原测试断言不含时间字段、无法发现。已修复并在 reference-host 测试中钉住 fixture 词级时间（1000 ticks @1000/1 → 1,000,000 µs）。
- reference-host diff 响应缺 `objectIds` 字段（client 类型与 daemon 均有）；已补齐并在测试钉住。
- 错误码→HTTP 映射不完整（引擎 10 个码中 LOCKED/PRECONDITION_FAILED/SEQUENCE_NOT_FOUND/PROJECT_MISMATCH/DUPLICATE_ID/INVALID_OPERATION 未映射）；已与 daemon 逐码对齐。
- 事务应用状态码不一致（reference-host 恒 200，daemon 首次 201/重放 200）；已统一为 201/200 并写入协议规范 §7.3。

### 验证

- 首轮 `pnpm check` 暴露并修复 9 处问题（全部为静态核对未覆盖到的运行时/类型事实）：`extensionValidators` 参数在 `exactOptionalPropertyTypes` 下的 3 处类型不兼容（readonly/undefined 联合）；reference-host 两处（options `| undefined`、`TimelineTransactionResult` 返回类型）；zod v4 `z.record` 需显式键 schema；daemon `ApiError` 参数顺序错误（code 在前非 status）；host-extensions 测试 fixture 双重断言转型；agent-client 事务请求体键序断言、审计头推导（`#request` 现同时识别 `idempotencyKey` 作为 X-AgentCut-Request-Id）；两处 `server.listen` 异步端口读取；MCP E2E fixture 相对路径层级与 words 数组匹配方式。
- **协议语义修复（测试驱动发现）**：宿主级 revision 预检破坏幂等重放（过期 baseRevision 的精确重试被 409 拒绝，违反协议 §7.4）——已从 daemon 与 reference-host 的 core 路由删除预检，改由 `ProjectStore.commit` 先查幂等、engine 对新事务校验 revision；`ProjectStoreError`（CAPABILITY_DENIED 等）在 reference-host 错误层未映射导致 500，已按 `statusForCode` 对齐。
- **产品策略与协议分层修复**：`assertAlphaTrialEditingActive` 为读登记状态而全量计算 alpha 审计（按"全部 clip 为启用媒体"渲染），未登记但含 disabled clip 的工程会让一切写入崩溃——core 事务路由首测即触发。已加短路：先廉价读 `agentcut.alphaTrial` extensions，未登记直接放行；登记工程行为不变。
- 最终 `CI=true AGENTCUT_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg pnpm check` **exit 0**：17 个包构建与 strict typecheck 通过，**443/443 测试通过**（429 基线 +16 新增 −2 从 timeline-schema 迁入 host-extensions 的 alpha-trial 用例，净增 14）。
- TalkCut 未触碰；`~/Developer/talkcut` 零读写。

### 限制与后续

- P1 Gate 的 "TalkCut daemon 以扩展命名空间方式暴露原有口播方法" 一项需要触碰 `~/Developer/talkcut`，属 GOAL.md 停下请示范围，待用户确认后执行；本仓库内（daemon 快照）已实现等价改造并随上述全绿验证。AgentCut 侧其余 Gate 项（reference-host 持久化/崩溃恢复语义来自 project-store 套件 18 项 + reference-host E2E 5 项；MCP core E2E 3 项）已满足。
- "扩展走通用调用通道"（mcp-server 以单一通用工具承载宿主扩展方法）未实现：当前 MCP 仍内置 13 个口播宿主扩展工具，待 TalkCut 自持 MCP server 时收敛。已记入 docs/protocol §13 与后续阶段。
- P1 期间提前产出了两项 P2 交付：协议规范 v0.1 草案、OTIO ADR-001。

### 限制与后续

- P1 Gate 的 "TalkCut daemon 以扩展命名空间方式暴露原有口播方法" 一项需要触碰 `~/Developer/talkcut`，属 GOAL.md 停下请示范围，待用户确认后执行；本仓库内（daemon 快照）已实现等价改造。AgentCut 侧其余 Gate 项（reference-host 持久化语义、MCP core E2E）以本条目验证结果为准。
- "扩展走通用调用通道"（mcp-server 以单一通用工具承载宿主扩展方法）未实现：当前 MCP 仍内置 13 个口播宿主扩展工具，待 TalkCut 自持 MCP server 时收敛。已记入 docs/protocol §13 与后续阶段。

## 2026-09-06：确立长程 Goal（GOAL.md）

### 目标

应用户要求把协议路线写成可跨 session 自主推进的长程 Agent 目标，使任何新进入的 Agent 不依赖对话记忆即可正确行动。

### 实际改动

- 新增根目录 `GOAL.md`：北极星、任务范围（docs/19 的 P1→P5）、自主推进规则（Gate 驱动接力、计划为活文档、阶段固定产出、不确定性显式化）、六类必须停下请示用户的点（仓库转公开/push/release、触碰 TalkCut、许可证变更、独立协议定位失效、超政策破坏性变更、付费服务）、全期硬约束（内核只收敛、复用优先+许可证滤网、模型演进免疫、口播需求不入仓、验证纪律）、阶段 Gate 速查与汇报格式。
- README 大目标行与 AGENTS.md 顶部加入 GOAL.md 指引。

### 验证

- 纯文档变更，无代码改动，未运行 `pnpm check`。

### 限制与后续

- GOAL.md 的阶段 Gate 速查是从 docs/19 摘录的副本，已注明冲突时以 docs/19 为准；后续阶段状态更新需同步两处（规则已写入 GOAL.md 自主推进规则第 2 条）。

## 2026-09-06：确立大目标（北极星）

### 目标

应用户要求为协议路线设定可筛选决策、可验证终点的大目标。

### 实际改动

- docs/19 新增 §0 大目标："让任何 AI Agent 安全地驱动任何视频编辑器成为行业默认能力，AgentCut 协议成为开放标准"，类比 LSP/OTIO。
- 可验证终点四条：规范 1.0 冻结、≥2 独立宿主实现通过 conformance、≥3 主流 Agent 宿主零定制完成剪辑会话、≥1 既有开源项目采纳或对接；全部达成前不宣布 1.0，2027 年中无第二宿主迹象则按 §6 退路重估。
- 反目标三条：不做编辑器市场份额、不做模型/云渲染/内容平台、不以品牌使用率为目标（协议被 fork/吸收也算赢）。
- README 头部加入大目标一句话指引。

### 验证

- 纯文档变更，未运行 `pnpm check`（无代码改动）。

### 限制与后续

- "≥3 主流 Agent 宿主"与"≥1 外部采纳"依赖外部生态，非单方可控；作为北极星而非阶段 Gate。

## 2026-09-06：P0 归属清理与冻结完成

### 目标

执行 docs/19 P0：核实两仓产品层归属、清理 AgentCut 工作区、冻结产品层演进。

### 实际改动

- **逐文件三方比对**（AgentCut 工作区 ↔ TalkCut 当前状态，按拆分时实际改名规则规范化后比对）：packages/apps 共 195 个文件，166 个一致；差异 29 个文件中 25 个纯为小写改名残留（`agentcut-` 临时目录前缀、产物前缀、授权 marker、凭据脚本名），无功能差异；4 个（studio App.tsx / TranscriptPanel.tsx/.test.tsx / styles.css）为 TalkCut 拆分后的**自有新增**（快捷确认、文稿段落化阅读），TalkCut 领先，AgentCut 侧无任何 TalkCut 缺失的改动。**结论：零迁移，未向 TalkCut 写入任何文件**（其工作区 3 个进行中文件未触碰）。
- AgentCut 自 7 月以来的全部工作此前从未 commit；现以快照提交 `09997d2`（307 文件、+55,032 行）落盘于 `codex/rough-cut-alpha` 分支，未 push。
- `.gitignore` 增加 `.playwright-mcp/`（测试产物）；experiments 下 HyperFrames 项目按其嵌套 gitignore 排除媒体/渲染产物后入库。
- AgentCut README 头部增加归属边界说明（协议路线 + 产品层为拆分快照、不再演进）；TalkCut README 已有拆分说明，未改动。
- 确认 experiments/video-talkcraft-trial 与 video-talkcraft-full 已被删除（其验证结论保留在 2026-09-03 日志中）。

### 验证

- 提交后 `git status` 干净；`CI=true pnpm check`（ffmpeg-full 环境变量）exit 0：15 个包构建与 strict typecheck 通过、429/429 测试通过，与 2026-09-02 基线一致。
- 暂存前扫描确认无媒体原片、无 >1MB 文件、无凭据入库；`.agentcut/` dogfood 工程与 asr-worker venv 维持忽略。

### 限制与后续

- 提交仅在本地 `codex/rough-cut-alpha` 分支，未 push 到 origin。
- 归属比对基于拆分时改名规则的规范化，若 TalkCut 做过规则外的深层重构可能漏判——抽样核对 4 个功能差异文件后风险低。
- P0 Gate 其余项已满足（工作区干净、TalkCut 全绿以其 2026-09-02 拆分验证为准、双方 README 边界已写明）；下一阶段为 P1 内核解耦与参考宿主。

## 2026-09-06：确立 MIT 许可与协议化重构总体计划

### 目标

在战略复盘（docs/18）之后，确定核心包许可证并产出可执行的总体重构计划，落实"复用优先、硬限制只守完整性"两条用户原则。

### 实际改动

- 许可证决策：核心包采用 MIT（理由：采纳摩擦最低、与 MCP/TS 生态惯例一致；Apache-2.0 的专利授权条款在出现企业贡献者前价值有限，MIT→Apache 单向迁移可行）。
- 新增 `docs/19-protocol-program-plan.md`：终态为 MIT 协议仓库（内核 6 包 + reference-host + conformance 套件 + OTIO interop）与 TalkCut 私有宿主分离；P0–P6 七阶段约 10–12 工程周，顺序为归属清理 → 内核解耦与参考宿主 → 协议硬化与规范 → 一致性套件与真实 Agent E2E → OTIO adapter → 开源发布，TalkCut 交接并行。
- 计划基于当日实测依赖关系：agent-client 零内部依赖、mcp-server 仅依赖 agent-client、产品层对内核单向依赖无反向引用；timeline-schema 内含 alpha-trial/preview-proxy 产品概念，列为内核解耦第一对象。
- 复用优先政策入档（docs/19 §2.1）：默认接入并修改现有开源项目，自建需举证；复用指依赖集成 + adapter + 上游贡献而非整仓 fork；附逐层复用/自建对照表与许可证滤网（MIT 内核不直接依赖 AGPL/GPL 代码，PolyForm Noncommercial 商业路径不可用）。
- README 文档索引加入第 19 项。

### 验证

- 纯文档变更，无代码改动，未运行 `pnpm check`。
- 包依赖关系由当日逐包读取 package.json 实测，非推测。

### 限制与后续

- 计划中的工程周为相对估计；P5 开源发布前必须完成 OpenChatCut 克隆逐条对比，若其协议已足够通用需重新评估独立协议定位（docs/19 §6 已列为风险）。
- P0 归属清理尚未执行：AgentCut 工作区仍有未 commit 的口播改动待移交 TalkCut。

## 2026-09-06：战略复盘——协议定位、轻量化与模型演进免疫

### 目标

回答"是否应基于现有开源视频架构（OpenShorts、video-talkcraft 等）重建 AgentCut"，并把 TalkCut 拆分后 AgentCut 的存在形态、轻量化边界与模型演进免疫原则固化为文档。

### 实际改动

- 完成 2026-09-06 前沿竞品调研（OpenChatCut、Pireel、video-use、OpenShorts、OpenCut、ChatCut、video-talkcraft 等），确认"不绑定编辑器的开放时间线 IR + 命令协议"位置仍为空，但 OpenChatCut 已在做同构的私有协议，OpenCut（Rust 重写）把 MCP 列为一级特性。
- 新增 `docs/18-strategy-review-2026-09.md`：结论为不推倒重建、不 fork 底座；AgentCut 收敛为协议核心（timeline-schema/edit-commands/project-store/agent-client/mcp-server），口播产品代码归 TalkCut；确立两条设计原则——轻量化（FFmpeg/WebCodecs/ASR Provider/OTIO/FCPXML 均为 adapter，自研仅限内核）与模型演进免疫（硬限制只守完整性层：事务/幂等/revision/审计；判断层——停顿阈值、口头禅表、固定工作流——降级为可绕过的默认工具，协议不编码"什么是好剪辑"）。
- 行动项含开源决策（阻塞项）、OpenChatCut 逐条协议对比、G5 移交 TalkCut 并改为协议级 Gate、OTIO/FCPXML adapter + ADR、代码剥离计划。
- README 文档索引加入第 18 项。

### 验证

- 纯文档变更，无代码改动，未运行 `pnpm check`。
- 竞品 stars/活跃度为 2026-09-06 抓取快照，部分来自二手聚合站，文档中已标注不确定性。

### 限制与后续

- 开源与否、G5 移交、代码剥离均为待用户确认的决策，尚未执行；OpenChatCut 协议完备性未深入验证，需在克隆对比后复核战略结论。

## 2026-09-03：用 video-talkcraft 完整剪辑 sample-02 中文口播

### 目标

将此前用于试剪的 dogfood `sample-02` 口播，完整制作成一条可交付的带人物让台、字幕、信息图与节点音效的成片；明确处理重复、断句和源片不完整尾句，而不是把 91.73 秒原片机械导出。

### 实际改动

- 新增隔离工程 `experiments/video-talkcraft-full/`，保留原 dogfood 媒体和转写不变。源片按三个语义完整区间重组：`3.56–26.56s`、`38.98–71.54s`、`75.14–83.30s`，得到 63.72 秒口播正文与 1.81 秒无声落版。
- 删除源 `26.56–38.98s` 的重复复述、`71.54–75.14s` 未说完的断句，以及 `83.30s` 后没有下文的重复“第三个是”；在 `SHOTBOOK.md`、`shots.json` 和 `audio/timestamps.json` 中记录了源时码到成片时码映射。ASR 同音误写“利得”按语境订正为“立德”。
- 新增完整 Remotion 分镜：理念引入、三位一体、立德为先、基础/广度/高度关系、复合型人才寄语、国家/行业需要的成长规划和结语；复用并保留三张模板卡的原卡对照，人物与文字分区，未引入外部 B-roll、数据或未提供的事实。
- 新增 8 段可恢复渲染与连续音频混音脚本 `scripts/render-segmented.sh`；每段限制 250 帧、`--concurrency=1` 和 256 MiB OffthreadVideo 缓存，修复长时间线直接渲染因缓存中断的问题。连续原声与 10 个有视觉动作对应的本地 Pack B 音效在最终封装前混音，避免段间 AAC 静音。
- 生成交付 `experiments/video-talkcraft-full/out/video-talkcraft-full.mp4`，并保存字级锚点、cue 表、联系表和片尾 QA 帧。

### 验证

- 完整工程 `npx tsc --noEmit -p tsconfig.json` 通过；`scripts/qa-anchors.mjs` 通过，9 个关键画面动作均可回指到 203 个词级时间点。
- 交付经 `ffprobe` 验证为 1920×1080、30fps、65.53 秒；已抽检全片联系表与 64.5 秒片尾，确认人物/字幕分区、主要镜头、结语和无声落版均存在。
- 三轮独立审片最终通过（P0=0、P1=0）：首轮提出 7 个 cue 缺少对应可见动作和一条字幕断句，已分别把标签/规划线/结论安排在其字级 cue 上进场，并订正为“同国家、行业的发展结合起来”；二轮提出 41.96 秒成长规划 cue 未写入 beat 表，已补齐并以 9/9 锚点复验。
- 全仓 `CI=true AGENTCUT_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg pnpm check` 在默认沙箱中构建和类型检查通过，但 MCP 测试监听 `127.0.0.1` 遇到 `EPERM`；在宿主环境用同一命令复跑通过：15 个 workspace 构建、全部 strict typecheck、所有测试通过。

### 限制与后续

- 成片只包含源素材中语义完整的口播，不应被误称为原片 91.73 秒逐秒全保留版；尾部“第三个是”没有后文，若需补成第三条内容，必须提供后续原始口播或授权另录。
- 本轮按 ASR 字级时间和画面抽检完成，不替代真人逐句监听；发布前仍建议以目标播放设备复听音量和跳剪节奏。
- 该工程验证的是 video-talkcraft 的成片包装和可追溯重组能力，尚未将其接入 AgentCut Timeline IR 或自动口误/停顿发现链路。
- 2026-09-06：用户要求清理本次生成文件，`experiments/video-talkcraft-full/`（约 92 MiB，含成片、工程、QA 与中间渲染）和 `experiments/video-talkcraft-trial/`（约 694 MiB，含试剪、QA 与依赖）均已删除；本条记录仅保留审计历史。

## 2026-09-03：隔离试用 video-talkcraft 的中文口播包装能力

### 目标

不用 video-talkcraft 改写 AgentCut 主链路，先以真实中文口播素材完成一段可播放试剪，验证它在字级同步、人物让台、动效卡片、字幕、音效和自动质量门槛上的实际能力，并明确它与口误/停顿清理及通用剪辑器的边界。

### 实际改动

- 在 `experiments/video-talkcraft-trial/` 新增隔离 Remotion 工程，截取 dogfood `sample-02-project` 源视频 1.00–15.60 秒，生成 14.6 秒、1920×1080/30fps 的试剪；未修改 dogfood 工程、Timeline、转写产物或 Studio 功能。
- 按 video-talkcraft skill 先写 `SHOTBOOK.md`，采用默认 Apple light 视觉 token，接入 `CameraRig`、`Plane`、`Live`、`Environment` 与运动匹配转场；复制并改造 `impact-open-title`、`host-shrink-to-chip`、`slab-punch-title` 三张原卡。
- 将已有 mlx-whisper 字级结果换算为片段相对时间，建立 `timestamps.json`、`beats.json`、`shots.json` 和 `anchors.json`；“三位一体”信息图对齐“三”字，“立德为先”重点卡对齐“就是/立”字。
- 使用本地人物视频与人声，添加普通底部字幕及 8 个 Pack B 本地音效；用 YuNet 测得原素材人脸检测率 100%，据此把标题、信息图和人物角标分区。
- 第一轮独立评审发现信息图无依据补写“学生/理念/教学”及两处交叉叠化残影；第二版删除节点语义标签，并将边界改成字点上的同向运动匹配切。新的独立评审上下文复核 34 张帧和两段连续转场后给出 PASS（P0=0、P1=0）。
- 产出 `out/delivery.mp4`，并保留 390px 手机复看版、原卡对照、完整 QA 帧、机器门槛报告与两轮 `REVIEW.md`，使试剪过程可追溯。

### 验证

- 试剪工程 `npx tsc --noEmit` 通过；卡片保真 3/3 通过（相似度 0.88–0.97）；字级节拍 4/4 通过（最大偏差 0.037 秒）。
- 画面健康检查通过：无 ≥0.8 秒全静止段，三个慢速窗口无周期光栅抖动；交付固定 `--concurrency=1`。
- 音效 solo 8/8 在场，中位 cue 峰值 -29.7 dBFS；最终 loudnorm 交付重新执行 mix 检查，得到 UNMASKED 5、AUDIBLE 3、MASKED 0，PASS。
- 全仓 `CI=true AGENTCUT_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg pnpm check` 在默认沙箱首轮因 MCP 测试监听 `127.0.0.1` 遇到 `EPERM`；宿主环境用同一命令复跑通过：15 个 workspace 构建、全部严格类型检查、429/429 测试通过。

### 限制与后续

- 本次验证的是“已有口播稿/成品人声/人物素材 → 带动效解说成片”的包装能力，不是从长原片自动发现并删除口误、停顿、废片；也没有把该 skill 接入 AgentCut Timeline IR。
- 样片只验证三张卡和两种转场，不能代表 78 张卡、B-roll 检索、真实网页证据截图、抠像、竖屏和长镜头系统全部已实测。
- 第二轮评审仍记录两个不挡交付的 P2：390px 下顶部试剪标识与灰色辅助文案偏小；重点卡按原模板“块先到、字后落”会短暂出现一帧空色块。
- 工具采用 PolyForm Noncommercial 1.0.0；个人、教育、研究用途免费，工具本身用于商业用途需事先获得作者授权。样片使用的 Pack B 音效仍需随发布说明保留素材来源。
- 2026-09-06：用户要求删除该试剪工程，`experiments/video-talkcraft-trial/` 已清理；本条记录仅留作历史审计。

## 2026-09-02：按口播审计完善完成状态、全局撤销、已删画面恢复与预览诊断

### 目标

落实 `agentcut-speaking-audit-2026-09-02` 口播功能逻辑审计的 P0 项：把"候选清零即初剪确认"改为多维独立就绪信号；提供全局撤销与已删无口播画面的可见恢复入口；为预览黑屏和服务掉线提供可操作的诊断与恢复。

### 实际改动

- `@agentcut/review-projection` 新增 `buildRoughCutReadiness`：从审阅投影、可选无口播区间、导出任务和命令日志派生独立就绪信号（候选待决数/已决定、剩余无口播画面数、导出是否成功/过期/最新），并解析"最近一次仍可恢复的删除"作为全局撤销目标（按 committedRevision 取最新，批量删除合并为一个事务并累计删除时长）。
- local daemon 在 `/api/review` 中返回 `readiness`；`roughCutStatus` 语义保持不变，继续作为导出门禁，避免影响 Alpha 协议。
- Studio 新增 `ReadinessChecklist` 组件（侧栏"完成度"区），把候选决定、无口播画面清理、成片导出三件事分列，明确"候选清零 ≠ 成片已验收"；附"撤销最近一次删除"按钮。
- Studio 新增全局 Cmd/Ctrl+Z：恢复最近一次删除事务（沿用现有可恢复 restore 端点）；Alpha 计时锁定与 busy 状态下不触发。
- Studio 文稿面板新增"已删除画面"条带：列出所有已提交的无口播画面删除（含句中无相邻文字、原先不会内联渲染的独立片段），点击即恢复，作为已删区间的 tombstone 视图。
- Studio Viewer 增加错误诊断：捕获视频 `error`（网络/解码/格式不支持），区分代理与源文件给出可操作提示，并提供"重新加载预览"按钮。
- Studio "无法打开工程"掉线页新增"重试连接"按钮，重新拉取工程而无需刷新整页。

### 验证

- 新增并通过测试：review-projection readiness 5 项（独立信号、批量合并撤销、gap 标注、失效事务忽略）、Studio readiness 4 项、Viewer 错误诊断 4 项、文稿已删画面恢复 1 项；daemon 恢复测试补充 readiness 与撤销目标断言。
- 全仓 `CI=true AGENTCUT_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg pnpm check` 通过：15 个 production build、全部 strict typecheck、429/429 测试通过（此前 415）。
- 用只读临时副本对真实 dogfood `sample-03-project`（REV 18）冒烟：投影得 0 待决候选、11 段可选无口播画面、撤销目标解析为真实最近手工删除事务（REV 16，3.46 秒口播内容）；临时副本已删除，真实工程保持 REV 18，未对 Gate 证据做任何写入。

### 限制与后续

- "用户已完整预览"这一审计建议的就绪维度需要持久化的用户确认，本轮未实现；当前就绪信号均为只读派生，不新增写操作。
- 全局撤销目前只恢复"最近一次删除"，不提供多步撤销栈或重做；已删画面恢复沿用单事务 restore，恢复后该候选回到待决或由分析候选集接管。
- 审计的其余 P0/P1 项（统一三套选择模型为单一清理队列、文稿拖选、时间线缩放/波形、停顿压缩预设、声学静音分层、剪口 crossfade 与爆音检测）尚未实现，仍需后续迭代。

## 2026-09-01：让无口播画面可选择、试听并 Ripple 删除

### 目标

落实口播视频的音画对应规则：当前初剪中未被任何 Transcript 文字覆盖的保留画面，应能从文稿或时间线明确选中，试听删除效果后做可恢复删除；修复原先人工补删只能提交文字 ID、无法选择开头/句间/结尾空白和删词后残留画面的能力缺口。

### 实际改动

- `@agentcut/review-projection` 新增 speech-gap 投影：以当前 Timeline 中仍启用的口播视频 clip 为边界，对照 Transcript word 时间戳派生无文字覆盖区间，同时给出 source range、edited timeline range、相邻 word 锚点和稳定 gap ID；已删除源片不会重新进入可选列表。
- 为避免把正常字间对齐抖动制造成大量碎片，默认只公开不短于 150ms 的无口播区间；区间可以是开头空白、句间空白、结尾空白，也可以是前序剪辑留下且内部没有任何文字的独立 clip。
- `@agentcut/candidate-engine` 新增人工 speech-gap 删除编译器；提交前强制验证区间仍完整存在于一个可编辑 clip、时长为正、没有覆盖任何 Transcript word，随后生成 `gap` candidate、proposal 和 `range.deleteRipple`，并保留完整 inverse operations。
- local daemon 在 `/api/review` 中返回当前 speech gaps，并新增 revision-bound 的预览与删除接口；接口只接受服务器当前投影的 gap ID，过期或已删除区间不能凭客户端旧 source range 重放。
- Studio 文稿面板新增“无口播画面”条带，区分开头/句间/结尾/独立无口播片段；选中后提供“试听删除效果”“删除此段”“取消”。时间线同步显示可点击的斜纹区间，点击后跳到文稿操作区。
- 新增 speech-gap 投影阈值、人工 gap 事务、语音重叠拒绝、daemon 预览不写入、删除可恢复、文稿操作控件和时间线定位回归测试。

### 验证

- 定向测试通过：review-projection 9/9、candidate-engine 31/31、Studio 96/96、local-daemon 42/42；相关 strict typecheck 通过。
- 对真实 dogfood REV 18 的只读投影得到 11 段可选无口播画面：开头 2.60 秒、多个 0.17–0.48 秒句间/边界停顿、三个 0.21–0.36 秒独立残留片段和尾部附近 2.62 秒独立片段；未对真实工程自动执行删除。
- 重启 Studio 后在当前页面实测：文稿条带完整显示 11 段，选择“开头空白 2.60 秒”后出现删除/试听/取消控件；时间线显示同样 11 个可点击区间，点击 0:54 的 2.62 秒区间会联动回文稿并选中对应片段。测试后已取消选区，真实工程保持 REV 18。
- 全仓 `CI=true AGENTCUT_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg pnpm check` 通过：15 个 production build、全部 strict typecheck、415/415 测试通过。

### 限制与后续

- speech gap 以现有 Transcript word 对齐为依据，不等同于声学 VAD 的逐采样真值；因此界面保留删除效果试听，不会自动批量提交。
- 当前只公开不少于 150ms 的无口播画面，避免正常字间微小时间戳空隙淹没交互；若需要逐帧修边，应在后续时间线 trim/drag 工具中处理，而不是降低口播清理默认阈值。
- 本轮覆盖单条、无变速的主口播视频轨道；多机位、B-roll、时间重映射与 J/L cut 仍需单独定义“没有对应口播即多余”的适用边界。

## 2026-09-01：为成功导出补充版本过期提示与重新导出入口

### 目标

修复工程继续剪辑后，Studio 顶栏仍只显示旧“打开成片”、没有重新导出入口的问题，避免用户误把旧版本成片当作当前初剪。

### 实际改动

- `ExportControl` 继续保留已成功成片和 SRT 的访问入口，同时始终提供按同一画幅预设重新导出的按钮。
- 根据导出任务的 `sourceRevision` 与当前工程 revision 判断产物是否已过期；成功导出登记产物会推进一次 revision，若工程版本在此之后继续前进，则显示“成片已过期”和“重新导出当前版本”。
- 将当前工程 revision 从 `ReviewHeader` 显式传入导出组件；重新导出继续走既有稳定 request ID 和 revision-bound 导出 API，不覆盖旧产物。
- 新增成功成片仍可重新导出、旧成片版本提示和当前 REV 文案回归测试，并补充过期与重新导出按钮样式。

### 验证

- Studio 定向测试通过：20 个测试文件、94/94 测试通过。
- 全仓 `CI=true AGENTCUT_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg pnpm check` 通过：15 个 production build、全部 strict typecheck、408/408 测试通过。
- 默认沙箱首轮在 MCP loopback 测试遇到 `listen EPERM`；在宿主环境使用相同命令复跑后全部通过，没有代码断言失败。

### 限制与后续

- 本次只补齐版本感知的重新导出入口，不会自动创建真实导出任务；由用户点击后才会按当前 REV 渲染。
- 旧成片仍可打开和下载，界面通过“成片已过期”明确区分其版本状态；当前未提供导出历史列表或旧产物清理操作。

## 2026-09-01：修复 Studio 导出预检失败并自动选择 ffmpeg-full

### 目标

修复候选已全部决定后点击“导出成片”仍无法创建任务的问题，并让渲染能力不足时显示真实原因。

### 实际改动

- 查明当前 Studio 进程使用 PATH 中的 `/opt/homebrew/bin/ffmpeg`；渲染能力预检返回 `missing: ["ass_filter"]`，四次导出请求均在创建 job 前失败，因此工程保持 REV 14 且 SQLite 中没有残留导出任务。
- 新增 Studio 媒体工具解析器：保留用户显式 `AGENTCUT_FFMPEG_PATH`/`AGENTCUT_FFPROBE_PATH`，未配置时优先选择 Homebrew `ffmpeg-full` 及同目录 `ffprobe`，不存在时继续使用 daemon 原有 PATH 降级与能力预检。
- `start-studio.mjs` 将解析出的路径显式传给 local daemon，并在启动日志中输出非敏感的 FFmpeg runtime 路径。
- local daemon 将确定性的 `RENDER_CAPABILITY_MISSING` 从兜底 500 改为 422；Studio 会直接显示“当前 FFmpeg 环境不能可靠导出”及缺失能力，不再误报为写入响应中断或 daemon 未连接。
- 新增显式配置优先、Homebrew 自动选择、PATH 降级、HTTP 状态映射和 Studio 错误保真测试。

### 验证

- 定向测试通过：local-daemon 41/41、Studio 92/92，两个相关 workspace strict typecheck 通过。
- 全仓 `CI=true AGENTCUT_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg pnpm check` 通过：15 个 production build、全部 strict typecheck、406/406 测试通过。
- 本机能力对照：PATH 默认 FFmpeg 8.1.1 返回 `ready: false`、缺少 `ass_filter`；`/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` 8.1.2 返回 `ready: true`、无缺失能力。

### 限制与后续

- 自动发现当前覆盖 Apple Silicon 和 Intel Homebrew 的标准 `ffmpeg-full` 路径；其他包管理器或自定义安装仍应显式设置 `AGENTCUT_FFMPEG_PATH`。
- 本轮不会替用户自动重新提交导出；重启后先验证 runtime 路径与预检，再由用户决定何时创建真实导出任务。

## 2026-09-01：修复连续口播删除在第四次左右失效

### 目标

修复 Studio 中候选点击“删除此段”后无反应的问题，并确保确定性的工程校验失败不会被误报为网络响应中断。

### 实际改动

- 查明连续 ripple 删除会把上一轮完整 clip ID、proposal ID 和 split 后缀递归拼接；真实工程的右侧 clip ID 已增长到 169 字符，下一次生成约 220 字符，超过 Timeline Schema 的 200 字符上限，事务因 `INVALID_DOCUMENT` 回滚。
- `@agentcut/edit-commands` 保持既有短 ID 格式不变；仅在生成结果将超长时，对完整 lineage 做 SHA-256 派生并生成固定长度 `clip_split_<digest>_<序号>`，避免后续连续删除再次递归增长。
- local daemon 将 `INVALID_DOCUMENT` 从兜底 500 改为权威 422；Studio 因而会结束当前稳定 request ID，并明确提示“本次没有写入”，不再将确定性回滚显示为“写入响应中断”。
- 新增长 lineage 编译、确定性 ID、Schema 提交、HTTP 状态映射和 Studio 中文错误信息回归测试。

### 验证

- 定向检查通过：edit-commands 27/27、local-daemon 38/38、Studio 91/91，三个相关 workspace strict typecheck 通过。
- 全仓 `CI=true AGENTCUT_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg pnpm check` 通过：15 个 production build、全部 strict typecheck、402/402 测试通过。
- local-daemon 的两个 loopback 测试在默认沙箱内因 `listen EPERM` 超时，按既有测试边界在宿主复跑后全部通过；不是代码断言失败。
- 对真实 dogfood SQLite 做一致性临时副本后，以原 REV 10 和原失败候选执行相同接受事务，副本成功提交到 REV 11 并生成固定长度 `clip_split_…` ID；真实工程保持 REV 10、待审 3、删除 4，未被验证写入。

### 限制与后续

- 压缩 ID 使用 128-bit SHA-256 前缀并继续执行现有工程内重复 ID 检查；理论哈希碰撞会显式返回 `DUPLICATE_ID`，不会覆盖已有片段。
- 本轮只修复删除事务与错误反馈；Transcript 手动选择仍是点击起点加 Shift 点击终点，拖拽选择交互尚未实现。

## 2026-09-01：首支主题到动效视频样片进入可预览 Gate

### 目标

验证“用户只给主题，外部 AI 使用 AgentCut 兼容的轻量媒体工具完成脚本、动效、文字、旁白、字幕和渲染计划”的第一类任务；本轮先制作真实 60 秒竖屏样片，不把模型或视频生成运行时并入 AgentCut 主进程。

### 实际改动

- 新增隔离实验工程 `experiments/deepseek-v4-vision-video/`，围绕 DeepSeek-V4-Flash-Vision-Exp 开源新闻完成事实边界、中文脚本、六镜头分镜、Deep Current 深海蓝/青色设计系统与 1080×1920 HyperFrames composition。
- 事实表达明确限定为“DeepSeek 官方自测多模态 Agent 接近 Opus-4.8”，同时展示实验模型、约 305B 参数和非第三方共识，避免把厂商 benchmark 制作成独立结论。
- 六帧分别实现 kinetic type、仓库清单组装、视觉到工具的 Agent 流程、四项基准同轴比较、官方自测/算力双限制、EYES/TOOLS/ACTION 开放闭环；主视觉均避开底部 17% 字幕安全区。
- 使用 macOS 本地 Tingting 声线生成六段普通话旁白；Kokoro Python 依赖因网络下载长时间无进展后停止，没有将权重或依赖写入产品包。
- 使用 FFmpeg 程序合成 60 秒低频电子底床（约 1 MB），没有安装 MusicGen；生成 17 个时间片的中文字幕、逐段旁白挂载与 60 秒总装配。
- 样片工程 `.gitignore` 排除虚拟环境、媒体缓存、音频和渲染成片，避免将模型缓存、构建产物或媒体交付物纳入仓库。

### 验证

- 分帧 packet 6/6 通过 48 KB 上限，六个 frame composition 均落盘并注册唯一 paused GSAP timeline。
- HyperFrames 0.8.22 `npm run check` 通过：Lint 0 error、Runtime 0 error、Layout 0 error、Motion 0 error、Contrast 61/61 WCAG AA；已修复字幕字体声明、动态 template selector 与第四帧两处实际文字重叠。
- 装配报告：1080×1920、6 帧、6 段旁白、1 条 BGM、中文字幕、总时长 60 秒，时间轴无漂移。
- 已在 3.5/11.5/21/32.5/44.5/55 秒和结尾生成联系表并人工检查；字体通过本机 PingFang PostScript 名称加载，画面与字幕可读，未发现关键内容进入字幕带。
- 全仓 `pnpm check` 以仓库要求的 `/opt/homebrew/opt/ffmpeg-full` 和本机 loopback 完整通过：15 个 production build、全部 strict typecheck、399/399 测试通过；默认沙箱首轮在 MCP loopback 得到 `EPERM`，宿主默认 FFmpeg 又因缺 libass 使 18 个渲染用例失败，绑定 README 指定的 ffmpeg-full 后原命令无代码断言失败。

### 限制与后续

- 当前为可预览、未渲染状态；按视频工作流在用户确认预览后再生成 `renders/video.mp4`，不能把本条记录表述为成片已交付。
- 本地 Tingting 是轻量降级声线，不代表最终商业旁白质量；若用户认可内容与视觉，再评估可选 Kokoro/外部 TTS provider，仍保持运行时外置和按需加载。
- `check` 仍有非阻断警告：部分 frame DOM id 以数字开头、若干 Studio 可编辑层缺少独立 id、四段旁白短于镜头 slot；这些不影响本次渲染，但在抽象为 AgentCut 通用 composition adapter 前应统一命名与音频 slot 语义。
- 快照显示第五帧在上下限制面板交接时保留较大负空间，这是刻意的审慎停顿；需结合完整播放听审后再决定是否加密信息节奏。

## 2026-09-01：课堂展示采用 ai-video 原生 UI（AgentCut demo 让位）

### 决策

用户原本计划用 `demos/short-video-generator` 包装 AgentCut 做课堂展示，但最终决定**改用用户自己的独立项目 `~/Developer/ai-video-clone`（ai-video）作为原生 demo**——它已有完整 Web UI（素材中心/创作工作台/时间线历史/渲染任务），展示"AI 短视频生成"的故事线更完整。AgentCut 核心与 demo 包保持不动。

### ai-video 演示环境（已跑通）

- 全栈 Docker Compose 运行中：web(3000) / api(8000) / render-worker / postgres / redis；`LangGraph 已连接`，各服务 healthy。
- LLM：DeepSeek（`LLM_API_BASE=https://api.deepseek.com/v1`，`LLM_MODEL=deepseek-chat`）。
- ASR：**本地 mlx-whisper 桥接**（`~/Developer/ai-video-asr-bridge/asr_bridge.py`，端口 8877，OpenAI 兼容 `/v1/audio/transcriptions`，复用 AgentCut `packages/asr-worker` venv）替代小米 MiMo ASR（账户余额不足 402）。ai-video `.env` 设 `ASR_PROVIDER=openai`、`ASR_API_BASE=http://host.docker.internal:8877/v1`、`ASR_MODEL=mlx-community/whisper-large-v3-turbo`。
- `VLM_ENABLED=false`（DeepSeek 不支持视觉）。
- 合成演示素材：两条不同主题的英文播客（macOS `say -v Alex` + ffmpeg 纯色背景），已上传素材库：`podcast.mp4`（76s，Future of Work）、`podcast2.mp4`（52s，Startup Stories），均已 ASR 转录。

### 本次修复（ai-video-clone 内，均为 demo 适配）

1. **QC `-Infinity` 崩溃**：`packages/api/app/services/qc/checker.py` 新增 `_finite_float()`，ffmpeg loudnorm 返回 `input_i=-inf` 时回退默认值，避免 asyncpg JSONB 写入失败。
2. **QC 布局误报**：竖版成片中纯视频素材（横屏播客 talking-head）统一 `fit_with_blur_bg` 是防黑边标准做法，但 QC 布局规则判失败（fit 占比 5/5、布局单一）。`check_layout_quality` 增加 `all_source_video` 豁免（全部 cut 为 `source_video` 时跳过这两条规则）。
3. **素材列表"待分析"显示**：`schemas/asset.py` 的 `AssetBasicResponse` 增加 `text` 字段（列表 API 已 selectinload 但未序列化），前端 `getReadyState` 据此显示"部分/就绪"。
4. **详情页 GET 405**：前端用 GET 读取已有 ASR/高亮结果，但后端只有 POST。为 `asr.py`、`highlight.py` 增加 GET 端点返回已存结果（ASR 按句分段、高亮返回文本摘要）。

### 验证（浏览器全流程）

- 素材中心显示 2 个素材（部分状态）；详情页"转录"tab 完整显示 ASR 文本（17 段）。
- 工作台：勾选 2 素材 → 输入自然语言 brief → 画幅"竖屏 9:16" → 精品模式（LangGraph）→ 生成时间线 `tl_a107b99cb331`（5 段落、2 素材混剪、含字幕轨）。
- 渲染：`job_r_78b8b039` **成功**（QC 通过，35.8s），成片 1080×1920 竖版 H.264+AAC 25s，下载入口 `/v1/render/{job_id}/file` 可用。

### 演示操作路径（给老师）

1. 打开 `http://localhost:3000`（web）→ 素材中心看已上传素材 → 点开素材看 ASR 转录。
2. 创作工作台 → 勾选 2 个素材 → 输入 brief（如"挑选最有价值的观点，生成约40秒竖版短视频"）→ 竖屏 9:16 → AI 混剪。
3. 等待时间线生成（精品模式 LangGraph 多轮验证，约 10–30s）→ 开始渲染（约 30–60s）→ 渲染任务页看到"成功" → 下载成片。

### 注意

- 渲染依赖 DeepSeek API key（`LLM_API_KEY`）与本地 ASR 桥接（8877 端口）保持运行。
- 若重装/重启 Docker：`cd ~/Developer/ai-video-clone && docker compose -f infra/docker-compose.yml -p ai-video-clone up -d --build`；ASR 桥接用 `uv run uvicorn asr_bridge:app --host 0.0.0.0 --port 8877`（在 `~/Developer/ai-video-asr-bridge` 内、AgentCut venv）。
- 素材库里留有历史失败任务（旧 QC 布局规则误报），不影响演示，必要时可在 UI 或 DB 清理。

## 2026-09-01：短视频切片 Demo（课堂/路演用）

### 目标

用户需要把 AgentCut 包装成"AI 短视频生成工具"给老师展示，核心故事是：把国外长播客自动剪成带悬浮字幕的竖版短视频（类似 YouTube 上常见的 AI 播客切片）。要求不破坏原有结构、临时使用、项目不要做大。

### 实际改动

- 新增独立 demo 包 `demos/short-video-generator/`，**不改动 AgentCut 核心代码与 Gate 证据**：
  - `scripts/run-demo.mjs`：CLI 入口。支持 `--synthetic` 生成内置样例，或接收任意本地视频路径。
  - 内置样例：用 macOS `say -v Alex` 合成一段约 76 秒英文播客（"Future of Work"），内容中立、无版权风险；脚本自动将其与纯色背景合成为 1920×1080 横版视频。
  - 复用 AgentCut 现有 `packages/asr-worker`（mlx-whisper large-v3-turbo）做英文词级转写。
  - 高光选择：合并连续 ASR 句子生成 25–40 秒候选片段，按词密度排序并去重；尾部剩余内容不足 25 秒时，若 ≥12 秒则作为第三个短 clip 输出。
  - 渲染：ffmpeg `filter_complex` 生成 1080×1920 竖版——横版源缩放居中、背景用模糊版填充、顶部标题条、底部 ASS 悬浮字幕（半透明背景框 + 白色描边大字）。
- 根 `package.json` 新增两个脚本：
  - `pnpm demo:shorts`：一键运行内置样例。
  - `pnpm demo:shorts:custom -- <视频路径>`：对指定视频切片。

### 验证

- `pnpm demo:shorts` 在本机跑通：76.1s 合成播客 → 162 个词级时间戳 → 自动选出 3 个 clip：
  - clip-01：0.00s–27.20s
  - clip-02：34.78s–61.60s
  - clip-03：63.60s–76.07s
- 输出全部位于 `/tmp/agentcut-shorts-demo/clip-*/short.mp4`，规格 1080×1920、H.264+AAC、duration 分别为 27.2s / 26.9s / 12.5s，可直接下载播放。
- `pnpm alpha:gate` 未运行新证据收集，Gate 状态保持先前快照（3/20 授权、0/20 审阅导出），demo 未泄漏证据。

### 限制与后续

- 目前只做「切片 + 悬浮字幕 + 竖版渲染 + 本地文件输出」，没有真正接入平台分发 API；演示时按 README 话术明确边界即可。
- 样例音频为系统 TTS，真实演示时可用 `pnpm demo:shorts:custom -- <真实播客视频>`，但输入时长建议控制在 90 秒以内，避免 mlx-whisper large-v3-turbo 在部分机器上因内存压力被系统终止。
- demo 代码未加入 `pnpm-workspace.yaml`，不参与 `pnpm -r build/typecheck/test`；保持与主工程隔离。
- 新增可视化 Web UI（课堂展示友好）：`pnpm demo:shorts:web` 启动 `http://127.0.0.1:4400`，页面提供「一键生成内置样例」按钮、实时进度日志、生成后直接播放与下载 3 条短视频。后端复用同一 `runPipeline`（通过 `onProgress` 回调推送日志），前端轮询 `/api/status`，视频流支持 HTTP Range。

## 2026-08-15：外部素材包（azh-video-analysis-pack）端到端工程冒烟

### 目标

用户提供私有仓库 `haoabcde/azh-video-analysis-pack-20260705`（深圳爱之慧教育视频项目分析包：8 条 raw 素材 + 5 条 AI 配音成片 + 制作脚本），问能否用于测试项目。先判定素材与 Alpha Gate 的适配性，再对代表性文件做**不计入 Gate** 的端到端工程冒烟（临时副本、非 alpha-trial 项目、验证后删除）。

### 素材判定（ffprobe + 音量检测实测）

- raw-assets 8 条全部 **HEVC** 720p30 + AAC，8.9–47.5s，活动现场短片（音量为环境/现场声量级）；其中 47.5s 那条实际含有连续真人普通话讲解（并非纯环境音）。
- generated 5 条成片全部 H.264（横版 720p 63–72s、竖版 1080×1920 58.8s/94MB），人声为 TTS 配音，竖版带合成 BGM。
- 结论：**不适合登记为 Gate 正式样本**——Gate 度量“可信中文口播”（definite_remove precision、边界可用率依赖真人语音的填充词/改口/自然停顿），TTS 无可度量缺陷，只会产生空证据污染 Gate；时长也全不满足 G1（5–15 分钟）；8 类 coverage 均为真实口播属性，TTS 一类都不该挂。素材包未做任何登记，是否授权的判断未触发。

### 冒烟执行（3 个 /tmp 临时项目，非 alpha-trial）

- **HEVC 现场讲解（47.5s）**：`playbackKind: "proxy"`——preview-proxy 直通检查正确判定非 h264/aac 并转码出 h264+aac 代理（1280×720，47.52s 与源对齐）。这是 HEVC 转码路径首次用真实输入验证（既有 3 条正式样本与本机 3 条待授权录屏全是 H.264）。ASR 转出 150 词纯中文讲解；机械检测 0 候选，直接 ffmpeg silencedetect 交叉复核一致（连续讲话确无 ≥0.5s/-40dB 停顿），无误报。
- **TTS 横版商务男声（65.3s）**：`playbackKind: "source"` 直通正确。候选报告 `definiteRemove: 0`（TTS 负面用例通过）；6 个停顿全部 medium/suggest_remove 且各留 150ms 呼吸余量；检出 1 条连续完全重复“全面启动”——对照原 SRT 脚本该句只出现一次，词级时间戳显示第二次“全面启动”挤在结尾 0.3s 内、词概率 0.002–0.110，判定为 **whisper 结尾幻觉**而非真实配音缺陷。引擎因聚合置信度 0.0016 将其 fail-closed 为 high risk「必须试听确认，不能自动删除」——低置信度反幻觉门禁在真实数据上按设计工作，未发生自动错删。
- **TTS 竖版 BGM（58.8s，94MB）**：大文件摄入正常；BGM 床下 ASR 稳健（词概率均值 0.984，仅 1 词 <0.5）；候选全零。已知特性确认：BGM 使能量高于 -40dB 阈值，停顿检测对 background-music 类素材恒为空，该类素材只能靠词级（填充词/重复）检测。
- **导出全链路（HEVC 项目）**：daemon 配对后经 `POST /api/exports` 导出 `succeeded`、`quality.passed: true`、时长 Δ0ms（47.500 vs 47.467s 对齐后无漂移）、12 条字幕 cue 烧录（ffmpeg-full libass）、fitMode contain；同 requestId+revision 幂等重放秒回同一 succeeded job，不重渲染。

### 清理与 Gate 复核

- 临时项目（/tmp/azh-smoke-projects）与素材克隆（/tmp/azh-pack-inspect，391MB）已全部删除；daemon 已停。未注册 manifest、未写授权文件、未改仓库任何文件。
- `pnpm alpha:gate` 复核与冒烟前逐项一致：3/20 授权、0/20 审阅导出、0/20 配对计时、四类正确性 3/3 across 3/3，exit 1 / insufficient_evidence——冒烟未向 Gate 泄漏任何证据。

### 限制与后续

- 冒烟只覆盖单视频工程；竖版 94MB 未跑导出（渲染路径与画幅无关，HEVC 案例已证明链路）。
- raw-assets 其余 7 条未逐条跑 ASR；若用户日后需要覆盖更多真实形态（如 background-music 真人素材），该包的 raw clip 可作为**工程鲁棒性**输入复用，但仍须另行授权且不替代 Gate 口播样本。
- 素材包内 `docs/technical-analysis.md` 的「AI 剪辑 agent 分层设计」（素材理解→风格规划→确定性渲染→复审）与 AgentCut 架构一致，可作 roadmap 参考，与本次冒烟无关。

## 2026-08-14：批量审阅在正式 sample-03 上的真实浏览器只读验证

### 目标

批量审阅的组件测试不能证明用户在真实工程上会看到什么。用生产构建在 sample-03（REV 9，4 个未决候选）上做一次完整的只读浏览器验证，并修复发现的问题。

### 实际改动

- 修复禁用原因优先级：已删除/已保留/已随主项解决的状态原因先于风险原因，避免「已删除的高风险候选」显示“高风险候选必须逐项试听并确认”的误导文案。Studio 90/90（+1 状态优先于风险的断言）。
- 用 Playwright 对 `127.0.0.1:4317`（生产构建 + 正式工程）完成只读验证：
  - 配对后 REV 9、4 待处理、7 候选队列与 08-13 记录一致；页面 warning/error 日志为 0。
  - 视频元素 readyState=4、duration 78.766667 秒、error null，实际播放推进到约 1.08 秒后暂停，源媒体 Range 与配对 Cookie 正常。
  - 批量模式：勾选资格与实际投影一致——两个独立中等停顿（401ms、764ms）可勾选；3 个已删项、等待主项的 660ms 停顿（title=“与更高风险主项重叠”）、高风险冲突主项（title=“高风险候选必须逐项试听并确认”）均禁用；全选恰好勾中 2 项，“删除选中 2 项”激活、全选按钮随之禁用。
  - 修复后重启 daemon 并硬刷新：状态正确重置（批量模式关闭、无残留勾选），已删除的高风险重说项 title 变为“已删除”，其余不变。
- 全程未点击任何写操作：REV 保持 9、command_log 9 条、alpha-evidence 3 事件，未推进 Timeline、未写标签/计时/导出。daemon 以最新生产构建留在 4317 端口供后续人工听审直接使用。

### 限制

- 验证只覆盖批量审阅 UI 与既有审阅投影的一致性；人工取舍、候选/边界标签与配对计时仍未开始，G5 证据不变（3/20 授权、0/20 审阅导出、0/20 配对计时）。
- 同一验证尚未在 sample-02（14 未决候选）重复执行；批量逻辑与投影门禁在单元/集成测试覆盖，sample-02 首次人工听审时按同样顺序复核即可。

## 2026-08-14：批量审阅——低/中风险候选按一次可恢复事务成批删除

### 目标

G2 尚未关闭的三项缺口中，「批量审阅」是纯工程缺口（另两项是整条素材人工验收与真实改口/误启动样本，依赖授权素材）。现有审阅循环逐候选提交，14 个未决候选的 sample-02 需要 14 次往返；初剪生成虽能一次应用全部 definite 低风险候选，但用户无法在提交前逐项勾选并成批试听确认。目标：低/中风险候选可以成批勾选、按一次事务提交（一次 revision、一次 undo），同时守住「高风险候选不进入无确认批量删除」的既有纪律。

### 实际改动

- candidate-engine 新增 `compileCandidateAcceptBatch`：一次事务内写入一个含 N 个候选的 human-review CandidateSet、一个 `selectedCandidateIds` 为 N 的 Proposal（payloadHash 覆盖全列表），以及按源范围合并的 Ripple 删除操作和重叠组替代锁。拒绝空/重复列表、跨 Transcript/Sequence/Clip 候选、已保留锁候选，并且**任何 high 风险候选都会 fail closed**（`HIGH_RISK_CONFIRMATION_REQUIRED`），与单项路径一致。
- 编译复用 `compileEditProposalBundle` 的多范围删除语义——初剪生成（`createLowRiskProposal`）已用同一机制一次应用全部 definite 低风险候选，因此批量接受不是新的时间线删除模型，而是把既有可逆机制开放给逐项勾选的用户审阅。
- 批量事务可携带 `resolveOverlapCandidateIds`：接受重叠组主项时，其余组员在**同一事务**内写入 `agentcut:candidate_overlap_group` 替代锁；组员被勾选进批量、或主项不在批量内却出现在解析表中，均 `INVALID_SELECTION` 拒绝。undo 同时还原剪切与整组锁。
- daemon 新增 `POST /api/candidates/batch-accept`：与单项路径相同的顺序——先查幂等记录、`assertAlphaTrialEditingActive`（正式样本计时门）、`assertCurrentRevision`，再对每个勾选项跑 `assertCandidateOverlapDecisionAnchor`（组员直接 `CANDIDATE_OVERLAP_ANCHOR_REQUIRED`），最后单事务提交。route 只对 Studio UI 用户开放，Agent CLI/MCP 依然没有批量或单项 accept 工具。
- Studio 新增批量审阅模式：候选队列可勾选低/中风险待审候选（高风险、非主项组员、已处理项禁用并说明原因）；「全选可批量项」「清空选择」「删除选中 N 项」经同一 MutationRequestRegistry/稳定 requestId 提交，响应未知时与单项删除互斥。提交成功后自动前进到下一条待审候选；revision 或候选投影刷新后自动剔除已失效的勾选。
- 恢复语义显式披露：批量接受是单一 transactionId，因此从任一已删候选点「恢复本次提交」会整批还原。CandidateInspector 现在计算共享同一 transaction 的候选数，批量提交显示「恢复本次提交（批量 N 项，将一并恢复）」。
- 队列标题栏的「批量审阅」开关在无可批量候选时禁用；批量面板明示「已勾选项按一次可恢复事务提交，恢复时整批还原」。

### 测试与限制

- candidate-engine **29/29**（+8：批量编译、high 拒绝、已保留拒绝、重叠锚批量解析与整批还原、锚+组员同时勾选拒绝、未知锚拒绝、空/重复列表拒绝、跨序列拒绝）；local-daemon **37/37**（+4：一次事务批量接受、幂等重放与整批还原、high 拒绝且 revision 不变、重叠组员拒绝/锚批量解析/恢复、畸形与 stale 请求拒绝）；Studio **89/89**（+6：批量勾选资格、checkbox 与禁用原因、提交按钮与整批还原文案、共享事务恢复标签、API 契约、导航判定）。
- 完整 `pnpm check`（`ffmpeg-full` + 本机 loopback）通过：15 个 production build、全部 strict typecheck、**398/398 测试**；较 2026-08-13 基线 374 净增 24（本批 +18，其余为既有测试文件在本批完整回归中的计数差异，见各包数字）。
- 未触碰正式 sample-02/03 工程：REV、候选、标签、计时与导出证据均未改变。批量审阅本身不产生新证据分母，G5 仍为 3/20 授权、0/20 审阅导出、0/20 配对计时（`pnpm alpha:gate` 已复核，exit 1 / insufficient_evidence，与改动前一致）。
- 该功能把 G2 的「批量审阅」从缺口变成已实现，但 G2 关闭仍需整条真实素材全部候选人工验收与真实改口/误启动样本；批量模式不改变「高风险必须逐项试听 + checkbox + confirmHighRisk」的约束，也不替用户决定任何内容取舍。

## 2026-08-14：样本 coverage 补登、建项辅助脚本与本机素材盘点

### 目标

gate 凑满 20 个授权项目后强制 8 类 coverage 全覆盖，未记录类别按缺失计；sample-02/03 早于该特性登记，manifest 中无类别。同时每条新样本的登记要经过算 hash、写 cohort 标记、建项三步终端操作，17 条新素材的收集摩擦高。目标：如实补登既有 cohort 的类别，并把新样本建项收成一条命令，授权判断仍归用户。

### 实际改动

- 用 `alpha:collect` 同一命令、同一授权证据文件为 `project_p1_real_dogfood_sample_02/03` 幂等补登 `coverageClasses: ["mandarin"]`。类别由机器验证：两个工程的 canonical Transcript `language: zh`，全文词表无任何拉丁/数字 token（纯中文口播，无混说、无专名数字）。manifest 差异仅 coverageClasses 与 evidenceBundle 引用（新 bundle 含新增的 collect 式 correctness run，旧 bundle 与旧事件保留）；candidate 计数、边界、正确性、授权 hash 等所有字段未变。`alpha:gate` 复核输出与改动前逐项一致（3/20 授权、四类正确性 3/3 across 3/3、其余 insufficient）。
- 新增 `scripts/new-alpha-sample.mjs`（`pnpm alpha:new-sample`）：流式计算源视频 SHA-256；对照 manifest 拒绝「同一素材换 cohort」与「同一 cohort 换素材」；`--alpha-trial` 建项；打印授权记录文件模板（含精确 cohort 标记行）与 collect 命令。**不代写授权文件**——来源、授权范围、确认方式必须由用户确认后落盘。`--dry-run` 只计算并打印不建项。project 目录缺省为 `.agentcut/dogfood/<cohort-id>`。
- docs/17 与 G5 runbook（docs/13 §9）把辅助脚本作为推荐建项路径，保留原始 `roughcut` 命令作为等价回退；docs/17 同时记录既有 cohort 幂等补登类别的支持路径。
- 本机素材盘点（不登记、不建项）：除已用 3 条外，发现 `~/Developer/ios开发/deliverables/day6-materials/demo-full-loop.mp4`（13.0s）、`demo-autocapture.mp4`（11.9s）、`~/Developer/ios开发/assets/review/blind-director-demo-flow.mp4`（47.6s），均为 1206×2622 手机竖屏 H.264 录屏。是否含中文口播、是否授权、覆盖类别（screen-recording）需用户确认；时长均不满足 G1 的 5–15 分钟，但若授权可作 G5 样本。

### 测试与限制

- 辅助脚本冒烟：dry-run 对未登记素材正确输出 hash、授权模板与 collect 命令；对已登记素材（sample-01 源）拒绝「同一素材不能进入第二个 cohort」；对已绑定其他素材的 cohort 拒绝并给出既有 hash。均为只读检查，未创建任何工程、未写 manifest。
- 本轮没有新增授权、没有替用户登记任何新素材：G5 仍为 3/20 授权、0/20 审阅导出、0/20 配对计时。三个新发现的录屏视频仅盘点待用户决定。
- 补登类别属于如实元数据登记，不改变任何内容取舍、标签、计时或导出证据；若未来发现登记类别与实际素材形态不符，应走新审查流程修正，不得静默覆盖。

## 2026-08-13：sample-03 暴露并修复跨 detector 候选重叠

### 目标

把现有授权项目从“代码可用”推进到真实听审时，sample-03 的最后两个候选暴露出结构性冲突：中风险停顿 `73.732104–74.392479s` 与高风险重复 `74.280000–76.360000s` 重叠 112.479ms。若按原队列先提交停顿，重复范围不再完整存在于一个可编辑 clip；若先保留重复、随后再删停顿，又可能截掉首词“下”的起音。旧 UI 只显示四个独立待审项，无法向用户或 Agent 表达这个互斥关系。

### 实际改动

- review projection 对全部未决候选的 source range 建连通重叠组，以 risk（high > medium > low）、完整 words 优先于 gap、语义重复/重说/改口优先的确定性规则选唯一 `overlapDecisionAnchorId`，并返回组员与决定后的 `overlapResolvedByCandidateId`。
- Studio 将主项、等待主项和随主项解决分别呈现；非主项仍可试听但删除/保留按钮及快捷键提交被禁用。主项明确说明其余组员会在同一可恢复事务内作为替代项锁定。React 只消费 daemon 投影并做交互防御，不保存第二份冲突图。
- daemon 在普通候选写入、Agent 高风险 approval request 和 approval apply 三条路径重新计算冲突组；旧前端或客户端先提交非主项会得到 `CANDIDATE_OVERLAP_ANCHOR_REQUIRED`。决定主项时，candidate-engine 在同一 transaction 写入其他组员的 source-bound group locks；接受主项的 undo 会同时恢复剪切和 locks，保留主项的 reconsider 会移除整组 locks。
- Agent typed response 同步暴露三个 overlap 字段；README、架构、Agent protocol 和口播工作流固定“不独立二次 Ripple”的约束。
- 从正式源文件为 4 个待审项生成 `/tmp` 原片/删除后对照片段及 28.096 秒合并试听包，全部 ffprobe 为 H.264/AAC 1280×720；这些临时派生物未写入工程、仓库或 Gate。正式 sample-03 只读复核仍为 REV 9，源 hash 和四个未决项均未改变，新投影正确选择重复候选为 anchor、660ms 停顿为等待项。

### 验证与限制

- candidate-engine **21/21**、review-projection **7/7**、Studio **83/83** 通过；新增 daemon overlap 场景单独 **1/1** 通过，覆盖错误顺序 fail closed、主项一次提交使工程 ready、替代锁披露以及 undo 后两项同时回到待审。五个相关 workspace strict typecheck 与 Studio production build 通过。
- daemon 全包运行时共有 31 个断言通过；两个既有真实 HTTP/Range 用例因受限执行环境不允许绑定 `127.0.0.1` 而超时。按仓库要求执行完整 `pnpm check`：15 个 production build 与全部 strict typecheck 通过，测试阶段已通过 Studio 83、agent-client 21、timeline-schema 24、timeline-engine 6，随后 MCP 真实 loopback suite 在 `listen EPERM 127.0.0.1` 处停止，未形成全仓通过总数。尝试申请本机 loopback 权限时又被当前 Codex 用量上限拒绝；这不是用窄测试替代全仓回归，待运行权限恢复后必须补跑并记录完整总数。
- 当前 `127.0.0.1:4320` 仍是修复前已启动的 daemon 进程。Studio 静态 build 已更新，但在重启 daemon 前不能执行正式候选写入，否则服务端不会应用新的整组 transaction；因此本批只读验证，不推进 REV 9，也不宣称 sample-03 已审阅或导出。
- conflict anchor 是安全的确定性默认，不替代人类内容判断。sample-03 仍需要用户试听高风险重复；此次修复只保证其决定能原子、可审计、可恢复地解决重叠范围。

## 2026-08-13：Studio 写操作使用稳定 requestId 收敛结果未知

### 目标

daemon、Timeline transaction、job 和 Alpha 证据侧车已经支持 request ID 幂等，但 Studio 除首次 Alpha 计时、导出取消与授权轮换外，大部分按钮仍在每次 API 调用时临时生成新 ID。若服务端已经提交、浏览器只丢失响应，用户再次点击会形成新的请求身份；这使“幂等正确率 100%”只在脚本/测试客户端成立，真实审阅 UI 仍可能重复提交或在未知结果下改做矛盾决定。

### 实际改动

- Studio 新增内存态 `MutationRequestRegistry`：用 `scope + canonical payload` 表示一项逻辑写入，首次产生调用者自有 requestId；断连、502 或无法判断结果的异常保留同一 ID，重试相同 payload 必须复用，结果未知时同 scope 的不同 payload 直接拒绝，防止候选 accept 未知后又提交 keep。
- 成功响应会确认并释放 ticket；明确 4xx 代表服务端已给出权威拒绝，同样释放。结果未知后 Studio 立即尝试重新读取 `/api/review` 或 `/api/alpha-audit`：读取成功即以 SQLite 最新投影解除不确定性，读取也失败则保留 ticket，下一次原操作继续使用原 ID。registry 不写 localStorage，不成为第二真相源，刷新页面仍通过 daemon/SQLite 重建。
- API 层所有有副作用的用户方法改为强制接收 caller-owned requestId，不再在低层隐式生成。覆盖候选删除/保留、手工文字删除、恢复、解除锁、生成初剪、语义分析、保留剩余、审批决定、Agent session 撤销、导出创建/取消、Alpha 候选/边界标签和 timing begin/start/pause/finish；只读试听 preview 与周期 heartbeat 不占用逻辑写 ticket。
- 成功写入引起 revision 前进时清理旧 project/export scope；Alpha 候选质量标签成功后自动定位下一条尚未标注候选，减少 20 项目逐条验收的重复导航。
- 按 React 最佳实践复核，将 registry 用 lazy state 初始化为工作区生命周期单例；effect 依赖保持原始 revision/source/session primitive，无 localStorage、派生 state effect 或重复全局 listener。

### 测试与限制

- Studio 定向 typecheck、production build 与 **81/81 测试**通过。新增测试覆盖：断连后同 ID 重放、canonical payload 键序无关、未知结果下矛盾操作拒绝、4xx 释放、5xx 保留、权威刷新清理，以及最终候选标签自动前进；API contract 证明 candidate write 不会自行调用 `crypto.randomUUID()`。
- 完整 `pnpm check`（`ffmpeg-full` + 本机 loopback）通过：15 个 production build、全部 strict typecheck、**374/374 测试**；较上一基线净增 5。首轮全仓回归由新增 stale-closure 用例抓到“刚标完的当前候选在旧投影仍为 null 时绕一圈选回自己”，修正为明确排除当前项后，Studio 定向 81/81 与第二轮完整 374/374 才作为最终证据。
- 该机制关闭的是“浏览器存活期间且 SQLite/daemon 可重新查询”的结果未知窗口；页面崩溃或整机重启后不会持久化 pending request ticket。此时 daemon 的 Timeline/job/evidence 查询仍是权威恢复路径，但若请求既无可查询对象又未推进 revision，用户只能以最新状态重新发起新意图。未来若加入离线队列，必须把 intent journal 做成项目绑定、加密且可审计的数据结构，不能偷偷用 localStorage 充当命令真相源。
- 正式 `pnpm alpha:gate --json` 在改动前重新核对，仍按预期 exit 1 / `insufficient_evidence`：授权 3/20、审阅导出 0/20、配对计时 0/20、不同操作者 0/5；高风险自动删除 0。此次可靠性修复没有新增授权、人工标签或时间分母。
- 完整回归后再次运行正式 Gate，指标与 issue 集保持相同。随后用最终 production build 原位重启 `127.0.0.1:4320`；应用内浏览器只读确认 sample-03 仍为 REV 9、4 项待处理、一个 video，当前初剪播放滑杆从 0 推进到约 0.73 秒，warning/error 日志为 0。未点击任何写操作，正式 Timeline、候选、标签、计时和导出证据均未改变。

## 2026-08-13：source-hash 绑定的浏览器兼容代理

### 目标

当前 sample-03 的 H.264/AAC 已在浏览器实机证明可直接播放，但正式 Alpha 的 20 条真实素材不能假设都使用相同 codec/container。Viewer 若直接把 HEVC、MOV 等原片交给 HTML video，可能出现“工程、Transcript 和导出都正常，审阅画面却无法解码”；直接把 clip 改绑代理又会破坏 source time、候选证据和 Timeline 唯一真相源。

### 实际改动

- Timeline Schema 新增版本化 `agentcut.previewProxy` binding 与 `browser-h264-aac-1280-v1` profile。代理必须是 online generated Asset，并精确绑定另一 source Asset 的 ID 与 content hash；semantic validator 拒绝无效结构、自引用、hash 漂移及同 source/profile 重复代理。
- media-ingest 增加保守兼容判定与代理生成：只有 H.264/AAC MP4/M4V 直读源文件；其他输入转为最大边 1280、H.264 Main/yuv420p + AAC 48 kHz stereo。输出先写 source/profile 专属 `.work-*`，验证 codec、音轨和时长误差 `<=40 ms` 后用同目录 hard link 无覆盖原子发布；相同 source/profile 续跑验证并收养既有文件，清理自己的中断临时文件。
- `pnpm roughcut` 在新工程初始 import transaction 同时登记必要代理和原片 full-length clip；主 clip 始终指向 source Asset。转写尚未完成的中断工程可在 ASR 前补登记代理；完成工程不会被启动器静默推进 revision。ASR、Transcript、候选、PreviewPlan、source locks 和导出继续只读原片。
- 工程续跑的 source-hash 匹配同步收紧为原始 `video` Asset，不能把 generated proxy 或其他派生产物的 hash 冒充建项源素材；误把工程代理文件传回 `roughcut` 会按 source conflict fail closed。
- daemon 的 review projection 保留 `media.assetId=source`，仅将 Viewer URL 指向精确绑定的代理，并返回 source/proxy playback 状态；PreviewSegment 仍返回 source asset ID。Studio 在代理播放时显示“本地兼容代理 · 时间与剪辑仍绑定原片”，兼容原片不出现误导提示。
- README、架构、P4 长程进度和验证文档同步固定上述身份、原子发布与证据边界。

### 测试与限制

- 定向回归通过：Timeline Schema **24/24**、media-ingest **8/8**、rough-cut workflow **10/10**、local-daemon **32/32**、Studio **76/76**。真实 FFmpeg 合成的 HEVC/hvc1 MOV 完成生成、H.264/AAC probe、source-hash binding、SQLite 建项、主 clip/Transcript source identity、同目录续跑不增 revision 和 `.work-*` 清理；daemon contract 同时断言 Viewer 使用代理而 PreviewPlan 使用原片，额外对抗性用例证明 generated proxy hash 不能冒充 rough-cut source。
- 完整 `pnpm check`（`ffmpeg-full` + 本机 loopback）通过：15 个 production build、全部 strict typecheck、**369/369 测试**；较上一基线净增 8，render-engine 既有 12 形态导出矩阵 33/33、Alpha Gate 73/73 和 MCP contract 12/12 同时保持通过。
- 用本批 production build 原位重启 `127.0.0.1:4320`。应用内浏览器确认 sample-03 仍直接读取 source Asset，代理提示计数为 0；视频 `readyState=4`、1280×720、duration 78.766667 秒、error null，播放头从 0 推进到约 1.07 秒后正常暂停。source identity 对抗性修正和最终 369/369 回归后再次重启同一地址，DOM 仍为 REV 9、4 项待审、一个 video、0 个代理提示，播放滑杆从 0 推进到约 0.98 秒，页面 warning/error 日志为 0。全程未执行内容取舍、标注、AI 重跑或导出。
- 该 HEVC 媒体是程序化 fixture，不是用户授权素材，不进入 20 条 Alpha 分母；尚未据此宣称真实 HEVC 手机视频、HDR 色彩或主观代理画质 Gate 通过。
- 已有完成工程不会为了补代理而静默改变 revision；当前正式路径保证新建工程和“尚未生成 Transcript”的安全续跑。若未来需要给历史完成工程补代理，应做显式 repair transaction 并处理 exact-revision 人工标签，而不是后台悄悄写入。
- 当前白名单刻意保守，可能为浏览器其实能播的格式多做一次本地代理；这是磁盘/建项时间换取 20/20 审阅确定性的取舍。代理不参与最终 RenderPlan，源素材和既有导出不会被覆盖。

## 2026-08-13：Studio 配对会话覆盖私有读取与媒体 Range

### 目标

Studio 已用项目绑定的 HttpOnly Cookie 保护删除、审批、标注和导出等写操作，但普通 `GET /api/review`、Alpha 审计、源媒体 `/media/*` 与字幕 `/artifacts/*` 仍可在知道本机端口时匿名读取。仅靠 loopback 和 CORS 响应头不能构成私有数据访问控制，这与本地优先产品对源视频和文稿隐私的承诺不一致。

### 实际改动

- 正式 daemon 配置 UI credential 时，统一要求私有 GET/HEAD 和全部 Studio POST 通过同一项目绑定 UI session。受保护面包含所有非 health `/api/*`、源媒体与导出媒体 Range、字幕/成片 artifact；静态 Studio shell、`/api/ui/session` 配对状态和最小 `/api/health` 保持公开，便于首次加载与进程诊断。
- Agent route 仍在 UI 门禁之前按 Bearer capability session 独立授权，不能用 UI Cookie 冒充 Agent，也不会因浏览器读取收紧而失效。测试/嵌入场景若显式不配置 UI credential 继续保持原有直连行为；正式 CLI 启动器仍强制生成 credential。
- 成功 GET/HEAD 不逐次写 `ui_access_events`，避免视频 Range 播放把每个字节块变成审计事件；匿名、伪造和过期的私有读取仍记录拒绝原因，全部写操作继续记录允许/拒绝。错误文案从“write session”改为覆盖私有工程访问的通用 session 诊断。
- README、架构安全边界和 Agent protocol 同步区分 UI 私有读取、Agent capability 与公开 health，并明确 Cookie 门禁尚不等于完整 Host/Origin/DNS-rebinding 防护。

### 测试与限制

- local-daemon 新增匿名 review/Alpha/media/artifact 拒绝、health 公开、过期读取拒绝、Agent `project:read` 不依赖 UI Cookie，以及真实 HTTP 配对后 `bytes=2-5` 返回 206/`Content-Range`/正确字节的集成场景；包级 strict typecheck 与 **31/31 测试**通过。
- 在修改前先用应用内浏览器读取真实 `<video>` 状态并短时播放 sample-03：H.264/AAC 为 `readyState=4`、1280×720、duration 78.766667 秒、error null，播放头从 0 推进到约 0.66 秒。无障碍 DOM 中的 `<video>` fallback 文本不是失败证据，因此本批没有凭误判引入代理转码或第二套预览真相源。
- 完整 `pnpm check`（`ffmpeg-full` + 本机 loopback）通过：15 个 production build、全部 strict typecheck、**361/361 测试**；其中 local-daemon 31/31、Studio 74/74、Alpha Gate 73/73、render-engine 33/33，较上一基线净增 1。
- 用本批最终 production build 原位重启 `127.0.0.1:4320`。不带 Cookie 的独立 HTTP 探针确认 `/api/review` 与源媒体 Range 均返回 401/`UI_SESSION_REQUIRED`，`/api/health` 返回 200；这两次预期拒绝各追加一条 side-table access audit，不推进 Timeline。既有配对浏览器跨 daemon 重启继续打开 REV 9、4 项待审，播放头从 0 推进到约 0.71 秒后暂停，页面诊断日志为 0。未执行内容取舍、标注、AI 重跑或导出，REV 保持 9。
- 当前 `/api/health` 仍公开 project ID 与 revision，不返回名称、路径、Transcript 或媒体字节；若 threat model 要求连工程存在性都隐藏，应把 health 拆成匿名进程存活与配对后工程诊断。显式 Host/Origin allowlist 仍是发布硬化缺口。

## 2026-08-13：Studio 内建私有证据文件分块 SHA-256

### 目标

正式 Alpha 计时已经强制绑定操作者与手工对照证据 commitment，但用户仍需离开 Studio、在终端运行 `shasum` 并复制结果。这既违背“无需零散脚本完成流程”的产品标准，也容易造成漏前缀、抄错 hash 或误选文件；直接使用 Web Crypto 整文件读取又会让长录屏整体进入浏览器内存。

### 实际改动

- Studio 固定引入 `hash-wasm@4.12.0`，新增独立 `sha256File`：默认按 4 MiB 读取 `Blob.slice()`，逐块更新 SHA-256，只保留当前块并报告字节进度；空文件、非法分块和中止信号均 fail closed。
- 正式 Alpha baseline 表单新增“本地证据文件”入口、计算进度、成功与错误状态。切换文件或改为手工粘贴会中止旧任务，组件卸载也主动取消；计算期间开始按钮保持禁用，完成后自动填入既有 `sha256:<64位>` 字段。
- 文件 input 不参与 API payload；实际 begin timing 仍只提交秒数、方法、操作者代号和 hash。界面明确说明文件内容与文件名不上传、不保存，并保留手工粘贴作为计算失败或复用已知 hash 时的恢复入口。
- README、Alpha Benchmark 与 G5 runbook 改为优先使用 Studio 本地分块计算，`shasum` 降为手工回退；commitment、源媒体 hash 禁止复用和人工抽查边界不变。

### 测试与限制

- 新增标准 `abc` 向量的逐字节分块/进度测试、无网络调用测试、空文件和已中止任务拒绝测试，并扩充正式表单 SSR 断言。Studio 包级 test/typecheck/build 通过：17 个测试文件、**74/74 测试**，production bundle 成功生成。
- 完整 `pnpm check`（显式使用 `ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**360/360 测试**；其中 Studio 74/74、Alpha Gate 73/73、render-engine 33/33、local-daemon 30/30，较上一基线净增 3。沙箱内首轮在 MCP loopback 监听处遇到 `EPERM`；允许本机监听后的第二轮因系统默认 FFmpeg 不带 libass 使 18 个字幕渲染用例统一失败，按仓库 doctor 要求绑定 `/opt/homebrew/opt/ffmpeg-full` 后同一完整命令通过，无代码断言失败。
- 用本批最终 production build 原位重启 `127.0.0.1:4320` 的 sample-03 工作区。应用内浏览器只读确认 REV 9、4 项待审，非正式工程中本地证据文件 input 与“登记对照并开始计时”按钮均为 0 个，页面诊断日志为 0；未执行计时、内容取舍、标注、AI 重跑或导出。
- 浏览器本地 hash 能减少操作错误并避免上传私有证据，但不能证明所选文件真实记录了完整手工初剪，也不能验证操作者身份。正式 Gate 仍需保留原文件供抽查，并依赖授权、时间顺序、revision、bundle hash 和人工评审的联合证据。

## 2026-08-13：配对提效基线绑定操作者与手工证据 commitment

### 目标

正式计时已经绑定前瞻建项、事件顺序和首次人工取舍 revision，但手工对照仍只是一项自报秒数和方法。任何正数都可能进入 30% 提效中位数，bundle 无法回答“由谁、依据哪份录屏或编辑器日志得到”，也无法区分真实对照证据与直接复用源视频 hash。

### 实际改动

- timing baseline 新增强制 `operatorIdHash` 与 `evidenceSha256`。Studio/API 接收稳定操作者代号和手工初剪证据 SHA-256；EvidenceStore 在本地将代号单向 SHA-256 后才写 append-only event，原始代号、录屏和日志均不持久化或进入 bundle。
- begin/baseline 领域入口验证代号非空且不超过 100 字符、证据 hash 格式正确，并拒绝用当前源媒体 hash 冒充手工对照证据。atomic begin 将带这两个 commitment 的 baseline 与首次 AgentCut start 放在同一事务，失败不留半条事件，稳定 request ID 的重放仍校验完整 payload。
- timing summary、evidence bundle、manifest materialization 和最终 Gate 全链路透传并强制校验两个 hash；即使同时从 summary 与 baseline event 删除字段并重算 payload hash，bundle loader 仍 fail closed。Gate 的手填 timing 也必须包含相同 commitment，不能绕过 verified bundle schema。
- Gate 新增操作者覆盖指标：20 个配对项目必须至少包含 5 个不同 `operatorIdHash`，否则返回 `OPERATOR_COVERAGE_INCOMPLETE`；人类可读报告同时展示 distinct timing operators，避免单一操作者的重复样本冒充设计伙伴覆盖。
- Alpha 面板新增操作者代号和手工证据 SHA-256 输入，两项未齐时开始按钮禁用；计时建立后只展示截断的两个 hash。README、Benchmark 说明和 G5 runbook 同步固定私有证据不上传、源 hash 不可复用及 `shasum` 操作方式。

### 测试与限制

- 新增缺操作者/复用源 hash 无副作用拒绝、原始代号不落事件、bundle 协同删字段重算 hash 仍拒绝、少于 5 个操作者 Gate 失败，以及 Studio 必填/commitment 展示断言。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**357/357 测试**；其中 Alpha Gate 73/73、Studio 71/71、local-daemon 30/30，较上一基线净增 3。
- 正式 Gate 继续按预期 exit 1 / `insufficient_evidence`：授权 3/20、审阅导出 0/20、配对计时 0/20、不同计时操作者 0/5，高风险自动删除 0，四类正确性 3/3 across 3/3。现有项目没有被补造 baseline 或操作者 commitment。
- 用本批最终 production build 原位重启 `127.0.0.1:4320` 的 sample-03 工作区。应用内浏览器只读确认 REV 9、4 项待审、“成对初剪用时：不计入”，且非正式工程中开始按钮、操作者输入和证据 hash 输入均为 0 个，console warning/error 为 0；未执行计时、内容取舍、标注、AI 重跑或导出。
- commitment 证明“登记后的 run 指向同一代号和同一证据文件 hash”，不会自动读取私有文件内容、判断手工剪辑质量或验证真实身份。正式设计伙伴采集仍需保留原文件并由评审按 hash 抽查；若未来要无人监督的法律级证明，需要独立签名/身份系统，不应由本地 Alpha Gate 冒充。
- 现有 3 个正式 manifest 项目没有 timing，因此不需要伪造迁移，也不会凭本批增加配对分母。下一条新 formal 素材必须按新字段采集。

## 2026-08-13：授权证据从可替换标记升级为独立记录整文件绑定

### 目标

正式 Gate 已会重新读取授权文件并检查 cohort/source 精确标记，但 manifest 没有保存授权文件内容哈希。只要保留同一隐藏标记，来源、授权范围或确认方式正文仍可在登记后被替换而不触发失败；同时三条项目共用一个持续追加的索引文件，无法在不连带影响旧项目的前提下固化整份授权内容。

### 实际改动

- Alpha manifest 的每条 `authorization` 新增强制 `sha256`。`alpha:collect` 读取授权证据原始字节、验证 cohort/source 标记后计算整文件 SHA-256 并写入 manifest；Gate materialization 每次重新计算并与 descriptor 比对，保留标记但替换正文同样以 `AUTHORIZATION_EVIDENCE_INVALID` fail closed。
- 新登记和幂等 re-collect 都由 collector 管理 hash；基础 Gate schema 同时拒绝缺失或格式非法的授权 hash，不再允许只有路径和自由文本 basis 的 confirmed 条目进入计数。
- 将现有 3 条已登记授权按原有事实拆为 `docs/alpha-authorizations/<cohort-id>.md` 独立记录，各自包含来源、范围、确认方式、源 hash 和唯一 marker；正式 manifest 改为引用并固化三份文件的真实 SHA-256。`docs/17-alpha-authorization.md` 保留为人工索引，不再作为不断追加且会使全部旧 hash 漂移的共享证据文件。
- Benchmark README、G5 runbook 与授权索引统一要求每个新 cohort 使用独立文件，并说明授权变更必须保留历史、经过明确复核，不能静默覆盖。

### 测试与限制

- 新增“保留 marker、替换授权范围正文后仍拒绝”的对抗性 materialization 测试。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**354/354 测试**；其中 Alpha Gate 70/70、Studio 71/71、local-daemon 30/30，较上一基线净增 1。
- 正式 `pnpm alpha:gate --json` 能逐一重验迁移后的三份授权记录，并继续按预期 exit 1 / `insufficient_evidence`：授权 3/20、审阅导出 0/20、配对计时 0/20、高风险自动删除 0、四类正确性 3/3 across 3/3。
- SHA-256 固化能在 manifest 未同步改写时证明“Gate 当前读取的授权字节与登记时一致”，不能独立证明记录中的人类同意真实发生，也不替代设计伙伴身份核验；同时改写文件和 manifest hash 仍需由 Git 历史/评审发现。现有三份记录只是把已经登记的事实拆分并固化，没有新增授权、改变范围或增加 Alpha 分母。

## 2026-08-13：formal Alpha 登记增加可校验的计时先后证明

### 目标

上一批已把 formal trial 身份和 `enrolledAt` 固化进 evidence bundle，并拒绝普通工程的计时，但 loader 只检查时间字段非空。攻击者若在计时结束后补写一个看似 formal 的登记时间并重新计算未签名的 payload hash，仍可能绕过“必须前瞻登记”的证据语义；事件的 `createdAt` 也只校验非空，不能作为可靠的顺序依据。

### 实际改动

- evidence bundle 对 formal `enrolledAt` 和所有 append-only event `createdAt` 改为可解析时间校验，不再接受任意非空文本。
- 只要 bundle 含 timing，loader 就要求事件序列中的第一条 timing event 是有效 baseline，并强制 `enrolledAt <= baseline.createdAt`；缺事件、首条不是 baseline 或登记晚于 baseline 均 fail closed。该判断发生在完整事件绑定/顺序校验之后，并与 payload hash 重验、计时摘要重算、人工取舍 revision 起点证明共同生效。
- 无 timing 的历史 bundle 继续允许缺少 `alphaTrial`，不伪造迁移，也不影响已有 correctness 证据；README 与 G5 runbook 同步说明最终 bundle 的时间顺序约束。

### 测试与限制

- 新增“无效登记时间重算 hash 仍拒绝”和“baseline 后事后登记重算 hash 仍拒绝”两条对抗性回归。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**353/353 测试**；其中 Alpha Gate 69/69、Studio 71/71、local-daemon 30/30，较上一基线净增 2。沙箱内首轮在 MCP loopback 监听处按预期遇到 `EPERM`，允许本机监听后同一完整命令通过，无代码断言失败。
- `pnpm alpha:gate --json` 继续按预期 exit 1 / `insufficient_evidence`：授权 3/20、审阅导出 0/20、配对计时 0/20，高风险自动删除 0，四类正确性 3/3 across 3/3。时间顺序加固没有把历史或伪造项目计入分母。
- `enrolledAt` 与 baseline 相同的服务器时间允许通过，以兼容原子建项/计时或时间戳精度相同的合法记录；约束证明的是“不晚于计时起点”，不能替代外部身份、授权和独立计时监督。
- 本批只加固证据接纳规则，不增加真实 Alpha 分母。仍需至少 17 条新授权素材完成前瞻建项、20/20 审阅导出、候选/边界听审与成对计时。

## 2026-08-13：成对提效计时强制绑定前瞻 formal Alpha 登记

### 目标

正式样本虽然已支持建项时 `--alpha-trial` 前瞻登记，并在审阅期间锁定计时状态，但普通工程仍能调用 Alpha timing API；evidence bundle 也只保存 project/revision/source，没有保存 formal trial 身份。这样一条审阅后补录或由内部脚本直接写入的非正式计时，理论上仍可能被 bundle/manifest 当作 30% 提效分母，无法从最终证据证明试验约束在第一次人工取舍前已经存在。

### 实际改动

- AlphaEvidenceStore 将 prospective formal enrollment 提升为领域不变量：begin、baseline、start、heartbeat、finish 都要求 audit project 带 `{mode:"formal", enrolledAt}`，否则返回 `ALPHA_TRIAL_ENROLLMENT_REQUIRED` 且不写事件；pause 仍允许清理历史遗留的运行态 session。daemon 同时在 API 边界给出面向用户的中文诊断。
- evidence bundle 的 canonical project binding 新增可选 `alphaTrial`。新正式 bundle 把 mode/enrolledAt 纳入 payload hash 与整文件 hash；任何含 timing 但缺 formal binding 的 bundle 即使重新计算 hash也 fail closed。无 timing 的历史 bundle 继续兼容，因此现有 correctness 证据不需要伪造迁移。
- Studio 对普通/历史工程显示“成对初剪用时：不计入”，解释必须用未审阅素材 `--alpha-trial` 建项，并完全移除 baseline/开始按钮。正式工程仍按“登记对照并开始计时 → 取舍 → 导出 → finish → 标签”的原路径工作；当正式工程的导出、计时、候选和边界全部封存后，面板保持展开并显示“本 revision 已可收集 / pnpm alpha:collect”。
- README、Alpha Benchmark 操作说明和长程 runbook 同步明确：普通工程不能计入提效中位数，formal 身份随 bundle 固化，Studio 的 ready 提示不替代授权依据、cohort ID 与覆盖类别参数。

### 测试与限制

- 新增 store 无副作用拒绝、daemon 非正式 begin 拒绝、bundle 去除 formal binding 后拒绝、bundle 持久化 enrollment、Studio 普通工程隐藏计时入口和正式 collect-ready 状态测试。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**351/351 测试**；其中 Alpha Gate 67/67、Studio 71/71、local-daemon 30/30，较上一基线净增 4。
- 用本批最终 build 在 `127.0.0.1:4320` 原位重启当前 sample-03 工作区（该历史工程不是前瞻 formal trial）；应用内浏览器展开 Alpha 面板，只读确认 REV 9、候选 0/7、边界 0/3、“成对初剪用时：不计入”、非正式工程诊断和 0 个“登记对照并开始计时”按钮，console warning/error 为 0。未执行取舍、计时、标注、AI 重跑或导出。
- `pnpm alpha:gate --json` 继续按预期 exit 1 / `insufficient_evidence`：授权 3/20、审阅导出 0/20、配对计时 0/20，高风险自动删除 0，四类正确性 3/3 across 3/3。正式身份加固没有把历史样本虚增为计时项目。
- 当前面板只能说明本工程“可运行 collect”，不能自行决定授权 basis、cohort ID 或 8 类覆盖标签，所以不在浏览器中自动登记 manifest。下一步仍需至少 17 条新授权素材在建项时使用 `--alpha-trial`，并由真实操作者完成完整流程。

## 2026-08-13：保留段保证改为 CandidateSet 显式 evidence contract

### 目标

新旧候选证据边界已能工作，但 validator 仍靠 `talking-head-mechanical/0.3.0` 和 `semantic-review/0.2/*` 两个 detector 字符串判断是否强制保留段。未来 detector 改名、升级或由第三方实现时，这条安全语义可能在没有 schema 变化的情况下静默消失；审计规则不应依赖实现名称。

### 实际改动

- CandidateSet Artifact 新增向后兼容的 `evidenceContracts[]`，当前唯一受支持值为 `retained-comparison-v1`。JSON Schema 限定非空、唯一且只接受已知 contract；旧 artifact 不需要迁移。
- 机械与语义候选生成器都显式写入该 contract，并将 contract 纳入 CandidateSet ID seed，避免相同 ID 指向不同安全保证。人工接受新候选时继续传播源 CandidateSet 的 contract；人工补删和历史候选不会凭空获得声明。
- Timeline validator 以 artifact contract 为主：声明后 repetition/restatement/correction 缺少 `retained_comparison` 必须返回 `evidenceRequired`，不关心 detector 如何命名。刚发布但尚未携带显式字段的 mechanical 0.3.0 / semantic 0.2 artifact 作为仅有的隐式兼容例外继续严格校验；更旧 artifact 仍按历史缺失投影，不伪造迁移。
- Timeline IR 与 Agent protocol 同步固定 contract 语义。Agent 侧仍消费候选级 `evidenceStatus`，无需根据 detector 名称推断保证。

### 测试与限制

- 新增自定义 detector 名称 + 显式 contract 的 fail-closed schema 用例，并扩充机械、语义生成和人工接受 contract 传播断言。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**347/347 测试**；其中 Timeline Schema 23/23、candidate-engine 19/19、local-daemon 29/29，较上一基线净增 1。
- `pnpm alpha:audit` 只读打开正式 sample-03 成功：仍为 REV 9、7 个候选、4 个 pending、3 个真实边界，其中 2 个历史对照型候选继续是 `legacy_missing`。新增可选字段没有迁移 SQLite、没有改变候选状态或 Timeline revision。
- 正常停止上一批 4320 daemon 后用本批最终 build 原位重启；`/api/health` 只读确认仍加载 `project_p1_real_dogfood` REV 9。当前浏览器地址继续使用 `127.0.0.1:4320`，未触发 AI 重跑或任何内容决定。
- contract 防止官方生成链和主动声明能力的第三方 detector 因改名丢掉门禁；未声明 contract 的历史/第三方候选仍只能按实际证据投影为 `legacy_missing`。当前受保护 Agent 路由不允许写任意 CandidateSet，且重复、重说、说错继续是 high/suggest-only 或人工确认路径；未来若开放 detector 插件注册，注册层还必须强制声明支持的 contract，不能把“未声明”当作新插件的默认许可。
- 这项修复提高的是后续 20 项采集过程中的规则稳定性，不增加任何真实 Alpha 分母。仍需至少 17 个授权项目、20/20 实际审阅导出、候选/边界人工听审和配对时间证据。

## 2026-08-13：新 detector 强制保留段证据，旧候选显式标记历史缺失

### 目标

上一批为候选增加了可选 `evidence[]`，但仅靠可选字段无法区分“历史 artifact 当时没有保存”和“新 detector 声称实现结构化证据却漏写”。机械相邻重复也仍只保存待删前一遍，没有像语义候选一样持久化应保留的后一遍。若继续共用旧 detector version，validator 只能为了兼容旧工程放行所有缺证据候选，Studio 又无法诚实告诉用户当前候选是否具备机器可核验的对照范围。

### 实际改动

- 机械相邻完全重复现在把后一遍原样写为 `retained_comparison`，detector contract 从 `talking-head-mechanical/0.2.0` 升到 `0.3.0`；本地语义 contract 升为 `semantic-review/0.2/<provider>`。候选删除 target、风险策略和高风险人工确认门没有改变。
- Timeline validator 按 contract 版本 fail closed：上述新版本产生的 repetition/restatement/correction 必须带结构化保留段，否则返回 `evidenceRequired`。旧 detector artifact 继续可读，不迁移、不从中文说明猜范围，也不会因为新规则使现有 SQLite 工程无法重启。
- Review projection 为对照型候选增加 `evidenceStatus: structured | legacy_missing`。Alpha audit 和 typed Agent client 同步透传该状态；Studio 对 `legacy_missing` 显示独立警告，要求以原片上下文和删除效果试听为准，并提示需要机器可核验范围时重新运行 AI 检查。
- Timeline IR、Agent protocol 与阶段交互规范同步固定版本边界：新 contract 的证据是 schema 保证，旧候选的缺失是必须暴露的历史事实，任何 UI/Agent 都不得把 `explanationZh` 当作结构化范围。

### 测试与限制

- 完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**346/346 测试**；其中 Timeline Schema 22/22、candidate-engine 19/19、review-projection 6/6、Agent client 21/21、Studio 70/70、local-daemon 29/29，较上一基线净增 3。新增用例覆盖新版本缺证据 fail closed、旧版本继续兼容、机械重复保留后一遍、投影状态和 Studio 历史警告。
- `pnpm alpha:audit` 只读打开正式 sample-03 成功：仍为 REV 9、7 个候选、4 个 pending、3 个真实边界；历史 restatement 与 repetition 均投影 `legacy_missing`，没有伪造回填、没有修改 Timeline。应用内浏览器在最终 build 的 `127.0.0.1:4320` 选择第 07 条历史重复候选，实际显示缺证据警告，console warning/error 为 0；未点击删除、保留、恢复、标注或 AI 重跑。
- 正式 `alpha:gate --json` 仍按预期以 exit 1 返回 `insufficient_evidence`：授权 3/20、审阅导出 0/20、配对计时 0/20，高风险自动删除保持 0，四类正确性均为 3/3 across 3/3 projects。证据协议升级没有被错误计入 Alpha 质量分母。
- 新 contract 的结构化保留段已由 schema、生成器、daemon 和组件测试覆盖，但还没有在下一条全新授权真实口播上获得人工试听标签；保留段精度仍属于待验证产品 Gate。旧 4317 daemon 未响应正常终止信号，本轮没有强杀；用户当前页面已切到并保留在最终构建 4320，后续应使用 4320。

## 2026-08-13：重复、重说与说错候选保存结构化保留段证据

### 目标

语义 provider 和 daemon 证据门已经要求 repetition/restatement/correction 同时给出“删除前一遍”和“保留后一遍”的 word range，但 CandidateSet 持久化时只留下删除 target；保留段被降成 `explanationZh` 中的一段自由文本。这样 Studio 能让人读懂，却无法让 Timeline validator、外部 Agent 或后续评测机器复核“保留的到底是哪几个词”，也无法提供稳定的对照段试听。

### 实际改动

- Timeline Schema 为 DeletionCandidate 增加向后兼容的 `evidence[]`，当前角色为 `retained_comparison`，目标必须是同一 Transcript 的 words + source range。语义 validator 继续负责模型 finding 的前后证据门；Timeline validator 再独立检查 word 引用、range coverage、bound source clip 和“保留段位于删除目标之后”，拒绝伪造、越界或倒序证据。
- semantic candidate generator 对 repetition/restatement/correction 把经过证据门的 keep range 原样保存为稳定 word IDs 和微秒 source range；false_start/incomplete 没有明确后一段时不制造空证据。候选 ID 仍由删除理由和删除 word IDs 决定，新增展示证据不会改变同一删除意图的身份。
- Review projection 从 canonical Transcript 还原证据文字，并把 role、word IDs、source range、text 送到 Studio；候选检查器新增绿色“对照保留段”和“试听保留段”，试听走原片 source loop，不生成 proposal、transaction 或 Timeline revision。
- Alpha audit 的运行时候选投影和 typed Agent client 同步返回隐私有界的保留段摘要（word IDs、微秒范围与文本）。正式 evidence bundle 仍只保存 Gate 所需标签/统计，不额外复制 Transcript 对照文本。
- Timeline IR、Agent protocol 和第一阶段交互文档同步明确：删除 target 与保留 evidence 是两个不同角色，UI/Agent 不得从中文说明反向猜范围。

### 测试与限制

- 新增 Schema 引用/顺序验证、semantic correction 证据、Review 文字投影，并扩充 daemon 持久化响应、Agent client 和 Studio 检查器契约。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**343/343 测试**；其中 Timeline Schema 21/21、review-projection 5/5、candidate-engine 19/19、Agent client 21/21、Studio 69/69、local-daemon 29/29，较上一基线净增 2。
- daemon 两条 SQLite/API 集成路径验证：受限 Agent 提交 correction finding、以及本地 semantic job，均在 REV 0→1 后从 `/api/review` 返回对应保留段 word IDs 与文字；高风险状态仍为 `candidate_remove`，没有自动生成删除 operation。
- `pnpm alpha:audit` 只读打开现有 sample-03 成功，仍投影 project REV 9、7 个历史候选、4 个 pending 和 3 个真实边界；历史候选的 evidence 数为 0，证明新增字段保持向后兼容且没有根据说明文字伪造回填。
- 既有 sample-02/03 候选按历史 canonical artifact 如实保持，不通过说明文本回填或猜测 evidence，因此 sample-03 当前界面不会凭空出现“对照保留段”。新建项目或最新 revision 重新生成的语义候选才具备该证据；要验证真实模型的保留段精度，仍需下一条未审阅授权素材和人工试听标签。

## 2026-08-13：紧凑时间线收敛到 canonical PreviewPlan 坐标

### 目标

Viewer 的“当前初剪”已经按 PreviewPlan 播放 67.60 秒，但下方紧凑时间线仍从 Transcript source range 推导 78.77 秒，并直接用 source time 放置候选。sample-03 因此同时显示“Viewer 1:07 / 时间线 1:17”，已删除区间还继续占据轨道空间，违反了“时间线 seek、播放头和 Viewer 统一使用 timeline time”的阶段约定。

### 实际改动

- TimelinePanel 总时长改为 canonical `preview.durationSeconds`，刻度、点击 seek、播放头比例与 Viewer 当前初剪使用同一个 PreviewPlan；仅在旧响应缺少 preview 时保留 source duration 降级。
- 新增 `sourceToTimelineAnchor`：保留 source position 按 segment 正常投影；已删除 source position 折叠到右侧真实 cut boundary，尾部删除折叠到最终 timeline end。候选 source range 两端都通过该映射求值，因此已提交删除显示为边界标记，待审候选显示为当前剪后时间轴上的实际跨度。
- App 对原片试听和只读虚拟删除预览的播放位置先恢复为 source time，再投影到 canonical timeline；候选循环试听本身仍使用 source time。时间线点击继续退出虚拟预览并 seek canonical current cut，没有在前端重算第二套剪辑片段。
- P4 验证文档同步写明时间线、原片试听、虚拟预览和删除区间的坐标约定。

### 测试与限制

- 新增 deleted-source→cut-boundary、尾部删除→timeline end、时间线 PreviewPlan duration、播放头比例及已删除候选折叠标记测试。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**341/341 测试**；其中 Studio 69/69，较上一基线净增 2。
- 应用内浏览器刷新真实 sample-03 / 4317 后验证：时间线从旧 `0:00 / 1:17` 收敛为 `0:00 / 1:07`，刻度终点 1:07；候选标记投影到 0:13、0:43、0:57、1:02、1:03 等剪后位置。单击已删除“引”进入原片 source 试听时，时间线播放头稳定映射到 collapsed boundary `0:43 / 1:07`；随后恢复“当前初剪”。工程始终为 REV 9、4 项待审，未提交任何内容决定。
- 正式 `alpha:gate --json` 继续按预期退出 1 / `insufficient_evidence`：授权 3/20、审阅并导出 0/20、配对计时 0/20、候选和边界人工标签均无分母；高风险自动删除仍为 0，四类正确性为 3/3 across 3/3 projects。时间线修复没有被错误折算为真实内容质量证据。
- 当前 anchor 语义针对第一阶段单一 Transcript 绑定素材和单主轨成立；未来允许同一 asset 重排、多素材或 time warp 时，source time 不再天然唯一，必须改为携带 clip identity 的映射，不能沿用本阶段的单值 helper。

## 2026-08-13：说错纠正保留独立语义，审阅理由全链路中文化

### 目标

语义模型和证据门已经能区分 `correction`（明确说错后纠正），但生成候选时会把它强制写成 `restatement`。这虽然仍能形成可删除的高风险候选，却丢失了“说错”与“只是重说”的区别，后续无法按真实错误类型做 Alpha 标签和误删分析；同步文稿与时间线还直接把 `restatement/repetition` 英文内部码暴露给用户。

### 实际改动

- Timeline Schema 的 `DeletionReasonCode` 和 JSON Schema 新增 `correction`。语义候选生成器不再把 correction 降级成 restatement，候选 ID、Review 投影、Proposal、Transaction 和 Alpha evidence 可以沿唯一真相源保留“说错纠正”这一原始判断；仍保持 `high + suggest_remove`，不因此放宽自动删除边界。
- Studio 新增统一 `review-reasons` 映射，候选检查器、候选队列、同步文稿按钮和时间线共享同一份中文标签：`correction = 说错纠正`、`restatement = 重说`、`repetition = 重复`、`false_start = 说到一半重来`。未知扩展码仍原样回退，避免 UI 因新码崩溃。
- 阶段产品边界和 Timeline IR 文档同步明确：语义类别不能为了展示被合并成另一种理由；内部英文码不能直接进入面向用户的正文、队列、检查器或时间线。

### 测试与限制

- 新增 Schema 接受 correction、Studio 说错纠正检查器、同步文稿中文 title/aria 与时间线中文定位测试，并更新 daemon 的真实语义候选契约。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**339/339 测试**；其中 Timeline Schema 20/20、candidate-engine 19/19、Studio 67/67、local-daemon 29/29，较上一基线净增 3。
- 应用内浏览器刷新真实 sample-03 / 4317 后只读验证：工程仍为 REV 9、4 项待审；删除线显示“已删除：重说”，待审文字显示“Agent 建议：重复”，时间线显示“定位 重说候选 / 重复候选”，DOM 中不再出现对应英文理由码。未执行删除、保留、恢复或其他写操作。
- 该改动修复的是分类可审计性与展示一致性，不证明模型已经准确发现全部说错内容。sample-03 当前没有独立 correction 真实候选；说错召回率、误报率和边界可用率仍需在授权真实素材中由人工标签验证，高风险自动错删目标继续为 0。

## 2026-08-13：人工补删范围前置门禁（不跨候选、已删除或锁定范围）

### 目标

同步文稿为了审计和恢复会持续显示 AI 候选、删除线与锁定文字。旧连续选择只按 Transcript 原始词序取起止点，因此用户可以在 UI 中框入已经删除/锁定的词，或用两个普通词跨过一个已经 Ripple 删除的 gap；直到调用 compiler/lock 门禁时才失败。对用户而言这会表现成“看起来选中了、试听或删除时才报错”，也增加把 source 连续误解为当前 Timeline 连续的风险。

### 实际改动

- 新增 `validateManualDeletionSelection`：人工补删只接受当前 Review 投影中的 `normal` token；`candidate_remove/candidate_keep` 必须回到候选检查器决定，`committed_deleted` 必须先恢复，`reviewed_keep` 必须先重新审阅解除保护。
- 校验同时检查选择区间内部的 ReviewGap。即使两端都是普通文字，只要它们之间跨过待审、已删除或已锁定 gap，也会在选择完成时拒绝，不把已经分裂的 retained clips 伪装成一段连续媒体。
- TranscriptPanel 在首次点击非普通文字或 Shift 扩展到非法范围时立即清空手工选择并显示具体恢复路径：“先决定候选 / 恢复删除 / 解除保护 / 缩小到同一保留片段”；提供“重新选择”，不会显示“删除选中”或“试听删除效果”写/预览入口。
- 合法普通文字范围保持原交互，可继续提交前试听、显式删除或取消。后端 `compileManualSelectionDeletion`、source lock 和当前 clip 校验仍是权威安全边界；前端校验只负责把确定可解释的冲突提前，不替代 canonical compiler。

### 测试与限制

- 新增选择校验测试，覆盖普通范围通过、已删除 token 拒绝、待审 token 拒绝和跨已锁定 gap 拒绝。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**336/336 测试**；其中 Studio 65/65，较上一基线净增 2。
- 应用内浏览器在真实 sample-03 / 4317 验证三条路径：点击已删除“引”立即提示不能作为补删起点；选择普通“当”到普通“最”因中间跨过已删除停顿而提前拒绝；重新选择开头“母、校”仍显示“已连续选择 2 个词 / 删除选中 / 试听删除效果 / 取消”。最后取消合法选择，全程未执行删除，工程保持 REV 9、4 项待审。
- 前端能提前判断 Review 投影已知状态；更底层的非候选 source lock、并发 revision 漂移或 clip 几何变化仍可能只在 server compiler 阶段发现，并以结构化错误拒绝。不会为了消除所有失败而在浏览器复制 Timeline compiler。

## 2026-08-13：连续文字补删支持提交前试听（人工选择只读 PreviewPlan）

### 目标

AI 候选已经能在提交前试听删除效果，但 AI 漏检内容的手工补删仍是“点击起点 → Shift 点击终点 → 删除选中”。用户虽然可以 Undo，却无法在写入 Timeline 之前判断这段人工范围删除后是否吞字、跳句或破坏语气；同一个可信初剪工作区不应让 AI 候选与人工补删拥有两套不同的风险体验。

### 实际改动

- 新增 `POST /api/selections/preview`，接收连续 `wordIds + baseRevision + requestId`。daemon 与真正的 `/api/selections/delete` 复用 `compileManualSelectionDeletion`；预览只把相同 transaction 应用到内存克隆，再由共享 `buildPreviewProjection` 求值得到虚拟 Timeline，不调用 `ProjectStore.commit`，不创建人工 CandidateSet/Proposal record，也不推进 revision。
- Studio 连续选择工具条新增“试听删除效果 / 停止删除效果”。选择两端仍由稳定 word ID 与 Transcript 顺序决定；试听围绕虚拟计划中实际右侧 retained segment 循环，在 Viewer 明示“待提交文字删除效果”。“删除选中”仍是唯一写入口，试听按钮本身不暗示已经修改工程。
- 候选试听与文字选择试听收敛为同一个 virtual preview 控制器：任一时刻只有一个 PreviewPlan override；候选切换、文字范围变化、取消、seek、Space/B、写操作或 revision 变化都会使旧异步响应失效并恢复 canonical/original 视图，避免跨范围串台。
- 阶段产品文档同步规定：人工连续选择也必须先有可选的提交前试听，预览不能创建 canonical candidate/proposal/transaction。

### 测试与限制

- daemon 新增只读选择预览测试，覆盖连续两词产生更短 PreviewPlan、revision 与 command records 保持不变、stale revision 冲突和非连续 word IDs 拒绝；Studio API 测试锁定 revision-bound POST 与 caller request ID。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**334/334 测试**；其中 local-daemon 29/29、Studio 63/63，较上一基线净增 2。
- 应用内浏览器在真实 sample-03 / 4317 验证：选择开头“母、校”两个连续词后，工具条显示“已连续选择 2 个词 / 删除选中 / 试听删除效果 / 取消”；点击试听后 Viewer 明示“待提交文字删除效果”，停止并取消后选择清空。全过程没有点击删除，复核仍为 REV 9、`reviewing`、4 项待审、canonical preview 67.603750s、28 个已删除 token 和 2 个 committed gap，均与试听前一致。
- 当前选择必须连续且能落在同一当前 retained clip；跨越既有已删除区间、锁或非连续 word range 会由现有 compiler/lock 门禁拒绝，不自动拆成多个隐藏删除。浏览器跳转预览用于提交前判断，最终边界质量仍以导出成片听审为准。

## 2026-08-13：删除效果试听进入键盘审阅流（B 键 A/B）

### 目标

提交前删除效果试听已经能避免“删完才知道接缝不自然”，但它仍要求操作者在左侧检查器和文稿/Viewer 之间来回找按钮。Alpha 需要衡量真实有效粗剪时间；逐候选判断的高频路径应让用户保持在当前文字与画面上下文中，通过键盘完成原片与删除后效果的 A/B，而不是用更多鼠标移动抵消 Agent 带来的时间收益。

### 实际改动

- 审阅快捷键新增 `B = 删除效果`：只对 `candidate_remove / candidate_keep` 待审候选生效；首次按下加载并循环只读虚拟 PreviewPlan，再按一次停止。`Space` 继续专门控制原片上下文试听，左右键、D/K/U 语义不变。
- 候选检查器的删除效果按钮增加 `aria-keyshortcuts="B"`，快捷键提示同步展示 B；已删除/已保留历史项既不显示按钮，键盘 dispatcher 也拒绝触发，避免把历史状态误当成待提交效果。
- 把快捷键副作用抽成可测试的 `performReviewShortcut`，浏览器事件层只负责输入焦点保护与 `preventDefault`。既有规则继续避开 input/textarea/select/contenteditable/video/audio，且拒绝 Meta/Ctrl/Alt 组合键，不抢占文字输入或系统快捷键。
- 删除效果请求增加 generation 失效机制：停止、切换候选、文字定位、其他写操作或新请求都会取消旧响应的 UI 资格并清除 busy 状态。即使本地 daemon 响应较慢，旧候选也不能在用户已经离开后重新覆盖 Viewer。

### 测试与限制

- 新增键盘 dispatcher 测试，覆盖 B 启动、B 停止及已决定候选拒绝；导航映射和检查器测试覆盖大小写 B 与 `aria-keyshortcuts`。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**332/332 测试**；其中 Studio 62/62，较上一基线净增 2。
- 应用内浏览器在真实 sample-03 / 4317 验证：焦点停在第 01 条候选时按 B，检查器切换为“停止删除效果”，Viewer 切换为“待提交删除效果”并播放；再按 B 返回原片。只读复核仍为 REV 9、`reviewing`、4 项待审、canonical preview 67.603750s，候选/删除统计不变，没有调用删除、保留或其他写入口。
- B 键减少的是交互摩擦，不等于已经证明中位粗剪时间下降 30%；该指标仍必须来自不少于 20 个授权真实项目的成对人工计时。浏览器跳转预览用于提交前判断，最终边界可用率仍以导出成片的人工听审标签为准。

## 2026-08-13：候选提交前删除效果试听（只读虚拟 Timeline）

### 目标

sample-03 的候选检查器此前只有“循环试听”：它播放包含候选内容的原片上下文，适合判断说了什么，却不能让用户在提交前听到删除区间两侧真正拼接后的节奏。对 401ms 停顿尚可凭经验判断，对重复、改口和说错内容则容易在提交后才发现吞字、语气突变或硬切不自然。

### 实际改动

- 新增 `GET /api/candidates/:candidateId/preview?baseRevision=N`。daemon 校验候选仍处于待审且 revision 精确匹配，复用既有 `compileCandidateAcceptance` 生成同一 Ripple transaction，只在克隆文档上调用 `applyTransaction`，再由与当前初剪/RenderPlan 共用的 `buildPreviewProjection` 求值；不会调用 `ProjectStore.commit`，不会写 command record、sidecar 或推进工程 revision。
- Studio 候选检查器把两种问题拆开：原有“循环试听”保留用于听原片上下文，待审项新增“试听删除效果”。后者加载 server 生成的虚拟 PreviewPlan，在 Viewer 明示“待提交删除效果”，围绕实际右侧 retained segment 的拼接点循环约 1.5 秒前后文；停止后回到原片，已删除/已保留历史项不显示该按钮。
- Viewer 支持 revision-bound preview override 与剪后时间窗循环，timeline/source 映射仍统一复用 `timelineToSource`、`projectSourcePlayback`，没有在前端构造 FFmpeg 时间或第二套剪辑结果。任何工程写操作、候选切换、文字定位或原片试听都会结束虚拟预览，避免把旧候选效果误认为当前初剪。
- 阶段产品文档同步明确：提交前试听是只读虚拟 Timeline，删除效果与真实硬切语义一致，不能创建 transaction 或静默修改项目。

### 测试与限制

- daemon 新增只读契约测试，覆盖真实候选 Ripple 后的分段/时长、调用前后 revision 与 command records 均不变化、stale revision 冲突及已决定候选拒绝；Studio 新增 API URL、双试听入口和真实 cut segment 定位测试。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**330/330 测试**；其中 local-daemon 28/28、Studio 60/60，较上一基线净增 3。
- 应用内浏览器在真实 sample-03 新版 4317 验证：初始为 REV 9、4 项待审、当前初剪 67.603750s；第 01 条 400.833ms 停顿的只读计划为 67.202917s，Viewer 明示“待提交删除效果”。播放器采样从 source 13.174843s 直接跳到 13.613375s，跨过候选范围后继续播放；停止前后工程仍为 REV 9、4 项待审、canonical preview 67.603750s，没有提交用户决定。
- 本能力试听的是与当前导出一致的硬切，不添加音频 crossfade、J/L cut 或自动边界润色；它能暴露不自然边界，但不能替代真实操作者对剩余 4 项逐项判断。正式 Alpha Gate 的审阅、导出、边界标签和样本分母没有因此增加。

## 2026-08-13：待审优先候选导航（跳过已决定历史项）

### 目标

首屏与批量门禁修复后继续走查 sample-03：决定候选后系统已会自动跳到下一个 pending，但左右键/检查器箭头仍按全部 7 条候选循环。当前第 1 个待审项按“下一项”会依次经过 3 条已删除历史记录，才能到第 5 个待审项；这让“4 待处理”的主任务与“候选 1/7”的导航语义冲突，也增加重复听审成本。

### 实际改动

- `selectRelativeCandidateId` 增加动态导航作用域：当前选中待审项（或尚无选择且存在待审项）时，只在 pending candidates 中前后循环；当前从队列主动选中已删除/已保留历史项时，仍在完整候选集合中浏览，恢复与重新审阅入口不被隐藏。
- `candidatePosition` 同步返回 `scope: pending | all`。候选检查器在主审阅流显示“待审 N / M”，在历史浏览显示“候选 N / M”，不再用总候选数冒充剩余工作量。
- App 统一复用共享 position 求值，删除此前组件侧重复的数组下标计算；决定后的 `nextPendingCandidateId` 行为保持不变，队列仍按源时间展示全部候选，保证审计顺序和历史访问。

### 测试与限制

- 更新导航单测，锁定 pending 集合正向/反向循环、待审位置口径，以及主动进入历史项后仍按完整集合导航。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**327/327 测试**；Studio 58/58。
- 应用内浏览器真实 4320 验证：初始显示“待审 1/4”；点击下一候选直接选中队列第 05 条并显示“待审 2/4”，跳过第 02–04 条已删除记录；点击第 02 条历史项显示“候选 2/7”且“恢复本次提交”仍可见。页面最终切回第 01 条待审，控制台 warning/error 为空，未调用写 API，工程保持 REV 9。
- 本批只优化导航作用域，不改变候选顺序、决定或风险门禁。剩余四项仍需用户真实试听；历史项必须由用户显式点击队列后才能恢复，避免主导航误入旧决定。

## 2026-08-13：批量保留二次确认（防误触伪装成审阅完成）

### 目标

真实 sample-03 还剩 4 项待审时，“保留全部剩余”原本单击即调用 `/api/candidates/keep-remaining`，为全部候选写 source-range locks 并立刻把工程推进到 `rough_cut_ready`。该路径虽然可逐项重新审阅，但误触会让未听审内容在 UI 上表现为“初剪内容已确认”并解锁导出，不符合可信审阅的预期。

### 实际改动

- `RoughCutControls` 把批量结束路径改为显式两阶段：第一次点击只在浏览器内展示“确认保留 REV N 的 M 项”，说明会写保护锁、结束当前审阅且之后仍可逐项重审；只有第二次点击“确认保留 M 项”才调用既有 API，另提供明确取消。
- 确认状态由 `StudioWorkspace` 以当前 project revision 绑定。revision 变化会通过现有 effect 自动清除；完成、失败或取消也会清除，避免用户确认旧 revision 后把动作误用于已变化的候选集合。后端原有 `baseRevision + requestId`、锁与幂等门禁不变，UI 二次确认是额外防误触层。
- 确认态显示实际 revision 与实时待审数量，不使用泛化的“确定吗”；首击不创建 proposal、lock、transaction 或任何 SQLite 记录。

### 测试与限制

- 新增 Studio 组件用例，覆盖普通 reviewing 状态只显示入口，以及确认态必须显示 REV、数量、保护锁影响、最终确认与取消。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**327/327 测试**；Studio 58/58，较上一基线净增 1。
- 应用内浏览器在真实 4320 首击后确认文案为“确认保留 REV 9 的 4 项”，第二次提交按钮可见；只读 API 仍为 REV 9、`reviewing`、4 项待审。点击取消后恢复“保留全部剩余”，控制台 warning/error 为空。本批没有调用最终确认，也没有改变 sample-03 的任何候选决定。
- 二次确认降低误触，不替代逐项试听。用户若有意结束审阅仍可使用该入口；正式 Gate 依然只接受真实用户完成的决定、导出和后续质量标签。

## 2026-08-13：真实审阅首屏重排（候选决策优先于治理与验收面板）

### 目标

在 4320 的真实 sample-03 页面做首屏验收时发现：左侧最关键的候选“循环试听 / 删除 / 保留”操作被 Agent 会话、Studio 授权和展开的 Alpha 验收面板压到视口之外。页面虽然显示“4 待处理”，用户首屏却看不到处理按钮，直接阻碍正式口播审阅。该问题不是数据链错误，但会让已接通的能力在真实工作区中难以完成。

### 实际改动

- `ReviewSidebar` 调整为任务优先的信息层级：审阅统计之后立即显示当前候选检查器，再显示有界滚动的候选队列；Agent 会话、Studio 浏览器授权和 Alpha 验收完整保留，统一后置到“工程治理与验收”辅助区。
- 左侧栏改为自身纵向滚动，候选队列使用 `clamp(140px, 24vh, 220px)` 的有界高度，既保证主要决策按钮首屏可见，也允许 7 条以上候选独立浏览；辅助区仍可向下滚动抵达，不靠隐藏或删除功能换取空间。
- Alpha 面板默认展开逻辑从“任何证据未完成都展开”收紧为“现在确实有 Alpha 动作可做才展开”：新正式样本需要登记/继续计时时展开，完成内容取舍、导出与计时后需要最终标注时展开；像 sample-03 这种已错过计时起点且当前标签仍被内容取舍门禁禁用的旧工程默认收起，用户仍可手工展开查看全部证据。

### 测试与限制

- 新增 Alpha 可操作性单测，覆盖旧工程事后计时已锁定时收起、新正式样本待计时时展开、最终标签可写时展开、全部完成后收起。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**326/326 测试**；其中 Studio 57/57，较上一基线净增 1。
- 应用内浏览器刷新真实 4320 后，DOM 仍为 `project_p1_real_dogfood` / REV 9、4 项待审、3 项已删除，未产生任何编辑；候选检查器实测位于视口 `top=368 / bottom=568`（视口底部 720），完整可见，候选队列紧随其后；旧 Alpha 面板 `open=false`，页面控制台 warning/error 为空。
- 本批只改善真实审阅路径的信息层级，不替用户判断剩余 4 项，也没有增加 Gate 分母。sample-03 仍需用户实际试听并决定，正式 Alpha 仍需新的未审阅授权工程采集成对时间证据。

## 2026-08-13：授权 cohort + 源媒体 hash 双绑定（防首次登记错素材）

### 目标

上一批已经要求授权文件含当前 `cohort-id` 的精确 marker，但仍留下首次登记漏洞：收集命令可以拿“明确授权给 cohort A 的文档”登记另一条实际素材，只要 manifest 尚未存在同 cohort/source 冲突就无法发现。正式证据链必须把人的授权记录同时绑定到 cohort 身份和建项后得到的 canonical 源媒体 SHA-256。

### 实际改动

- 共享授权 marker 升级为 `<!-- agentcut-alpha-authorization: <cohort-id> <source-sha256> -->`，源 hash 统一按小写生成并继续要求独占整行精确匹配；只对 cohort、只对素材或任一字段不一致均返回 `AUTHORIZATION_EVIDENCE_INVALID`。
- `alpha:collect` 在运行 correctness、创建 `alpha-evidence.sqlite` 或发布 bundle 前，以只读方式先打开目标工程 Audit，取得 canonical `sourceSha256` 后再验证授权文件；拒绝路径不会产生正式证据副作用。manifest materialization / `alpha:gate` 使用同一函数，并以 manifest 项目的 `sourceSha256` 重新验证离线证据。
- 正式授权登记中的 3 条 marker 已迁移为 cohort + 各自实际源 hash；benchmark README、G5 执行计划和授权登记规则同步要求先建项取得 canonical hash，再补授权绑定，避免授权另一条视频的文档被复用。

### 测试与限制

- 新增 collect 对抗测试：cohort 完全相同但授权 marker 使用另一条源 hash 时必须 exit 2，且 sidecar 与 bundle 目录均不存在。manifest materialization 同样覆盖“cohort 对、源 hash 错”；既有 source/bundle 冲突测试同步调整夹具，使其继续到达原本要证明的后置门禁，而非被新前置校验提前截断。
- 完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**325/325 测试**；alpha-gate 65/65，较上一基线净增 1。正式 `pnpm alpha:gate` 成功重放 3 条双绑定授权后仍按预期返回 `INSUFFICIENT EVIDENCE`：授权 3/20、审阅导出 0/20、配对计时 0/20，四项 correctness 各 3/3，高风险自动删除 0。
- 该 marker 是本地防错与可审计绑定，不是数字签名，也不能单独证明授权人的身份。Alpha Gate 仍需新增至少 17 个真实授权项目，并由真实操作者完成审阅、导出、候选/边界试听标签与成对计时；本批没有伪造或回填这些证据。

## 2026-08-13：授权证据与 cohort 精确绑定（防无关授权文件复用）

### 目标

在授权文件实体校验之后继续审计发现：只要求“相对路径 + 非空普通文件”仍不能证明该文件授权了当前 cohort。一个新项目理论上可以复用另一个项目的非空授权文档并被计入 20 项目分母。授权链必须同时证明文件存在和该 `cohort-id` 被明确列入。

### 实际改动

- 新增共享 `authorization.ts`，规定机器可验证的独占行：`<!-- agentcut-alpha-authorization: <cohort-id> -->`。校验按整行 trim 后精确匹配，不接受相似前缀、正文偶然出现 ID 或另一个项目的 marker。
- `alpha:collect` 在运行 correctness、创建 sidecar 或发布 bundle **之前**读取目标授权文件并验证请求 cohort marker；不匹配直接 exit 2，不留下 `alpha-evidence.sqlite` 或 bundle。
- `materializeAlphaGateManifest` 复用同一校验，因此现有 manifest 每次 Gate 聚合时也重新证明“授权文件实体 + 当前项目 marker”两层绑定；错误被统一映射为 `AUTHORIZATION_EVIDENCE_INVALID`。
- `docs/17-alpha-authorization.md` 为当前 3 个正式 cohort 增加精确 marker；benchmark README、G5 runbook 与授权说明补充新项目登记格式。人类可读表格仍是授权语义，marker 只是防错和机器绑定，不替代实际同意。

### 测试与限制

- 新增 collect 对抗测试：授权文件仅含 `another-cohort` marker 时请求 `cohort-real-001` 被拒，且 correctness sidecar/bundle 均不存在；manifest materialization 同样覆盖错误 marker。既有 fixture 均改为显式授权具体测试 cohort，不再用泛化的 “Authorized fixture” 文本冒充绑定。
- 完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**324/324 测试**；alpha-gate 64/64，较上一基线净增 1。正式 Gate 仍正常读取三条精确绑定授权并返回预期 `INSUFFICIENT EVIDENCE`（3/20、审阅导出 0/20、配对计时 0/20、高风险自动删除 0）。
- marker 证明本地证据文件明确列出了 cohort，不提供第三方数字签名；20 项目 Alpha 阶段仍以用户/设计伙伴授权记录和本地审计为边界，不扩张到合规签名平台。

## 2026-08-13：Alpha 授权证据引用实体验证（修复“错路径仍计为已授权”）

### 目标

审计 cohort 最后一步时发现正式 manifest 的 sample-02/sample-03 把授权证据写成 `docs/15-p2-transcript-review-validation.md`。授权路径按 `benchmarks/alpha-gate/` 解析，因此实际指向不存在的 `benchmarks/alpha-gate/docs/...`；但旧 `alpha:gate` 只读取 `confirmed=true` 和非结构化字段，未打开证据文件，仍把两条计入 3/20。该状态不满足“20 个授权真实项目”的可审计含义。

### 实际改动

- `evaluateAlphaGate` 在任何指标计算前验证 authorization 是完整对象：`confirmed` 必须为 boolean，`basis` 与 `evidence` 必须为非空文本；畸形数据返回 `INVALID_AUTHORIZATION`，不再以运行时属性访问或 truthy 字符串蒙混过关。
- `materializeAlphaGateManifest` 对每个 `confirmed` 项目重新解析相对路径并 `stat`：证据必须当前存在、非空且为普通文件；缺失、空文件、目录或绝对路径返回 exit 2 / `AUTHORIZATION_EVIDENCE_INVALID`，不会进入授权项目计数。该检查同时覆盖无 bundle 的占位项目和有 bundle 的正式项目。
- 正式 manifest 的 3 条引用统一修正为 `../../docs/17-alpha-authorization.md`；benchmark README、G5 runbook 与授权登记文档同步使用这一实际存在的 canonical register，不再展示不存在的 `authorization.md`。

### 测试与限制

- TDD 新增两组对抗场景：authorization 字段为空或把 `confirmed` 写成字符串时拒绝；确认项目的授权文件缺失或为空时 materialization 拒绝。既有 CLI/manifest fixture 补上真实非空授权文件，避免测试继续依赖“只写路径不落实体”的旧假设。完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**323/323 测试**；alpha-gate 为 63/63，较上一基线净增 2。
- 修正后的正式 `pnpm alpha:gate` 能读取 3 条授权引用并正常到达 `INSUFFICIENT EVIDENCE`：授权仍为 3/20、审阅导出 0/20、配对计时 0/20、高风险自动删除 0。数量没有因修路径而虚增；它现在表示 3 条可解析授权记录，而不是 1 条有效路径加 2 条悬空字符串。
- 授权正文仍是本地 Markdown 人工记录，并未引入外部签名或内容 hash；Alpha 当前需要的是可定位、可复核的授权链。若未来进入多方分发或合规审计，再单独升级为逐项目不可变授权收据，不在本阶段扩张范围。

## 2026-08-13：正式 Alpha 最终标注顺序门禁（导出 → 封存计时 → 质量标注）

### 目标

修复正式 Alpha 提效证据的顺序漏洞。runbook 规定用户完成内容取舍和通过质量门的导出后，必须先封存 AgentCut active-time，再试听并记录候选/边界质量；但既有 daemon 与 Studio 只检查“取舍完成 + 当前 revision 导出通过”，计时仍为 running/paused 时也能写最终标签。这样会把质量标注时间混入粗剪耗时，并让 append-only 事件无法证明指标采集顺序。

### 实际改动

- `AlphaEvidenceStore.labelCandidate/labelBoundary` 新增最终标签计时门禁：正式 Alpha 工程即使尚未登记 baseline 也必须先形成 completed timing；任何已经开始计时的工程同样必须先 finish。未采集 timing 的历史辅助工程保持可标注，不追溯伪造计时证据。
- evidence bundle 校验新增事件顺序约束：只要 bundle 同时含 timing 和最终候选/边界标签，timing 必须 `complete=true`，且所有最终标签事件 sequence 必须严格晚于最后一条 `finish`。即使篡改事件并重算 payload hash，也不能把“先标注、后完成计时”的证据送入 Gate。
- Studio 将“当前初剪已导出”与“最终质量标签可写”拆成两个状态。正式样本或任何已开始计时的工程，在 timing 未完成时禁用候选/边界按钮，显示“先完成本次计时，质量标注时间不会混入粗剪提效数据”；“完成本次计时”本身仍只依赖内容取舍完成和当前导出通过，避免循环锁死。

### 测试与限制

- 新增 EvidenceStore 单测：running 与 paused 均拒绝候选/边界标签，finish 后允许；新增 bundle 对抗测试：交换 finish/label sequence 并重算 integrity 后仍被 `INVALID_BUNDLE` 拒绝；新增 daemon API 全流程测试：正式建项、开始计时、删除/保留、登记通过导出、暂停、过早标签 409、finish、标签成功；新增 Studio 渲染测试覆盖按钮锁定、提示与完成后解锁。
- 完整 `pnpm check`（`ffmpeg-full`）通过：15 个 production build、全部 strict typecheck、**321/321 测试**；其中 alpha-gate 61/61、local-daemon 27/27、Studio 56/56。较上一基线 317 净增 4 个顺序门禁测试。
- 将正式 sample-03 的 4320 切换到上述最终 build，健康接口确认仍为 `project_p1_real_dogfood` / REV 9。应用内浏览器 DOM 复验显示 4 个待审、3 个已删除、0/7 候选标签、0/3 边界标签，最终标签仍因内容取舍未完成而禁用；旧工程未启动 timing，因此没有被新门禁错误要求补录计时。页面控制台日志为空。
- 该修复保证新采集证据的顺序可信，但不会把既有 3 个授权项目变成已完成人工审阅；正式 Gate 仍需用户真实试听、导出、标签和新增授权素材。

## 2026-08-13：Agent Transcript / 语义建议真实进程闭环与 4320 UI 复验

### 目标

补齐 2026-08-10「Agent Transcript 分页读取与高风险语义建议桥」留下的真实运行缺口：此前实现、内存 contract 与分组测试已通过，但 11 项依赖本机监听的 MCP/daemon loopback 未能执行，正式 4320 仍是旧 build，也没有证明外部 Agent 对真实 Transcript 提交语义建议后只形成待审 artifact、能够幂等重放并在重启后恢复。

### 实际验证

- 使用 `ffmpeg-full` 执行完整 `pnpm check`：15 个 production build、全部 strict typecheck 与 **317/317 测试通过**；其中 MCP **12/12**（含 stdio/HTTP loopback）与 local-daemon **26/26**，此前 270/281 的环境性缺口已关闭。
- 将正式 sample-03 Studio 切换到本批最终 production build 并保持在 `127.0.0.1:4320`。Agent CLI 通过工程 credential 调用 `transcript get --offset 0 --limit 5`，真实返回稳定 word id、source time、置信度与分页游标；调用前后工程均为 REV 9，源 hash `e536a169…ecf64` 不变，只有 session/access 审计侧表新增记录。
- 应用内浏览器完成 DOM 级复验：页面标题为「AgentCut · 通用剪辑工作区」，正式工程显示 REV 9、4 个待审、3 个已删除、导出因待审项禁用；原片/初剪、同步 Transcript、候选队列、Alpha 证据面板与 Agent session 均可见，控制台 warning/error 为空。该证据只证明当前页面投影与交互入口可用，不替代人工剪辑验收。
- 从 sample-03 的转写完成态 REV 2 创建一次性副本，提交一条真实 `restatement` finding：删前一遍 28 个词、保留后一遍，confidence 0.95。daemon 独立生成 **1 条 `high + suggest_remove` 待审候选**并推进到 REV 3；command log 仅含一个 `artifact.put`，主序列仍是一条 78.766667 秒完整源 clip，未出现 `range.deleteRipple` 或任何自动删除。
- 同 `requestId + payload + baseRevision` 重放后仍为 REV 3、候选仍为 1；更换 requestId 但继续提交旧 REV 2 时返回 exit 3 / `REVISION_CONFLICT`。完整停止并重启临时 daemon 后，REV 3 与同一候选可恢复，再次幂等重放仍不重复写入。
- 临时 4321 daemon 已停止，一次性工程副本及其临时凭据已永久删除；正式 4320 随后复核仍为 `project_p1_real_dogfood` / REV 9，没有用测试建议污染正式人工审阅状态。

### 结论与限制

Agent 已能在真实进程中分页读取规范 Transcript，并通过受控语义 finding 接口把「重复、重说、改口、说错」建议写成可审计的高风险待审候选；revision conflict、request 幂等、SQLite 持久化和“不得直接删除”边界均有真实样本证据。正式 Alpha Gate 仍未因此完成：这次是功能与信任边界验证，不是人工试听标签、审阅导出或 20 条授权素材证据；后续仍须按正式样本协议收集真实用户取舍与边界质量。

## 2026-08-13：sample-03 导出前置条件复核——「取舍缺失」与「标签缺失」的区分（修正）

### 目标

验证 sample-03 在修复后导出管线上的可行性；澄清「Alpha 验收面板显示 4 项待审」与「导出被阻止」的真实关系，避免用户把质量标签缺失误认为取舍未完成。

### 实际验证（一次性副本，删除，不计入正式 Gate）

- 复制 `.agentcut/dogfood/sample-03-project` 到 /tmp，启动 daemon（4405），CLI 探测 `export start`：返回 `ROUGH_CUT_INCOMPLETE 还有 4 个候选尚未决定，不能导出`（roughCutStatus=reviewing）。
- **修正**：此前误称 `alpha-audit` 显示 `pendingCandidateIds: 0`、`completed: None`——这是 Playwright 页面 evaluate 表达式把 UI 标签进度（0/7）误读为取舍进度的错误。**直接用 `pnpm alpha:audit` 核实：`pendingCandidateIds` 为 4 个 ID、`completed: False`、`candidate_remove` 状态 ×4**（1 个高置信重复 + 3 个停顿）。两者完全一致：sample-03 有 4 个取舍未决，导出阻止是正当的取舍缺失，不是标签缺失。
- 结论：sample-03 导出前置要求用户先完成 4 个取舍（1 重复 + 3 停顿，docs/15 §14 有定位），再写人工质量标签；这是预期的 Gate 门禁，不是缺陷。

## 2026-08-11：sample-01 导出管线媒体兼容性验证（241s VFR 录屏 MOV）

### 目标

sample-01（241s 屏幕录制 MOV）从未在任何导出管线（含修复后的越尾钳制 + 显式 `-t`）上渲染过——历史 `dogfood-report.json` 只含 ASR 报告（754→746 词、MLX whisper-large-v3-turbo），无 FFmpeg 渲染记录。为排除「用户首次完整跑样本时导出卡住」的风险，在一次性副本上做媒体兼容性预检（不替用户做内容取舍，完整导出被 `ROUGH_CUT_INCOMPLETE` 正当阻止）。

### 实际验证

- probe：MOV 容器、H.264 Main、**2930×1738（非标准宽高比）**、**VFR（60fps 标称、平均 35.3fps）**、AAC LC 48kHz 立体声、241.43s、765MB。
- 管线覆盖核对：renderer contain 缩放 + pad（`videoFitFilter`）、`fps=` 归一化、media-ingest 显示尺寸派生均已有实现。
- ffmpeg 真实转码（renderer 同款滤镜，源前 3 秒）：→ 1920×1080/25fps H.264 + AAC 成功，exit 0，输出 3.000s（AAC 2.986s 为 AAC priming 常态）。
- 副本验证完删除，正式工程未触碰。

### 结论

sample-01 在修复后导出管线上的媒体输入兼容性无意外，用户完成审阅取舍后即可直接走导出。这不是完整导出 job 验证（前置条件需用户内容决定），但排除了最大的媒体兼容性风险。

## 2026-08-11：sample-01 补登记入正式 manifest（授权 2/20 → 3/20）+ 审阅速查表补齐

### 目标

复核发现 `.agentcut/dogfood/project-full-job` 是 docs/17 已登记授权的 241s 录屏素材（`9a2755b480…` = 录屏2026-04-24 21.53.13.mov）的完整工程（REV 5、5 候选、1 边界、`firstHumanDecisionRevision` 为空），此前仅因「早期流程未跑协议」未入 manifest。docs/17 授权表本身即进入 manifest 的资格依据，遂按既定授权路径补登记，不再等待人工逐条批准（属于登记而非范围变更）。

### 实际改动

- `alpha:collect` 登记 `sample_01_screen_recording`（coverage: `screen-recording`，authorization 指向 docs/15 文档，bundle `…-r5-94c295a9f8b1.evidence.json`），幂等重跑确认不重复。
- `docs/17` 更新 sample-01 登记状态（未入 manifest → 已登记）与缺口数字（18 → 15 条新素材）；`docs/15` §14 新增 sample-01 审阅速查表（5 候选 + 1 边界）；目录核查确认其余遗留工程均为同一素材的早期版本，无其他可登记样本。

### 验证（全绿）

- `alpha:gate`：授权 3/20、审阅导出 0/20、配对计时 0/20、precision/边界/时间中位数未测量；四类正确性 `3/3 across 3/3 projects`。正式 manifest 更新为 3 个项目、4 个 bundle（sample-02/03 原 bundle 未触碰）。
- `git diff --check` 干净。
- **计时链路代码级验证**：Studio 启动指向 sample-01 工程后，「Alpha 验收」面板候选 0/5、边界 0/1、5 项待审、2 个试听按钮全部可见；「登记对照并开始计时」按钮初始 disabled 是 UI 预期（`Number(baselineSeconds) <= 0` 时禁用，输入正值后启用，AlphaAuditPanel.tsx:133）；无「不能事后启动计时」警告（`firstHumanDecisionRevision` 为空）。sample-01 未带 `agentcut.alphaTrial` enrollment（该标记仅在 `roughcut --alpha-trial` 建项时写入，workflow.ts:100-104），故 UI 不显示「正式 Alpha 样本」状态条、finish 不检查审阅完成+导出通过（server.ts:528）——不影响计时证据进入 gate（只认 timing block 有 evidence），但语义上该样本走的是宽松路径，按历史工程如实对待。

## 2026-08-11：`alpha:collect --coverage-classes` 端到端测试补齐 + 停顿降级文档全库对齐

### 目标

正式样本协议要求新样本用 `alpha:collect --coverage-classes` 登记素材类别（凑满 20 个项目后 gate 强制 8 类全覆盖），但该入口此前零测试：登记、幂等重放保留、非法类别拒绝都只靠实跑依赖。补齐测试，并把「停顿不再 definite」的修复语义同步到全部残留旧表述。

### 实际改动

- `collect-cli.test.ts` 新增 2 个测试：首次登记带 `--coverage-classes`（排序去重落盘）、幂等重放省略该参数时保留既有登记（upsert 不清空）；未知类别（`holographic-8k`）在写任何工程证据前拒绝（exit 2，`alpha-evidence.sqlite` 与 bundle 目录均不产生）。
- 文档对齐（历史快照加注，不改写史实）：`docs/15` 停顿 definite 表行、`docs/06` 自动模式策略、`docs/05` `agentcut_rough_cut_generate` 表行、`docs/11` 三个 08-11 早期条目（precision 审查 ×2、停顿检测解析）与 07-28 真实 Gate 工程条目——凡「silence 驱动 definite/自动删」表述一律标注「2026-08-11 起停顿一律 suggest_remove」。
- `docs/13` 新增两份可执行 runbook（此前只有「验证了什么」记录，没有「到时怎么跑」）：§7 G3 真实 Codex 宿主补跑 7 步（handoff 签发、语义建议、stale conflict、越权拒绝、撤销重启矩阵），§9 G5 新样本 9 步（建项→计时→取舍→导出→标注→collect→复核，含 30s 静止窗/requestId/coverage 允许值）。命令均对照 wrapper 源码核实。
- 素材存量核查：扫描 ~/Downloads、~/Movies、~/Desktop、~/Documents、~/Pictures、~/Music、/Volumes、iCloud Drive 及 12 种视频扩展名——本机仍只有 2 个已知旧视频，18 条新授权素材不在本机。
- codex CLI 实测：`codex-cli 0.146.0` 已登录（ChatGPT 账号），但最小请求即失败——`failed to connect to websocket: tls handshake eof`（chatgpt.com 网络层不可达，非额度错误）。**08-16 额度恢复后仍需先确认到 chatgpt.com 的 websocket 可达，再执行 G3 runbook**。

### 验证（全绿）

- 完整基线 `pnpm check`（ffmpeg-full）exit 0：**317/317 测试通过**（alpha-gate 57→59，较克隆审计基线 315 净增 2）。
- 正式 manifest 未触碰，`alpha:gate` 仍 `INSUFFICIENT EVIDENCE`（2/20 授权、0/20 审阅导出、0/20 配对计时）。

## 2026-08-11：Alpha Gate 首次端到端到达 PASSED（合成 cohort）+ 对抗性克隆审计（结论：四层防线已闭合）

### 目标

gate 自建成以来从未端到端见过「全部标注齐全的 ≥20 项目」——2/20 时 precision/边界/计时都停在「未测量」，单项目底线、coverage 检查、PASSED 终态只在单测里跑过。用彩排 bundle 克隆出 20 个「全绿」项目，验证 gate 在真实数据上能否到达 PASSED，并对抗性审计 cohort 完整性。

### 端到端 PASSED（合成克隆，仅验证逻辑）

把彩排 bundle（1 definite TP、4 边界 usable、计时 300s→43.2s、correctness 4/4）克隆成 20 个项目（各自重算 payload/file hash、独立 source hash、循环覆盖 8 类），gate 输出 **PASSED**：20/20 授权、20/20 审阅导出、precision 100%、边界 100%、计时中位数降 85.6%、四类正确性 20/20。这证明 gate 逻辑端到端正确（不是「永远失败」）。**这是合成克隆，不计入正式 Gate。**

### 对抗性审计：cohort 克隆是否能把 1 个真实项目放大成 20 个？

构造 20 个 cohort 条目共享同一段计时/正确性数据，逐一探测 gate 的拦截层：

1. **篡改 bundle 内容** → payload hash mismatch（`BUNDLE_FILE_HASH_MISMATCH` 前）拦截。✓
2. **换 projectId 不换 bundle**（字节复制）→ `BUNDLE_BINDING_MISMATCH`（bundle.project.id ≠ canonicalProjectId）。✓
3. **重算 hash 使 binding 通过、但 20 项目共享同一段计时** → 到达 PASSED。**这正是本审计要回答的问题：这是否算漏洞？**

### 结论：不是漏洞，四层防线已闭合，无需改代码

- **源 hash 唯一性**（`evaluateAlphaGate` 的 `DUPLICATE_SOURCE`，在 binding 前的 manifest 层）：同一底层素材换皮 N 次，只要 manifest 的 sourceSha256 相同即拦截。这是克隆的第一道、也是最早命中的防线。
- **binding 校验**（`BUNDLE_BINDING_MISMATCH`）：bundle 内 project id / source / revision 必须与 manifest 声明一致，且 bundle 经双层 hash 校验（文件 hash + 内部 payload hash），篡改任一字段即失配。
- **binding 后的 canonical 唯一性**：曾尝试加「binding 后按 bundle.project.id 唯一」检查，但**误伤真实 manifest**——sample-02/03 是同一 dogfood 工程目录（共用 `project_p1_real_dogfood`）分两次独立转写的不同素材，bundle project id 只反映工程目录来源、不含素材区分度。该检查对「同工程不同素材」的合法历史样本误报，且对「同素材重复登记」又是冗余（已被 DUPLICATE_SOURCE 拦截），故移除。
- **timing 中位数**：计时配对继承 bundle 的 source-hash 绑定，同素材重复计时被 DUPLICATE_SOURCE 拦截；不同真实素材本就有不同时长/内容，配对自然不同。

教训：**审计性唯一性检查必须区分「工程目录 id」与「素材身份」**——二者在修复工程 id 来源（按源 hash 派生）之前的 dogfood 工程里是解耦的。对历史样本加「工程 id 唯一」会把合法的多样本同工程误判为克隆。

### 测试与验证（全绿）

- 新增 2 个 manifest-evidence 测试：克隆（共享 bundle）被外层 `DUPLICATE_SOURCE` 拦截、binding 锁 sourceSha256（换 source 不换 bundle 即失配）。曾因误设「binding 后 canonical 唯一」反复失败，最终对齐到真实的四层防线语义。
- 完整基线 `pnpm check`（ffmpeg-full）exit 0：**315/315 测试通过**（较停顿修复基线 313 净增 2）。
- 三个 manifest 实跑：克隆 manifest 被拒（`BUNDLE_BINDING_MISMATCH`）、合成 20 项目 manifest `PASSED`、正式 manifest 仍 `INSUFFICIENT EVIDENCE`（2/20，未被污染）。
- 合成 manifest 在 /tmp，正式 `benchmarks/alpha-gate/manifest.json` 未触碰。

## 2026-08-11：首次接触浸泡（130s 合成口播）+ 停顿候选全部降级为 suggest（precision 可审计性修复）

### 目标

把 18 条新样本协议的「首次接触」环节（`pnpm roughcut -- <视频> --alpha-trial`）从 23.8s 彩排放大到分钟级口播，验证建项+ASR 在真实量级素材上的行为，并审查候选生成在分钟级素材上的分类是否符合 Gate 语义。

### 浸泡结果（合成素材，不计入正式 Gate）

- 素材：macOS `say`（Tingting）9 段中文口播 ×~15s，段间插入 1.0s 静音，共 138.3s 720p MP4。
- 建项 + ASR 11s 完成（增量构建），转写 439 词、填充词（2×嗯、1×呃）与重复（我们今天我们今天）全部命中。
- 候选生成 12 个：1 填充词 definite 自动删、2 填充词 suggest、1 重复 suggest、**8 段间停顿全部 definite_remove + low risk 自动删**。

### 发现（Gate 可审计性缺陷）：长停顿自动删除不可审计

`candidates.ts` 此前把 ≥800ms 的停顿判 `definite_remove + low` 并由 generate 路径自动提交。但 Gate 的 precision 证据**只统计 definite_remove 候选的人工标注**（suggest 不进分母），这意味着「自动删停顿」在 precision ≥98% 的验证里完全不可见——而停顿是否该删取决于语义（思考停顿 vs 废话），误删风险远高于填充词。这与同日 precision 审查确立的设计意图（「definite 只由填充词驱动，其余全部人工确认」）相悖。

### 修复

`candidates.ts`：停顿候选（无论长短）一律 `suggest_remove + medium`，`explanationZh` 明示「是否删除请试听后决定」。自动删除从此**仅限**高置信填充词（嗯/呃/额，confidence ≥0.85、时长 ≤800ms）——设计意图与实现重新一致。新增回归测试锁定：长停顿（800ms bounded）不再 definite、不进低风险自动提案；首个既有用例的 silence 期望同步改为 suggest。

### 真实工程佐证（只读检查，未修改正式样本）

sample-02（REV 4）历史候选含 13 个停顿候选、其中 4 个 definite；sample-03（REV 9）含 5+1 个停顿候选、3 个 definite——证明该缺陷在真实口播素材上确实触发，修复有实质影响。历史工程不重跑，新候选生成自然走修复后路径。

### 验证（全绿）

- 完整基线 `pnpm check`（ffmpeg-full）exit 0：**313/313 测试通过**（较越尾修复基线 312 净增 1）。
- 修复按 TDD：新测试先在旧代码上失败（silence definite），修复后全绿。
- 彩排/浸泡 daemon 已全部停止，正式 manifest 未触碰。

## 2026-08-11：操作者协议全流程彩排 + 导出管线两处真实缺陷修复（源尾越界钳制 / -shortest 替换）

### 目标

在用户排队 18 条新样本之前，用一次性合成素材把正式样本协议（`--alpha-trial` 建项 → 计时 → 取舍 → 导出 → 完成计时 → 标注 → `alpha:collect --coverage-classes` → gate）端到端实跑一遍，暴露文档/实现漂移与协议摩擦。素材：macOS `say`（Tingting）合成中文语音（含 3 个"嗯"填充词、2 处重复、多处停顿）+ lavfi testsrc2 画面，23.8s；彩排 manifest 完全独立于正式 `benchmarks/alpha-gate/manifest.json`，永不计入正式 Gate。

### 发现一（P0，阻断正式样本）：末段越尾导出必挂质量门

彩排导出报 `QUALITY_FAILED`：期望 21.873s，实际 21.193s，差 680ms（容差 40ms）。根因实验（ffmpeg 逐步二分）：

1. 末句 ASR 词边界 23.833s 微超音频流尾 23.131s（短视频/录屏的常态）；trim 请求不存在的媒体时 concat 按视频流尾拉伸，最终段比实际媒体长约 1.32s；
2. 既有 `-shortest` 本应兜底，但被音频 AAC priming/padding（encoder delay ~21ms + decoder trim + 末帧 padding）拖短约 680ms——质量门挂；
3. 去掉 `-shortest` 则输出被拉伸段拖到 23.566s（+1.7s）——同样挂。**两种行为都无法同时满足 40ms 容差。**

### 修复（plan → renderer → 质量门 三处协同）

- `plan.ts`：每段新增 `availableSourceMicros` = min（视频流时长， 转写音频流时长） − 段起点（真实探针流时长；旧 fixture 缺时长时不钳制，行为与修复前一致）；plan 新增 `expectedOutputMicros` = 各段钳后时长之和；越尾时追加中文+英文 warning（"末段请求越过源媒体尾部，导出在源尾结束"）。
- `renderer.ts`：trim/atrim 时长钳到 `availableSourceMicros`；输出侧用 `-t expectedOutputMicros`（33ms 帧格精度）替换 `-shortest`。
- `workflow.ts` 质量门：越尾时对 `expectedOutputMicros`（而非理想时间线时长）保持 40ms 容差，报告新增 `expectedOutputMicros` 字段（timeline-schema 类型 + JSON schema 同步）；未越尾时语义完全不变。
- 回归：媒体矩阵新增第 13 形态 `tail-overrun-final-segment`（音频 3.02s < 视频 4.03s < 容器 4.0s，clip 请求越过全部流尾部），含反退化守护（clip 窗口必须真越尾、报告必须披露钳后时长）。修复前该用例按原管线实测 680ms 超差失败，修复后 0ms 通过。

### 发现二（协议摩擦，文档已补）：计时 30s 静止窗与跨分钟写操作冲突

计时心跳静止窗 `TIMING_STALE_AFTER_MS = 30_000`：距上次心跳 >30s 的写操作会被 `ALPHA_TRIAL_TIMING_REQUIRED` 拒绝（防"停机时间计入活跃用时"的设计意图）。Studio UI 在运行态持续发心跳不受影响，但 CLI/脚本驱动的正式样本若在两次操作间停顿 >30s（导出等待、人工试听长片段）会反复被拒。实跑中用「写前重启计时 + 立即心跳」模式通过。README 操作顺序段已补两条说明（见下）。

### 彩排全链路结果（一次性副本，不计入正式 Gate）

- 建项 → ASR（69 词，填充词/重复全部命中）→ begin 计时（baseline 300s）→ 生成候选 4 个（1 个 definite 自动删 + 3 个 suggest）→ 逐个接受（REV 2→6）→ 导出修复后 succeeded（质量门 29ms 偏差、8 条字幕、1280×720）→ finish（active 43.2s）→ 4 候选 true_positive + 4 边界 usable 标注 → `alpha:collect --coverage-classes mandarin`（独立彩排 manifest）→ gate 评估：precision 100%、边界 100%、四类正确性 1/1、计时下降 85.6%，诚实 `INSUFFICIENT EVIDENCE`（1/20）。
- 正式 manifest 复跑确认仍 2/20 `INSUFFICIENT EVIDENCE`，未被彩排污染。
- 完整基线 `pnpm check`（ffmpeg-full）exit 0：**312/312 测试通过**（较底线修复基线 311 净增 1，即越尾矩阵形态）。

### 协议彩蛋（非缺陷）

幂等重放在证据事件中复现：`rehearsal-hb-1`（REV 4）排序在 `rehearsal-hb-2`（REV 3）之后，正是「同 requestId 安全重试」语义在真实操作中的体现。

## 2026-08-11：Alpha Gate 单项目底线（防聚合稀释）修复

### 目标

补上 Gate 精度/边界指标的统计漏洞：此前只做跨项目聚合（precision ≥0.98、边界 ≥0.95），19 个满分项目可以把 1 个 precision 仅 50% 的项目稀释到聚合 99.5% 而判通过——单项目灾难被集体成绩掩盖，违背「每个真实项目都要可信」的 Gate 语义。

### 实际改动

- `alpha-gate/gate.ts`：新增 `MINIMUM_PER_PROJECT_DEFINITE_REMOVE_PRECISION = 0.9` 与 `MINIMUM_PER_PROJECT_BOUNDARY_USABILITY = 0.8` 两条单项目底线。任何已标注项目跌破底线即判 failed，分别报 `DEFINITE_REMOVE_PROJECT_BELOW_FLOOR` / `BOUNDARY_PROJECT_BELOW_FLOOR` 并附跌破底线的 `projectIds`；聚合阈值逻辑原样保留（底线是补充而非替代）。
- 测试：新用例「19 个完美项目 + 1 个 precision/边界各 50% 的项目」聚合 99.5%/97.5% 均过线但仍判 failed，且只报两条底线 issue（不含聚合失败），证明拦截归因正确。

### 测试构造要点（首个版本曾写错）

首版用例直接沿用 `qualifyingProject` 自带的 49/50、19/20「良好但非完美」数据，导致聚合实际只有 97.5%/92.75%——聚合阈值先失败，用例无法区分是底线还是聚合在拦截。修复为先把 20 个项目全部拉满（TP=predicted、usable=evaluated），再只压低第 20 个；教训：**验证拦截归因的测试必须让除目标机制外的所有机制都保持通过**。

### 验证（全绿）

- `pnpm --filter @agentcut/alpha-gate test`：55/55 通过。
- 完整基线 `pnpm check`（ffmpeg-full 环境变量）exit 0：**311/311 测试通过**（较覆盖追踪基线 310 净增 1）。
- 真实 manifest（2/20）`alpha:gate` 仍 `INSUFFICIENT EVIDENCE`，issue code 与基线完全一致（无标注项目时底线不触发，行为不变）。

## 2026-08-11：Alpha Gate 素材多样性覆盖追踪（8 类强制全覆盖）

### 目标

补上 Gate「数据与试用」要求（20 个项目覆盖普通话/口音/中英混说/专名数字/快语速/背景音乐/VFR/录屏口播 8 类）此前完全无机器追踪的缺口：manifest 与 gate 都不记录每项目覆盖类别，无法防止"20 条同质素材冒充达标"。

### 实际改动

- `alpha-gate/gate.ts`：新增 `REQUIRED_COVERAGE_CLASSES`（8 类常量）与 `AlphaGateProjectEvidence.coverageClasses`（可选，向后兼容）；`evaluateAlphaGate` 在凑满 20 个授权项目后强制 8 类全覆盖，缺类报 `SAMPLE_COVERAGE_INCOMPLETE`（failed）；`validateProjects` 拒绝不在允许集合内的覆盖类别（`INVALID_COVERAGE_CLASS`）。
- `alpha-gate/collect-cli.ts`：`alpha:collect` 新增可选 `--coverage-classes <逗号分隔>`，校验类别合法后写入 manifest；缺省不记录（凑满 20 个后按缺失计，诚实不静默通过）。
- 测试：3 个新用例——20 个达标项目循环覆盖 8 类通过、20 个同质（只 mandarin）项目判 failed、20 个未记录类别的项目按缺失判 failed、非法类别 manifest 抛 `INVALID_COVERAGE_CLASS`。

### 设计取舍

覆盖检查**只在凑满 20 个授权项目后触发**（与 AUTHORIZED_PROJECTS_MISSING 的 insufficient_evidence 分支互斥），避免在收集中途对未完成的 cohort 误报；未记录类别的项目按缺失计而非豁免，保证诚实。

### 验证（全绿）

- 完整基线 `pnpm check`（ffmpeg-full 环境变量）exit 0：15 个构建、**310/310 测试通过**（较安全审查基线 307 净增 3）。
- 现有真实 manifest（2/20）`alpha:gate` 仍诚实 `INSUFFICIENT EVIDENCE`，覆盖检查未触发——与既有行为一致。
- 不改变正式 Gate 分母（授权 2/20、审阅导出 0/20、配对计时 0/20）。

## 2026-08-11：Agent 能力/提权边界安全审查（结论：无漏洞）

### 目标

对抗性审查「Agent 原生 + 可审计」目标的核心信任边界：`timeline:write:low_risk_only` 能力是否可能被提权为高风险删除，以及 token/session 校验是否可伪造或绕过。

### 审查项与结论（逐行核验）

- **能力检查**：`authorizeAgentSession` 用 `session.capabilities.includes(capability)` 精确匹配，缺能力返回 `CAPABILITY_DENIED`（403），有测试覆盖；revoked/expired/unknown token 分别 fail-closed。
- **low_risk_only 无法提权**：该能力唯一映射到 `/api/rough-cut/generate`，其执行路径只调 `createLowRiskProposal`（仅筛 `decision==="definite_remove" && risk==="low"` 的候选）；而重复/改口检测永不产生 definite（见同日 precision 审查），故 low_risk_only 会话**物理上无法**触达中/高风险删除。高风险删除必经 `timeline:write:approved`（approval token 绑定精确候选定义 + revision + 过期）。
- **token 生成**：access token = `agc_` + HMAC-SHA256(bootstrap, `agentcut:{sessionId}`)，不可由客户端伪造；存储只存 token 的 SHA-256 hash，不明文落盘。
- **bootstrap 比较**：`assertSecret` 用 `timingSafeEqual` 且先比长度，抗时序侧信道。
- **能力授予**：`readAgentCapabilities` 白名单仅含已定义的 8 种能力，未定义能力（如从未存在的 `transcript:write`）在协议层直接拒绝；拒绝重复项、强制排序。`ttlSeconds` 限定 60–86400s。
- **UI session**：nonce 用 `randomBytes(18)`，签名比较用 `timingSafeEqual`。

**结论：未发现提权或伪造漏洞，无需修改。** 能力模型的纵深防御（白名单授予 + 精确匹配检查 + low-risk 路由物理隔离 + approval token 三重绑定）成立。记录此审查以避免后续重复审计同一面。

## 2026-08-11：重复/改口检测的 precision 安全性审查（结论：有意保守，无缺陷）

### 目标

对抗性审查 Gate 的 `definite_remove` precision ≥98% 指标：怀疑重复检测因归一化剥离标点、默认 2 字阈值会把"这个这个方案"等合法口语强调误判为自动删除，损害 precision。

### 审查方法（第一性原理 + 实测）

构造最小 document 实测三类输入：(A) 强调重复"这个这个方案"、(B) 真口误"我们今天我们今天"、(C) 标点分隔两句"我们去。我们去。"。

### 实测结论（证伪假设，无缺陷）

- 三类输入的重复候选 `decision` **全部为 `suggest_remove` + `medium` 风险，永不自动删除**（含 B 真口误）；`definite_remove` 只由 filler（嗯/呃/额，且需 confidence ≥0.85、时长 ≤800ms）与 silence 驱动（注：silence 部分于当日稍后降级为 `suggest_remove`，见本文件同日「停顿候选全部降级为 suggest」条目；此处保留的是审查当时的实现）。
- 归一化剥离标点是有意设计：标点分隔的两句（C）正确不判重（已有测试 `does not cross punctuation` 锁定）；强调重复（A）标为 suggest 由人工在审阅时保留，不进 `definite_remove`，故不伤 precision 指标。
- "啊"为 CONTEXTUAL_FILLERS（suggest），仅 3 个高精度填充词进 definite——高度保守。

**结论：重复/改口检测的 precision 风险假设被证伪，无需修改。** 记录此审查以避免后续 Agent 重复怀疑该路径；`definite_remove` precision ≥98% 的设计安全边际来自「只对 3 个填充词 + silence 自动删除、其余全部人工确认」的有意保守策略（注：silence 部分于当日稍后降级为 `suggest_remove`，自动集合仅剩高置信填充词，见同日「停顿候选全部降级」条目）。

## 2026-08-11：停顿检测解析的真实集成测试 + 时间戳边界加固

### 目标

Gate 的 `definite_remove` precision 与剪切边界可用率都依赖 `detectSilences` 的边界精度——它把 ffmpeg `silencedetect` 的 stderr 翻译成停顿区间（注：precision 依赖关系于当日稍后随停顿降级失效——`definite_remove` 此后只由高置信填充词的词边界驱动；静音边界仍影响边界可用率与剪切质量，见同日「停顿候选全部降级」条目）。但它此前只被高层 candidates 测试以 mock 间接覆盖，真实解析逻辑零直接测试；逐行审查发现 `secondsToMicros` 对畸形时间戳（多段小数、空小数部分）会静默产出错误或抛原生 `SyntaxError`，需加固并补真实集成测试。

### 实际改动

- `candidate-engine/silence.ts`：`secondsToMicros` 增加格式校验（`^\d+(\.\d+)?$`），非规范时间戳（如 `1.2.3`、`abc`）抛带 `INVALID_SILENCE_OUTPUT` 码的 `CandidateDetectionError` 而非原生 `SyntaxError` 或静默错误值；保留对 `5.`、`1.5` 等规范形式的正确解析。
- 新增 `candidate-engine/silence.test.ts`（真实 ffmpeg 集成）：生成「有声-停顿-有声」三段音频，断言检出停顿的起点/持续落在真实窗口内；连续纯音返回空；非正 `minimumDurationSeconds` 抛 `RangeError`。

### 验证（全绿）

- 完整基线 `pnpm check`（ffmpeg-full 环境变量）exit 0：15 个构建、**307/307 测试通过**（较 HDR 基线 304 净增 3）。
- 不改变正式 Gate 分母（授权 2/20、审阅导出 0/20、配对计时 0/20）。

## 2026-08-11：媒体元数据改动后的正式样本回归验证（正确性 + schema 校验）

### 目标

对抗性审查：媒体保真链路（旋转/SAR/HDR）改动了 ingest probe、render plan/renderer、timeline schema 与素材矩阵，需确认这些改动未破坏既有正式样本的可恢复性与导出产物合法性——这是「关闭或重启后可继续」与「Timeline IR/SQLite 唯一真相源」Gate 的回归保障。

### 实际验证（全部真实运行）

- `alpha:verify` 在 sample-02（REV 4）与 sample-03（REV 9）各自的临时 SQLite 克隆上重跑四类正确性：**undo / restart / idempotency / revisionConflict 全部 passed**；正式库只读、未被触碰。
- `alpha:gate` 聚合视图与改动前一致（诚实 `INSUFFICIENT EVIDENCE`，四类正确性 2/2 across 2/2 projects），未因元数据字段新增而退化。
- 在 sample-03 临时副本（`/tmp/schema-verify`，daemon 4405，ffmpeg-full）完成 keep-remaining（REV 9→10）并真实导出（succeeded，`fitMode: contain`，SDR 时正确省略 `colorApproximate`）；随后用 `ProjectStore.open` 读回该副本快照，`validateProjectDocument` 返回 `valid: true`——证明含新 `renderReport.quality` 字段（`fitMode`/`fitModeApproximate`/`colorApproximate`）的导出文档仍通过 0.1 schema 校验。
- 验证后停止 daemon、删除全部临时副本与脚本；正式 sample-03 确认 REV 9、无 renders 目录。

### 结论

媒体元数据改动对既有正式样本无回归：可恢复性、幂等、revision 冲突拒绝与导出产物 schema 合法性均保持。正式 Gate 分母不变（授权 2/20、审阅导出 0/20、配对计时 0/20）。

## 2026-08-11：HDR 源检测 + 近似 SDR 诚实标记（PQ/HLG）

### 目标

延续媒体保真链路的系统性排查：iPhone/现代手机默认 HDR 录制（bt2020 色域 + PQ/HLG 传递特性），当前管线把它当 SDR 直接编码成 bt709 MP4 而不色调映射——输出保留 PQ 标签，在 bt709 播放器上高光/色彩失真。检测并诚实标记，避免创作者发片前不知情。

### 实际改动（检测+告警，不做色调映射）

- `media-ingest`：`video` 新增 `colorTransfer`（来自 `color_transfer`），覆盖 PQ(smpte2084)/HLG(arib-std-b67)。
- `render-engine`：`RenderSegment.sourceColorTransfer`、`RenderPlan.sourceHdr`；plan 在检测到 HDR 源时追加中文告警（HDR 源不色调映射、输出近似 SDR、bt709 播放器可能失真）；质量报告新增 `colorApproximate: true` 诚实标记（仅 HDR 时出现，SDR 省略）。
- `timeline-schema`：`renderQuality` 新增可选 `colorApproximate`（纯新增可选字段，无迁移）。
- 素材矩阵新增 `hdr-pq` 条目（HEVC 10bit + bt2020/PQ），走完整持久化渲染质量门并断言 `colorApproximate: true` + HDR 告警。

### 设计取舍

**检测+告警而非自动色调映射**：色调映射（zscale+tonemap→bt709）在本机 ffmpeg-full 实测可行（输出干净转为 bt709 标签），但属于有损、需感知峰值亮度的处理，且 `zscale/tonemap` 依赖 libzimg——并非所有用户 ffmpeg 构建都自带。Alpha 首发聚焦"诚实标记已知近似"而非引入新的有损默认行为；若真实口播素材大量为 HDR，再单独立项评估自动色调映射（需同时把 `zscale/tonemap` 加入 doctor 能力检测，缺失时优雅降级为当前的告警路径）。

### 验证（全绿）

- 完整基线 `pnpm check`（ffmpeg-full 环境变量）exit 0：15 个构建、**304/304 测试通过**（较 SAR 基线 303 净增 1：matrix `hdr-pq`）。
- 不改变正式 Gate 分母（授权 2/20、审阅导出 0/20、配对计时 0/20）。

## 2026-08-11：非方形像素（SAR）保真修复（probe 显示宽高含 SAR + 渲染前归一化）

### 目标

延续旋转修复同一条保真线：旧式宽银幕 SD（720×480 SAR 32:27 等）存储帧是拉伸的，显示需按 SAR 缩放。此前 probe 只读存储宽高，`scale=W:H:decrease` 会按存储宽高比适配导致画面被水平压缩（变形）。实测确认：把圆画到 anamorphic 源再经当前管线渲染，输出圆被压成椭圆。

### 实际改动

- `media-ingest`：`video` 新增 `pixelAspectRatio`（来自 `sample_aspect_ratio`，兼容 `N/M` 与 `N:M`，非法值回退 1/1）；`displayWidth` 改为「存储宽 × SAR 取整」，旋转 90/270 时再交换。
- `render-engine`：`RenderSegment` 携带 `sourceDisplayWidth/Height`（plan 从 probe 的 video 流读取）；`compileFfmpegArgs` 在 `videoFitFilter` 前插入 `scale=<显示宽高>` 预归一化（SAR≠1:1 或旋转与存储不同时），保证 contain/cover 按显示宽高比适配；`ProbeMetadata` 类型放宽为完整 `MediaStreamProbe[]`。
- `rough-cut-workflow` 画布已用 `displayWidth/Height`，自动继承 SAR（旧 NTSC 竖拍不再建 3:2 画布）。
- 测试：ingest 新增 anamorphic SAR 探针（720×480 SAR 8/9 → display 640×480）；素材矩阵新增 `anamorphic-sar` 条目走完整渲染质量门。

### 验证（全绿）

- 完整基线 `pnpm check`（ffmpeg-full 环境变量）exit 0：15 个构建、**303/303 测试通过**（较旋转基线 301 净增 2）。
- 不改变正式 Gate 分母（授权 2/20、审阅导出 0/20、配对计时 0/20）。

## 2026-08-11：旋转元数据竖拍保真修复（probe 显示宽高 + 画布校正）

### 目标

修掉首发口播工作流中一个已实测暴露的真实保真缺陷：手机竖屏录制（最常见的中文口播形态）存储为横幅帧 + Display Matrix rotate=90/270，此前 probe 只读存储宽高，导致 ingest 建画布时误判为横幅，渲染把竖幅内容 pillarbox 进横幅画框（左右黑边、内容缩小）。

### 实测暴露过程（对抗性审查）

- 生成 `testsrc2 640x360` 存储帧 + `-display_rotation 90` 的真实旋转样本，证实 ffprobe/ffmpeg 在解码时已 autorotation（输出 360x640 竖幅、内容朝上）；
- 但我们的 probe 只读 `width/height`（640x360 存储帧），`buildInitialRoughCutProject` 用它建画布 → 画布为横幅 640x360；
- 实测把竖幅源渲染到横幅画布：输出左右黑边 pillarbox、竖幅内容缩小居中——确认缺陷真实存在且影响首发最常见素材形态。

### 实际改动

- `media-ingest`：`MediaStreamProbe.video` 新增 `rotation`（度，来自 Display Matrix side data，缺省 0）与 `displayWidth/displayHeight`（rotation 为 90/270 时与存储宽高互换）；ffprobe 查询加入 `:stream_side_data=rotation`，新增 `readDisplayRotation` 解析。渲染侧 ffmpeg autorotation 已正确处理像素方向，无需改 filtergraph——缺的是元数据层的显示宽高。
- `rough-cut-workflow`：`buildInitialRoughCutProject` 画布改用 `displayWidth/displayHeight`，旋转竖拍建项即得竖幅画布，不再 pillarbox。
- 测试：ingest probe 断言 rotation=90/显示宽高互换；素材矩阵新增 `rotated-portrait` 条目（存储 640x360+rotate=90、画布 360x640）走完整持久化渲染质量门。

### 验证（全绿）

- 完整基线 `pnpm check`（ffmpeg-full 环境变量）exit 0：15 个构建、**301/301 测试通过**（较素材矩阵基线 298 净增 3：ingest 的旋转探针 1 个 + matrix 的 `rotated-portrait` 1 个；原 baseline CFR 探针断言也更新为含 displayWidth/Height 但不算新增用例）。
- 不改变正式 Gate 分母（授权 2/20、审阅导出 0/20、配对计时 0/20）；本修复属于 G4 保真范围，不计入正式矩阵分母。

## 2026-08-11：阶段依赖/许可证/隐私/磁盘/降级审查（维护节奏要求）

### 目标

按 `docs/13` 维护节奏「每阶段结束审查依赖、许可证、隐私、磁盘占用和降级路径」，在 P4 工程侧收尾节点把这项审查落成可核验记录，供 Gate 证据档案引用。

### 实际审查结果（逐项可复核）

- **第三方 JS 依赖共 11 个直接外部包，许可证全部宽松**：ajv 8.20.0(MIT)、ajv-formats 3.0.1(MIT)、@modelcontextprotocol/server 2.0.0(MIT)、@modelcontextprotocol/client 2.0.0(MIT)、zod 4.4.3(MIT)、react 19.2.7(MIT)、react-dom 19.2.7(MIT)、swr 2.4.2(MIT)、vite 8.1.5(MIT)、@vitejs/plugin-react(MIT)、@phosphor-icons/react 2.1.10(MIT)；开发侧 fast-check/vitest(MIT)、typescript(Apache-2.0)、@types/node(MIT)。无 copyleft JS 依赖，无 GPL 传染风险。
- **外部运行时二进制 FFmpeg**：本机 ffmpeg-full 8.1.2 带 `--enable-gpl`（含 GPL 组件）。AgentCut 仅通过子进程调用 FFmpeg 二进制、不静态/动态链接其库，因此 AgentCut 自身代码不被 GPL 传染；但若未来要**分发**该 FFmpeg 构建需遵守 GPLv3（提供源码）。Alpha 阶段 FFmpeg 由用户自装、AgentCut 不分发，风险可控；分发前需另立许可证评审。
- **ASR**：`mlx-whisper==0.4.3`（MIT，底层 OpenAI Whisper 亦为 MIT）；本地运行、音频不出本机。**语义审阅**：外部用户自装的 LM Studio 本地服务器（127.0.0.1:1234），模型由用户自行下载、其许可证随模型而定；AgentCut 不内置、不分发模型，未检测到服务器时优雅降级为"本地语义审阅不可用"。
- **隐私**：所有媒体/转写/渲染均在本地 SQLite + 托管目录，无遥测上报；唯一网络出口是 loopback（daemon UI/Agent 路由、LM Studio、可选云 ASR 尚未启用）。Alpha 证据 manifest 只存 hash/统计/证据引用，不存原始媒体。
- **磁盘**：node_modules 159M；渲染产物按 project 隔离在各自 `renders/`，崩溃残留由 `.work-*` 目录在重启时清理或收养，不无限累积。
- **降级路径**：FFmpeg 缺 ass_filter → `RENDER_CAPABILITY_MISSING` 明确拒绝；LM Studio 缺席 → 语义审阅不可用提示；旧 job 无 preset → 按 source 解释；导出失败保留旧产物可安全重试。无静默失败。

### 结论

当前阶段无阻塞性许可证或隐私问题；唯一需跟踪项是 FFmpeg GPL 构建的**分发**许可证（Alpha 不分发，故非阻塞）。本审查不改变 Gate 分母（授权 2/20、审阅导出 0/20、配对计时 0/20）。

## 2026-08-11：G4 离线素材矩阵（9 形态确定性渲染全过质量门）

### 目标

推进 G4「固定素材矩阵导出成功率 100%，再扩大矩阵校准 99% 发布门槛」中可自主完成的一半：在真实素材到齐前，用完全离线、程序化生成的合成边缘案例媒体矩阵压测导出管线，把成功率从两条真实样本推广到机器可重复的矩阵。

### 实际改动

- 新增 `packages/render-engine/src/media-matrix.test.ts`（9 条矩阵、一次构建 9 个真实渲染）：基准 CFR H.264/AAC、HEVC(hvc1) 输入、VFR 混合帧率（24/30/15fps 段拼接）、4K 降采样、60fps 降帧、竖幅源 contain 适配、单声道语音轨、96kHz 音频重采样、快速运动内容。每条都走与 daemon 完全相同的持久化渲染路径（plan → 源 hash 复核 → FFmpeg → 质量门 → 原子发布 → Timeline 登记），断言质量 `passed`、时长偏差 ≤40ms、画幅匹配、含音轨、REVISION 推进。
- VFR 条目带防退化断言：ffprobe 帧间隔种类 >1 才算真 VFR；时间线时长一律取容器真实探针时长，不做人工假设。生成用「段拼接 + 重编码 + aresample/apad 音频对齐」，保证流间时长一致。

### 验证（全绿）

- 矩阵自身 9/9 通过；完整基线 `pnpm check`（ffmpeg-full 环境变量）exit 0：15 个构建、**298/298 测试通过**（较 UI 基线 289 净增 9）。

### 纪律与限制

- 矩阵**只收录当前管线明确支持的素材形态**；无声轨视频这类当前明确不支持的形态刻意不进矩阵——它要靠真实素材听审暴露，再按规定变成 fixture/回归，而不是在这里被静默隐藏或提前修补。（旋转元数据竖拍原为同类"留待暴露"项，但经实测确认其会静默 pillarbox 最常见口播形态，已在当日单独立项修复，见「旋转元数据竖拍保真修复」条目。）
- 这是 G4 的离线一半；「固定素材矩阵」的正式分母仍是授权真实项目（当前 2/20；当日稍后补登记 sample_01_screen_recording 后为 3/20，见本文件同日条目），矩阵结果不计入正式 Gate。人工边界听审与真实素材扩充仍待用户。

## 2026-08-11：Studio UI 落地 9:16 preset 选择器（同日 preset 工作的 UI 收尾）

### 目标

补上同日竖屏 preset 条目中遗留的“Studio UI 尚无 preset 选择器”：让走 Studio 审阅的用户（Alpha Gate“20/20 项目可审阅并导出”的用户路径）不离开界面即可在原画幅与 9:16 竖屏之间显式选择，且近似取景限制在 UI 上同样诚实披露。

### 实际改动

- `apps/studio/src/api.ts`：`ExportPreset` 类型（source | vertical-9-16）、`ExportJobResponse` 增加 `preset` 与质量里的 `fitMode/fitModeApproximate`、`createExport` 输入接受可选 preset。
- `ExportControl` 默认态改为两个按钮：「导出成片」（source）与「导出 9:16 竖屏」（title 披露 1080×1920 中心裁切、无人物跟踪）；运行态标签带 preset（如“导出中 N%（9:16 竖屏（近似取景））”）；成功态显示 preset 胶囊标签，且 `fitModeApproximate` 时追加“竖屏为中心裁切近似取景，请目检构图”警示条（`role="note"`）。`App.tsx` 的 `startExport(preset)` 透传选择并对竖屏弹出中文说明；`ReviewHeader` 签名同步。新增 `.export-start-group/.export-preset-tag/.export-approximate-note/.export-vertical` 四个样式。

### 验证（全绿）

- 新增 5 个 UI 测试：审阅中禁用原因、进度展示、成片链接、双 preset 入口与近似披露、运行中/成功竖屏 job 的标签与警示。
- 完整基线 `pnpm check`（ffmpeg-full 环境变量）exit 0：15 个构建全部通过，289/289 测试通过（较同日 preset 基线 284 净增 5）。
- 真实 UI 路由端到端（sample-03 的 `/tmp` 一次性副本，daemon 4402，ffmpeg-full）：REV 9 未审完导出被 `ROUGH_CUT_INCOMPLETE` 拒绝 → keep-remaining REV 10 → UI cookie session 走 `POST /api/exports {preset:"vertical-9-16"}` 真实渲染成功（1080×1920 cover，`fitModeApproximate:true`，probe 复核 h264/1080/1920）；浏览器截图确认成功态页头为“9:16 竖屏（近似取景）”标签 + 打开成片 + 下载 SRT + “竖屏为中心裁切近似取景，请目检构图”警示条；同 REV 再发缺省导出得到 source job（1280×720 contain、无 approximate 标记），页头标签为“原画幅”。验证后 daemon 停止、副本与临时文件已删除，正式 sample-03 未被触碰。
- 本轮不改变正式 Gate 分母（授权 2/20、审阅导出 0/20、配对计时 0/20）。

## 2026-08-11：9:16 竖屏导出 preset 端到端落地（schema → 引擎 → daemon → Agent 双宿主）

### 目标

补齐 P4 交付物“16:9 与 9:16 基础 preset”的 9:16 一半：让 Agent（CLI/MCP）和用户路由都能用同一个 revision 绑定、幂等的导出协议产出 1080×1920 竖屏 MP4，同时对“竖屏是中心裁切近似取景、没有人物跟踪”这一限制保持机器可读的诚实标注。

### 实际改动

- Timeline JSON Schema 的 `renderQuality` 增加可选 `fitMode`（contain/cover）与 `fitModeApproximate`；纯新增可选字段，无迁移，旧报告照旧合法。`RenderReportArtifact.quality` 类型同步。
- render-engine：`buildRenderPlan` 接受 `outputWidth/outputHeight/fitMode` 覆盖（缺省仍是序列画布 + contain，既有导出语义不变）；校验维度为 ≥2 的安全整数，cover 与画布同宽高时抛 `UNSUPPORTED_FIT_MODE`；planHash 的 hashPayload 纳入 `output:{width,height,fitMode}`，因此同一 revision 的 source 与竖屏导出得到不同 planHash 与产物文件名，互不覆盖。`videoFitFilter`：contain 走 scale-decrease+pad 黑边，cover 走 scale-increase+crop 中心裁切。质量报告对 cover 恒带 `fitModeApproximate: true` 并追加中文 warning。
- daemon `POST /api/exports`：body 增加可选 `preset`（source | vertical-9-16，缺省 source）；preset 进入 job payload 参与幂等——同 requestId 同 preset 精确重放，同 requestId 换 preset 返回 `IDEMPOTENCY_CONFLICT`；2026-08-11 之前的旧 job 无 preset 字段按 source 解释；调度与崩溃恢复两条路径都把 preset 的 output 覆盖传入渲染。
- Agent 双宿主：typed client `startExport` 接受可选 preset 并在本地拒绝未知值；CLI 增加 `export start ... [--preset source|vertical-9-16]`；MCP `agentcut_export_start` 的 inputSchema 增加 zod enum preset，未知值在到达 daemon 前被 schema 拒绝。`ExportJobResponse` 增加 `preset` 与质量里的 `fitMode/fitModeApproximate`。

### 验证（全绿）

- 新增 9 个测试：`videoFitFilter` 两种模式的滤镜串；plan 的 cover-同画布拒绝、非法维度拒绝、竖屏 plan 尺寸/warning/hash；workflow 真实 FFmpeg 1080×1920 渲染断言 probe 尺寸、`fitModeApproximate`、与 source plan 的 planHash 不同；daemon 的 preset 透传、重放、冲突、未知 preset 拒绝、旧 job 缺省 source；agent-client 的 preset 发送/缺省省略/本地拒绝；MCP 的 preset 透传与本地 schema 拒绝。
- 完整基线 `pnpm check`（ffmpeg-full 环境变量）：15 个构建全部通过，284/284 测试通过（较上次基线 275 净增 9）。
- 真实端到端（sample-03 的 `/tmp` 一次性副本，排除 alpha-evidence；重签凭据）：未审完先导出被正确拒绝（exit 7 / `ROUGH_CUT_INCOMPLETE`）；keep-remaining 后 REV 9→10；`export start --preset vertical-9-16` 真实渲染成功（job succeeded，durationDelta 13.75ms，18 条字幕 cue，quality 带 `fitMode:"cover"` + `fitModeApproximate:true`）；ffprobe 复核产物确为 1080×1920 h264；抽帧目检：人像充满竖幅画框、左右两侧被裁、底部中文字幕完整烧入；同 requestId 同 preset 重放返回同一 succeeded job，同 requestId 换 preset 返回 `IDEMPOTENCY_CONFLICT`。验证后 daemon 停止、副本与全部临时文件已永久删除；正式 sample-03 保持 REV 9、无 renders 目录，未被触碰。

### 限制与后续

- 9:16 的 cover 只有中心裁切，没有人脸/人物跟踪；对非居中构图的素材会裁掉重要内容——这正是协议强制 `fitModeApproximate` 的原因。构图敏感的竖屏导出目前应由人确认取景，后续需要主体感知取景时再单独立项。
- Studio UI 已有 preset 选择器（见同日「Studio UI 落地 9:16 preset 选择器」条目）；UI 侧仅剩目检构图的人工确认习惯，无待开发项。
- 本轮不改变正式 Gate 分母（授权 2/20、审阅导出 0/20、配对计时 0/20）。

## 2026-08-11：G3 真实 Agent 接管矩阵在隔离副本上完成，真实 Codex 宿主受额度限制

### 目标

推进 P3/G3 的最后缺口：用 delegated handoff session 完成“新 Agent 任务接管同一工程 → 读取全文 → stale conflict → diff 恢复 → 语义分析与建议 → 越权拒绝 → 用户撤销 → 重启后仍拒绝”的完整矩阵，同时不把任何验证写入正式 sample-03。

### 实际执行与结果

- 在 `/tmp` 建立 sample-03 完整隔离副本（删除绑定原路径的 `.agentcut-runtime` 后由 launcher 重新签发凭据），daemon 运行于 4401；正式 sample-03 daemon 运行于 4399，全程 REV 9、7 候选未变，验证后两个 daemon 均已停止、副本目录已永久删除。
- 用 bootstrap 签发 4 能力（project:read、transcript:read、analysis:local、analysis:propose）4 小时 delegated session。handoff CLI 逐字段拒绝 `transcript:write`：该能力从未定义、不属于可授予集合，协议层无歧义。
- CLI 腿（代表新 Agent 任务接管）：status 读到 REV 9；`transcript get` 分页读完全部 243 词；`semantic analyze --base-revision 5` 返回 exit 3 / `REVISION_CONFLICT`（"Project advanced from revision 5 to 9"）；`project diff 7..9` 恢复上下文；`semantic analyze --base-revision 9` 触发本地 LM Studio job，轮询至 succeeded，REV 9→10。
- `semantic propose` 提交 2 条带精确 wordId 证据的发现（43.78s 起 7.02s 长句重说 restatement、74.28s 起结尾“下边这个我再看一下”相邻重复 repetition），daemon 证据门接受其中 1 条，REV 10→11，候选 7→8（pending 4→5，high 2→3）；相同 requestId+payload 精确重放返回同一 REV 11 不重复提交；同 requestId 换 payload 返回 exit 7 / `IDEMPOTENCY_CONFLICT`。
- 越权检查：`rough-cut generate`（CLI）与 `agentcut_rough_cut_generate`（MCP）均返回 exit 5 / tool-level error `CAPABILITY_DENIED`（session 缺 `timeline:write:low_risk_only`），revision 不变。
- MCP 腿：按 Codex 全局配置格式注册 stdio server（handoff 文件注入），initialize + tools/list 恰好 13 个工具，无任何名称含 accept/approve/resolve/confirm/delete/keep 的工具；status 工具返回 REV 11 与 CLI 一致。验证后已从 Codex 配置移除注册。
- 用户面矩阵：UI bootstrap 配对 HttpOnly Cookie → `POST /api/agent-sessions/:id/revoke` 返回 200 → 同一 handoff session 后续请求 exit 5 / `AGENT_SESSION_INVALID reason=revoked` → **完整重启 daemon 后仍按 revoked 拒绝**，工程保持 REV 11。

### 限制与后续

- 真实 Codex 宿主（codex-cli 0.146.0）两次 headless 尝试均因账号用量额度（2026-08-16 恢复）被拒，未能产生“模型自主逐步执行”的证据；以上矩阵由本会话按同一协议逐命令真实执行，语义分析本身经 LM Studio 本地模型真实完成。额度恢复后应按 `/tmp/agentcut-g3-matrix/codex-prompt.md` 同款场景补跑一次真实 Codex 接管（提示词已随副本删除，场景记录在本条日志）。
- 本轮证明协议矩阵在隔离副本端到端成立；G3 是否关闭仍需在一条全新、未审阅且授权的正式素材上由真实 Codex 宿主完成同一矩阵，并由用户处理其高风险建议。
- 没有替用户决定任何正式样本内容；正式 Gate 分母（2/20 授权、0/20 审阅导出、0/20 配对计时）不因本轮变化。

## 2026-08-10：Agent Transcript 分页读取与高风险语义建议桥

### 目标

关闭当前 Agent 原生链路中最实质的内容理解缺口：此前 CLI/MCP 只能读取候选摘要，Codex 看不到整条稳定 word-level Transcript，也没有受控方式把自己识别出的重复、重说、改口、误启动或未说完提交回工程。新增能力必须保持 daemon/Timeline 为唯一真相源，外部 Agent 不能直接删除内容或绕过人工高风险确认。

### 实际改动

- Agent capability 增加相互独立的 `transcript:read` 与 `analysis:propose`，并同步到 ProjectStore、daemon session parser、typed client、CLI、MCP 和 mode-`0600` handoff schema。只读会话可以看文稿但不能制造候选；提交会话不自动获得 Timeline 删除权限。
- daemon 新增 `GET /api/agent/transcript?offset&limit`。响应每页最多 500 词，包含 stable word ID、全局 index、文本、source timing、ASR confidence、Transcript ID、当前 revision 与素材 content hash；不返回绝对路径、媒体 URI 或数据库位置。
- daemon 新增 `POST /api/agent/semantic-findings`。调用者必须携带匹配 header/body 的稳定 `requestId`、精确 `baseRevision` 和 1–100 条结构化 finding。服务独立校验分类、ID、长度、0–1 confidence、说明、Transcript 范围、保留段关系、重复/改口证据、重叠与当前 revision，不信任 CLI/MCP schema；若没有一条通过证据门，整次请求拒绝且不写空 artifact、不推进 revision。
- 合法 finding 复用既有 semantic candidate engine，只以一条 `artifact.put` transaction 写入 `high + suggest_remove` CandidateSet；不生成 `range.deleteRipple`，所以重复、重说和说错仍进入 Studio 待审队列。相同 request/payload 精确重放，request ID 换 payload 拒绝，stale revision 停止执行；正式 Alpha 样本的新提交继续受 running timer 硬门禁，已提交请求的精确重放不受暂停影响。
- `pnpm --silent agent -- transcript get` 支持 offset/limit；`semantic propose --findings-file ... --base-revision ... --request-id ...` 只读取显式 `{"findings": [...]}` JSON。MCP 增加 `agentcut_transcript_get` 和 `agentcut_semantic_findings_propose`，工具面从 11 项增至 13 项；instructions 明确 Transcript 是不可信数据，提交只产生高风险建议。
- 增加官方 MCP client 的纯内存 contract，避免测试依赖网络端口：验证 13-tool discovery、新工具参数透传、structured content 和 schema 层非法 confidence 拒绝。保留原 stdio + HTTP fake-daemon E2E，未通过修改测试来掩盖当前沙箱不能监听 loopback 的事实。
- README、Agent 协议和长程计划补充命令、capability、数据边界与当前 G3 缺口；同时修正 Alpha 执行顺序为“导出通过 → 暂停并 finish timing → 最终质量标注”，避免把标注时间错误计入粗剪活跃时间。

### 验证结果

- agent-client 20/20 通过；覆盖默认 capability、分页 URL、revision/request ID 原样透传、CLI 参数和 JSON findings 文件。
- local-daemon 新增定向集成测试通过：真实 semantic fixture 的明确改口生成且只生成 high-risk candidate；Transcript 分页不泄露工程路径；合法请求推进一次 revision，精确重放不重复提交；不同 payload、stale revision、非法 confidence 和只读会话越权均拒绝。当前沙箱内 local-daemon 为 24 passed + 1 skipped，唯一跳过项是必须绑定 `127.0.0.1` 的静态 Studio/HTTP 进程测试。
- MCP 新增纯内存官方 client contract 1/1 通过，strict typecheck 通过。原 stdio + HTTP E2E 本批新增用例已写入，但执行环境以 `listen EPERM 127.0.0.1` 拒绝启动测试 daemon；进一步申请本机监听又因当前 Codex 使用额度策略拒绝，因此这 10 项未在本轮重跑，标为待验证，不写成通过。
- 已执行默认全仓 `pnpm check`：15 个 production build 和全部 strict typecheck 通过，测试阶段只在上述 MCP loopback suite 停止。随后分组补跑全部非 loopback package、local-daemon 排除单个监听测试及 MCP 内存 contract，合计 270/281 项通过；剩余 11 项均为 loopback 依赖，不是已观察到的代码断言失败。
- 只读打开正式 sample-03 canonical SQLite，确认仍为 `project_p1_real_dogfood` REV 9，Transcript `transcript_0f9916d66ea6215b5ec468d5` 共 243 词，素材 hash 仍为 `sha256:e536a169baaaf1e62462c9b0ce2def85e0a6e18f39359f395af7ad2dadeecf64`，stable word IDs 可直接供新分页协议使用。未写 session、candidate、Timeline、导出或 Alpha 证据。
- Alpha Gate 按预期退出 1、状态 `insufficient_evidence`：授权 2/20、完整审阅导出 0/20、配对计时 0/20、高风险自动删除 0，四类正确性均为 2/2 across 2/2 projects。协议实现没有被误计入内容质量分母。

### 限制与后续

- 当前 `127.0.0.1:4320` 仍是本批修改前已运行的 sample-03 daemon。由于本轮环境既不能连接/监听 loopback，又拒绝新的本机监听授权，没有冒险停止一个无法在当前 turn 恢复的进程；下一次有权限时必须先补跑 10 项 stdio/HTTP MCP E2E 和 1 项 daemon 监听测试，再将 4320 切换到本批最终 build。
- sample-03 只有只读真实性检查，没有把新的语义 finding 写入正式工程；因此其 revision、4 项未决候选和 Alpha 空标签状态不变。下一条全新、未审阅且明确授权的真实口播才适合验证“Codex 分页读全文 → 提交建议 → 用户试听决定 → conflict/revoke/restart”的完整 G3 矩阵。
- 本批解决的是内容理解与安全提案通道，不是语义准确率 Gate。Agent 仍可能漏判或提出被 daemon/用户拒绝的建议；高风险自动删除目标继续为 0。

## 2026-08-10：正式 Alpha 样本从建项起强制计时门禁

### 目标

关闭上一批已确认的证据缺口：普通试用不应被强制计时，但 20 项目正式样本不能依赖执行清单提醒。正式样本必须在建项时可审计地登记，并在未开始、暂停、服务中断或计时完成后由后端拒绝新的初剪修改，避免出现“已经编辑但没有活跃时间”的无效项目。

### 实际改动

- Timeline Schema 新增版本化 `agentcut.alphaTrial` extension reader/creator。`pnpm roughcut -- ... --alpha-trial` 在初始 canonical project document 写入 formal mode 与 `enrolledAt`；同目录续跑时普通/正式模式不一致会以 `PROJECT_TRIAL_CONFLICT` fail closed，不能把已存在的普通工程事后改成正式样本。
- Alpha audit 的 project binding 对正式样本增加 `alphaTrial` 投影；普通工程维持原输出兼容。标记来自 Timeline/SQLite 当前状态，Studio 不维护第二份 enrollment 状态。
- daemon 对正式样本新增 `ALPHA_TRIAL_TIMING_REQUIRED` 硬门禁：生成初剪、语义分析、连续文字删除、候选接受/保留、批量保留、恢复、解除锁、用户审批、Agent 应用批准和新建导出只有 timing state 为 `running` 时才能产生新结果。既有 transaction/job 的精确 request replay 仍可在暂停后返回原结果；读取、试听、计时操作、导出取消和安全/session 管理不受门禁影响。
- 正式样本的 timing finish 进一步要求所有候选已决定，且当前 rough-cut revision 已成功导出并通过质量检查；否则 daemon 以 `ALPHA_TRIAL_NOT_READY_TO_FINISH` 拒绝，Studio 禁用“完成本次计时”并说明剩余条件，避免操作者过早封存后永久无法完成工程。
- Studio 直接从 SWR 的 Alpha audit 响应派生 formal lock，不用 effect 镜像。Alpha 面板明确显示“正式 Alpha 样本”的锁定、运行和封存状态；初剪生成、语义分析、候选决策、手工补删和新建导出在非 running 时禁用，候选导航、原片/剪后试听、恢复计时和凭据/session 安全操作仍可用。
- README 增加正式样本建项命令、不可切换模式、后台暂停重新锁定和完成后封存规则。
- 真实执行 README 约定的 `pnpm roughcut -- <视频>` 时发现 pnpm 会把首个 `--` 保留给脚本；旧解析器因此在建项前报 `Unknown roughcut option --`。CLI 现只接受位置 0 的单个分隔符并继续严格拒绝其他未知选项，新增文档命令形态的回归测试。

### 验证结果

- Timeline Schema 3 个测试文件 19/19、rough-cut workflow 2 个测试文件 8/8、alpha-gate 11 个测试文件 51/51、Studio 14 个测试文件 53/53 通过。
- local-daemon 2 个测试文件 24/24 在允许 loopback 监听的环境通过。新增集成测试证明：正式样本第一次编辑在无计时时拒绝且 revision 不变；原子 begin 后允许提交；内容未完成时 finish 明确拒绝；pause 后新编辑再次拒绝；暂停后重放已提交 request 仍返回同一 revision，不破坏幂等恢复。
- 使用带 libass 的 `ffmpeg-full` 完成修复后的全仓 `pnpm --config.verify-deps-before-run=false check`：15 个 workspace production build、全部 strict typecheck 与 275/275 项测试通过。
- 使用用户提供的 78.8 秒真实口播视频在临时目录执行文档中的正式命令。沙箱内 MLX 因无 Metal 失败后，同一持久化 failed/retryable ASR job 在宿主环境幂等续跑成功，工程得到真实 Transcript、REV 2、`alphaTrial=true`。真实 daemon HTTP 矩阵验证：计时前 generate 返回 423；原子 begin 后两条 timing event 解锁并生成候选到 REV 3；pause 后原 request 精确重放仍返回 REV 3，新 keep 请求再次 423；完整重启后仍为 paused/423。
- 验证结束后停止临时 daemon，并永久删除整个 `/private/tmp/agentcut-formal-trial-real.bxHNkm`，其中包含媒体副本、临时凭据、数据库和验证脚本。用户原始视频、正式 sample-02/sample-03、候选、Timeline、导出和 Alpha 人工证据均未修改；临时项目没有登记进正式 manifest。
- 正式 Alpha Gate 继续按预期以退出码 1 返回 `INSUFFICIENT EVIDENCE`：授权 2/20、审阅并导出 0/20、配对计时 0/20、高风险自动删除 0，四类正确性 2/2 across 2/2 projects。临时验证没有被错误计入质量或提效分母。
- 将正式 `127.0.0.1:4320` sample-03 daemon 切换到本批最终 build；健康接口确认 `project_p1_real_dogfood` 仍为 REV 9。该旧工程没有 formal enrollment，因此没有被追溯锁定或改写。

### 限制与后续

- 该模式只保护从 `--alpha-trial` 新建的后续正式项目，不追认或迁移已有 sample-02/sample-03；二者继续不能计入配对提效分母。
- 计时完成会永久封存初剪写入；daemon 已阻止在内容取舍或当前导出尚未完成时过早结束。若导出后仍需返修，必须在完成计时前继续计时并修改、重新导出。
- 本批只保证证据采集顺序和可审计性，没有增加真实授权项目、人工候选真值、边界听审或成功导出数量；正式 Alpha Gate 仍需按真实证据复核。

## 2026-08-10：Alpha 基线与首次活跃计时原子开始

### 目标

避免 20 项目正式试用因“两步操作”产生无效时间证据：此前用户先录入手工基线、再单独开始 AgentCut 计时，若中间开始内容取舍或首次请求响应丢失，该项目会永久失去配对计时资格或留下重复事件。首次登记必须成为一个可重试、不可半完成的审计动作。

### 实际改动

- `AlphaEvidenceStore` 新增 `beginTiming`，在一个 `BEGIN IMMEDIATE` transaction 内追加 baseline 与 first start。两条 child event 从同一父 request ID 派生、共享 server timestamp；两条精确存在时整体重放，只有一条存在、request ID 换 payload 或既有 timing 状态不兼容时 fail closed。
- eligibility、手工基线、method 和 session ID 在事务内校验；首次人工内容取舍已经发生时整批回滚，不留下可被误认为有效的 baseline。现有 pause/resume/heartbeat/finish、跨 revision 单调延续和 daemon downtime 自动暂停语义不变。
- daemon 新增 `POST /api/alpha-audit/timing/begin`，继续要求 UI session、当前 revision、source hash 和稳定 request ID。旧 baseline/start route 保留给兼容和暂停后 resume，但 Studio 首次流程不再分别调用。
- Studio 的首次按钮改为“登记对照并开始计时”，一次提交 baseline、method 和新 session ID。父 request ID 保存于 React ref，不写 localStorage、不用 effect 镜像；响应不确定时下一次点击仍重试同一意图，成功后才清除。

### 验证结果

- alpha-gate 11 个测试文件 51/51 通过；新增测试验证原子两事件、同 timestamp、精确重放、payload 冲突，以及 timing origin 已关闭时零部分写入。
- local-daemon 2 个测试文件 23/23 通过；真实 HTTP route 首次与重放均只有 baseline/start 两条事件，随后 heartbeat、Timeline edit、跨 revision pause/finish 仍累计为既有 35 秒。
- Studio strict typecheck 与 14 个测试文件 52/52 通过；API contract 覆盖 caller-stable begin request ID，组件文案明确同一事务和第一次人工取舍前门禁。按 React 最佳实践复核，稳定重试身份使用 ref，未增加派生状态 effect 或长期浏览器存储。
- 使用带 libass 的 `ffmpeg-full` 完成全仓 `pnpm --config.verify-deps-before-run=false check`：15 个 workspace production build、全部 strict typecheck 与 268/268 项测试通过。
- 使用正式 sample-03 的审阅前 REV 2 临时副本做真实进程验证：首次 begin 返回 running、baseline 300 秒、两条事件；相同请求重放仍为两条，Timeline revision 始终为 2。完整重启 daemon 后 baseline/start 跨进程恢复，运行态因停机超过阈值诚实变为 paused 且活跃时间仍为 0。
- 验证完成后停止临时 daemon，并删除 `/private/tmp/agentcut-alpha-begin-real.JoAz2o` 整个副本且不可恢复。正式 sample-02/sample-03、候选、Timeline、导出和 Alpha 人工标签均未修改。
- 正式 Alpha Gate 复核仍按预期以退出码 1 返回 `INSUFFICIENT EVIDENCE`：授权 2/20、审阅并导出 0/20、配对计时 0/20、高风险自动删除 0，四类正确性 2/2 across 2/2 projects；临时计时验证未被登记为正式样本。
- 将正式 `127.0.0.1:4320` daemon 切换到本批通过全仓检查的 production build。重启后 sample-03 仍为 REV 9、4 项待审、0 export、0 timing event；`firstHumanDecisionRevision=6`，因此 UI 继续诚实禁止该旧样本事后补计时。

### 限制与后续

- 原子开始只能防止新项目的操作窗口，不能为已发生人工取舍的 sample-02/sample-03 追补时间；这两项仍不能计入配对提效分母。必须从下一条未审阅真实素材开始使用新按钮。
- 当前 UI 仍允许普通非计时试用直接开始审阅，避免把内部 Alpha 采样强加给所有用户；正式试用执行清单必须要求先完成原子开始。后续可增加显式“正式 Alpha 样本模式”并在该模式下对首次编辑做硬门禁。
- 本批没有增加授权项目、候选真值、边界听审或完整导出数量，Alpha Gate 仍必须按实际证据判断。

## 2026-08-10：最小权限 Agent 交接文件与第二宿主接管

### 目标

关闭“另一个 Codex 任务要接管同一工程就必须读取永久 project bootstrap”的缺口：当前任务可签发短期、工程绑定、显式 capability 的 session，并通过私有本地文件交给下一任务或 MCP host；后续宿主不获得扩权能力，读取、拒绝、撤销和重启继续以 SQLite session/access audit 为权威，不复制 Timeline 或工程数据库。

### 实际改动

- 新增 `pnpm --silent agent -- handoff create`。调用者必须提供 client ID、一个或多个显式 capability、稳定 request ID、60–86400 秒 TTL、loopback daemon URL 和输出路径；命令复用现有 `/api/agent/sessions` 幂等签发，不新增 ticket 表或第二套授权真相源。
- 交接文件使用 `credentialType: agent-session` 版本化 schema，包含 loopback daemon origin、公开 session descriptor、access token 与 token SHA-256 指纹。文件先写同目录 mode-`0600` 临时文件并 `fsync`，再用 exclusive hard-link 发布并 `fsync` 目录；父目录必须已存在，符号链接、组/其他用户可读写、远端 URL、篡改元数据和不同内容覆盖均 fail closed。
- CLI stdout 只返回文件路径、project/session/client、capability、到期时间、指纹与 replay 状态，不输出 access token。相同 session 与目标文件可幂等重放；目标已有不同凭据时拒绝覆盖。
- 根 CLI/MCP launcher 现能区分永久 bootstrap 文件和 delegated session 文件。后者直接注入现有 `AgentCutClient` session，并从文件取得 daemon origin，不再次调用 session creation；用 delegated session 再执行 `handoff create` 会以 capability error 拒绝，避免无意复制或扩权。
- MCP server 支持显式 `AgentSessionCredential`。现有 Studio“Agent 会话”面板无需保存交接文件或 token：签发后的 session 自动出现在当前投影中，用户继续使用同一撤销入口；expiry、revocation、allowed/denied audit 和 daemon 重启语义均沿用已有 SQLite 实现。

### 验证结果

- agent-client 17/17 通过；新增测试覆盖 handoff CLI 解析、显式最小 capability、session 创建 payload、stdout 无 token、mode `0600`、loopback 限制、精确重放、拒绝覆盖、宽松权限拒绝和 delegated credential loader。
- 官方 MCP client 9/9 通过；同一测试 daemon 上启动第二个独立 stdio host，只提供 delegated session 文件即可读取工程，且 `/api/agent/sessions` 创建次数不增加，证明后续宿主没有回读 bootstrap。
- 使用带 libass 的 `ffmpeg-full` 完成全仓 `pnpm --config.verify-deps-before-run=false check`：15 个 workspace production build、全部 strict typecheck 与 266/266 项测试通过。
- 对正式 sample-03 签发一条 1 小时、仅 `project:read` 的 `codex-real-handoff` session。新的 CLI 进程只凭临时交接文件读取到 REV 9/4 项待审；尝试 `rough-cut generate` 以 exit 5、`CAPABILITY_DENIED` 拒绝，revision 保持 9。
- 完整重启 daemon 后同一交接 session 仍可读。随后通过配对的 Studio 用户路由撤销，下一请求立即以 `reason=revoked` 拒绝；再次完整重启 daemon 后仍拒绝，证明撤销不是进程内状态。临时 `/private/tmp/agentcut-handoff-real.K0mMeJ` 已删除且不可恢复；正式素材、候选、Timeline 和导出均未改变。
- 正式 Alpha Gate 复核继续按预期以退出码 1 返回 `INSUFFICIENT EVIDENCE`：授权 2/20、审阅并导出 0/20、配对计时 0/20、高风险自动删除 0，四类正确性为 2/2 across 2/2 projects；交接安全证据没有被错误计入内容质量分母。

### 限制与后续

- 交接文件本身是短期 bearer secret，不是可公开分享的项目文件；应通过本机私有路径交接，用完后在 Studio 撤销 session 并删除文件。token 指纹用于识别和防止误覆盖，不是独立签名；真正授权仍由 daemon 中的 token hash/session 状态决定。
- 当前完成了自动第二 MCP host 与本机独立 CLI 进程矩阵，但没有创建一个用户可见的新 Codex 任务，因此 G3 仍未关闭。下一项是用户从另一个真实任务读取交接文件，参与一次 revision conflict/重新读取 diff，并由当前 Studio 撤销后验证拒绝。
- 交接只覆盖当前单工程 loopback daemon；不引入远程传输、云同步或多项目路由。正式 Alpha 内容质量分母不因本批安全协议验证增加。

## 2026-08-10：导出 job 可取消、AbortSignal 收敛与未知响应查询

### 目标

把已有 `cancelRequested` 字段从未接通的底层能力升级为用户与 Agent 都能依赖的导出协议：pending/running job 可安全取消，FFmpeg 与恢复流程会响应取消，成功/取消竞态不删除有效成片，响应中断后可查询唯一 job 得到权威结果；所有状态和审计跨重启恢复且不改 Timeline。

### 实际改动

- ProjectStore 的现有 job 状态机新增可选的稳定取消身份，并以 `job_cancellation_requests` side table 记录 project/job/request ID、请求者、观察到的状态、是否真正改变状态和时间。相同 request 重放不追加事件，request ID 换 job/actor 拒绝；对 succeeded/failed/cancelled/outcome_unknown 的新取消意图记录 `changed=false`，不反向改写终态。
- render workflow 在规划、源哈希校验、FFmpeg 前后、质量检查和原子发布前检查 `cancelRequested`/AbortSignal。取消异常统一收敛为 `cancelled`，清理 `.work-*`，不提交 output asset/caption/renderReport；恢复 interrupted job 时也先服从已持久化取消，避免 daemon 重启把 cancelled 意图误判成 `outcome_unknown`。
- daemon 为每个运行/恢复中的 export job 维护进程内 AbortController。`POST /api/exports/:jobId/cancel` 及 `/api/agent/exports/:jobId/cancel` 先持久化取消，再 abort runner；runner 即使忽略 signal，settle 后 daemon 仍检查并收敛。pending 直接 cancelled，running 返回 202 + `cancelRequested=true`，成功竞态返回原 succeeded；Agent route 要求 `export:write` 并保留 access audit。
- export projection 新增 `cancelRequested` 与 `canCancel`。`GET /api/exports/:jobId`/Agent get 继续作为开始或取消响应丢失后的唯一权威查询：cancelled 不会在重启后回到 running，只有未请求取消且无法收养 verified MP4/SRT 的 interrupted job 才进入 outcome_unknown。
- typed client/JSON CLI 新增 `export cancel JOB_ID --request-id ID`，保持 stdout 单文档与结构化错误；MCP 增至 11 tools，新增 destructive-but-idempotent `agentcut_export_cancel`。Studio 导出进行态新增取消按钮、取消中门禁与 750 ms 状态轮询；不确定网络失败时 request ID 保存在 React ref，重复点击仍是同一取消意图。

### 验证结果

- ProjectStore 18/18 通过；原 job cancellation 测试扩展到 pending/running/terminal、稳定重放、ID 冲突、changed=false、关闭重开和 revision 0。render-engine 4 个测试文件 16/16 通过；新增预先 abort、取消异常收敛、无产物/无 Timeline edit，以及重启恢复时清理 work directory 并保持 cancelled。
- local-daemon 2 个测试文件 23/23 通过；真实异步 runner 测试从 Agent `export:write` route 发起取消，验证 AbortSignal、202 → cancelled、同 request 重放、Agent access audit、job cancellation audit、无 renderReport 和 revision 不变；另覆盖 succeeded 后取消的 `changed=false` 竞态与 outcome_unknown GET 字段。
- daemon 重启扫描新增持久化取消优先级：running job 已有 `cancelRequested` 时不再先尝试按旧 renderReport 登记成功，而是进入恢复收敛并成为 cancelled；回归测试覆盖跨重启后 `cancelRequested=true` 且不落入 outcome_unknown。
- agent-client 15/15、Studio 14 个测试文件 52/52、官方 MCP client 8/8 通过。CLI 保留调用者 request ID，MCP discovery 为 11 tools；Studio API/组件覆盖 URL 编码、same-origin Cookie、取消按钮和取消中重复门禁。
- 使用带 libass 的 `ffmpeg-full` 完成全仓 `pnpm --config.verify-deps-before-run=false check`：15 个 workspace production build、全部 strict typecheck 与 263/263 项测试通过。首次定向测试仅因受限沙箱禁止绑定 `127.0.0.1` 而超时；授予本机临时端口监听后同一测试 23/23 通过。
- 在正式 sample-03 的临时完整副本上做真实 FFmpeg 测试：副本 REV 9 将剩余候选暂时保留后成为 REV 10/rough_cut_ready，创建 export 返回 202，running 时取消返回 202，随后权威 GET 为 cancelled；SQLite 恰有一条 `changed=1` 取消审计，无 MP4/SRT、无 renderReport。完整重启临时 daemon 后仍为 cancelled/`canCancel=false`，没有变成 running 或 outcome_unknown。
- 测试完成后停止临时 daemon 并删除 `/private/tmp/agentcut-export-cancel-real.Vm9yCB` 整个副本。正式 sample-03 没有执行保留、导出或取消，仍保持 REV 9 与四项人工待审。
- 将 `127.0.0.1:4320` 正式 sample-03 daemon 切换到本批通过全仓检查的 production build；重启后只读投影仍为 project REV 9、`reviewing`、四项人工待审，UI credential 保持 generation 1，未新增正式 export/cancel 记录。
- 正式 Alpha Gate 复核按预期以退出码 1 返回 `INSUFFICIENT EVIDENCE`：授权 2/20、审阅并导出 0/20、配对计时 0/20、高风险自动删除 0；undo/restart/idempotency/revisionConflict 均为 2/2 across 2/2 projects。导出取消的协议与真实运行验证没有被错误计入内容质量分母。

### 限制与后续

- FFmpeg 取消是尽力尽快，不承诺收到 HTTP 请求后瞬时停止；协议先持久化取消意图，再等待进程安全退出。已进入 succeeded 的结果不会因晚到取消而删除。
- 如果进程在文件原子发布后、Timeline 登记前中断且此前没有持久化取消，请求仍按 verified adoption/outcome_unknown 规则处理；取消不被用来静默删除无法证明来源的已发布文件。
- Studio 自动化视觉检查仍受应用内浏览器 localhost 策略限制；本批有静态组件、HTTP、真实 FFmpeg 和重启证据，但按钮外观需用户手动刷新查看。
- 本批不增加正式 Alpha 内容质量分母。下一项 G3 工作是另一个真实 Codex 任务用最小 capability session 接管同一工程，并形成跨 host contract matrix。

## 2026-08-10：UI bootstrap 原子轮换、旧 Cookie 失效与崩溃补审计

### 目标

关闭 Studio 浏览器授权仍依赖永久 bootstrap 的缺口：本地用户可轮换密钥并立即退出其他浏览器；当前浏览器不中断，旧 Cookie 不再被接受；文件发布与 SQLite 审计之间即使中断也能恢复，且整个过程不改 Timeline 或暗中撤销 Agent session。

### 实际改动

- `.agentcut-runtime/ui-access.json` 从初始 `0.1.0` 凭据兼容升级为可轮换 `0.2.0` 文档。轮换保留 `createdAt`，新增单调 generation、当前 bootstrap SHA-256 fingerprint 和不含旧 secret 的 `lastRotation`（request ID、前后 fingerprint、代次、时间）。读取时重新计算 fingerprint 并校验工程根目录、代次和恢复标记，元数据被篡改时 fail-closed。
- 新凭据先写同目录 mode-0600 临时文件，完成 file `fsync` 后原子 rename、重新确认权限并 `fsync` 目录；旧 bootstrap 不写 SQLite、日志、响应或历史字段。相同 request ID 读取已发布标记并幂等返回，不生成第二个 secret。
- 正式 launcher 不再把 UI bootstrap 固化在 daemon 环境变量中，而是传入 `AGENTCUT_UI_CREDENTIAL_PATH`。daemon 配对和 Cookie 校验读取当前文件密钥；轮换一经发布，其他浏览器的旧 HMAC Cookie 立即失效，不存在“文件已是新密钥但运行中 daemon 仍接受旧密钥”的长期双窗口。测试仍可显式传静态 bootstrap，但该模式拒绝轮换。
- 新增受现有 UI session 保护的 `POST /api/ui/bootstrap/rotate`。请求发布新凭据后直接给发起浏览器签发同源 `HttpOnly; SameSite=Strict` 新 Cookie，JSON 只返回 generation、时间和 replay 状态。读取 request body 后会再次校验 Cookie，避免两个并发旧会话先后轮换不同代。
- ProjectStore 新增 `ui_credential_rotations` side table，按 request ID 幂等记录工程、前后 fingerprint、generation、执行者和时间，不推进 Timeline revision。若在 credential 原子发布后、SQLite 写入前中断，文件中的 `lastRotation` 会在下一请求或 daemon 重启时补记；request ID 换 payload 或旧 request 对不上当前代时拒绝。
- Studio 新增“Studio 浏览器授权”折叠面板，展示当前代次，并以“轮换并退出其他浏览器”明确动作影响。请求 ID 在 React ref 中跨不确定失败保留，成功后当前 session 更新为新代；没有 localStorage、effect 派生状态或 bootstrap 投影。

### 验证结果

- credential 文件测试覆盖原子替换、mode `0600`、旧 secret 不进入文档历史、相同 request 重放，以及 publish 后故障仍留下可恢复 canonical marker。
- ProjectStore 18/18 通过；新增轮换审计首次写入、重放、request ID 冲突、关闭重开和全过程 revision 0 验证。
- local-daemon 2 个测试文件 22/22 通过；覆盖旧/新 Cookie、响应无 bootstrap、同 request 重放、generation、静态凭据拒绝轮换、publish 后崩溃与 `createAgentCutServer` 重启补审计。Studio strict typecheck 与 13 个测试文件 49/49 通过；新增 API 稳定 request ID 和授权面板文案/忙碌门禁检查。
- 使用带 libass 的 `ffmpeg-full` 完成全仓 `pnpm --config.verify-deps-before-run=false check`：15 个 workspace production build、全部 strict typecheck 与 255/255 项测试通过。
- 使用最新 production build 对正式 sample-03 执行一次真实轮换：generation 0 → 1，首次返回 201，旧 Cookie 立即变为 unauthenticated，新 Cookie 有效，同 request 重放返回 200/`idempotentReplay=true`，SQLite 只有一条 generation 1 审计；轮换前后 Timeline revision 均为 9。
- 将新 Cookie 暂存为 mode-0600 临时文件后完整停止并重启 file-backed daemon；同一 Cookie 仍认证为 generation 1，轮换审计保持一条、工程 revision 仍为 9。验证完成已删除临时 Cookie 文件，最新 Studio 继续在 `127.0.0.1:4320` 运行。
- 正式 Alpha Gate 复核仍按预期以退出码 1 返回 `INSUFFICIENT EVIDENCE`：授权 2/20、审阅导出 0/20、配对计时 0/20、高风险自动删除 0，四类正确性 2/2 across 2/2 projects；安全凭据轮换没有被错误折算为内容质量证据。

### 限制与后续

- 轮换只失效 Studio 浏览器 Cookie，现有 Agent capability sessions 按显式产品边界继续有效；用户可在相邻“Agent 会话”面板单独撤销。两类授权不做隐式联动，避免密钥维护暗中中断正在运行的 Agent job。
- 同一 macOS 账号下能读取 mode-0600 credential 的恶意进程仍可重新配对；当前方案不是 OS sandbox。没有把 `fsync + rename` 的故障注入描述成真实拔电证明。
- 文件只需保留最后一条恢复标记；正常下一次配对/轮换前 daemon 会先幂等同步它。若用户绕过唯一 daemon 直接并发改 credential 文件，不属于受支持写路径。
- 应用内浏览器 localhost 策略仍阻止自动 DOM/截图视觉验收；本批有组件渲染、HTTP 和真实重启证据，但授权面板外观仍需用户手动刷新检查。
- 本批不增加 Alpha 内容质量样本。下一项协议缺口是导出 job cancel、断线后的 outcome 查询，以及另一个真实 Codex 任务用最小 capability 接管同一工程。

## 2026-08-10：Studio 独立浏览器配对、HttpOnly 写入会话与访问审计

### 目标

关闭“任何能访问 loopback daemon 的进程都能直接调用 Studio 用户写 route”这一边界：浏览器必须持有与 Agent bootstrap 分离的用户会话，才可删除文字、决定候选、解决 approval、标注 Alpha、创建导出或撤销 Agent session；正式 Agent route 继续只接受 capability token。

### 实际改动

- 启动器为每个工程新增 `.agentcut-runtime/ui-access.json`，沿用目录 `0700`、文件 `0600`，与 `agent-access.json` 使用不同的 32-byte bootstrap。local-daemon CLI 缺少 `AGENTCUT_UI_BOOTSTRAP_TOKEN` 时拒绝启动写入服务，不静默降级为无鉴权模式。
- `pnpm studio` 打印带 `#ui-bootstrap=…` fragment 的本地配对 URL。fragment 不会随 HTTP 请求发送；Studio 读取后立即用 `history.replaceState` 清理地址栏，调用 `/api/ui/session` 换取 7 天有效、项目绑定、带随机 nonce 与 HMAC 的 `HttpOnly; SameSite=Strict` cookie，长期 secret 不写入 localStorage。
- daemon 对所有非 Agent 的 POST 写 route 统一执行 UI session 校验；缺失、伪造和过期 cookie 分别 fail-closed。`/api/agent/*` 仍先经过 capability authorization，映射后的正式 Agent 写入不会要求或接受 UI cookie 代替自身权限。
- ProjectStore 新增 `ui_access_events` side table，持久记录 paired/allowed/missing/invalid/expired、method/path 与时间；不保存 cookie、bootstrap 或请求正文，也不推进 Timeline revision。
- Studio 根组件先检查 cookie；未配对时展示独立本地授权门，可粘贴完整配对链接或授权码。配对输入使用 password 控件且只存在 React 内存；写操作遇到 session 缺失/过期时自动退回授权门，不在失效状态继续显示可操作工作区。
- CORS 在配置显式开发 origin 时增加 credentials 支持；正常 production Studio/API 仍使用同源 127.0.0.1。UI pairing/API contract、fragment 解析和授权门都有独立测试。

### 验证结果

- ProjectStore strict typecheck 与 17/17 测试通过；新增测试验证 UI paired/denied audit 跨关闭重开恢复且 Timeline revision 始终为 0。
- local-daemon strict typecheck 与 18/18 测试通过；新增集成场景覆盖无 cookie 写拒绝、错误 bootstrap、Agent 映射写不依赖 UI cookie、正确配对、响应不回传 bootstrap、HttpOnly/SameSite、签名篡改、7 天过期、五类访问审计和 revision 只由真实编辑推进。
- Studio strict typecheck、production build 与 12 个测试文件 46/46 项通过；新增测试覆盖 session 查询/配对请求不把 secret 放进 JSON、fragment 严格解析、password 授权门和三种加载状态。按 React 最佳实践复核，外部浏览器状态只在根组件 effect 同步一次，没有 localStorage、重复 listener 或派生状态 effect。
- 使用带 libass 的 `ffmpeg-full` 完成全仓 `pnpm --config.verify-deps-before-run=false check`：15 个 workspace production build、全部 strict typecheck 与 247/247 项测试通过。首次沙箱运行仅因 MCP 集成测试不允许绑定 loopback 端口中止；在允许本机监听后原命令完整通过，且显式关闭 pnpm 的运行前依赖重装检查。
- 对正在运行的 sample-03 做真实进程验证：无 cookie 的 Studio 写请求返回 401/`UI_SESSION_REQUIRED`；配对后 Cookie 可读取会话并撤销一条只含 `project:read` 的测试 Agent session，该 token 随即以 `reason=revoked` 被拒绝，工程 revision 保持 9。
- 完整停止并重新启动 daemon 后，保存在权限 `0600` 临时文件中的同一 HttpOnly Cookie 仍通过 `/api/ui/session`，`/api/review` 返回 revision 9、`roughCutStatus=reviewing`，刚撤销的 session 仍带 `revokedAt`。验证结束已删除临时 Cookie 文件；没有修改候选判断、Alpha 标签或 Timeline。
- 直接对已通过构建的 Gate 运行正式审计，仍按设计以退出码 1 返回 `INSUFFICIENT EVIDENCE`：授权 2/20、审阅导出 0/20、配对计时 0/20、高风险自动删除 0，四类正确性保持 2/2 across 2/2 projects；没有把本批安全验证计入内容质量分母。

### 限制与后续

- 浏览器 cookie 能阻止未配对的普通 loopback 请求冒充 Studio，但同一账号下能读取工程 `.agentcut-runtime/ui-access.json` 的恶意进程仍可重新配对；这不是 OS sandbox。
- UI bootstrap 尚无产品化轮换，浏览器 session 也没有显式“退出所有 Studio”入口。下一批轮换必须同时失效旧 cookie、避免 daemon/file 双密钥窗口，并决定是否联动撤销 Agent sessions。
- 配对 URL 含 secret fragment，只应保留在本机启动终端；虽然 fragment 会被页面立即清理，终端日志本身仍应按本地凭据处理。
- 应用内浏览器的 localhost URL 策略拒绝了现有 4320 标签页的自动刷新和 DOM/截图接管；因此本批确认了真实 HTTP、Cookie 与跨重启语义，但没有把组件测试冒充为浏览器视觉验收。用户仍需在现有标签页手动刷新或使用启动器打印的配对链接检查授权门和工作区外观。
- 验证重启时 `pnpm` 提示整仓移除并重装 `node_modules`，为保护现有工作树已拒绝；随后直接启动刚通过 `pnpm check` 的 production daemon 完成跨重启验证，未改动依赖目录。
- 本批不增加 Alpha 内容质量证据；20 项目候选、边界、导出和配对时间 Gate 仍需真实用户素材与人工判断。

## 2026-08-10：Agent capability session 可查看、可撤销与跨重启拒绝

### 目标

把工程绑定的 Agent session 从“签发后只能等待过期”推进到用户可管理的本地安全边界：Studio 能看见谁接入、使用了哪些能力和访问结果，并能立即撤销；撤销不改 Timeline、不可由 Agent 自行执行，且 daemon 重启后不能恢复权限。

### 实际改动

- ProjectStore 新增 `agent_session_revocations` append-only side table，以及 `listAgentSessions`、`revokeAgentSession`、`listAgentSessionRevocations`。每次撤销记录 project/session/request hash、执行者、是否真正改变状态和时间；`revoked_at` 更新与 lifecycle event 在同一 SQLite transaction 内完成。
- 撤销采用调用者 request ID 幂等：相同 payload 重放返回同一状态，不同 payload 复用 ID 拒绝；已经撤销的 session 再收到新请求会追加 `changed=false` 的审计事件，不会改写首次撤销时间。全部 side-table 写入保持 Timeline revision 不变。
- daemon 的 `/api/review` 新增不含 token/token hash 的 `agentSessions` 投影，只返回 client、能力、创建/到期/撤销时间和允许/拒绝访问计数；本地用户 route `POST /api/agent-sessions/:id/revoke` 执行撤销。CLI/MCP 不增加 list/revoke 工具，Agent 无法用正式协议撤销竞争 session 或清理审计。
- 被撤销 token 的后续能力请求继续经过统一 authorization，返回 `reason=revoked` 并追加 denied access event；不存在的撤销目标使用独立 404 语义，不与无效 Bearer token 的 401 混淆。
- Studio 编辑助手新增折叠的“Agent 会话”面板，区分有效、过期、已撤销状态，展示能力数和允许/拒绝计数；只有有效 session 可点击撤销。界面不保存第二份 session 状态，操作后直接用 daemon 返回的 `/api/review` 投影更新。

### 验证结果

- ProjectStore 16/16 测试通过；新增测试覆盖撤销、相同请求重放、request ID 换目标拒绝、已撤销再请求的 `changed=false` 事件、关闭重开、`reason=revoked` access audit 和全过程 revision 0 不变。
- local-daemon 17/17 测试通过；能力 session 集成测试新增元数据投影、无 token 泄漏、撤销/重放、撤销后请求拒绝、缺失目标和 revision 不变。静态 Studio/API 同进程测试在授予本机监听权限后通过。
- Studio strict typecheck、production build 与 11 个测试文件 43/43 项通过；新增 API contract 和会话面板测试覆盖 URL 编码、无凭据请求体、三种状态、忙碌门禁和无 token/token hash 文本。
- 按 React 最佳实践复核：状态从 SWR 的 daemon projection 派生，未增加 effect 镜像、全局 listener 或客户端 session 缓存；日期 formatter 提升到模块级，避免列表渲染重复构造。
- 使用带 libass 的 `ffmpeg-full` 完成全仓 `pnpm check`：15 个 workspace production build、全部 strict typecheck 与 242/242 项测试通过。
- 以最新 build 在 `127.0.0.1:4320` 对 sample-03 创建一条仅含 `project:read` 的 `codex-revoke-gate` 测试 session：创建后 revision 仍为 9，Studio projection 不含 token，撤销后同一 token 返回 401/`reason=revoked`。再次完整重启 daemon 后，旧 token 仍被拒绝、session 仍显示 revoked，工程保持 revision 9、4 个待审、0 approval、0 export；未改变内容或 Alpha 标签。
- 正式 `pnpm alpha:gate` 仍按预期以退出码 1 返回 `INSUFFICIENT EVIDENCE`：授权 2/20、审阅导出 0/20、配对计时 0/20、precision/边界可用率/时间降幅未测得；高风险自动删除仍为 0，四类正确性仍为 2/2 across 2/2 projects。本批 session 证据没有被折算为 Alpha 内容质量证据。

### 限制与后续

- 该批完成时撤销入口仍属于“本机用户面即可信”的 UI route；上方后续批次已补齐独立 UI session/cookie 鉴权，但同一账号下可读取 UI bootstrap 的恶意进程仍不在防护范围。
- bootstrap credential 仍缺少轮换流程；轮换时还需定义已有 session 是全部撤销还是保持到期，并验证 launcher/daemon 重启不会出现双密钥窗口。
- 本批有 production build、组件/API 测试和真实 4320 状态验证，但应用内浏览器的 localhost 接管策略此前已拒绝自动 DOM/截图检查；没有把静态渲染测试当作视觉验收。用户需在现有 4320 标签页手动刷新查看折叠面板。
- 本批只推进 G3 安全与可审计性，不增加 Alpha 候选人工标签、边界试听、真实导出或配对计时样本；正式 20 项目 Gate 必须继续按独立证据判定。

## 2026-08-10：高风险内容 approval 的持久化、Studio 决策与 Agent 应用闭环

### 目标

为“Agent 提出精确高风险删除意图 → 用户决定 → 新 Agent session 只能应用原 payload”建立持久化基础，避免把现有 `confirmHighRisk: true` 布尔值包装成可伪造的批准令牌。

### 实际改动

- ProjectStore 新增 `approvals` side table 与 `ProjectApproval` 状态机：`pending → approved|denied`，批准后可一次性进入 `consumed`。记录绑定 project、requesting session、candidate target、base revision、payload SHA-256、过期时间、用户 resolution 和最终 transaction；创建、解决与消费都支持稳定重放并拒绝 request ID 换 payload。
- capability 集合预留 `approval:request` 与 `timeline:write:approved`；批准 token 仍只保存 SHA-256。approval side table 与 Agent session/access audit 一样不推进 Timeline revision。
- candidate engine 新增高风险候选 acceptance payload hash：哈希覆盖 project ID、精确 revision、candidate set/transcript/sequence 和完整 candidate 定义；revision 或候选证据变化都会产生不同 hash，非 high-risk 候选拒绝申请该类 approval。
- daemon 新增受能力会话保护的 approval request/get/apply route，以及仅供当前本地用户面的 resolve route。UI review projection 不返回 token；只有已批准、未过期、未 stale 的 Agent get 会得到 HMAC 派生 token。apply 同时校验 token、revision 和重算 payload，并用固定 transaction ID 提交为 `local_user` 已决定内容；崩溃窗口或重复调用不会产生第二次删除，随后将 approval 标为 consumed。
- Studio 在当前候选检查器展示 Agent 请求的精确 revision 绑定，用户可批准或拒绝；批准后明确显示“等待 Agent 应用”，不会由 UI 暗中代替 Agent 提交。普通 high-risk 手工审阅仍保留原试听+checkbox 路径。
- typed SDK/CLI 增加 approval request/get/apply；MCP 增至 10 个工具，只暴露申请、查询和精确应用，明确没有 resolve tool。新增 `approval:request` 与 `timeline:write:approved` 会话能力，后者不能绕过 token/payload/revision 校验。

### 验证结果

- `@agentcut/project-store` strict typecheck 与 15/15 测试通过；新增测试覆盖 approval 创建/重放、request payload 漂移拒绝、用户批准、错误 token 拒绝、一次性消费、重复消费幂等、重启持久化，以及全过程 Timeline revision 不变。
- `@agentcut/candidate-engine` strict typecheck 与 15/15 测试通过；新增测试验证 payload hash 确定性、revision 绑定、候选证据绑定和非 high-risk 拒绝。
- `@agentcut/local-daemon` strict typecheck 与 17/17 测试通过；完整测试覆盖 Agent 申请、UI 投影无 token、用户批准、不同 capability session 读取并应用、错误 token 拒绝、deny/expiry/stale fail-closed，以及最终 transaction 以用户批准语义记录。
- 新增精确故障注入覆盖“Timeline commit 已成功、consume approval 前进程崩溃”：首次调用保留 revision 1 与 `approved`，另一 session 用同一批准重试时识别固定 transaction、只收敛为 `consumed`，不会产生 revision 2 或第二次删除。
- 该故障分支测试暴露出 UI resolve route 曾用系统时钟重开 ProjectStore、与 daemon 注入时钟不一致；现统一经同一 store factory 注入时钟，过期 approval 在 Agent get 与用户 resolve 两条路径都拒绝。
- Studio strict typecheck 与 40/40 测试通过；组件测试覆盖待批准卡片、无 token 泄漏、直接删除旁路禁用，API 测试覆盖用户 resolve route。按 React 最佳实践专项复核，当前改动没有新增 effect 派生状态、重复全局监听或重型同步渲染。
- agent-client 14/14、官方 MCP stdio E2E 7/7 通过；MCP contract 验证 10-tool 精确列表、request/get/apply envelope 与不存在 resolve 工具。
- 使用带 libass 的 `ffmpeg-full` 完成全仓 `pnpm check`：15 个 workspace production build、全部 strict typecheck 与 238/238 项测试通过。默认沙箱运行曾在 MCP 测试监听本地随机端口时得到 `EPERM`；授予仅本机测试权限后的完整重跑通过，未把跳过的 7 项记作成功。
- 最新 Studio 已在 `127.0.0.1:4320` 重启；sample-03 只读 status 返回 revision 9、7 个候选、4 个待审、3 个已删除、0 approval、0 export，并显示新增六项 session capability。无效 token 仍被 `AGENT_SESSION_NOT_FOUND` 拒绝；没有在真实 high-risk 候选上创建或消费批准，因此 Timeline 与人工判断均未改变。
- 在 `/private/tmp` 创建不含用户媒体的最小工程副本，将 fixture 候选改为 high-risk 后，用四个独立 CLI 进程完成 request、get、apply 与重启后 status：申请 session 与取 token/应用 session 不同，Timeline 只从 revision 0 前进到 1；daemon 重启后 revision 1、1 个 committed delete 和 `consumed` approval 均保持，查询不再返回 token。该副本仅为协议验证，不进入 Alpha cohort，验证后已删除。
- 应用内浏览器的 localhost URL 策略拒绝接管并刷新现有 4320 标签页，因此本批没有把“构建成功/组件测试通过”冒充为真实视觉验收；用户仍需在现有标签页手动刷新查看。正式 Alpha Gate 仍为 `INSUFFICIENT EVIDENCE`：2/20 授权、0/20 审阅导出、0/20 配对计时，高风险自动删除 0。

### 限制与后续

- approval 产品与跨进程协议闭环已落地，但当前运行中的 sample-03 尚未用高风险内容实际走一遍该路径；为避免替用户作内容决定，不能直接消费 sample-03 的待审候选。
- 当前 UI resolve route 仍依赖“本机用户面即可信”的边界，尚无独立 UI session 鉴权；session revoke/轮换、另一个真实 Codex 任务接管、跨宿主 contract matrix 及 job cancel/未知导出结果恢复仍未完成，因此 G3 不能关闭。

## 2026-08-10：工程绑定的 Agent 能力会话、访问审计与 revision diff

### 目标

把 CLI/MCP 从“只靠工具命名约束安全边界”推进到 daemon 强制执行的工程级能力会话；让 Agent 在 revision conflict 后能读取最小化 diff 恢复上下文，同时继续禁止它冒充用户批准高风险内容。

### 实际改动

- `@agentcut/project-store` 在同一工程 SQLite 中新增 `agent_sessions` 与只追加的 `agent_access_events` side table。会话绑定 project/client/capability/过期时间，access token 只以 SHA-256 保存；创建支持 `requestId + payload hash` 幂等重放，重复 ID 换 payload 或换 credential key 会拒绝。允许、未知 token、过期和 capability denied 均写审计，但这些运维记录不改变 Timeline revision。
- local daemon 新增 `POST /api/agent/sessions` 与受 Bearer session 保护的 `/api/agent/*` 路由。当前四项 capability 为 `project:read`、`analysis:local`、`timeline:write:low_risk_only`、`export:write`；没有 accept/keep/manual delete/high-risk confirm 映射。CORS 明确允许 `Authorization` 与 `X-AgentCut-Request-Id`，写调用的 request ID 同时进入 access audit。
- 新增 `GET /api/agent/project/diff?fromRevision=N[&toRevision=M]`。返回有界 command 摘要、actor、operation types、受影响 object IDs、before/after hash 与提交时间，不返回逐词 Transcript、媒体路径或任意项目 JSON；非法区间拒绝。
- Studio launcher 为工程创建 `.agentcut-runtime/agent-access.json`，目录 mode `0700`、文件 mode `0600`，只显示文件路径。CLI/MCP launcher 从 `AGENTCUT_PROJECT_ROOT`、`AGENTCUT_AGENT_CREDENTIALS` 或显式 bootstrap 环境变量读取 secret；缺失或格式错误时 fail closed。daemon 用工程 bootstrap secret 确定性派生限时 session token，凭据文件已在现有 `.agentcut/` 忽略范围内。
- `@agentcut/agent-client` 改为先建立/复用 capability session，再访问受保护 route；CLI 新增 `project diff --from-revision ... [--to-revision ...]`，缺凭据/session/capability 映射 exit code 5。MCP 增加 `agentcut_project_diff`，总工具数变为 7，并在 server instructions 中要求冲突后先读 diff 和最新 status。
- README、Agent 协议与 P3 长程计划同步说明凭据配置、能力集合、访问审计和威胁边界；明确能力会话尚不是 approval token，也不是对同一账号下恶意本地进程的系统级沙箱。

### 验证结果

- `@agentcut/project-store` build/typecheck 与 14/14 测试通过；覆盖持久化幂等 session、未知/过期/权限不足审计、request ID 复用和 credential key 变化拒绝。
- `@agentcut/local-daemon` typecheck 与 15/15 测试通过；真实临时 SQLite 验证会话创建/重放、授权 status、拒绝未授权 semantic、允许低风险初剪、revision diff、Agent 高风险路由不存在，以及 access event 不推进 Timeline revision。
- `@agentcut/agent-client` typecheck 与 13/13 测试通过；覆盖 bootstrap 换 session、受保护 route、Authorization/request ID header、差异查询和缺凭据 fail-closed。
- `@agentcut/mcp-server` build/typecheck 与 6/6 官方 client stdio E2E 通过；fixture 强制 bootstrap/session Bearer，验证精确 7-tool 列表、project diff、低风险写入与结构化 revision conflict，且仍不存在 accept/approve/confirm/delete/keep 工具。
- 独立临时目录实测 credential 创建和幂等加载：重复调用得到同一 43-byte base64url token，运行目录权限为 `0700`、JSON 文件为 `0600`；测试目录随后已删除。
- 使用 `ffmpeg-full` 完成全仓 `pnpm check`：15 个 workspace production build、全部 strict typecheck 与 230/230 项测试通过；包括 agent-client 13/13、MCP 6/6、project-store 14/14、daemon 15/15、Studio 38/38、render-engine 14/14、alpha-gate 49/49。
- 以新版本在 `127.0.0.1:4320` 重启 sample-03：CLI 通过工程 credential 建立 session 后只读返回 revision 9、7 个候选、4 个未决、3 个已删除、Preview 67.60375 秒、0 个导出；`project diff 7..9` 只返回两笔 transaction 摘要。ProjectStore 复核得到 2 个 session、2 条 allowed access event，Timeline 仍为 revision 9。
- 正式 `pnpm alpha:gate` 仍按预期以退出码 1 返回 `INSUFFICIENT EVIDENCE`：授权 2/20、审阅导出 0/20、配对计时 0/20、precision/边界可用率/时间降幅未测得；高风险自动删除为 0，四类正确性为 2/2 across 2/2 projects。能力会话与 diff 没有被折算为人工 Gate 证据。

### 限制与后续

- 这一批完成的是 per-project capability session，不是内容 approval。session bootstrap credential 由同一用户本地持有；现有 Studio 用户 API 尚未统一加 UI session 鉴权，因此不能宣称能抵御同账号恶意进程或关闭 P3/G3。
- session 暂无 revoke API/Studio 管理界面，bootstrap secret 没有轮换流程；access audit 也尚未在 UI 展示。下一批应做 revision + payload hash 绑定的 approval request/resolve/token，随后验证另一个 Codex 任务按最新 revision 接管。
- 本批不制造 Alpha 人工标签、真实导出或计时样本；正式 Gate 仍必须由授权项目的人工审阅与导出证据推进。

## 2026-08-10：首批 MCP stdio server 与受控 Agent 工具面

### 目标

让支持 MCP 的 Codex/外部 Agent 能通过标准 stdio 协议连接 AgentCut，而不是依赖 shell 拼接 CLI；同时把“可推进低风险工作流”和“不得冒充用户完成高风险内容判断”的边界固化在工具注册层。

### 实际改动

- 新增 `@agentcut/mcp-server`，基于 `@modelcontextprotocol/server` 2.0.0 与 Zod 4.4.3，使用 `McpServer + serveStdio` 连接既有 `@agentcut/agent-client`，daemon 继续是唯一写入者。
- 注册 6 个稳定工具：project status、candidate list、rough-cut generate、semantic analyze、export start/get。只读工具返回紧凑、隐私最小化投影；三个写工具全部要求调用者显式提供非负 `baseRevision` 与稳定 `requestId`。
- 成功结果使用 `status`、`candidates` 或 `export` structured-content envelope；daemon 的 status/code/message/details 原样进入 tool-level `error`，revision conflict 不被吞掉或自动重放。
- 工具面没有 candidate accept/keep、连续文字 delete 或 high-risk confirm；MCP instructions 还明确要求写前读取 status、仅为同一意图复用 requestId、冲突后重读并重新规划。源素材路径不会通过 MCP 暴露或上传。
- 新增 `scripts/agentcut-mcp.mjs`/`pnpm mcp` launcher。构建 stdout/stderr 均转送到进程 stderr，协议 stdout 不混入 pnpm 日志；使用 `pathToFileURL` 安全解析本地入口。
- README、Agent 协议和长程计划补充真实配置、工具返回契约、人工边界与未完成 Gate，锁文件登记官方 MCP server/client 及其传递依赖。

### 验证结果

- MCP package build、strict typecheck 和 6/6 定向测试通过。测试用官方 `@modelcontextprotocol/client` 与 `StdioClientTransport` 启动根目录 launcher，真实完成 handshake、tools/list、status/candidates、rough-cut write 与 revision-conflict error；能成功解析协议本身证明 launcher 没有污染 stdout。缺失 requestId 或会被规范化的前后空白 ID 在抵达 daemon 前被 schema 拒绝。
- contract 测试断言工具列表精确为 6 项，且不存在名称含 accept/approve/confirm/delete/keep 的入口；写入 fixture 收到的 `baseRevision=9` 与 `requestId=mcp-rough-cut-001` 未被改写。
- 使用带 libass 的 `ffmpeg-full` 完成最终全仓 `pnpm check`：15 个 workspace production build、全部 strict typecheck 与 224/224 项测试通过，其中 MCP 6/6、agent-client 10/10、Studio 38/38、daemon 14/14、render-engine 14/14、alpha-gate 49/49。
- 使用官方 MCP client 对正在运行的 sample-03 做只读实连：返回精确 6-tool 列表、revision 9、7 个候选、4 个未决、3 个已删除、Preview 67.60375 秒、0 个导出；该调用没有写入候选判断或 Timeline。
- 正式 `pnpm alpha:gate` 仍按预期以退出码 1 返回 `INSUFFICIENT EVIDENCE`：授权 2/20、审阅导出 0/20、配对计时 0/20，precision、边界可用率和时间降幅仍未测得；高风险自动删除为 0，四类正确性均为 2/2 across 2/2 projects。MCP 接入没有被折算为人工质量证据。

### 限制与后续

- 当前是单工程、本地 stdio MCP 子集，尚无 approval token、per-session capability、project diff、job cancel、未知结果恢复或多 MCP host contract matrix；P3/G3 仍未关闭。
- `rough_cut_generate` 只允许 daemon 自动提交低风险明确删除，semantic candidate 和其他高风险内容仍需用户在 Studio 试听。没有工具层命名并不替代未来的 capability enforcement，下一批应实现可审计 session 权限。
- 本批不制造 Alpha 人工标签、真实导出或配对时间样本；正式 Gate 分母和质量指标必须继续来自授权真实项目。

## 2026-08-10：首批 typed Agent CLI 与可恢复 daemon 操作面

### 目标

让 Codex/外部 Agent 不再依赖手工拼 curl 或直接读取 SQLite，而能通过稳定、紧凑、幂等且保留 revision 冲突语义的公共入口理解当前工程、生成候选并查询导出。

### 实际改动

- 新增无第三方运行时依赖的 `@agentcut/agent-client`：封装 `/api/review`、`/api/alpha-audit`、初剪生成、语义分析与 export start/get，统一结构化 `AgentCutClientError`。
- 新增 `pnpm agent`/`agentcut-agent` JSON CLI，当前支持 `status`、`candidates`、`rough-cut generate`、`semantic analyze`、`export start|get`；daemon URL 可由 `AGENTCUT_DAEMON_URL` 或 `--url` 指定。
- `status` 丢弃完整 token 文稿和 job 内部 payload，只返回 project/revision、rough-cut 状态、媒体、Preview、候选计数、紧凑 job/export 与能力；`candidates` 从审计投影输出固定的文本、源时间、时长、decision、risk、reason、confidence 和状态。
- 所有写命令强制调用者提供非负 `baseRevision` 与稳定 `requestId`，不在客户端自动制造不可重放的幂等键；revision conflict、approval、capability、job failure 映射到 3/4/5/6，参数错误和内部错误映射到 2/7。
- CLI 不提供候选接受/保留、连续文字补删或 `confirmHighRisk`，防止 Agent 通过本地协议冒充用户质量判断；这些决定继续由 Studio 写入同一 Timeline IR/SQLite。
- 新增 launcher，把必要的 TypeScript 构建输出重定向至 stderr，stdout 保持单一 JSON 文档；兼容 pnpm 传入的前导 `--`。workspace lockfile 仅登记新 package，没有新增第三方依赖。

### 验证结果

- agent-client build、strict typecheck 与 10/10 测试通过，覆盖紧凑状态、稳定候选投影、caller-owned revision/requestId、结构化冲突、job ID 编码、pnpm 分隔符、单 JSON stdout，以及参数/冲突/capability/job-failed 退出码 2/3/5/6。语义 Provider 不可用归为 capability；HTTP 200 但 export job 已失败、取消或 outcome unknown 时不会误退 0。
- 首次真实 `pnpm agent -- status` 暴露并修复前导 `--` 解析错误；修复后对 `127.0.0.1:4320` 的 sample-03 只读调用返回 revision 9、7 个候选、4 个未决、3 个已删除、Preview 67.60375 秒、0 个导出。
- 直接运行已构建 CLI 的真实 `candidates` 命令只输出一份 JSON，7 个候选均包含可理解文本和 source timing；没有读取 SQLite、修改工程或传输完整逐词 Transcript。
- 首轮使用 `ffmpeg-full` 在宿主环境完成完整 `pnpm check`：14 个 workspace production build、全部 strict typecheck 与 217/217 项测试通过；随后补齐 export terminal failure 语义，最终完整检查结果见本节后续记录。
- 最终再次使用 `ffmpeg-full` 完成完整 `pnpm check`：14 个 workspace production build、全部 strict typecheck 与 218/218 项测试通过；agent-client 10/10。
- 正式 `pnpm alpha:gate` 仍按预期返回退出码 1 / `INSUFFICIENT EVIDENCE`：授权 2/20、审阅导出 0/20、配对计时 0/20；新增 Agent 操作面没有被折算为人工质量证据。

### 限制与后续

- 当前是首批单工程 HTTP client/CLI，不是 MCP server，也没有完整 protocol schema 生成、approval token、project diff、job cancel 或多客户端 capability session；P3/G3 仍未关闭。
- CLI 触发的是 daemon 内已有的高层 workflow，尚未提供低层 timeline query/apply；在 approval 和 capability 模型落地前不应扩大到任意写操作。
- sample-03 的真实 CLI 验证是只读状态与候选投影，没有替用户做剩余四项内容取舍，也不增加 Alpha Gate 的人工标签、导出或计时分母。

## 2026-08-10：导出与崩溃恢复增加源素材 content hash 门禁

### 目标

关闭 RenderPlan 只记录 Asset `contentHash`、却直接读取当前路径字节的 provenance 漏洞：托管媒体若被外部替换或损坏，不能继续渲染或收养旧成片并错误声称来自登记的源素材。

### 实际改动

- render workflow 对 Timeline 实际引用的每个唯一 Asset 重算 SHA-256，并与 canonical Asset registry 的 `contentHash` 比较；FFmpeg 开始前与输出发布前各校验一次，缩小长渲染期间外部改写素材的竞态窗口。
- interrupted running job 收养已发布 MP4/SRT 前执行同一校验。素材丢失返回 `SOURCE_NOT_FOUND`，字节漂移返回新错误码 `SOURCE_INTEGRITY_FAILED`；两者都不会提交 output/caption/report transaction。
- daemon 恢复线程会把结构化 RenderError 原样持久化为确定失败，不再把已知的源素材漂移模糊成 `outcome_unknown`；已有 MP4/SRT 仍原样保留。
- README、P4 验证文档与长程计划同步写明源素材不可变门禁及其边界。

### 验证结果

- 先新增两条失败测试，分别证明旧实现会在源文件漂移后继续尝试 FFmpeg，以及会收养基于旧源生成的已发布输出；修复后 render-engine 14/14 通过。
- local-daemon 定向恢复测试验证 `SOURCE_INTEGRITY_FAILED` 被持久化为不可重试的 `failed` job，且不被误标为未知结果；daemon 14/14 通过。
- 使用 `ffmpeg-full` 在宿主环境完成完整 `pnpm check`：13 个 workspace production build、全部 strict typecheck 与 208/208 项测试通过；其中 render-engine 14/14、local-daemon 14/14。
- 正式 `pnpm alpha:gate` 仍按预期返回退出码 1 / `INSUFFICIENT EVIDENCE`：授权 2/20、审阅导出 0/20、配对计时 0/20；本批完整性修复没有被错误折算成真实产品质量证据。
- 用最新 production build 在 `127.0.0.1:4320` 重启 sample-03 Studio；只读 Alpha audit 仍为 revision 9、4 个未决候选、0 个导出，未发生状态写入。另对托管 MP4 实际执行 SHA-256，结果与 audit/Asset registry 的 `e536a169…ecf64` 完全一致。

### 限制与后续

- 校验减少但无法彻底消除第二次 hash 完成到原子登记之间的极短 TOCTOU 窗口；发布硬化阶段可考虑只读文件描述符/平台文件锁或 content-addressed 只读目录权限。
- 这只证明字节身份门禁，不等于扩大真实素材导出矩阵，也不提供人工吞字、截断音节或主观节奏结论；G4/G5 仍未通过。

## 2026-08-10：最终质量标注移到通过导出后的接受 revision

### 目标

消除正式 Alpha 样本的证据顺序陷阱：候选/边界标签严格绑定 revision，而成功导出会用 artifact transaction 推进一次 revision。旧流程允许用户在导出前完成全部最终标签，导出成功后这些标签立即不再投影，造成整轮人工试听返工。

### 实际改动

- `AlphaEvidenceStore.labelCandidate/labelBoundary` 除“内容取舍已完成”外，新增当前接受导出门禁：必须存在 quality passed 的 render report，且 `export.sourceRevision + 1 === project.revision`。缺少导出、质量失败或导出后又发生 revision 变化均返回 `INVALID_LABEL`。
- Studio 的 Alpha 面板把内容门禁和导出门禁分开解释；未完成内容取舍时提示剩余候选，内容已完成但未有当前成片时提示先导出，候选正确性与边界可用性按钮保持禁用。计时入口不受影响，可从审阅前跨导出 revision 累计。
- evidence bundle loader 独立重验同一约束：只要存在任一最终候选/边界标签，就必须携带当前接受 revision 的 passing export，防止绕过写入 API 后用重算 hash 的 bundle 进入 Gate。
- 本批当时把 Benchmark 顺序写为“审阅前 baseline/start → 内容取舍 → succeeded export → 最终质量标注 → finish timing → alpha:collect”；后续正式模式的 finish 门禁落地后，当前权威顺序已在文件顶部与 Benchmark README 更正为“导出通过 → 暂停并 finish timing → 最终质量标注”。

### 验证结果

- 先用失败测试确认 review complete 但无导出、以及携带旧 source revision 导出的工程仍可写标签；修复后 evidence store 13/13、整个 alpha-gate 49/49 通过并通过 strict typecheck。
- Studio 组件 6/6 通过：无当前导出时显示明确文案，候选和边界按钮均不可写；存在 current passing export 时原有标注交互保持可用。
- daemon 真实 API 定向测试在内容取舍完成后先验证标注被拒绝，再通过 typed transaction 登记 passing export，revision 2→3 后候选/边界标注成功；定向测试与 strict typecheck 通过。
- 使用 `ffmpeg-full` 在宿主环境完成完整 `pnpm check`：13 个 workspace production build、全部 strict typecheck 与 206/206 项测试通过；其中 alpha-gate 49/49、Studio 38/38、local-daemon 14/14、render-engine 12/12。
- 正式 `pnpm alpha:gate` 按预期以退出码 1 返回 `INSUFFICIENT EVIDENCE`：授权项目 2/20、已审阅并导出 0/20、配对计时 0/20；高风险自动删除仍为 0，precision、边界可用率与时间降幅仍未测得。
- 用最新 production build 在 `127.0.0.1:4320` 重启 sample-03 Studio；只读 `/api/review` 验证工程仍为 revision 9、`reviewing`、0 个导出，重启没有推进 Timeline revision 或改写样例状态。本机未启动 LM Studio，因此语义复审能力诚实显示不可用。

### 限制与后续

- `sourceRevision + 1` 适用于当前单一主轨 Alpha 的“渲染后只发生一次输出登记事务”协议；未来若增加签名、发布或代理衍生事务，需要显式引入内容状态 hash，不能继续假设固定 revision 偏移。
- 标签仍是人工听审结果，不会因存在 passing export 自动产生。正式 cohort 的 20 项目、precision、边界可用率和配对时间均未因此增加。

## 2026-08-10：导出崩溃窗口收养与无覆盖安全重试

### 目标

修复持久化导出在“MP4/SRT 已从工作目录发布，但 output/caption/report 尚未写入 Timeline”时重启无法继续的问题。此前 daemon 会把任务标为 `outcome_unknown`，Studio 虽显示“安全重试导出”，新 job 却会再次撞到 `OUTPUT_EXISTS`，不满足关闭重启后仍能找到成片或安全重试的 Alpha 要求。

### 实际改动

- render workflow 增加 `recoverRunningPersistedRenderJob`：对 running job 重建同 project/revision/plan hash 的 RenderPlan，检查确定性主输出和该 job 的 `safe-retry` 输出对；只有 MP4 与 SRT 同时存在、SRT 字节与剪后 cue 完全一致、ffprobe 质量通过时才计算 hash、构造 artifact 并补交 Timeline 登记事务。
- 正常导出增加显式 `existingOutputPolicy`。默认仍拒绝任何既有目标，保持底层保守契约；daemon 导出使用 `recover_or_preserve`：完整匹配对直接收养，残缺或错配文件绝不删除或覆盖，改写带 job hash 的 `safe-retry-*` 新文件对。
- daemon 重启恢复先处理已登记 artifact，再异步尝试收养已发布文件；无法证明匹配才进入 `outcome_unknown`。Studio 新 requestId 会创建新 job，因此“安全重试导出”现在可以在保留旧文件的同时完成新输出。
- 输出收养仍通过同一 `asset.put + caption artifact.put + render report.put` typed transaction，Timeline IR/SQLite 保持唯一真相源；不存在通过扫描目录直接伪造 succeeded UI 状态的旁路。

### 验证结果

- 先用两个失败测试复现：完整 MP4/SRT 对在未登记工程中触发 `OUTPUT_EXISTS`；只有旧 MP4 的残缺发布也阻断重试。修复后 render workflow 定向 4/4 通过：默认冲突仍拒绝、完整匹配对收养并登记、残缺文件字节保持不变且新 `safe-retry` MP4/SRT 成功导出。
- daemon 定向测试验证 pending 恢复、可收养 running job 与无匹配输出的 `outcome_unknown` 分流，并确认所有新导出 job 都启用 `recover_or_preserve`；2/2 通过，daemon strict typecheck 通过。
- 使用 `ffmpeg-full` 在宿主环境完成 `pnpm check`：13 个 workspace production build、全部 strict typecheck 与 203/203 项测试通过，其中 render-engine 12/12、local-daemon 14/14。
- `pnpm alpha:gate` 复核仍为预期的 `INSUFFICIENT EVIDENCE`：授权 2/20、审阅导出 0/20、配对计时 0/20、高风险自动删除 0，四类正确性均为 2/2 across 2/2 projects。本修复没有伪造项目完成数。
- 使用新 build 重启 `127.0.0.1:4320` Studio 后只读检查 sample-03：仍为 REV 9、`roughCutStatus=reviewing`、export job 为空；启动恢复扫描没有写入工程或制造虚假成片。

### 限制与后续

- 自动化覆盖了真实 FFmpeg 文件和 daemon 调度协议，但尚未在真实用户工程上通过强制杀死进程制造崩溃窗口；因此本批证明恢复机制，不把它写成真实故障演练完成。
- 无法证明属于当前 plan 的旧文件会永久保留并使用替代文件名，当前没有自动 orphan 清理；这是避免误删用户产物的保守取舍。
- 本修复不增加正式 cohort 样本。Alpha Gate 仍需要不少于 20 条授权素材的人工审阅、听边界、导出和配对时间。

## 2026-08-10：Alpha 配对计时起点证明与事后计时防线

### 目标

堵住“先完成内容取舍，再补录手工基线和很短的 AgentCut 用时”仍可能进入提效指标的证据漏洞。跨 revision 计时仍要支持真实粗剪，但必须证明正式计时早于第一次人工删除、保留或恢复。

### 实际改动

- Alpha audit 从 canonical append-only `CommandRecord` 推导 `firstHumanDecisionRevision`：用户提交的 `range.deleteRipple`、`lock.add`、`lock.remove` 或正式 `restore:` 逆事务均视为人工内容取舍；workflow 自动提交不冒充人工起点。
- `AlphaEvidenceStore` 在首次人工取舍后拒绝新基线和首次 start，返回 `INVALID_TIMING_ORIGIN`。如果 start 已在取舍前写入，后续仍可随 Timeline revision 暂停、恢复和最终完成；相同 request ID 的幂等重放仍优先返回旧结果。
- evidence bundle 写入首个人工取舍 revision，并校验基线与第一次 start 都早于该 revision。旧 bundle 没有 timing 时保持可读；缺少起点证明的旧格式不能携带 timing 进入 Gate。
- Studio 在计时尚未启动且工程已经发生人工取舍时显示明确门禁，禁用基线和 start，提示改用尚未开始审阅的新工程采集正式提效证据。
- 此规则取代 2026-07-31 记录中的“暂停后可登记新基线从零开始”行为；新基线现在只允许在第一次人工内容取舍前登记。

### 验证结果

- 先用失败测试确认旧实现会接受事后基线和首次 start，并会漏掉“自动删除后由用户恢复”这一人工判断；修复后 `@agentcut/alpha-gate` 47/47 项测试与 strict typecheck 通过，覆盖事后拒绝、合法跨 revision 恢复、恢复逆事务、bundle 起点校验和旧无 timing bundle 兼容。
- local-daemon 通过真实 HTTP 集成路径验证：rev 0 启动计时后执行用户候选删除，rev 1 可继续累计至完成；已有人工取舍的 rev 2 工程补录基线会返回 `INVALID_TIMING_ORIGIN`。定向测试 2/2 通过，daemon strict typecheck 通过。
- Studio 组件验证门禁文案与禁用状态，定向测试 5/5 通过，strict typecheck 通过。
- 使用已安装且带 libass 的 `ffmpeg-full` 完成宿主环境 `pnpm check`：13 个 workspace production build、全部 strict typecheck 与 201/201 项测试通过。默认 Homebrew `ffmpeg` 不带 libass，第一次检查在字幕烧录处失败；改用项目支持的 `AGENTCUT_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` 后渲染测试通过。受限沙箱的静态服务测试仍会因 `listen EPERM` 失败，宿主环境同一测试 14/14 通过。
- 现有正式 bundle 兼容性通过真实 `pnpm alpha:gate` 复验，报告仍为预期的 `INSUFFICIENT EVIDENCE`：授权 2/20、审阅导出 0/20、配对计时 0/20、四类正确性均为 2/2 across 2/2 projects。
- 更新后的 Studio 已在 `127.0.0.1:4320` 启动；宿主侧只读 API 验证 sample-03 保持 REV 9、首个人工取舍为 REV 6、timing 事件为 0、候选标注 0/7、边界标注 0/3。应用内浏览器安全策略拒绝了 localhost DOM 接管，因此本批没有新增页面截图/DOM 级实机证据，不能把组件测试和 API 响应描述成完整视觉验收。

### 限制与后续

- 该防线只保证计时事件顺序，不证明外部手工基线本身真实；手工对照仍须保留秒表、录屏或编辑器日志等可核查来源。
- 已经开始人工取舍且此前没有正式 start 的 sample-03 不能再用于配对时间指标，但仍可用于候选质量、边界、导出和正确性证据；配对提效必须用新的授权工程从审阅前开始采集。
- 正式 Gate 仍只有 2/20 个授权项目，当前没有完整审阅/导出或合格配对时间样本，不能因防线完成而提升 Gate 进度。

## 2026-07-31：Alpha 活跃计时跨 revision 连续性与最终标注门禁

### 目标

修复 Alpha 时间收益证据的口径漏洞：真实粗剪会通过删除、保留、恢复持续推进 Timeline revision，计时若只绑定单一 revision，就会在第一次有效编辑后丢失此前活跃时间。与此同时，候选真阳性和剪切边界结论必须继续严格绑定最终接受版本，不能因放宽计时而跨版本复用。

### 实际改动

- `AlphaEvidenceStore` 将 binding 分成两类：candidate、boundary、correctness 仍只投影当前精确 revision；timing 只要 project ID/source SHA-256 相同，允许读取不高于当前 head 的历史事件，并要求写入仍使用 daemon 当前 revision。
- timing event 在一个真实粗剪 run 内可随 Timeline revision 单调推进。若某 revision 已完成计时后又发生编辑，旧结果在新 head 自动投影为 `paused + incomplete`，保留已核算活跃秒数并允许继续；只有在最新接受 revision 再次 finish 后才恢复完整配对证据。
- 暂停状态录入新手工基线会显式重置累计时间、session 和完成状态，开始一轮新计时；运行中的 session 禁止静默替换基线。后台、空闲和 daemon 断档的 30 秒上限逻辑保持不变。
- evidence bundle 允许 timing event revision 小于等于最终 bundle revision，但校验 revision 随事件序列不得倒退；任何非 timing 事件仍必须等于最终 revision。完整 timing 摘要继续由 append-only 事件重新求值，不能靠修改汇总数字伪造。
- daemon/API 在最终内容取舍尚未完成时拒绝 candidate/boundary 人工标签；Studio 同步禁用这些按钮并解释剩余事项。边界试听仍可用于剪辑判断，活跃计时仍可从粗剪开始时运行。
- Studio 的计时说明明确提示跨 revision 连续累计、完成后继续编辑会自动退回未完成，避免操作者把旧版本结果误解为最终证据。

### 验证结果

- 先用失败测试复现：revision 7 开始计时并累计 15 秒后，revision 8 的旧实现返回 `baseline=null / 0 秒 / not_started`；修复后保留同 session，并在新 revision 继续累计到 35 秒。
- `@agentcut/alpha-gate` 覆盖跨 revision 计时、旧质量标签不继承、完成后再编辑自动失效并续计、新基线从零重开、运行中禁止改基线，以及跨 revision bundle 重算与防篡改。
- local-daemon 定向集成测试在计时中执行真实 `/api/restore` Timeline transaction：revision 1→2 后仍保留前 15 秒与 active session，继续心跳/暂停/完成得到 35 秒；所有 timing 写入自身不增加 Timeline revision。
- Studio 组件回归验证：存在未决候选时显示最终标注门禁，候选正确性和边界可用性按钮均不可写；计时入口保持可用。
- `pnpm check` 的 13 个 workspace production build 与 strict typecheck 全部通过；除临时监听端口的静态服务测试外，196/197 项测试已在本批新代码上通过（Studio 36/36、alpha-gate 44/44、daemon 其余 13/13）。唯一未能在本轮重新通过的测试因受限沙箱对 `127.0.0.1` 返回 `listen EPERM`；申请宿主执行又被当前 Codex 用量限制拒绝，不是代码断言失败。该静态服务测试在上一批完整检查通过，且本批未修改静态服务实现，但仍按“本轮待宿主复验”记录，不能写成 197/197。
- 正式 sample-03 只做只读检查和浏览器渲染验证，不写入人工判断或计时。

### 限制与后续

- 跨 revision 只解决计时口径正确性，不提供真实手工基线或主观听审结论；正式 cohort 仍必须由真实操作者完成。
- 同 project/source 的 timing 历史会保留在 append-only sidecar；新 baseline 是显式新一轮的分界，旧事件仍用于审计但不进入新一轮累计。
- 当前 Gate 仍只有 2/20 授权项目，不能因证据管道更可靠而提升样本完成数。

## 2026-07-31：Alpha cohort 一键采集与重复素材防线

### 目标

把每条真实项目进入 Alpha Gate 的流程从“分别跑 correctness、导出 bundle、抄写双层 hash、手改 manifest”收敛为可幂等续跑的一次操作，并堵住同一素材换 project ID 重复计入 20 项目 cohort 的漏洞。

### 实际改动

- Gate 的 manifest 校验新增全项目 source SHA-256 唯一约束；即使 cohort project ID 不同，只要源素材 hash 相同就返回 `DUPLICATE_SOURCE`，不进入任何指标计算。
- 新增 `pnpm alpha:collect -- <工程> --cohort-id <id> --authorization-basis <basis> --authorization-evidence <path>`。命令先校验现有 manifest 和授权文件，再用临时 SQLite backup 执行 undo/restart/idempotency/revision-conflict correctness，并确认正式工程的 project/revision/source binding 在运行期间未变化。
- correctness run 使用由 cohort ID 与 revision 派生的稳定 request ID；完全重跑只保留一个同 ID 事件。命令随后从当前 sidecar 生成隐私最小 evidence bundle，以整文件 SHA-256 前缀生成内容寻址文件名；相同字节复用既有文件，不覆盖不同内容。
- manifest 登记保留旧 bundle，更新 descriptor 指向新内容寻址版本；写入前重新比较最初读取的 manifest 字节，再通过临时文件原子替换。若另一进程已更新 manifest，则拒绝覆盖并保留安全的孤立 bundle，允许下次幂等恢复。
- collector 在写正式 sidecar 前拒绝：同一 source hash 使用另一 cohort ID、同一 cohort ID 更换 source、同一 cohort 静默更换授权 basis/evidence、另一 canonical project 复用旧 cohort。授权引用必须为相对 manifest 的现有且非空普通文件，空占位文件不能满足授权前置条件。
- README、长程执行计划和 Benchmark 操作说明改用 `alpha:collect` 作为日常登记路径；`alpha:audit`、`alpha:verify`、`alpha:evidence` 仍保留作诊断和低层操作，不要求普通采集者手改 JSON。

### 验证结果

- 新增 collector 的真实 ProjectStore/SQLite 测试，覆盖首次登记、完全幂等重跑、Timeline revision/state hash 不变、单 correctness 事件、内容寻址 bundle、重复素材、授权替换、cohort/source 冲突、manifest 并发修改保护和 bundle 发布失败临时文件清理。
- `@agentcut/alpha-gate` 当前 11 个测试文件、40/40 项通过，strict typecheck 通过；重复素材 Gate 与空授权文件测试都先在旧实现上确认失败，再补充约束。
- 在 `/private/tmp/agentcut-alpha-collect-e2e.APtjx4` 的 sample-03 revision 9 副本上连续运行两次真实 `pnpm alpha:collect`，两次均解析为同一 `48df381d6b30…` bundle；第二次没有新增 bundle 或第三个 correctness 事件，Timeline 保持 revision 9，timing 事件保持 0。
- 临时 cohort 重新执行 Gate 后仍诚实为授权 2/20、完整审阅导出 0/20、配对时间 0/20、四类正确性 `2/2 across 2/2 projects`；collector 没有把空人工标签解释为通过。
- 使用 `ffmpeg-full` 的完整 `pnpm check` 通过：13 个 workspace 完成 production build、strict typecheck，共 192/192 项测试通过。

### 限制与后续

- `alpha:collect` 消除的是采集和登记摩擦，不会自动制造授权、人工候选判断、边界听审、导出成功或手工基线；正式 cohort 仍只有 2/20。
- correctness 事件写入后若 manifest 并发冲突，sidecar 会保留有效 run，内容寻址 bundle 也可能成为未引用文件；这是防止覆盖并保留审计轨迹的设计，后续可增加只读 orphan report，但不能自动删除证据。
- 现有正式 manifest 的授权路径是早期按仓库根目录书写的相对路径；collector 兼容其解析，新项目统一按 manifest 目录记录，未来若迁移格式需要显式 migration，不能静默重写历史授权引用。

## 2026-07-31：可暂停的 Alpha 活跃计时与成对时间证据

### 目标

把 Alpha Gate 的“人工初剪 vs AgentCut 初剪”时间收益从 manifest 可手填数字升级为 revision/source-bound 的 append-only 证据；后台、空闲、刷新和 daemon 中断不能被误计为活跃编辑时间，未做真实人工对照时不得生成配对样本。

### 实际改动

- `AlphaEvidenceStore` 新增人工基线、开始、心跳、暂停和完成五类 timing 事件。基线必须为正数并注明秒表、录屏或编辑器日志来源；所有事件沿用 project ID、revision、source SHA-256、request ID 幂等和 payload hash 约束，不提交 Timeline command。
- 活跃时间完全使用 daemon 时钟计算：相邻 start/heartbeat/pause/finish 的间隔只有在不超过 30 秒时才累计；断档超过 30 秒会投影为暂停，旧 session 不能继续心跳，重新开始会创建新 session，因此刷新、后台和服务停机不会补算离线时长。
- daemon 新增 `/api/alpha-audit/timing/{baseline,start,heartbeat,pause,finish}` 五个 revision/source-bound API；无基线、无实际累计、重复运行 session 或错误 session 都返回结构化错误，Timeline revision 保持不变。
- Studio 的 Alpha 验收面板新增“成对初剪用时”：登记手工对照及来源、开始/暂停/继续/完成 AgentCut 计时，并展示两侧时长和完成后的下降比例。运行中每 15 秒发送一次心跳；页面隐藏立即暂停，60 秒无近期键盘或指针操作暂停。
- evidence bundle 增加 timing 摘要和原始事件；加载时不仅校验双层 hash，还重新按事件时间戳求值并对照完成摘要。带 bundle 的项目会移除 manifest 手填 timing，只在 verified bundle 中存在完整配对证据时才向 Gate 提供一个项目样本。

### 验证结果

- `@agentcut/alpha-gate` 新增跨进程暂停/续跑、断档自动暂停、完成前置条件、bundle timing 物化和事件/摘要不一致拒绝测试；10 个测试文件、32/32 项通过，strict typecheck 通过。
- local-daemon 定向集成验证五个 timing API、刷新恢复和 project revision 不变；Studio API/组件回归覆盖全部 timing 请求和缺基线/已完成界面，Studio 10 个测试文件、35/35 项通过并通过 strict typecheck。
- 正式 sample-03 只刷新和检查 UI：页面显示 REV 9、候选 0/7、边界 0/3、“缺少对照”和禁用的基线提交按钮，console warning/error 为 0；只读查询确认 timing 事件仍为 0、Timeline revision 仍为 9，没有制造人工基线或活跃时间。
- 使用 `ffmpeg-full` 的完整 `pnpm check` 通过：13 个 workspace 完成 production build、strict typecheck，共 184/184 项测试通过。

### 限制与后续

- 当前只采集 Studio 页面的活跃时间，不宣称等价于认知负荷或总任务耗时；20 项目 cohort 必须统一从相同起止定义开始计时，并保留外部人工基线来源。
- 浏览器突然崩溃时最多丢失最后一个尚未心跳的 15 秒活跃区间；这是避免把离线时间误算为活跃时间的保守取舍。
- 正式 sample-02/sample-03 均未录入人工基线，Gate 配对时间仍应为 0/20；下一步必须由真实操作者完成对照实验，不能由开发测试或临时副本冒充。

## 2026-07-31：真实工程副本 correctness verifier 与逐项目 Gate

### 目标

把 undo、restart、idempotency、revision conflict 从可手填的 manifest 计数升级为每个真实工程可重复运行的机器证据；验证过程不得修改 canonical Timeline IR/SQLite，并且 20 次重复验证不能冒充 20 个不同项目覆盖。

### 实际改动

- 新增 `pnpm alpha:verify -- <工程目录> --request-id <id>`：先校验当前 ProjectStore，再用 Node SQLite `backup()` 创建一次性数据库副本，所有探针只在系统临时目录执行。
- verifier 在副本中提交一个真实可逆 `clip.update`：重复同一 transaction 检查 idempotent replay 与 revision/hash 不变；关闭重开并执行完整 replay/integrity 检查 restart；用 stale base revision 检查结构化 `REVISION_CONFLICT`、state/command count 不变；最后 undo 并比较去除 revision/history 后的领域状态，同时再次验证 SQLite replay。
- 每项输出 `passed/code/details`，整次 run 绑定 canonical project ID、project revision、source SHA-256 和 source state hash；运行结束后 CLI 再读源工程，若期间发生 revision/source 变化则拒绝记录。
- 机器结果作为 `targetType: correctness` 的 append-only 事件写入现有 `alpha-evidence.sqlite`，同 request ID/同 payload 幂等，复用 ID 改写结果会产生冲突。事件不影响候选/边界标注进度，也不提交 Timeline command。
- evidence bundle 与双层 hash 校验扩展到 correctness result；Gate 对每个有 bundle 的项目只采用最新绑定 run，每种机制最多贡献一个项目覆盖，不采用 manifest 手写次数。
- 修复旧 Gate 的覆盖漏洞：过去 1 个项目累计 20 次成功可能满足 `evaluated >= 20`；现在必须不少于 20 个授权项目各自至少一次且全部通过，报告同时显示 `passed/evaluated` 和 `covered/authorized projects`。
- 对正式 sample-02 revision 4 与 sample-03 revision 9 各运行一次 verifier，生成新的不可覆盖 bundle 并接入 manifest。两个源工程仍分别保持 revision 4/9、command 4/9，当前 state hash 与事件记录的 source state hash 一致。

### 验证结果

- correctness verifier 2 项测试覆盖四项真实机制与 stale binding；correctness CLI 测试覆盖重复运行幂等、源 revision/hash 不变和单事件写入；侧车、bundle/Gate 和逐项目覆盖另有 3 项回归。
- `@agentcut/alpha-gate` 当前 10 个测试文件、28/28 项测试通过，strict typecheck 通过。
- 正式两个工程的 machine run 均为 undo/restart/idempotency/revisionConflict `passed`；bundle 重新读取显示每个工程恰好 1 个 run，且 `stateHashMatchesEvidence=true`。
- 当前 `pnpm alpha:gate` 按设计仍返回 `INSUFFICIENT EVIDENCE` 和退出码 1，但四项正确性已从 0/0 推进到 `2/2 across 2/2 projects`；授权项目仍为 2/20、完整审阅导出 0/20、配对时间 0/20。
- 使用 `ffmpeg-full` 的完整 `pnpm check` 通过：13 个 workspace 完成 production build、strict typecheck，共 177/177 项测试通过。

### 限制与后续

- verifier 证明的是每个真实 ProjectStore 上四种基础机制可用，不代表所有 edit operation 的 undo 质量；全 operation property/replay 测试仍承担广度覆盖，真实候选和边界听审承担产品质量覆盖。
- 当前只有 2 个授权真实项目具备 machine correctness 证据，仍需随项目 cohort 扩展到不少于 20 个，不允许在同一项目重复计数。
- 人工候选/边界标签仍为空，配对人工时间仍无结构化事件；下一步需要正式听审，并实现可暂停/恢复的 active-time 采集与人工基线登记。

## 2026-07-31：可校验 Alpha evidence bundle 与 Gate 自动汇总

### 目标

把 Studio 的本地人工证据侧车变成可跨机器检查、可由 Alpha Gate 直接消费的最小证据包；候选和边界指标不再依赖手工抄写统计，同时保持 Transcript、媒体和工程 SQLite 不进入 Benchmark 仓库。

### 实际改动

- 新增 `pnpm alpha:evidence -- <工程目录> --output <bundle.json>`：从当前只读 ProjectStore 审计和 `alpha-evidence.sqlite` 生成确定性 JSON；输出经临时文件加硬链接原子发布，目标存在时拒绝覆盖。
- evidence bundle 只保存 project/revision/source hash/Transcript ID、候选 ID 与决策/风险/状态/人工标签、边界 ID 与听审结果、append-only 事件、进度及最小导出摘要，不复制候选文稿、完整 Transcript、媒体路径、SQLite 或自由备注正文；备注仅以 SHA-256 commitment 出现。
- bundle 内部 payload 使用 canonical JSON 的 SHA-256；manifest 另保存整文件 SHA-256。加载时同时验证双层 hash、事件顺序/request ID、事件与最终标签一致性、目标完整性、进度、cohort ID 对应的 canonical project ID、revision 和 source hash。
- Alpha manifest 项目可引用 `evidenceBundle`；`pnpm alpha:gate` 会在评估前读取并校验 bundle，并以其中的 canonical state 覆盖手工候选/边界/审阅/导出汇总。文件篡改、目录逃逸、错误 project/revision/source binding 都作为输入错误退出，不降级为“证据不足”。
- benchmark project ID 与工程内部 canonical project ID 明确分离：sample-02 和 sample-03 历史上复用了同一工程 ID，manifest 继续使用唯一 cohort ID，descriptor 显式记录 canonical ID，避免篡改旧工程或制造重复项目。
- 正式 sample-03 revision 9 已生成 `bundles/sample-03-r9.evidence.json` 并登记文件 hash。包内为 0/7 候选、0/3 边界、0 个事件和 4 个未决候选，没有把临时副本的合成标签或任何虚构人工判断写入正式 Gate。

### 验证结果

- 新增 3 个测试文件、6 项行为测试，覆盖确定性/Transcript 与备注正文最小化、内部 payload 篡改、真实 ProjectStore CLI、拒绝覆盖、manifest 文件 hash、canonical binding、错误 revision 和 Gate 指标派生。
- `@agentcut/alpha-gate` 当前 8 个测试文件、23/23 项测试通过，strict typecheck 通过。
- 当前真实 `pnpm alpha:gate` 成功验证 sample-03 bundle 后仍按设计返回 `INSUFFICIENT EVIDENCE` 和退出码 1：2/20 个授权项目、0/20 个完整审阅导出、高风险自动删除 0，候选、边界、四类正确性和配对时间仍无合格分母。
- 使用 `ffmpeg-full` 的完整 `pnpm check` 通过：13 个 workspace 完成 production build、strict typecheck，共 172/172 项测试通过。

### 限制与后续

- 该版 bundle 当时只自动汇总候选、边界、项目审阅状态和最小导出摘要；四项 correctness 已由上方后续记录接入统一事件包，配对人工时间仍待收敛。
- bundle descriptor 仍由 Benchmark 维护者登记到版本化 manifest；普通剪辑用户不需要接触 JSON，但 20 项目数据采集尚未形成一键 cohort 登记流程。
- sample-03 正式人工标签仍为 0，下一步必须由用户实际试听并完成候选/边界判断；程序生成的空 bundle 只证明证据链可用，不证明质量指标达标。

## 2026-07-31：Alpha 人工标注侧车与 Studio 验收入口

### 目标

让候选正确性和剪切边界听审可以直接在 Studio 内完成，同时保证人工证据精确绑定工程 revision 与素材 hash、不修改 Timeline IR，也不要求用户手工编辑 JSON 或 SQLite。

### 实际改动

- `@agentcut/alpha-gate` 新增独立 `AlphaEvidenceStore`：人工事件追加写入工程目录下的 `alpha-evidence.sqlite`，启用 WAL 与 `synchronous=FULL`，并绑定 project ID、project revision、source SHA-256、目标 ID 和 request ID。
- 候选支持标记真阳性/误报；边界支持标记可用，或选择吞字、截断音节、音画不同步、节奏不自然和其他问题。重复 request ID 幂等返回，不同 payload 复用同一 ID 会拒绝；旧 revision 或不同素材的标签不会投影到当前审计。
- daemon 新增 `GET /api/alpha-audit`、候选标注和边界标注接口。每次写入前重新只读生成当前审计草稿并检查 `baseRevision + sourceSha256`；人工证据写入不会提交 project command，也不会递增 Timeline revision。
- Studio 编辑助手新增可折叠的“Alpha 验收”面板，展示候选/边界进度、绑定 revision/hash、当前候选判断和全部真实剪切边界。边界可以先切换到“当前初剪”并从剪点前试听，再提交听感结论。
- 正式 sample-03 工程只执行了读取和试听，没有替用户填写人工结论；另在该工程的临时副本上完成合成标注写入、页面刷新恢复与 revision 不变验证，避免把程序验证冒充真实人工听审。

### 验证结果

- `AlphaEvidenceStore` 4/4 项测试通过，覆盖关闭后恢复、幂等冲突、revision/hash 隔离、目标与边界问题校验；包 strict typecheck 通过。
- local-daemon 13/13 项测试通过，新增真实 ProjectStore 集成覆盖 GET、候选/边界写入、刷新恢复、stale revision、错误素材 hash 和 project revision 不变。
- Studio 10 个测试文件、33/33 项测试通过；新增 API 合约与验收面板回归，strict typecheck 和 Vite production build 通过。
- 正式 sample-03 revision 9 的界面显示候选 0/7、边界 0/3；第一个真实剪切边界通过“当前初剪”成功播放。临时副本写入候选误报和边界“截断音节”后变为 1/7、1/3，整页刷新仍恢复，revision 保持 9，浏览器 warning/error 日志为空。
- 使用 `ffmpeg-full` 的完整 `pnpm check` 通过：13 个 workspace 完成 production build、strict typecheck，共 166/166 项测试通过。
- `pnpm alpha:gate` 按设计返回 `INSUFFICIENT EVIDENCE` 和退出码 1：授权项目 2/20、完整审阅导出 0/20、高风险自动删除 0，候选、边界、四类正确性和配对时间均无合格分母；本批次没有把临时副本标签写入 manifest。

### 限制与后续

- 正式工程尚无真实人工候选和边界标签，当前 Gate 仍应维持 2/20 个授权项目、0/20 个完整审阅导出的 `insufficient_evidence`，不能用临时副本的合成标签计入指标。
- 侧车事件已经可追加和更正，但 Studio 尚未展示完整事件历史，也未提供自由备注输入。
- `alpha-evidence.sqlite` 尚未自动导出为带 hash 的 evidence bundle，也未自动汇总进版本化 manifest；下一步要先完成确定性导出/校验，再开始正式人工听审和 20 项目累积。

## 2026-07-31：将 Alpha 质量目标变成可执行 Benchmark Gate

### 目标

让 20 项目 Alpha Gate 由机器根据真实证据判定，杜绝以样本未标、分母为零或只挑成功项目的方式宣布 precision、边界质量和时间收益达标。

### 实际改动

- 新增 `@agentcut/alpha-gate`，聚合授权项目数、审阅导出完成数、高风险自动错删、`definite_remove` 人工真阳性、边界听审、undo/restart/idempotency/revision conflict 和配对人工时间。
- 指标区分 `passed`、`failed` 与 `insufficient_evidence`：没有分母不能获得 100%；任何高风险自动删除直接失败；已观察值低于阈值也不会被证据不足掩盖。
- 每种正确性机制至少需要每个授权项目一次通过证据；时间收益只计算同项目手工基线与 AgentCut 人工有效时间的配对中位数。
- 新增 `pnpm alpha:gate [manifest] [--json]`：通过返回 0，指标失败或证据不足返回 1，输入非法返回 2。
- 新增 `benchmarks/alpha-gate/manifest.json` 和说明；manifest 只保存 SHA-256、统计和证据路径，不保存媒体或 SQLite，也不能反向写入 canonical project state。
- 新增 `pnpm alpha:audit -- <工程目录> --output <草稿.json>`：只读打开 ProjectStore，从当前 Timeline IR、候选 artifact、command actor 和 RenderReport 生成 revision-bound 审计草稿；通过临时文件加硬链接原子发布，目标已存在时拒绝覆盖。
- 审计草稿列出每个候选的 decision/risk/reason/source range/current state/transaction/提交者，并从实际 timeline clip 的 source discontinuity 推导剪切边界；`humanLabel`、`humanUsable` 和人工备注始终初始化为空，不把机器推导伪装成人工结论。
- 接入用户提供的 91.73/78.77 秒两条真实口播：分别生成 revision 4 和 revision 9 的持久审计草稿。前者有 14 个未决候选和 0 个实际边界；后者有 4 个未决候选和 3 个实际边界，其中 7.02 秒高风险重说由用户提交，另有 2 个低风险停顿边界；两条均未发现 workflow 自动提交的高风险删除。
- 重新核对曾用于导出验证的 `/private/tmp/agentcut-roughcut-gate-20260728`：该临时工程及产物已不存在，因此只保留在历史开发记录中，不再计入当前持久化 Gate 的“已审阅/已导出”或正确性分母。

### 验证结果

- Alpha Gate 定向测试现为 4 个测试文件、13 项测试通过，除 Gate 阈值和 CLI 外，覆盖真实 ProjectStore 草稿生成、精确剪切边界、workflow 高风险错删识别、缺失 Transcript、禁止覆盖既有证据和 pnpm `--` 参数分隔符。
- 当前真实 manifest 返回 `insufficient_evidence` 和退出码 1：授权项目 2/20、持久化审阅导出 0/20、高风险自动删除 0；precision、人工边界、配对时间和四类逐项目正确性均为 0/0，不能解释为通过。
- 带 `ffmpeg-full` 环境变量的完整 `pnpm check` 通过：13 个 workspace 完成 build、strict typecheck，共 158/158 项测试通过。

### 限制与后续

- 该 Gate 能防止虚假通过，但不能替代人工标注或自动创造授权素材；仍需补齐 18 个授权真实项目、至少 5 位设计伙伴和全部配对时间。
- 两份草稿已经消除人工寻找候选、边界和提交 provenance 的工作，但人工真阳性、边界听感、机制验证和有效编辑时间仍为空；不得用草稿的机器字段替代人工标签。
- 当前仍需要一个不要求用户修改 JSON 的本地标注入口，把人工判断绑定到 project revision/source hash 后再安全汇总进 manifest。
- Benchmark evidence 目前是版本化路径引用，尚未增加引用文件 hash/签名和跨机器 artifact 打包；在多人标注前需要补充 evidence bundle 校验。

## 2026-07-28：单条中文口播初剪闭环与真实导出 Gate

### 目标

让用户不接触 JSON、SQLite 或零散脚本，即可从一条本地中文口播完成建项、转写、低风险初剪、高风险审阅、人工补删、剪后预览和持久化导出任务。

### 实际改动

- 新增 `@agentcut/rough-cut-workflow` 和根命令 `pnpm roughcut -- <视频> --project <工程目录> [--name <名称>]`：内容哈希导入、单主轨工程、MLX 中文转写和 SQLite job/transaction 被串成一个正式入口；同素材完整工程幂等续跑，不同素材拒绝覆盖。
- render doctor 检查 ffmpeg/ffprobe、ASS filter、H.264/AAC encoder、PingFang 和可用磁盘；支持 `AGENTCUT_FFMPEG_PATH` / `AGENTCUT_FFPROBE_PATH`，并补充 macOS MobileAsset PingFang 动态发现。
- daemon 增加 `rough-cut/generate`、连续 `selections/delete` 和 `candidates/keep-remaining`；低风险 `definite_remove` 在一个可恢复 transaction 内提交，高风险和其余建议仍进入待审队列。
- Studio 增加“生成初剪”“保留全部剩余”，以及点击锚点后 Shift 点击终点的连续文字选择；人工删除仍生成 `manual` CandidateSet/Proposal 并经过 Ripple compiler，不在前端拼媒体时间。
- daemon 的 `roughCutStatus` 与 Preview projection 均从最新 Timeline IR/command records 计算；`evaluateTimelineSegments` 现在同时服务 RenderPlan 和 Preview，消除前后端各算一套 clip 结果的分叉。
- Viewer 增加“原片 / 当前初剪”切换；当前初剪按 Timeline clip 顺序播放、跨已删除 source 区间自动跳转，文字 seek 和时间线 seek 映射到剪后时间，候选循环试听保持原片 source time。
- daemon 增加 revision-bound 持久化 export job、FFmpeg preflight、进度/失败/质量/成片 API、MP4/SRT 下载，以及 pending/running job 的重启恢复或 `outcome_unknown` 诊断；Studio 只在 `rough_cut_ready` 后开放导出。
- `/api/review` 现在投影全部持久化 export job；Studio 会在刷新或 daemon 重启后恢复最新任务状态、成片链接和 SRT 链接，不再把导出结果只保存在 React 内存中。
- ProjectStore 增加按创建顺序和 job type 列举持久化任务，供重启恢复和 Studio 状态重建使用。
- 新增 `docs/16-p4-preview-export-validation.md`，分开记录已通过的协议测试与尚未通过的真实成片 Gate。

### 验证结果

- 新增/更新的定向测试已覆盖：doctor、共享 Timeline evaluator、低风险批量提交、高风险排除、人工连续删除、整批 keep、Preview 时间映射/跨 cut 跳转、export preflight/job/restart、CLI 参数与工程续跑状态。
- local-daemon 集成测试 12/12 通过；Studio 9 个测试文件 30 项通过，strict typecheck 和 Vite production build 通过；ProjectStore 12 项测试通过。
- 用户提供的 78.77 秒 `8be1…46e.mp4` 通过新命令真实建项：source SHA-256 为 `e536a1…cf64`，首次完成 revision 2 与稳定 Transcript；第二次运行返回 `resumed: true`，revision 和 Transcript ID 均未改变。
- 真实 Gate 工程位于 `/private/tmp/agentcut-roughcut-gate-20260728`：生成初剪在一个 transaction 内删除 2 个 low-risk 停顿、共 4.142917 秒（注：2026-08-11 起停顿候选一律 suggest_remove，不再自动提交，见本文件同日「停顿候选全部降级」条目；此处保留的是修复前的历史行为记录）；3 个 medium-risk 停顿和 1 个 high-risk 重复没有自动删除，随后经“保留全部剩余项”写锁，待审数归零并进入 `rough_cut_ready`。
- revision 4 成功导出 H.264/AAC、1280×720 MP4 和 20 cue SRT；输出 74.590 秒，对 74.623750 秒 Timeline 的误差为 33.75 ms，`quality.passed=true`。抽帧确认 PingFang 中文字幕实际烧录、画幅未拉伸；源文件与 managed copy 的 SHA-256 均为 `e536a1…cf64`。
- daemon 重启后 `/api/review` 仍返回 succeeded job、quality report、MP4 和 SRT URL；媒体 Range 返回 206/1,024 bytes，字幕下载返回 200/1,491 bytes。
- 内置浏览器打开重启后的真实工程：Header 显示 REV 5 和 MP4/SRT 链接，统计为待审 0 / 保留 4 / 删除 2；画面面板默认选中“当前初剪”并显示 1:14。整页 reload 后上述 SQLite 投影仍恢复，浏览器 warning/error 日志为空。
- 使用官方 keg-only `ffmpeg-full 8.1.2_1`（`/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`）重跑 `pnpm check`，12 个 workspace 的 build、strict typecheck 和 145/145 项测试全部通过；新增 refresh/restart export projection 回归后，local-daemon 12/12、Studio 30/30 再次通过。

### 限制与后续

- 默认 `/opt/homebrew/bin/ffmpeg` 仍缺少 ASS filter，运行环境必须继续设置 `AGENTCUT_FFMPEG_PATH` 和 `AGENTCUT_FFPROBE_PATH` 指向 `ffmpeg-full`；产品还没有自动安装或选择该工具链。
- Homebrew 修复了三个旧式非 symlink `opt` 目录；原内容可恢复地备份在 `/private/tmp/agentcut-homebrew-{fontconfig,little-cms2,freetype}-opt-backup-20260728`，标准 `opt` symlink 已恢复。
- 本轮已机器验证 cut 数量、Timeline 时长、字幕、codec、画幅、哈希和重启恢复，但尚未由人工从头听审两个真实 cut 边界；吞字、截断音节、音画同步听感、误删和漏删仍标为待验证，因此 M4 的主观质量 Gate 不伪装为已关闭。
- Alpha 仍只有一条 Transcript 绑定素材和一条主视频轨；多素材、B-roll、转场、多轨、画幅重构和字幕样式编辑器仍明确不在本阶段。

## 2026-07-27：通用剪辑工作区窄窗口导航与时间线联动

### 目标

修复通用剪辑工作区在 Codex 窄窗口内只能看到编辑助手和部分文稿、Viewer 与时间线不可达的问题，并让时间线从静态示意推进到与真实视频播放位置联动。

### 实际改动

- Header 新增助手、文稿、画面、时间线四个紧凑工作区 Tab；1180 px 以下一次展示一个主面板，宽屏四区布局保持不变。
- 四个主面板增加稳定的 `aria-controls` 目标与选中状态，默认打开文稿，不再依赖强制 1100 px 画布和横向裁切。
- Player 将 `currentTime` 回传到工作区；时间线显示当前时间/总时长和同步播放头，点击素材轨可定位原片，点击候选仍保留独立选择层。
- 页面标题改为“通用剪辑工作区”，避免继续把产品误表述为独立口播审阅台。
- 新增 `ReviewHeader` 与 `TimelinePanel` 回归测试，并新增根目录 `design-qa.md` 保存同视口视觉比较、交互证据和剩余边界。

### 验证结果

- Studio 定向测试通过：5 个测试文件共 14 项测试；Studio strict typecheck 与 Vite production build 通过。
- 真实 `sample-03` 工程在 664 × 749 窗口完成四个 Tab 可达性检查；画面、时间线、文稿切换后的实际可见面板与选中状态一致。
- 点击时间线中点后视频定位到 38.7 秒，时间线时钟更新为 `0:38 / 1:17`，播放头位置随之更新。
- 同视口前后截图已并排检查；旧版被裁掉的 Viewer/时间线改为明确可达，文稿完整占用可用宽度，页面运行日志为空；`design-qa.md` 结论为 passed。
- 全仓 build 与 strict typecheck 通过；排除 `@agentcut/render-engine` 后 10 个 workspace 共 103 项测试全部通过。完整 `pnpm check` 的 107 项测试中 106 项通过，唯一失败为字幕烧录测试：本机 `/opt/homebrew/bin/ffmpeg` 8.1.1 的编译配置缺少 `ass/subtitles` filter，稳定返回 `No such filter: 'ass'`；没有通过跳过测试制造绿灯。
- 本批次最终 Studio 验证再次通过：5 个测试文件共 14 项测试、strict typecheck、production build 与 `git diff --check` 均为成功状态。

### 限制与后续

- 紧凑模式目前一次只显示一个主面板，尚未提供分栏比例、面板停靠或用户自定义布局。
- 时间线点击定位已经闭环，但拖拽播放头、缩放、滚动、多轨和字幕轨仍不属于当前 P2 交付。
- 664 px 验证代表窄桌面窗口，不代表移动端产品适配；Alpha 仍以 macOS 桌面工作区为目标。
- 当前系统 FFmpeg 不具备字幕烧录所需的 libass 能力；恢复完整导出测试需安装带 `ass/subtitles` filter 的 FFmpeg 构建，界面与本批次时间线功能不依赖该滤镜。

## 2026-07-18：P2 候选删除、删除线投影与 Transcript-first Studio（进行中）

### 目标

把稳定 Transcript 推进为第一条可见、可试听、可恢复的真实口播删除链路，并确保 UI 只投影 SQLite 最新状态，不在浏览器维护第二份 canonical edit state。

### 实际改动

- 新增 `@agentcut/candidate-engine`：从 FFmpeg `silencedetect` 和稳定 Transcript 生成确定 ID 的停顿/语气词候选；仅把不短于 800 ms 且带 150 ms handles 的安全停顿标为低风险确定删除。
- Proposal compiler 增加 CandidateSet、Proposal 与 Ripple edit 同 revision 原子提交；`range.deleteRipple` 绑定 `proposalId`，Undo 能完整恢复编辑态与分析 artifact。
- 新增 `@agentcut/review-projection`：从项目 artifact 与 command records 重建 normal、candidate 和 committed 状态；候选只显示背景提示，只有已提交删除显示删除线/已删除停顿并绑定可恢复 transaction。
- 新增 `@agentcut/local-daemon`：提供 health、review、restore 和带路径边界检查的媒体 Range API；恢复以 inverse operations 写入 SQLite，并使用 request ID 做幂等提交。
- 新增 React/Vite/SWR `@agentcut/studio`：左侧真实原片、右侧同步中文文稿、候选/已删除统计和筛选、点击文字 seek、已提交删除恢复语义；组件按单文件职责拆分，服务端状态由 SWR 读取。
- Lock scope 增加 `source_range`：用户保留的候选绑定 asset/source time，而不是会随 Ripple 漂移的时间线坐标；自动 Agent 删除、移除或 trim 相交源内容时返回 `LOCKED`。
- Candidate review workflow 支持在最新分片上重新绑定历史候选并生成新 revision Proposal；保留写入 `deny_agent` source lock，重新审阅仅由 lock owner 解锁。
- Daemon 增加 candidate accept/keep/unlock API，所有决定绑定 `baseRevision + requestId`；旧 UI 决定返回结构化 `REVISION_CONFLICT`，同一成功请求幂等重放。
- Studio 增加候选 Inspector、原因/风险/置信度、前后各 1.5 秒循环试听、删除、保留并锁定、重新审阅和冲突自动刷新；高风险删除按钮默认禁用。
- 审阅投影新增按 `candidateId` 去重、按 source time 排序的 canonical candidate queue，并保留多词候选的完整 source range；Studio 不再从单个 token 临时反推候选范围。
- Studio 增加左右键候选导航、Space 循环试听、D 删除、K 保留、U 恢复/重新审阅、候选序号和决定后自动前进；快捷键对输入控件和组合键让路。
- 高风险删除改为显式试听确认门禁：未勾选时 UI 按钮禁用且 D 不写入，勾选后请求携带 `confirmHighRisk: true`；daemon 缺少该字段时拒绝提交且 revision 不变。
- 候选检测器增加相邻精确重复：只跨连续 token、避开标点和单字叠词，删除前一份并保留后一份；重复永不进入 `definite_remove`，ASR confidence 低于 0.6 时升级为 high risk。
- CandidateSet identity 改为包含完整候选 payload，并把默认 detector version 升至 `talking-head-mechanical/0.2.0`，避免算法判断变化后 artifact ID 仍不变。
- Review projection 在同一 `candidateId` 存在多版 artifact 时统一采用最新的同状态 metadata；修复 Inspector 显示 HIGH、文字提示却残留旧版 medium 的不一致。
- Transcript 在切换候选时自动滚动到完整 word/gap target，选中词使用独立 outline；桌面工作区固定可用高度，右侧文稿内部滚动，真实播放器按 16:9 展示。
- 新增 `scripts/dogfood-apply-candidates.mjs` 和 `docs/15-p2-transcript-review-validation.md`，保留真实素材候选、应用、恢复、重放和浏览器证据。
- 新增 `scripts/dogfood-analyze-candidates.mjs`：只把候选 artifact 写入工程，不自动应用删除，并输出可审计分析报告。
- 新增本地 AI 语义审阅：LM Studio 通过 strict JSON Schema 返回重复、重说、明确改口和未完成表达；输入只发送到 loopback HTTP，不允许默认云端上传 Transcript。
- 语义协议改为按标点/停顿生成紧凑阅读行和稳定短 ID，500 词窗口把 243 词真实文稿从 3 次模型调用收敛为 1 次，并避免 4096-token 上下文溢出。
- 模型结果新增独立证据门：重复/重说必须有前后文本相似度，改口必须有明确纠错词或重说证据，未完成表达必须对应真实停顿；发明 ID、倒置 keep range、拆词和重叠范围会被拒绝。
- 重说边界用后一遍共同开头自动收紧；真实模型最初把“校企结合”误带入删除范围，校准后候选准确从“引导青年学子”开始。
- Daemon 增加 revision-bound `POST /api/analyze-semantic` 和持久化 `transcript.semantic-review` job；所有语义候选固定为 high risk，只写 CandidateSet，不自动删除。
- Studio Header 增加“AI 检查重复与改口”，未发现 LM Studio 时明确禁用；`pnpm studio -- <project>` 现在构建并由同一个 daemon 同时服务 Studio/API/media，避免 Vite 页面存活而 daemon 停止造成 502。
- 502/503 现在显示可执行的完整工作区启动命令；启动脚本兼容 pnpm 传入的 `--` 分隔符，并自动发现本地非 embedding 模型，优先选择已验证的大参数模型。
- Studio 信息架构调整为通用剪辑工作区：顶层同时保留 Agent 编辑助手、素材/文稿、Viewer 和时间线；“口播清理”只作为当前激活工具，不再把整个产品表述成独立口播审阅台。时间线使用 `V1 主画面` 和真实素材名，口播候选仍是当前轨道上的可定位投影。
- 新增 `@phosphor-icons/react` 并替换界面中的字符图标；素材/文稿 Tab、素材搜索、候选队列、Viewer 和时间线均连接真实 dogfood 工程数据，没有另建演示状态。

### 当前验证

- 真实 241 秒素材产生 9 个原始静音区间、5 个有效停顿候选；1 个 1.574 秒低风险停顿被应用，4 个短停顿保留为中风险建议，未检测到可安全删除的语气词。
- 首次应用后 Undo 恢复 editable state，重新生成并再次应用后工程为 revision 5、2 个 clip、时间线缩短 1.574 秒；SQLite 5 条 command 从 genesis replay 到 head hash 一致。
- 浏览器读取真实工程并显示 746 个普通 token、4 个待审阅停顿和 1 个已提交停顿；视频 metadata 为 4:01，点击文稿后成功 seek 到约 2:03 并播放。
- 媒体 API 对真实 765,669,362 字节 MOV 返回 `206 Partial Content`、正确 `Content-Range` 和 1,024 字节 payload。
- Local daemon 集成测试经过真实请求解析与 SQLite：已提交删除恢复到 revision 2，同一 restore request 重放仍停留 revision 2。
- 真实工程临时副本完成 REV 5 保留锁定 -> 6、stale accept -> 409、解锁 -> 7、接受 -> 8、幂等重放仍为 8、恢复 -> 9；基准工程仍为 revision 5。
- 浏览器 UI 在同一临时副本完成循环试听、保留锁定 REV 9 -> 10、重新审阅 -> 11、删除 -> 12、恢复 -> 13；每一步统计、按钮和通知均从 daemon 最新投影重建。
- 第二个真实工程临时副本从 REV 5 验证完整快捷键：Right 切换候选、Space 循环试听、K 保留并自动前进至 REV 6、Left + U 重新审阅至 REV 7、D 删除并自动前进至 REV 8、Left + U 恢复至 REV 9；基准工程保持 REV 5。
- 高风险 daemon 集成测试证明无确认请求返回 `HIGH_RISK_CONFIRMATION_REQUIRED` 且工程保持 REV 0，显式确认后才提交至 REV 1；Studio 服务端渲染测试证明 checkbox 未选时删除按钮不可用。
- `CI=true pnpm check` 通过：10 个 workspace project 完成 build、strict typecheck 和共 99 项测试；`git diff --check` 通过；ASR strict JSON 的 Python unittest 另行通过。
- 浏览器验证期间工作区被外部改名为 `/Users/hao/Developer/未命名文件夹`；经 Git remote、dirty worktree 和 `.agentcut` 数据只读核对为同一目录后恢复原路径，没有文件或 revision 丢失。
- 用户提供的两段 1280×720、H.264/AAC、30 fps 正面口播 MP4 已分别完成 ingest、ASR、候选分析与 replay；正式工程均为 revision 4，未自动应用候选。
- 91.73 秒样本生成 13 个停顿候选和 1 个重复候选；78.77 秒样本生成 5 个停顿候选和 1 个重复候选。两条重复的 ASR confidence 仅 0.407/0.041，均升级为 high risk。
- 78.77 秒样本的 `/tmp` 副本验证 high-risk accept：缺少确认返回 409 且保持 REV 4，显式确认到 REV 5 后 6 个词显示删除线，restore 到 REV 6 后全部回到待审阅；正式工程未被修改。
- Chrome accessibility tree 验证候选自动定位到文稿末尾、Inspector/词元都显示 high、checkbox 未选时删除按钮禁用；真实视频首帧与用户截图构图一致，16:9 无拉伸，媒体 Range 返回 206。
- sample-03 真实文稿的高质量本地模型审阅命中 43.78–50.80 秒第一遍“引导青年学子…作识”，保留 53.28 秒开始的完整第二遍；边界校准后不再包含前面的“校企结合”。
- 语义分析经真实 HTTP 写入正式 sample-03 工程 REV 4 -> 5，CandidateSet 只有 1 条 `restatement/high` 候选；job 为 succeeded，SQLite 从 genesis replay 5 条 command，integrity/hash 为 ok。
- Chrome 在单进程 `127.0.0.1:4317` 显示 REV 5、AI 操作按钮和 7 条候选；点击语义候选准确 seek 到 43.78 秒，Inspector 显示“重说 · 7.02 秒 · HIGH”，未勾选试听确认前删除按钮 disabled。
- 新增语义响应、边界收紧、持久化 job、单进程静态服务、Studio API 与 502 错误回归测试；定向测试和 strict typecheck 均通过。
- 通用工作区定向验证通过：Studio strict typecheck、4 个测试文件共 12 项测试和 Vite production build 全部通过；`TimelinePanel` 新增回归测试，锁定通用“时间线”、`V1 主画面`、真实素材名和当前口播工具语义。

### 限制与后续

- 已命中两个精确重复候选和一条长句重说，但三者都只作为 high-risk 人工试听项；明确“说错/不对”已有合成回归，真实改口、误启动和复杂中文语气词仍需标注数据，不能用激进词表补齐功能数量。
- Studio 已完成查看、seek、循环试听、单项接受/保留/解锁/恢复、revision conflict、完整单项键盘审阅、高风险显式确认和本地 AI 语义候选生成；整条真实素材人工验收与批量决策仍未完成，G2 不关闭。
- 当前本地 26B 模型对 243 词文稿一次审阅约 64 秒；这是可用但偏慢的 Alpha 基线，后续需用标注集比较更快模型，不能因速度直接换回已证明会误判拆词的小模型。
- 视觉验收覆盖 Chrome 桌面视口；环境没有 `agent-browser` CLI，已用 Computer Use 确认非空页面、无 Vite overlay、真实播放和 UI 写入闭环，未完成自动化 console 捕获及移动端视觉检查。
- 一次 Proposal 可能包含多个删除，恢复按 transaction 执行整批 inverse；UI 文案必须持续称为“恢复本次提交”，不能暗示只恢复单个词或停顿。
- 新增两段素材只有约 79/92 秒，可作为真实 codec、构图和错误样本，但不计入 G1 要求的 5–15 分钟合格样本；Gate 仍只有 1/5 条满足时长。
- 通用工作区当前只有单条主视频和最小 V1 候选范围，素材多选、多轨拖拽、字幕轨与 B-roll 尚未实现；这是已冻结的信息架构，不代表完整 NLE 已完成。

## 2026-07-18：P1 媒体导入与本地 ASR 基础链（进行中）

### 目标

用本机真实媒体建立 `file -> managed asset -> raw ASR -> stable Transcript` 链路，避免 UI 或 Agent 直接依赖 ffprobe/Provider 临时 JSON。

### 实际改动

- 新增 `@agentcut/media-ingest`：精确解析 ffprobe container/stream/duration/frame rate/audio metadata，流式 SHA-256，临时文件校验后原子 rename，并按 content hash 去重。
- Edit Commands 增加 typed `asset.put/remove`，被 clip/Transcript 引用的 asset 删除会在最终语义验证中原子失败。
- Schema 增加 `AsrProviderArtifact` 和 Transcript `providerArtifactId`，原始 Provider 输出与规范化文字稿分别保存并校验 asset/audio stream binding。
- 新增 `@agentcut/asr-engine`：稳定 word ID、微秒 source range、重叠单调化、无效 token 丢弃统计、payload hash 和可取消的本地 worker runner。
- 新增隔离的 `packages/asr-worker`，固定 `mlx-whisper==0.4.3`，使用 Apple Silicon MLX 与 word timestamps；模型尚在真实素材验证阶段，不提前冻结为默认方案。
- Worker 输出增加 strict JSON 清洗，把 Python `NaN/Infinity` 转成 `null` 并禁止非标准 JSON；normalizer 依据 segment temperature/compression/logprob 丢弃 provider fallback 幻觉，并以音频时长丢弃或 clamp 越界 token。
- Project Store 增加持久化 job/event：pending/running/succeeded/failed/cancelled/outcome_unknown、progress、attempt、retry、取消请求和 output artifact IDs；付费 Provider outcome unknown 禁止自动重试。
- 新增持久化 ASR workflow，把 worker、normalize、artifact transaction 与 job success/failure 串成可重试链路。
- 新增 `scripts/dogfood-ingest-asr.mjs` 和 `docs/14-p1-media-asr-validation.md`，保留首轮真实验证的命令、数据、限制与模型错误。

### 当前验证

- media-ingest 4 项测试通过：真实 FFmpeg 生成媒体探测、原子复制/去重、缺失/非法媒体与无音轨转写前置错误。
- asr-engine 4 项测试通过：稳定 identity、Provider provenance、重叠/置信度规范化、空结果拒绝、artifact commit 和 retryable failure。
- Project Store job tests 覆盖 retry、cancel、outcome unknown、事件和重启持久化。
- `CI=true pnpm check` 通过：6 个 workspace package 构建与 strict typecheck 通过，共 65 项测试通过。
- 本机 241 秒、765,669,362 字节真实中文 MOV 完成导入；完整 ASR 得到 754 个 Provider token，规范化为 746 个稳定 ID，平均 confidence 0.9696，SQLite revision 2 的两条 command replay/hash 一致。
- 视觉核对标题确认专名为“华夏筑影”，模型输出“华夏助影”；60 秒硬截断实验产生低置信尾部重复，均已进入 P1 风险与 benchmark 规则。
- 真实 dogfood 工程中的 ASR job 以 attempt 1 成功，事件序列为 created -> started -> progress -> succeeded，并绑定 raw/Transcript 两个 output artifact ID。
- 两段新增 1280×720 MP4 均完成本地 ASR：91.73 秒样本 226 -> 226 token、平均 confidence 0.9588；78.77 秒样本 258 -> 243 token，5 个不可靠 fallback segment/15 个尾部 token 被丢弃，平均 confidence 0.9429。
- 两个新增项目的最终 token 均未越过音频时长，SQLite ingest revision 2 的两条 command replay/hash 一致；候选 artifact 后续独立推进到 revision 4。

### 限制与后续

- 当前唯一可发现素材是屏幕录制，不一定属于标准正面口播；可验证工程链路，但不能替代 5 条中文口播质量 benchmark。
- MLX 需要沙箱外 Metal 访问；产品必须把该能力做成明确的本地 job runtime，而不是假定任意进程环境都可用。
- 目前处理过 3 条真实素材，但只有首条满足 5–15 分钟 Gate 时长，仍按 1/5 计；新增短样本也没有人工 gold/CER，不能据此冻结默认模型或把 token confidence 当删除 confidence。
- 完整素材 source ranges 已验证单调且未越界，但 cut 边界吞字率仍需人工听审；P1 G1 尚未关闭。

## 2026-07-18：P0 口播契约、Proposal 编译与 Ripple 数据链

### 目标

把“Agent 认为应该删掉某些口播文字”落实为可验证、可锁定、可撤销、可重放的领域数据和 Timeline transaction，而不是直接拼接 FFmpeg 参数。

### 实际改动

- Timeline Schema 增加 typed `TranscriptArtifact`、稳定 `TranscriptWord.id`、`DeletionCandidate`、revision-bound `EditProposalArtifact` 和严格 provenance 引用。
- Candidate set 明确绑定 `transcriptArtifactId + sequenceId + clipId + projectRevision`；只有绑定当前 revision 时检查实时 clip/source range，提交后保留为合法历史证据。
- Edit Commands 增加 `artifact.put/remove`、`clip.split` 和跨轨 `range.deleteRipple`；Ripple 支持中段切片、源时间同步裁切、后续片段前移、锁检查和 inverse undo。
- 新增 Proposal compiler：校验 payload hash/revision，把 ASR 毫秒边界显式吸附到素材帧，合并相邻区间，并按从右向左顺序生成 Ripple operations。
- 新增纯 migration runner：支持合成的 `0.0.0 -> 0.1.0` fixture、dry-run report、输入不变性和未知/更新版本只读保护。
- SQLite 增加覆盖 0.1 全部 edit operation 的 14 次混合提交、checkpoint、重启与 genesis-to-head replay/hash 测试。

### 验证

- `pnpm check` 通过：4 个 workspace package 构建与严格类型检查通过，共 53 项测试通过。
- Timeline Schema：15 项测试通过，包括 word identity/range、proposal/candidate revision、source clip binding、migration 幂等和未知版本保护。
- Edit Commands：23 项测试通过，包括 split、Ripple、锁、Undo、Proposal hash、防篡改、边界吸附、相邻合并、右到左多区间编译，以及 100 轮全 operation 随机生命周期与逆序 Undo。
- Project Store：9 项测试通过；14 次混合 operation 在 SQLite 首次验证与重启后 replay/hash 均一致；10 分钟、1,798 词、90 个删除范围的 Proposal 可提交并重放。
- SQLite `max_page_count` 容量耗尽返回结构化 `STORE_CAPACITY` 且 revision/command 保持为 0；非法 JSON 和 state hash 漂移的数据库副本在 `open` 时返回 `STORE_CORRUPT`。

### 限制与后续

- `0.0.0` 是为 runner 行为建立的合成旧格式，不代表已经存在的发布版；真正变更 0.1 schema 前仍需增加真实的下一版本 fixture。
- ASR 边界当前使用 `nearest` 吸附到素材时间单位；必须在真实语音 cut benchmark 中验证吞字率，并把吸附偏差写入 quality report。
- 本轮以 SQLite page 上限模拟 `SQLITE_FULL`，不是对宿主磁盘真实写满的破坏测试；数据库损坏覆盖逻辑文档/hash 漂移，尚未注入原始 WAL 字节损坏。

## 2026-07-18：建立可信中文口播 Alpha 长程目标

### 目标

把后续工作统一到一个可持续追踪的终点，防止基础设施、UI、模型和渲染各自扩张而没有真实用户闭环。

### 实际改动

- 建立持续目标：真实素材导入与转写、Agent 删除方案、删除线审阅与恢复、非破坏剪辑、字幕/预览/导出、MCP 和 dogfood Gate。
- 新增 `docs/13-long-term-execution-plan.md`，将目标拆为 P0–P5 六个阶段及 G0–G5 退出 Gate。
- 为每个阶段定义交付、失败降级和明确不做项；Alpha 前聚焦 macOS、Codex 和一条默认 ASR 路径。
- 原完整路线图保留为产品地图，但实际执行以本长程计划为准。

### 验证

- 对照第一阶段 Transcript cut、现有 Timeline/store 能力和当前未验证清单，检查阶段依赖没有反向引用。
- 每个阶段都绑定真实产物、自动化测试或真实素材指标，不以功能数量作为完成证明。
- `pnpm check` 通过：4 个 workspace package 构建与严格类型检查通过，共 23 项测试通过。

### 限制与后续

- 14–20 个工程周是相对工作量估计，不是发布日期承诺；真实素材、模型性能和可用人力会改变节奏。
- P0 当前处于进行中；其余阶段必须在前置 Gate 证据足够后再更新为进行中。

## 2026-07-18：确定第一阶段为可信口播文字剪辑

### 目标

把第一阶段从宽泛的“编辑器功能集合”收敛成可验证的口播文字删除闭环。

### 实际改动

- 新增 `docs/12-phase-1-transcript-cut.md`，定义文字稿主界面、删除线语义、候选/提交/恢复状态和退出 Gate。
- 产品定义明确第一阶段不以完整多轨时间线为主，而以播放器同步的 Transcript 为主编辑表面。
- 口播工作流补充停顿/语气词/重复筛选、风险分层、批量应用和重启重建约束。
- README 的下一步调整为真实口播转写、Agent 删除方案、文字审阅和导出纵向闭环。
- 复核 `Agentchengfeng/chengfeng-videocut-skills` 当前默认分支，把稳定 `wordIds`、Skill/Runtime 分层、单写者/CAS、review-ready 门禁和确认后 revision 复查纳入第一阶段协议。
- 修正旧调研对 Chengfeng 项目的描述：当前公开仓库是两 Skill 的 Codex 插件与 Runtime bridge，不包含 Studio/Timeline Runtime 源码，也尚未闭环原视频转写和 renderer。

### 验证

- 核对一份公开剪映智能剪口播图文流程与界面截图，确认文字播放联动、类别计数、候选色块、单项/批量处理等基础模式。
- 将参考中可复用的交互与 AgentCut 的 revision、reason、risk、inverse 和 lock 逐项映射。
- 参考仓库 runtime preflight tests 通过；MCP smoke test 因临时审查目录未安装 `@modelcontextprotocol/sdk` 而未完成，不据此声称插件 E2E 通过。
- AgentCut `pnpm check` 通过：4 个 workspace package 构建与严格类型检查通过，共 23 项测试通过。

### 限制与后续

- 参考资料发布于 2024-03-05，是二手公开资料，不代表剪映 2026 当前完整界面。
- 本轮只冻结产品交互语义，尚未生成 AgentCut 视觉方案或实现 UI；实现前仍需视觉方向选择和可用性验证。
- Chengfeng 的独立产品 Runtime 与 Studio 未安装、未审计，不能视为可直接复用组件；只采用公开仓库中可验证的协议思想。

## 2026-07-18：建立仓库级开发记录制度

### 目标

让开发历史成为版本化资产，避免计划、实现和验证状态在多轮 Agent 协作中失真。

### 实际改动

- 新增根目录 `AGENTS.md`，要求每批有效修改同步维护本文件。
- 在 README 文档索引中加入开发记录入口。
- 更新 `.gitignore`，避免提交本地 pnpm store、依赖目录、构建产物、覆盖率和日志。
- 初始化本地 Git `main` 分支，首次提交为 `a33dbd2`。
- 创建 GitHub 私有仓库 `haoabcde/AgentCut`，配置 `origin` 并推送 `main`。

### 验证

- 核对规则覆盖代码、测试、架构、依赖、配置和产品文档修改。
- GitHub 返回仓库 URL `https://github.com/haoabcde/AgentCut`，首次推送成功且本地 `main` 已跟踪 `origin/main`。

### 限制与后续

- 开发记录依赖提交者遵循仓库规则；后续可增加 CI 检查，验证功能提交是否同步触及本文件。

## 2026-07-18：SQLite 持久化与进程崩溃恢复 Gate

### 目标

把内存事务原型推进为可重启、可审计、无半提交的最小持久化实现。

### 实际改动

- 新增 `@agentcut/project-store`，使用 SQLite WAL、`BEGIN IMMEDIATE` 和 `synchronous=FULL`。
- 将 command、inverse、idempotency payload hash、current state 和 checkpoint 放入同一事务。
- 支持重启后 snapshot、history、undo、idempotent replay 与 genesis-to-head hash 验证。
- 新增真实子进程 `SIGKILL` harness，覆盖 begin、apply、command insert、state update、checkpoint、commit 前和 commit 后边界。

### 验证

- `pnpm check` 通过；4 个 workspace package 构建与严格类型检查通过，共 23 项测试通过。
- commit 前六个死亡点均恢复到 revision 0 且无 command；commit 后死亡恢复到 revision 1 且 command 可 replay。
- 两个数据库连接基于相同 revision 写入时，首个提交成功，第二个得到显式 `REVISION_CONFLICT`。

### 限制与后续

- 尚未覆盖真实断电、磁盘写满、WAL 字节损坏和长项目规模。
- migration runner、未知 major 只读保护和全部 operation 混合 replay 仍属于下一数据正确性 Gate。

## 2026-07-17：产品与技术验证基线

### 目标

在开发完整编辑器前，先定义 AgentCut 的产品边界并验证 Timeline IR、精确时间和受控编辑事务是否成立。

### 实际改动

- 完成调研、产品定义、总体架构、Timeline IR、Agent 接入协议、口播/访谈工作流、路线图和风险审查文档。
- 建立 Timeline IR 0.1 JSON Schema、TypeScript 领域类型和 golden fixture。
- 实现 BigInt rational 精确时间运算、半开区间语义与显式 rounding mode。
- 实现 typed edit operations、revision/precondition/semantic lock、inverse、undo 和内存幂等事务。

### 验证

- Golden fixture、结构语义验证和精确时间测试通过。
- 1,000 组随机 trim/inverse round-trip 通过。

### 限制与后续

- 当时的事务仅在内存中验证，不能证明跨进程恢复可靠性；该缺口已在 2026-07-18 的最小 SQLite Gate 中推进。
- 浏览器预览、FFmpeg parity、中文 ASR benchmark 与 MCP contract 尚未开始实测。
