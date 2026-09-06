import { randomUUID } from "node:crypto";
import { buildChecks } from "./checks/index.js";
import { SkipCheck, type ConformanceCheckContext } from "./checks/helpers.js";
import {
  CONFORMANCE_SUITE_VERSION,
  TARGET_PROTOCOL_VERSION,
  type CheckResult,
  type ConformanceOptions,
  type ConformanceReport,
} from "./types.js";

export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const startedAt = new Date().toISOString();
  const checks = buildChecks();
  const results: CheckResult[] = [];
  const allowedSkips = new Set(options.allowedSkips ?? []);

  const ctx: ConformanceCheckContext = {
    baseUrl: options.baseUrl,
    bootstrapToken: options.bootstrapToken,
    clientId: options.clientId ?? "agentcut-conformance",
    runId: randomUUID(),
    ...(options.controller ? { controller: options.controller } : {}),
    state: {
      protocolVersion: null,
      readToken: null,
      writeToken: null,
      projectId: null,
      sequenceId: null,
      headRevision: null,
      writeCapability: null,
      clipId: null,
      committed: null,
    },
    async request(token, method, path, body, extraHeaders = {}) {
      const response = await fetch(new URL(path, ctx.baseUrl), {
        method,
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        // 非 JSON 响应由调用检查以“body 无法解析”为由判 fail。
      }
      return { status: response.status, body: parsed };
    },
  };

  let abortReason: string | null = null;
  for (const check of checks) {
    if (abortReason !== null) {
      results.push({
        id: check.id,
        specClause: check.specClause,
        status: "skip",
        detail: `not run: ${abortReason}`,
        evidence: { skipReason: "prerequisite" },
      });
      continue;
    }
    try {
      const outcome = await check.run(ctx);
      results.push({ id: check.id, specClause: check.specClause, ...outcome });
    } catch (error) {
      if (error instanceof SkipCheck) {
        results.push({
          id: check.id,
          specClause: check.specClause,
          status: "skip",
          detail: error.detail,
          ...(error.evidence ? { evidence: error.evidence } : {}),
        });
      } else {
        results.push({
          id: check.id,
          specClause: check.specClause,
          status: "fail",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // 协议版本不匹配时套件的全部其他假设失效：立即中止，避免误导性的级联失败。
    if (check.id === "core.health"
      && ctx.state.protocolVersion !== null
      && ctx.state.protocolVersion !== TARGET_PROTOCOL_VERSION) {
      abortReason =
        `host protocolVersion ${ctx.state.protocolVersion} is not supported by this suite (targets ${TARGET_PROTOCOL_VERSION})`;
      const index = results.findIndex((result) => result.id === "core.health");
      results[index] = {
        id: check.id,
        specClause: check.specClause,
        status: "fail",
        detail: abortReason,
        evidence: { reported: ctx.state.protocolVersion, target: TARGET_PROTOCOL_VERSION },
      };
    }
  }

  const unpermittedSkips = results.filter((result) =>
    result.status === "skip"
    && result.evidence?.skipReason !== "prerequisite"
    && !allowedSkips.has(result.id)
  );
  const failed = results.filter((result) => result.status === "fail").length;
  const skipped = results.filter((result) => result.status === "skip").length;
  const verdict = failed === 0 && unpermittedSkips.length === 0 ? "pass" : "fail";

  return {
    suite: "agentcut-conformance",
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    targetProtocolVersion: TARGET_PROTOCOL_VERSION,
    host: {
      label: options.hostLabel ?? "unknown-host",
      baseUrl: options.baseUrl,
      reportedProtocolVersion: ctx.state.protocolVersion,
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: {
      total: results.length,
      passed: results.filter((result) => result.status === "pass").length,
      failed,
      skipped,
    },
    checks: results,
    verdict,
  };
}
