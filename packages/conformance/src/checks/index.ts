import { createHash } from "node:crypto";
import {
  type ConformanceCheck,
  type ConformanceCheckContext,
  SkipCheck,
  errorBody,
  expect,
  expectStatus,
  fail,
  pass,
} from "./helpers.js";

const CORE_READ_CAPABILITIES = ["project:read", "transcript:read", "timeline:write:low_risk_only"];
const READ_ONLY_CAPABILITIES = ["project:read", "transcript:read"];
const TRANSCRIPT_ONLY_CAPABILITIES = ["transcript:read"];

function stableRunIdSeed(runId: string, label: string): string {
  return createHash("sha256").update(`${runId}:${label}`).digest("hex").slice(0, 12);
}

interface SessionResponse {
  session: {
    id: string;
    projectId?: string;
    clientId: string;
    capabilities: string[];
    expiresAt?: string;
  };
  accessToken: string;
  idempotentReplay: boolean;
}

interface ProjectSummaryResponse {
  protocolVersion: string;
  project: { id: string; name?: string; revision: number; activeSequenceId?: string };
  facts?: Record<string, unknown>;
  capabilities: { extensions: string[]; writePolicy?: { timelineTransactions?: { baseCapability?: string } } };
  session: { id: string; clientId: string; capabilities: string[] };
}

interface TimelineResponse {
  protocolVersion: string;
  project: { id: string; revision: number };
  timeline: {
    sequenceId: string;
    tracks: Array<{ trackId: string; kind: string }>;
    totalClips: number;
    offset: number;
    nextOffset: number | null;
    clips: Array<{
      clipId: string;
      trackId: string;
      startMicros: number;
      durationMicros: number;
      enabled?: boolean;
    }>;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function createSession(
  ctx: ConformanceCheckContext,
  requestIdSuffix: string,
  capabilities: readonly string[],
): Promise<{ status: number; body: unknown }> {
  return ctx.request(ctx.bootstrapToken, "POST", "/api/agent/sessions", {
    requestId: `conf-${ctx.runId}-${requestIdSuffix}`,
    clientId: ctx.clientId,
    capabilities: [...capabilities],
    ttlSeconds: 3_600,
  });
}

/**
 * 套件检查清单（顺序执行；后续检查复用前序记录的状态）。
 * 每个检查对应协议规范的条款；宿主只有全部通过（或经 allowedSkips 许可的跳过）才算 conforming。
 */
export function buildChecks(): ConformanceCheck[] {
  return [
    {
      id: "core.health",
      specClause: "§6.1",
      async run(ctx) {
        const health = await ctx.request(null, "GET", "/api/health");
        expectStatus(health, 200, "GET /api/health");
        const body = health.body as { ok?: unknown; protocolVersion?: unknown };
        if (body.ok !== true || typeof body.protocolVersion !== "string") {
          return fail("health response must be {ok: true, protocolVersion: string}", {
            received: health.body,
          });
        }
        ctx.state.protocolVersion = body.protocolVersion;
        return pass(`host reports protocolVersion ${body.protocolVersion}`);
      },
    },
    {
      id: "core.sessions.reject-bad-bootstrap",
      specClause: "§5.2",
      async run(ctx) {
        const missing = await ctx.request(null, "POST", "/api/agent/sessions", {});
        if (missing.status !== 401) {
          return fail("session creation without credentials must be 401", { status: missing.status });
        }
        const wrong = await ctx.request("definitely-not-the-bootstrap-token", "POST", "/api/agent/sessions", {
          requestId: `conf-${ctx.runId}-wrong-token`,
          clientId: ctx.clientId,
          capabilities: [...CORE_READ_CAPABILITIES],
        });
        if (wrong.status !== 401) {
          return fail("session creation with a wrong bootstrap token must be 401", {
            status: wrong.status,
          });
        }
        const { code } = errorBody(wrong.body);
        if (typeof code !== "string" || code.length === 0) {
          return fail("401 response must carry a machine-readable error code (§9)", {
            body: wrong.body,
          });
        }
        return pass("missing and wrong bootstrap credentials are rejected with 401 + error code");
      },
    },
    {
      id: "core.sessions.create-replay",
      specClause: "§5.2",
      async run(ctx) {
        const created = await createSession(ctx, "main-001", CORE_READ_CAPABILITIES);
        expectStatus(created, 201, "session creation");
        const body = created.body as SessionResponse;
        expect(typeof body.accessToken === "string" && body.accessToken.length > 0, "accessToken missing");
        expect(body.idempotentReplay === false, "first creation must not be a replay");
        expect(Array.isArray(body.session.capabilities) && body.session.capabilities.length > 0,
          "session.capabilities must be a non-empty array (the authoritative grant)");
        ctx.state.readToken = body.accessToken;

        const replay = await createSession(ctx, "main-001", CORE_READ_CAPABILITIES);
        expectStatus(replay, 200, "idempotent session replay");
        const replayBody = replay.body as SessionResponse;
        expect(replayBody.idempotentReplay === true, "replay must set idempotentReplay=true");
        expect(replayBody.session.id === body.session.id, "replay must return the same session id");
        return pass("session created (201) and requestId replay returned the same session (200)");
      },
    },
    {
      id: "core.sessions.strict-validation",
      specClause: "§5.2",
      async run(ctx) {
        const post = (suffix: string, capabilities: unknown, ttlSeconds?: number) =>
          ctx.request(ctx.bootstrapToken, "POST", "/api/agent/sessions", {
            requestId: `conf-${ctx.runId}-${suffix}`,
            clientId: ctx.clientId,
            capabilities,
            ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
          });
        for (const [label, suffix, capabilities, ttlSeconds] of [
          ["unknown capability", "unknown-cap", ["media:fly"]],
          ["duplicate capabilities", "dup-cap", ["project:read", "project:read"]],
          ["empty capabilities", "empty-cap", []],
          ["ttl below minimum", "low-ttl", ["project:read"], 30],
        ] as const) {
          const response = await post(suffix, capabilities, ttlSeconds);
          if (response.status !== 400) {
            return fail(`${label} must be rejected with 400`, { status: response.status, label });
          }
          const { code } = errorBody(response.body);
          if (typeof code !== "string") {
            return fail(`${label}: 400 must carry error.code (§9)`, { body: response.body });
          }
        }
        return pass("unknown/duplicate/empty capabilities and out-of-range ttl are rejected with 400");
      },
    },
    {
      id: "core.project.summary",
      specClause: "§6.2",
      async run(ctx) {
        const response = await ctx.request(ctx.state.readToken, "GET", "/api/agent/project");
        expectStatus(response, 200, "GET /api/agent/project");
        const body = response.body as ProjectSummaryResponse;
        if (!isObject(response.body)) return fail("response must be a JSON object");
        if (typeof body.project?.id !== "string" || typeof body.project?.revision !== "number") {
          return fail("project.id (string) and project.revision (number) are required", {
            received: body.project,
          });
        }
        if (!Array.isArray(body.capabilities?.extensions)) {
          return fail("capabilities.extensions must be an array (§6.2, §10)", {
            received: body.capabilities,
          });
        }
        if (typeof body.session?.id !== "string") {
          return fail("session echo (id) is required", { received: body.session });
        }
        ctx.state.projectId = body.project.id;
        ctx.state.headRevision = body.project.revision;
        ctx.state.sequenceId = body.project.activeSequenceId ?? null;
        return pass(`project summary shape ok (revision ${body.project.revision})`);
      },
    },
    {
      id: "core.project.write-policy",
      specClause: "§6.2",
      async run(ctx) {
        const response = await ctx.request(ctx.state.readToken, "GET", "/api/agent/project");
        expectStatus(response, 200, "GET /api/agent/project");
        const body = response.body as ProjectSummaryResponse;
        const baseCapability =
          body.capabilities?.writePolicy?.timelineTransactions?.baseCapability;
        if (typeof baseCapability !== "string" || baseCapability.length === 0) {
          return fail(
            "capabilities.writePolicy.timelineTransactions.baseCapability is required for hosts implementing the transaction route (§6.2)",
            { received: body.capabilities?.writePolicy ?? null },
          );
        }
        ctx.state.writeCapability = baseCapability;
        return pass(`writePolicy declares baseCapability "${baseCapability}"`);
      },
    },
    {
      id: "core.transcript.behavior",
      specClause: "§6.3",
      async run(ctx) {
        const response = await ctx.request(ctx.state.readToken, "GET", "/api/agent/transcript");
        if (response.status === 404) {
          const { code } = errorBody(response.body);
          if (code !== "OBJECT_NOT_FOUND") {
            return fail("a transcript-less project must 404 with OBJECT_NOT_FOUND", {
              status: response.status, code,
            });
          }
          return pass("host honestly reports no transcript artifact (404 OBJECT_NOT_FOUND)");
        }
        expectStatus(response, 200, "GET /api/agent/transcript");
        const body = response.body as {
          transcript: {
            totalWords: number; offset: number; limit: number; nextOffset: number | null;
            words: Array<{ wordId: string; text: string; startMicros: number; durationMicros: number }>;
          };
        };
        const transcript = body.transcript;
        expect(isObject(transcript), "transcript object missing");
        expect(typeof transcript.totalWords === "number", "totalWords must be a number");
        expect(Array.isArray(transcript.words), "words must be an array");
        for (const [index, word] of transcript.words.entries()) {
          expect(typeof word.wordId === "string" && word.wordId.length > 0,
            `words[${index}].wordId must be a non-empty string (stable word IDs are the addressing unit)`);
          expect(typeof word.text === "string", `words[${index}].text must be a string`);
          expect(typeof word.startMicros === "number" && typeof word.durationMicros === "number",
            `words[${index}] must carry startMicros/durationMicros`);
        }
        const nextPage = await ctx.request(
          ctx.state.readToken, "GET", "/api/agent/transcript?limit=1&offset=1",
        );
        expectStatus(nextPage, 200, "GET /api/agent/transcript?limit=1&offset=1");
        const paged = (nextPage.body as typeof body).transcript;
        expect(paged.offset === 1 && paged.limit === 1, "offset/limit echo must match the query");
        expect(paged.words.length === (transcript.totalWords > 1 ? 1 : 0),
          "limit=1 must return at most one word");
        const expectedNext = 1 + paged.words.length < transcript.totalWords ? 1 + paged.words.length : null;
        expect(paged.nextOffset === expectedNext,
          `nextOffset must be ${String(expectedNext)} at offset 1`, { received: paged.nextOffset });
        return pass(`transcript paging consistent (${transcript.totalWords} words)`);
      },
    },
    {
      id: "core.transcript.param-validation",
      specClause: "§6.3",
      async run(ctx) {
        const probe = await ctx.request(ctx.state.readToken, "GET", "/api/agent/transcript?limit=1&offset=1");
        if (probe.status === 404) {
          return pass("no transcript artifact; parameter validation not exercised");
        }
        for (const query of ["limit=0", "limit=501", "offset=-1"] as const) {
          const response = await ctx.request(ctx.state.readToken, "GET", `/api/agent/transcript?${query}`);
          if (response.status !== 400) {
            return fail(`transcript ${query} must be 400 INVALID_REQUEST`, { status: response.status });
          }
        }
        return pass("out-of-range and non-canonical paging parameters rejected with 400");
      },
    },
    {
      id: "core.timeline.discovery",
      specClause: "§6.4",
      async run(ctx) {
        const response = await ctx.request(ctx.state.readToken, "GET", "/api/agent/timeline");
        expectStatus(response, 200, "GET /api/agent/timeline");
        const body = response.body as TimelineResponse;
        const timeline = body.timeline;
        expect(typeof timeline?.sequenceId === "string", "timeline.sequenceId required");
        expect(Array.isArray(timeline.tracks), "timeline.tracks must be an array");
        expect(typeof timeline.totalClips === "number" && timeline.totalClips >= 0,
          "timeline.totalClips must be a non-negative number");
        expect(timeline.clips.length <= timeline.totalClips, "clips page cannot exceed totalClips");
        const expectedNext = timeline.offset + timeline.clips.length < timeline.totalClips
          ? timeline.offset + timeline.clips.length
          : null;
        expect(timeline.nextOffset === expectedNext, "nextOffset must follow §6.3 paging semantics",
          { received: timeline.nextOffset, expected: expectedNext });
        for (const [index, clip] of timeline.clips.entries()) {
          expect(typeof clip.clipId === "string" && clip.clipId.length > 0,
            `clips[${index}].clipId required (§7 object IDs are learned here)`);
          expect(typeof clip.trackId === "string", `clips[${index}].trackId required`);
          expect(typeof clip.startMicros === "number" && typeof clip.durationMicros === "number",
            `clips[${index}] must carry startMicros/durationMicros`);
        }
        ctx.state.sequenceId = timeline.sequenceId;
        if (timeline.clips.length > 0) {
          ctx.state.clipId = timeline.clips[0]!.clipId;
        }

        const unknownSequence = await ctx.request(
          ctx.state.readToken, "GET", "/api/agent/timeline?sequenceId=conf_missing_sequence",
        );
        if (unknownSequence.status !== 404
          || errorBody(unknownSequence.body).code !== "OBJECT_NOT_FOUND") {
          return fail("unknown sequenceId must 404 OBJECT_NOT_FOUND", {
            status: unknownSequence.status, body: unknownSequence.body,
          });
        }
        const windowed = await ctx.request(
          ctx.state.readToken, "GET", "/api/agent/timeline?fromMicros=0&toMicros=9007199254740991",
        );
        expectStatus(windowed, 200, "GET /api/agent/timeline with full window");
        return pass(`timeline discovery ok (${timeline.totalClips} clips in active sequence)`);
      },
    },
    {
      id: "core.timeline.param-validation",
      specClause: "§6.4",
      async run(ctx) {
        for (const query of [
          "fromMicros=5&toMicros=4",
          "fromMicros=01",
          "toMicros=-1",
          "limit=0",
        ] as const) {
          const response = await ctx.request(ctx.state.readToken, "GET", `/api/agent/timeline?${query}`);
          if (response.status !== 400) {
            return fail(`timeline ${query} must be 400 INVALID_REQUEST`, { status: response.status });
          }
          const { code } = errorBody(response.body);
          if (typeof code !== "string") {
            return fail(`timeline ${query}: 400 must carry error.code (§9)`, { body: response.body });
          }
        }
        return pass("window order, canonical integers, and paging bounds enforced with 400");
      },
    },
    {
      id: "core.timeline.capability-gating",
      specClause: "§6.4",
      async run(ctx) {
        const session = await createSession(ctx, "transcript-only-001", TRANSCRIPT_ONLY_CAPABILITIES);
        expectStatus(session, 201, "transcript-only session creation");
        const token = (session.body as SessionResponse).accessToken;
        const response = await ctx.request(token, "GET", "/api/agent/timeline");
        if (response.status !== 403 || errorBody(response.body).code !== "CAPABILITY_DENIED") {
          return fail("a session without project:read must get 403 CAPABILITY_DENIED on /api/agent/timeline", {
            status: response.status, body: response.body,
          });
        }
        return pass("timeline read requires project:read; insufficient session gets 403 CAPABILITY_DENIED");
      },
    },
    {
      id: "core.transactions.apply",
      specClause: "§7",
      async run(ctx) {
        if (ctx.state.clipId === null) {
          throw new SkipCheck(
            "no clips discovered via §6.4; transaction checks cannot probe this host — run against a project with at least one clip",
            { skipReason: "host-content" },
          );
        }
        const summary = await ctx.request(ctx.state.readToken, "GET", "/api/agent/project");
        expectStatus(summary, 200, "GET /api/agent/project");
        const currentRevision = (summary.body as ProjectSummaryResponse).project.revision;
        const key = `conf:${stableRunIdSeed(ctx.runId, "tx-001")}`;
        const payload = {
          protocolVersion: "0.1.0",
          transactionId: `tx-conf-${stableRunIdSeed(ctx.runId, "tx-001")}`,
          idempotencyKey: key,
          projectId: ctx.state.projectId,
          sequenceId: ctx.state.sequenceId,
          baseRevision: currentRevision,
          actor: { kind: "user", id: "conformance-spoofed-actor" },
          reason: "AgentCut conformance probe (clip.update)",
          preconditions: [],
          operations: [{ type: "clip.update", clipId: ctx.state.clipId, patch: { enabled: true } }],
        };
        const applied = await ctx.request(ctx.state.readToken, "POST", "/api/agent/timeline/transactions", payload, {
          "x-agentcut-request-id": key,
        });
        expectStatus(applied, 201, "first transaction apply");
        const body = applied.body as {
          revision: number; idempotentReplay: boolean;
          record: { committedRevision: number; afterHash?: string };
        };
        expect(body.idempotentReplay === false, "first apply must not be a replay");
        expect(body.revision === currentRevision + 1, "revision must increment by exactly one");
        expect(body.record.committedRevision === body.revision, "record.committedRevision must equal new revision");
        ctx.state.writeToken = ctx.state.readToken;
        ctx.state.headRevision = body.revision;
        ctx.state.committed = {
          idempotencyKey: key,
          transactionId: payload.transactionId,
          baseRevision: currentRevision,
          committedRevision: body.revision,
          afterHash: typeof body.record.afterHash === "string" ? body.record.afterHash : null,
          payload,
        };
        return pass(`transaction applied (revision ${currentRevision} → ${body.revision})`);
      },
    },
    {
      id: "core.transactions.replay",
      specClause: "§7.4",
      async run(ctx) {
        const committed = ctx.state.committed;
        if (!committed) throw new SkipCheck("prerequisite core.transactions.apply did not commit", { skipReason: "prerequisite" });
        const replay = await ctx.request(
          ctx.state.readToken, "POST", "/api/agent/timeline/transactions", committed.payload,
        );
        expectStatus(replay, 200, "idempotent replay");
        const body = replay.body as { revision: number; idempotentReplay: boolean };
        expect(body.idempotentReplay === true, "replay must set idempotentReplay=true");
        expect(body.revision === committed.committedRevision, "replay must return the committed revision");
        return pass("exact retry with the same idempotencyKey replays (200) without a second revision");
      },
    },
    {
      id: "core.transactions.idempotency-conflict",
      specClause: "§7.4",
      async run(ctx) {
        const committed = ctx.state.committed;
        if (!committed) throw new SkipCheck("prerequisite core.transactions.apply did not commit", { skipReason: "prerequisite" });
        const payload = committed.payload as { operations: unknown[]; transactionId: string };
        const conflict = await ctx.request(
          ctx.state.readToken, "POST", "/api/agent/timeline/transactions",
          {
            ...payload,
            transactionId: `${committed.transactionId}-mutated`,
            operations: [{ type: "clip.update", clipId: ctx.state.clipId ?? "clip_conf_probe", patch: { enabled: false } }],
          },
        );
        if (conflict.status !== 409 || errorBody(conflict.body).code !== "IDEMPOTENCY_CONFLICT") {
          return fail("same idempotencyKey with a different payload must 409 IDEMPOTENCY_CONFLICT", {
            status: conflict.status, body: conflict.body,
          });
        }
        return pass("payload mutation under a used idempotencyKey rejected with 409 IDEMPOTENCY_CONFLICT");
      },
    },
    {
      id: "core.transactions.revision-conflict",
      specClause: "§7.2",
      async run(ctx) {
        const committed = ctx.state.committed;
        if (!committed) throw new SkipCheck("prerequisite core.transactions.apply did not commit", { skipReason: "prerequisite" });
        const payload = committed.payload as Record<string, unknown>;
        const stale = await ctx.request(
          ctx.state.readToken, "POST", "/api/agent/timeline/transactions",
          {
            ...payload,
            transactionId: `tx-conf-${stableRunIdSeed(ctx.runId, "stale")}`,
            idempotencyKey: `conf:${stableRunIdSeed(ctx.runId, "stale")}`,
            baseRevision: Math.max(0, committed.committedRevision - 1),
          },
        );
        if (stale.status !== 409 || errorBody(stale.body).code !== "REVISION_CONFLICT") {
          return fail("stale baseRevision with a fresh key must 409 REVISION_CONFLICT", {
            status: stale.status, body: stale.body,
          });
        }
        return pass("stale baseRevision rejected with 409 REVISION_CONFLICT");
      },
    },
    {
      id: "core.transactions.unknown-operation",
      specClause: "§7.2/§8",
      async run(ctx) {
        const committed = ctx.state.committed;
        if (!committed) throw new SkipCheck("prerequisite core.transactions.apply did not commit", { skipReason: "prerequisite" });
        const payload = committed.payload as Record<string, unknown>;
        const response = await ctx.request(
          ctx.state.readToken, "POST", "/api/agent/timeline/transactions",
          {
            ...payload,
            transactionId: `tx-conf-${stableRunIdSeed(ctx.runId, "unknown-op")}`,
            idempotencyKey: `conf:${stableRunIdSeed(ctx.runId, "unknown-op")}`,
            // 指向当前 head：否则会先命中 REVISION_CONFLICT 而测不到 operation 语义。
            baseRevision: ctx.state.headRevision,
            operations: [{ type: "clip.hallucinate", clipId: ctx.state.clipId }],
          },
        );
        if (response.status !== 422 || errorBody(response.body).code !== "INVALID_OPERATION") {
          return fail("unknown operation type must 422 INVALID_OPERATION (§8: the whole transaction is rejected)", {
            status: response.status, body: response.body,
          });
        }
        return pass("unknown operation type rejected with 422 INVALID_OPERATION");
      },
    },
    {
      id: "core.transactions.atomicity",
      specClause: "§7.2",
      async run(ctx) {
        const committed = ctx.state.committed;
        if (!committed || ctx.state.clipId === null) {
          throw new SkipCheck("prerequisite core.transactions.apply did not commit", { skipReason: "prerequisite" });
        }
        const payload = committed.payload as Record<string, unknown>;
        const before = await ctx.request(ctx.state.readToken, "GET", "/api/agent/project");
        const revisionBefore = (before.body as ProjectSummaryResponse).project.revision;
        const response = await ctx.request(
          ctx.state.readToken, "POST", "/api/agent/timeline/transactions",
          {
            ...payload,
            transactionId: `tx-conf-${stableRunIdSeed(ctx.runId, "atomic")}`,
            idempotencyKey: `conf:${stableRunIdSeed(ctx.runId, "atomic")}`,
            // 指向当前 head：否则会先命中 REVISION_CONFLICT 而测不到原子性。
            baseRevision: ctx.state.headRevision,
            operations: [
              { type: "clip.update", clipId: ctx.state.clipId, patch: { enabled: true } },
              { type: "clip.hallucinate", clipId: ctx.state.clipId },
            ],
          },
        );
        if (response.status !== 422) {
          return fail("a transaction mixing valid and invalid operations must be rejected 422", {
            status: response.status, body: response.body,
          });
        }
        const after = await ctx.request(ctx.state.readToken, "GET", "/api/agent/project");
        const revisionAfter = (after.body as ProjectSummaryResponse).project.revision;
        expect(revisionAfter === revisionBefore,
          "rejected transaction must not change the revision (all-or-nothing)");
        return pass("mixed transaction rejected atomically; revision unchanged");
      },
    },
    {
      id: "core.transactions.missing-object",
      specClause: "§7.2",
      async run(ctx) {
        const committed = ctx.state.committed;
        if (!committed) throw new SkipCheck("prerequisite core.transactions.apply did not commit", { skipReason: "prerequisite" });
        const payload = committed.payload as Record<string, unknown>;
        const response = await ctx.request(
          ctx.state.readToken, "POST", "/api/agent/timeline/transactions",
          {
            ...payload,
            transactionId: `tx-conf-${stableRunIdSeed(ctx.runId, "missing")}`,
            idempotencyKey: `conf:${stableRunIdSeed(ctx.runId, "missing")}`,
            baseRevision: ctx.state.headRevision,
            operations: [{ type: "clip.update", clipId: "clip_conf_missing", patch: { enabled: true } }],
          },
        );
        if (response.status !== 404 || errorBody(response.body).code !== "OBJECT_NOT_FOUND") {
          return fail("operations addressing unknown objects must 404 OBJECT_NOT_FOUND", {
            status: response.status, body: response.body,
          });
        }
        return pass("unknown object ID rejected with 404 OBJECT_NOT_FOUND (agents must not guess IDs)");
      },
    },
    {
      id: "core.transactions.capability-gating",
      specClause: "§6.2/§7",
      async run(ctx) {
        const session = await createSession(ctx, "readonly-write-probe-001", READ_ONLY_CAPABILITIES);
        expectStatus(session, 201, "read-only session creation");
        const token = (session.body as SessionResponse).accessToken;
        const response = await ctx.request(token, "POST", "/api/agent/timeline/transactions", {
          protocolVersion: "0.1.0",
          transactionId: `tx-conf-${stableRunIdSeed(ctx.runId, "gating")}`,
          idempotencyKey: `conf:${stableRunIdSeed(ctx.runId, "gating")}`,
          projectId: ctx.state.projectId,
          sequenceId: ctx.state.sequenceId,
          baseRevision: ctx.state.headRevision ?? 0,
          reason: "conformance capability probe",
          preconditions: [],
          operations: [{ type: "clip.update", clipId: ctx.state.clipId ?? "clip_conf_probe", patch: { enabled: true } }],
        });
        if (response.status !== 403 || errorBody(response.body).code !== "CAPABILITY_DENIED") {
          return fail("a session lacking the writePolicy baseCapability must get 403 CAPABILITY_DENIED", {
            status: response.status, body: response.body,
          });
        }
        return pass("transaction route enforces the declared base capability (403 CAPABILITY_DENIED)");
      },
    },
    {
      id: "core.transactions.protocol-version",
      specClause: "§3/§7.1",
      async run(ctx) {
        const committed = ctx.state.committed;
        if (!committed) throw new SkipCheck("prerequisite core.transactions.apply did not commit", { skipReason: "prerequisite" });
        const payload = committed.payload as Record<string, unknown>;
        const response = await ctx.request(
          ctx.state.readToken, "POST", "/api/agent/timeline/transactions",
          {
            ...payload,
            transactionId: `tx-conf-${stableRunIdSeed(ctx.runId, "version")}`,
            idempotencyKey: `conf:${stableRunIdSeed(ctx.runId, "version")}`,
            protocolVersion: "9.9.0",
          },
        );
        if (response.status !== 400) {
          return fail("an unsupported protocolVersion must be explicitly rejected with 400, never silently accepted", {
            status: response.status, body: response.body,
          });
        }
        return pass("unsupported protocolVersion rejected with 400");
      },
    },
    {
      id: "core.transactions.audit-header",
      specClause: "§5.3",
      async run(ctx) {
        const committed = ctx.state.committed;
        if (!committed) throw new SkipCheck("prerequisite core.transactions.apply did not commit", { skipReason: "prerequisite" });
        const payload = committed.payload as Record<string, unknown>;
        const response = await ctx.request(
          ctx.state.readToken, "POST", "/api/agent/timeline/transactions", payload,
          { "x-agentcut-request-id": "x".repeat(129) },
        );
        if (response.status !== 400) {
          return fail("X-AgentCut-Request-Id longer than 128 characters must be rejected with 400", {
            status: response.status, body: response.body,
          });
        }
        return pass("oversized audit request-id header rejected with 400");
      },
    },
    {
      id: "core.diff.window",
      specClause: "§6.5",
      async run(ctx) {
        const committed = ctx.state.committed;
        if (!committed) throw new SkipCheck("prerequisite core.transactions.apply did not commit", { skipReason: "prerequisite" });
        const response = await ctx.request(
          ctx.state.readToken, "GET",
          `/api/agent/project/diff?fromRevision=${committed.baseRevision}`,
        );
        expectStatus(response, 200, "GET /api/agent/project/diff");
        const body = response.body as {
          projectId: string; fromRevision: number; toRevision: number; headRevision: number;
          changes: Array<{
            transactionId: string; committedRevision: number; actor: { kind: string; id: string };
            operationTypes: string[]; objectIds: string[]; afterHash: string;
          }>;
        };
        expect(body.headRevision === ctx.state.headRevision, "headRevision must match the project summary");
        const entry = body.changes.find((change) => change.transactionId === committed.transactionId);
        if (!entry) {
          return fail("diff window must contain the committed conformance transaction", {
            fromRevision: committed.baseRevision,
            transactionIds: body.changes.map((change) => change.transactionId),
          });
        }
        expect(Array.isArray(entry.operationTypes) && entry.operationTypes.length > 0,
          "diff entry must list operationTypes");
        expect(Array.isArray(entry.objectIds) && entry.objectIds.length > 0,
          "diff entry must list objectIds");
        expect(typeof entry.afterHash === "string" && entry.afterHash.length > 0,
          "diff entry must carry afterHash (§6.5 out-of-band edit detection)");
        if (committed.afterHash !== null) {
          expect(entry.afterHash === committed.afterHash,
            "diff afterHash must equal the apply response's afterHash");
        }
        return pass("diff window contains the committed transaction with operations, objects, and hashes");
      },
    },
    {
      id: "core.diff.actor-forcing",
      specClause: "§7.1",
      async run(ctx) {
        const committed = ctx.state.committed;
        if (!committed) throw new SkipCheck("prerequisite core.transactions.apply did not commit", { skipReason: "prerequisite" });
        const response = await ctx.request(
          ctx.state.readToken, "GET",
          `/api/agent/project/diff?fromRevision=${committed.baseRevision}`,
        );
        expectStatus(response, 200, "GET /api/agent/project/diff");
        const body = response.body as {
          changes: Array<{ transactionId: string; actor: { kind: string; id: string } }>;
        };
        const entry = body.changes.find((change) => change.transactionId === committed.transactionId);
        if (!entry) return fail("committed transaction missing from diff window");
        expect(entry.actor.kind === "agent" && entry.actor.id === ctx.clientId,
          `actor must be forced to the session identity {kind: "agent", id: "${ctx.clientId}"} (request body actor is ignored)`,
          { received: entry.actor });
        return pass("request actor ignored; diff records the session identity");
      },
    },
    {
      id: "core.diff.invalid-windows",
      specClause: "§6.5",
      async run(ctx) {
        const head = ctx.state.headRevision ?? 0;
        for (const query of [
          `fromRevision=${head}&toRevision=${Math.max(0, head - 1)}`,
          `fromRevision=${head + 1}`,
          "fromRevision=01",
        ] as const) {
          const response = await ctx.request(ctx.state.readToken, "GET", `/api/agent/project/diff?${query}`);
          if (response.status !== 400) {
            return fail(`diff ${query} must be 400 INVALID_REQUEST`, { status: response.status });
          }
        }
        return pass("diff window constraint 0 <= from <= to <= head enforced with 400");
      },
    },
    {
      id: "core.errors.machine-readable",
      specClause: "§9",
      async run(ctx) {
        const response = await ctx.request(
          ctx.state.readToken, "GET", "/api/agent/project/diff?fromRevision=999999999",
        );
        if (response.status < 400) {
          return fail("an out-of-range diff window must be rejected (this probe expects a 4xx)", {
            status: response.status,
          });
        }
        const { code, message } = errorBody(response.body);
        if (typeof code !== "string" || code.length === 0 || typeof message !== "string") {
          return fail("error responses must be {error: {code, message}} machine-readable bodies", {
            body: response.body,
          });
        }
        return pass(`4xx errors carry machine-readable {error: {code, message}} (probe: ${code})`);
      },
    },
    {
      id: "crash.recovery-state",
      specClause: "§7.4/§11",
      async run(ctx) {
        const committed = ctx.state.committed;
        if (!committed) throw new SkipCheck("prerequisite core.transactions.apply did not commit", { skipReason: "prerequisite" });
        if (!ctx.controller) {
          throw new SkipCheck(
            "no host controller provided; crash-recovery checks need the runner to be able to restart the host",
            { skipReason: "no-controller" },
          );
        }
        const newBaseUrl = await ctx.controller.restart();
        ctx.baseUrl = newBaseUrl;
        const project = await ctx.request(ctx.state.readToken, "GET", "/api/agent/project");
        expectStatus(project, 200, "GET /api/agent/project after restart");
        const revision = (project.body as ProjectSummaryResponse).project.revision;
        expect(revision === committed.committedRevision,
          `revision must survive restart (expected ${committed.committedRevision})`, { received: revision });
        const replay = await ctx.request(
          ctx.state.readToken, "POST", "/api/agent/timeline/transactions", committed.payload,
        );
        expectStatus(replay, 200, "idempotent replay after restart");
        const replayBody = replay.body as { revision: number; idempotentReplay: boolean };
        expect(replayBody.idempotentReplay === true && replayBody.revision === committed.committedRevision,
          "the committed idempotency key must still replay after restart (no duplicate application)");
        const diff = await ctx.request(
          ctx.state.readToken, "GET",
          `/api/agent/project/diff?fromRevision=${committed.baseRevision}`,
        );
        expectStatus(diff, 200, "GET /api/agent/project/diff after restart");
        const diffBody = diff.body as {
          changes: Array<{ transactionId: string; afterHash: string }>;
        };
        const entry = diffBody.changes.find((change) => change.transactionId === committed.transactionId);
        expect(entry !== undefined, "committed transaction must survive restart in the diff history");
        if (committed.afterHash !== null && entry) {
          expect(entry.afterHash === committed.afterHash, "afterHash must be stable across restart");
        }
        return pass("revision, idempotency ledger, and diff history survive a host restart");
      },
    },
  ];
}
