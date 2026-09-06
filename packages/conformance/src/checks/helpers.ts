import type { CheckResult, CheckStatus, HostController } from "../types.js";

export interface ConformanceCheckContext {
  baseUrl: string;
  bootstrapToken: string;
  clientId: string;
  runId: string;
  /** 由 runner 注入；crash 检查用它重启宿主，其余检查不感知。 */
  controller?: HostController;
  /** 各检查间共享的可变状态；检查按声明顺序执行，后续检查依赖前序记录。 */
  state: {
    protocolVersion: string | null;
    readToken: string | null;
    writeToken: string | null;
    projectId: string | null;
    sequenceId: string | null;
    headRevision: number | null;
    writeCapability: string | null;
    clipId: string | null;
    /** 已提交事务的回放证据，供幂等与崩溃恢复检查复用。 */
    committed: {
      idempotencyKey: string;
      transactionId: string;
      baseRevision: number;
      committedRevision: number;
      afterHash: string | null;
      /** 提交时的完整请求体；幂等重放与崩溃恢复检查需要逐字节一致的载荷。 */
      payload: unknown;
    } | null;
  };
  /** 以 session token 调用宿主；4xx/5xx 返回 status + 解析出的 body（不抛错）。 */
  request: (
    token: string | null,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ) => Promise<{ status: number; body: unknown }>;
}

export interface ConformanceCheck {
  id: string;
  specClause: string;
  /** 返回 pass/fail 结果；需要跳过时抛 SkipCheck（runner 统一处理）。 */
  run: (ctx: ConformanceCheckContext) => Promise<Omit<CheckResult, "id" | "specClause">>;
}

export class SkipCheck extends Error {
  constructor(readonly detail: string, readonly evidence?: Record<string, unknown>) {
    super(detail);
    this.name = "SkipCheck";
  }
}

export function pass(detail: string): { status: CheckStatus; detail: string } {
  return { status: "pass", detail };
}

export function fail(
  detail: string,
  evidence?: Record<string, unknown>,
): { status: CheckStatus; detail: string; evidence?: Record<string, unknown> } {
  return { status: "fail", detail, ...(evidence ? { evidence } : {}) };
}

export function errorBody(value: unknown): { code: unknown; message: unknown } {
  const error = (value as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return { code: error?.code, message: error?.message };
}

export function expectStatus(
  response: { status: number; body: unknown },
  expected: number,
  label: string,
): void {
  if (response.status !== expected) {
    const { code, message } = errorBody(response.body);
    throw new Error(
      `${label}: expected HTTP ${expected}, got ${response.status}`
        + (code ? ` (${String(code)}: ${String(message)})` : ""),
    );
  }
}

export function expect(
  condition: boolean,
  message: string,
  evidence?: Record<string, unknown>,
): void {
  if (!condition) throw new Error(message + (evidence ? ` ${JSON.stringify(evidence)}` : ""));
}
