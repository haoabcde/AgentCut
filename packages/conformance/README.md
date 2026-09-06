# @agentcut/conformance

AgentCut 协议一致性套件：**对任何声称实现 AgentCut 协议 core 面的宿主运行同一组检查**，输出机器可读报告。这是协议规范（`docs/protocol/agentcut-protocol-0.1.md`）的可执行定义，也是 Gate P3 的核心交付。

零运行时依赖；Node ≥ 20（自带 fetch）。

## 运行

```bash
agentcut-conformance \
  --url http://127.0.0.1:4318 \
  --token <bootstrap-token> \
  --host-label my-host \
  --report conformance-report.json \
  --pretty
```

退出码 `0` = verdict pass；非 0 = 存在失败或未许可的跳过。报告 JSON 含逐条检查结果（检查 ID、规范条款、状态、证据）。

## 检查什么

按规范逐条对应（检查 ID 见 `src/checks/index.ts`）：

- **会话**：bootstrap 认证、严格校验（未知/重复/空 capability、TTL）、requestId 幂等重放
- **core 读**：project 概要与 `writePolicy` 声明、transcript 分页一致性（或如实 404）、timeline 结构发现（§6.4 窗口/分页/参数规范性）
- **事务**：201/200 幂等重放、`IDEMPOTENCY_CONFLICT`、`REVISION_CONFLICT`、未知 operation `422`、原子性（混合载荷不落盘）、未知对象 `404`、capability 门禁、actor 强制、协议版本拒绝、审计头限制
- **diff**：窗口内容与 afterHash 一致性、actor 记录、非法窗口 400
- **错误模型**：4xx 一律 `{error: {code, message}}`
- **崩溃恢复**（需提供 controller）：重启后 revision / 幂等账本 / diff 历史必须存续

## 崩溃恢复检查（可选 controller）

库调用方提供 `controller.restart()`（停掉宿主进程并重启，同一持久化数据库），套件才会执行 `crash.recovery-state`；不提供则该检查按 skip 记录。CLI 模式暂不传 controller——需要崩溃恢复证据时用库 API 接线（参考 `apps/local-daemon/src/conformance.test.ts`）。

## 宿主接入（库 API）

```ts
import { runConformance } from "@agentcut/conformance";

const report = await runConformance({
  baseUrl: "http://127.0.0.1:4317",
  bootstrapToken: process.env.MY_HOST_BOOTSTRAP!,
  hostLabel: "my-host",
  // 可选：提供重启控制以获得崩溃恢复证据
  controller: { label: "my-host", restart: async () => restartMyHost() },
});
if (report.verdict !== "pass") process.exit(1);
```

本仓库的参考接线：

- reference-host：`packages/conformance/src/conformance.test.ts`
- local-daemon（第三方宿主视角消费套件的模式）：`apps/local-daemon/src/conformance.test.ts`

## 跳过语义

- 宿主工程没有 clip：事务检查组 skip（`host-content`）。这是合法宿主状态，但跳过必须显式许可（`--allow-skip <checkId>`）才算 pass——否则报告 fail，提示操作者换一个有内容的工程运行。
- 前置检查失败导致的未运行项 skip（`prerequisite`）不要求许可。
- `crash.recovery-state` 无 controller 时 skip（`no-controller`），需要许可或提供 controller。

## 注意

- 套件会对目标工程**写入真实事务**（clip.update 探针）。请对着可丢弃的工程运行；幂等键每次运行随机，可安全重复执行。
- 协议版本不匹配（`/api/health` 返回非 `0.1.0`）时套件立即中止并判 fail，避免对错误版本产生误导性级联失败。
