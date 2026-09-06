/** AgentCut 协议一致性套件的报告与选项类型（协议规范 docs/protocol/agentcut-protocol-0.1.md §2/§12）。 */

export const CONFORMANCE_SUITE_VERSION = "0.1.0";

/** 套件针对的协议版本；宿主 /api/health 返回其他版本时整体判 fail。 */
export const TARGET_PROTOCOL_VERSION = "0.1.0";

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  id: string;
  specClause: string;
  status: CheckStatus;
  detail: string;
  /** fail/skip 时的补充字段（如期望/实际值），保持 JSON 可读。 */
  evidence?: Record<string, unknown>;
}

export interface ConformanceReport {
  suite: "agentcut-conformance";
  suiteVersion: string;
  targetProtocolVersion: string;
  host: {
    label: string;
    baseUrl: string;
    reportedProtocolVersion: string | null;
  };
  startedAt: string;
  finishedAt: string;
  summary: { total: number; passed: number; failed: number; skipped: number };
  checks: CheckResult[];
  /** pass = 全部通过（或跳过项均获许可）；fail = 存在失败或未许可跳过。 */
  verdict: "pass" | "fail";
}

export interface ConformanceOptions {
  /** 宿主 base URL，例如 http://127.0.0.1:4318 */
  baseUrl: string;
  /** 宿主 bootstrap token（只用于创建 session，绝不能用于其他路由）。 */
  bootstrapToken: string;
  /** 报告里的宿主标识，例如 "reference-host"、"talkcut-daemon"。 */
  hostLabel?: string;
  /**
   * 提供宿主重启控制后，套件执行崩溃恢复检查（重启后 revision/幂等/diff 状态必须存续）。
   * 返回重启后的 base URL（端口可能变化）。
   */
  controller?: HostController;
  /** 允许跳过的检查 ID 清单（如宿主工程无 clip 时的事务检查组）。未列出的跳过计入 verdict fail。 */
  allowedSkips?: readonly string[];
  /** 请求 session 时的 client 标识，默认 "agentcut-conformance"。 */
  clientId?: string;
}

export interface HostController {
  label: string;
  /** 停止并重启宿主（同一持久化数据库与 bootstrap token），返回重启后的 base URL。 */
  restart: () => Promise<string>;
}
