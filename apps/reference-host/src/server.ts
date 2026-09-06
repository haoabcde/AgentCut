import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EditError, type EditOperation, type EditTransaction } from "@agentcut/edit-commands";
import {
  ProjectStore,
  ProjectStoreError,
  type AgentCapability,
  type AgentSession,
  type ProjectStoreOptions,
} from "@agentcut/project-store";
import type { AgentCutProjectDocument, TranscriptArtifact } from "@agentcut/timeline-schema";

export const REFERENCE_PROTOCOL_VERSION = "0.1.0";

/**
 * 最小参考宿主：只用 project-store 实现协议 core 面
 * （project 概要、Transcript 读取、project diff、任意合法 timeline transaction、capability session）。
 * 不含媒体导入、ASR、候选、渲染与导出——那些属于宿主扩展。
 */
export interface ReferenceHostOptions {
  databasePath: string;
  agentBootstrapToken?: string | undefined;
  agentAccessClock?: (() => string) | undefined;
  allowedOrigin?: string | undefined;
  storeOptions?: ProjectStoreOptions | undefined;
}

export class ReferenceHostError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ReferenceHostError";
  }
}

const AGENT_CAPABILITIES: readonly AgentCapability[] = [
  "project:read",
  "transcript:read",
  "analysis:local",
  "analysis:propose",
  "timeline:write:low_risk_only",
  "approval:request",
  "timeline:write:approved",
  "export:write",
];

export function createReferenceHost(options: ReferenceHostOptions): Server {
  const openStore = (): ProjectStore =>
    ProjectStore.open(options.databasePath, {
      ...(options.storeOptions ?? {}),
      ...(options.agentAccessClock ? { clock: options.agentAccessClock } : {}),
    });

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, protocolVersion: REFERENCE_PROTOCOL_VERSION }, options.allowedOrigin);
        return;
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders(options.allowedOrigin));
        response.end();
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/agent/sessions") {
        const bootstrap = requiredBootstrap(options);
        assertSecret(readBearerToken(request), bootstrap, "AGENT_BOOTSTRAP_DENIED");
        const body = await readJsonBody(request);
        const requestId = readStableString(body, "requestId", 128);
        const clientId = readStableString(body, "clientId", 128);
        const capabilities = readCapabilities(body);
        const ttlSeconds = readTtlSeconds(body);
        const store = openStore();
        try {
          const projectId = store.snapshot().project.id;
          const sessionId = `session_${createHash("sha256")
            .update(`${projectId}\0${clientId}\0${requestId}`)
            .digest("hex")
            .slice(0, 24)}`;
          const accessToken = `agc_${createHmac("sha256", bootstrap)
            .update(`agentcut:${sessionId}`)
            .digest("base64url")}`;
          const creation = store.createAgentSession({
            id: sessionId,
            requestId,
            clientId,
            capabilities,
            ttlSeconds,
            tokenHash: hashToken(accessToken),
          });
          sendJson(response, creation.idempotentReplay ? 200 : 201, {
            session: creation.session,
            accessToken,
            idempotentReplay: creation.idempotentReplay,
          }, options.allowedOrigin);
        } finally {
          store.close();
        }
        return;
      }

      const capability = coreRouteCapability(request.method ?? "", url.pathname);
      if (capability === undefined) {
        throw new ReferenceHostError(404, "NOT_FOUND", `No reference-host route for ${request.method} ${url.pathname}`);
      }
      const store = openStore();
      try {
        const session = store.authorizeAgentSession({
          tokenHash: hashToken(readBearerToken(request)),
          capability,
          method: request.method ?? "",
          path: url.pathname,
          ...(readRequestIdHeader(request) ? { requestId: readRequestIdHeader(request)! } : {}),
        });

        if (request.method === "GET" && url.pathname === "/api/agent/project") {
          sendJson(response, 200, projectSummary(store.snapshot(), session), options.allowedOrigin);
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/agent/transcript") {
          sendJson(response, 200, transcriptPage(store.snapshot(), url), options.allowedOrigin);
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/agent/project/diff") {
          sendJson(response, 200, projectDiff(store, url), options.allowedOrigin);
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/agent/timeline/transactions") {
          const body = await readJsonBody(request);
          const result = applyTimelineTransaction(store, body, session);
          sendJson(response, result.idempotentReplay ? 200 : 201, result, options.allowedOrigin);
          return;
        }
        throw new ReferenceHostError(404, "NOT_FOUND", `No reference-host route for ${request.method} ${url.pathname}`);
      } finally {
        store.close();
      }
    } catch (error) {
      sendError(response, error, options.allowedOrigin);
    }
  });
}

function coreRouteCapability(method: string, path: string): AgentCapability | undefined {
  if (method === "GET" && path === "/api/agent/project") return "project:read";
  if (method === "GET" && path === "/api/agent/transcript") return "transcript:read";
  if (method === "GET" && path === "/api/agent/project/diff") return "project:read";
  if (method === "POST" && path === "/api/agent/timeline/transactions") {
    return "timeline:write:low_risk_only";
  }
  return undefined;
}

function projectSummary(document: AgentCutProjectDocument, session: AgentSession): unknown {
  const clips = document.sequences.flatMap((sequence) =>
    sequence.tracks.flatMap((track) => track.clips),
  );
  return {
    protocolVersion: REFERENCE_PROTOCOL_VERSION,
    project: {
      id: document.project.id,
      name: document.project.name,
      revision: document.project.revision,
      createdAt: document.project.createdAt,
      updatedAt: document.project.updatedAt,
      activeSequenceId: document.project.activeSequenceId,
    },
    facts: {
      sequenceCount: document.sequences.length,
      clipCount: clips.length,
      artifactCount: document.artifacts.length,
      transcriptArtifacts: document.artifacts.filter((artifact) => artifact.kind === "transcript").length,
    },
    capabilities: {
      extensions: [],
    },
    session: {
      id: session.id,
      clientId: session.clientId,
      capabilities: [...session.capabilities],
      expiresAt: session.expiresAt,
    },
  };
}

function latestTranscript(document: AgentCutProjectDocument): TranscriptArtifact {
  const transcripts = document.artifacts.filter((artifact): artifact is TranscriptArtifact =>
    artifact.kind === "transcript",
  );
  const latest = transcripts[transcripts.length - 1];
  if (!latest) {
    throw new ReferenceHostError(404, "OBJECT_NOT_FOUND", "Project has no transcript artifact");
  }
  return latest;
}

function transcriptPage(document: AgentCutProjectDocument, url: URL): unknown {
  const transcript = latestTranscript(document);
  const source = document.assets.find((asset) => asset.id === transcript.assetId);
  if (!source) {
    throw new ReferenceHostError(404, "OBJECT_NOT_FOUND", `Asset ${transcript.assetId} is missing`);
  }
  const offset = readBoundedQueryInteger(url, "offset", 0, 10_000_000);
  const limit = readBoundedQueryInteger(url, "limit", 200, 500, 1);
  const words = transcript.words.slice(offset, offset + limit).map((word, index) => ({
    wordId: word.id,
    index: offset + index,
    text: word.text,
    startMicros: toMicros(word.sourceRange.start),
    durationMicros: toMicros(word.sourceRange.duration),
    confidence: word.confidence,
  }));
  return {
    protocolVersion: REFERENCE_PROTOCOL_VERSION,
    project: { id: document.project.id, revision: document.project.revision },
    transcript: {
      id: transcript.id,
      language: transcript.language,
      sourceSha256: source.contentHash,
      totalWords: transcript.words.length,
      offset,
      limit,
      nextOffset: offset + words.length < transcript.words.length ? offset + words.length : null,
      words,
    },
  };
}

function projectDiff(store: ProjectStore, url: URL): unknown {
  const headRevision = store.snapshot().project.revision;
  const fromRevision = readRevisionQuery(url, "fromRevision", true);
  if (fromRevision === undefined) {
    throw new ReferenceHostError(400, "INVALID_REQUEST", "fromRevision is required");
  }
  const toRevision = readRevisionQuery(url, "toRevision", false) ?? headRevision;
  if (fromRevision > toRevision || toRevision > headRevision) {
    throw new ReferenceHostError(400, "INVALID_REQUEST",
      "project diff requires 0 <= fromRevision <= toRevision <= headRevision",
      { fromRevision, toRevision, headRevision });
  }
  const records = store.listRecords().filter((record) =>
    record.committedRevision > fromRevision && record.committedRevision <= toRevision,
  );
  return {
    projectId: store.snapshot().project.id,
    fromRevision,
    toRevision,
    headRevision,
    changes: records.map((record) => ({
      transactionId: record.transactionId,
      baseRevision: record.baseRevision,
      committedRevision: record.committedRevision,
      actor: record.request.actor,
      reason: record.request.reason,
      operationTypes: record.request.operations.map((operation) => operation.type),
      objectIds: [...new Set(record.request.operations.flatMap(operationObjectIds))],
      beforeHash: record.beforeHash,
      afterHash: record.afterHash,
      committedAt: record.committedAt,
    })),
  };
}

interface TimelineTransactionResult {
  protocolVersion: string;
  revision: number;
  idempotentReplay: boolean;
  record: {
    transactionId: string;
    baseRevision: number;
    committedRevision: number;
    committedAt: string;
    beforeHash: string;
    afterHash: string;
    inverseOperationCount: number;
  };
}

function applyTimelineTransaction(
  store: ProjectStore,
  body: Record<string, unknown>,
  session: AgentSession,
): TimelineTransactionResult {
  const transaction = body as unknown as EditTransaction;
  if (transaction.protocolVersion !== REFERENCE_PROTOCOL_VERSION) {
    throw new ReferenceHostError(400, "INVALID_REQUEST", "protocolVersion must be 0.1.0");
  }
  const document = store.snapshot();
  if (transaction.projectId !== document.project.id) {
    throw new ReferenceHostError(400, "INVALID_REQUEST", "Transaction projectId does not match this project");
  }
  // baseRevision 校验交给 engine：commit 先按 idempotencyKey 幂等重放（允许过期 baseRevision 的精确重试），
  // 非重放的过期 revision 由 engine 抛 REVISION_CONFLICT。宿主级预检会破坏协议 §7.4 的重试语义。
  let result;
  try {
    result = store.commit({
      ...transaction,
      actor: { kind: "agent", id: session.clientId },
    });
  } catch (error) {
    if (error instanceof EditError) {
      throw new ReferenceHostError(statusForCode(error.code), error.code, error.message, error.details);
    }
    throw error;
  }
  return {
    protocolVersion: REFERENCE_PROTOCOL_VERSION,
    revision: result.document.project.revision,
    idempotentReplay: result.idempotentReplay,
    record: {
      transactionId: result.record.transactionId,
      baseRevision: result.record.baseRevision,
      committedRevision: result.record.committedRevision,
      committedAt: result.record.committedAt,
      beforeHash: result.record.beforeHash,
      afterHash: result.record.afterHash,
      inverseOperationCount: result.record.inverseOperations.length,
    },
  };
}

function operationObjectIds(operation: EditOperation): string[] {
  switch (operation.type) {
    case "asset.put": return [operation.asset.id];
    case "asset.remove": return [operation.assetId];
    case "artifact.put": return [operation.artifact.id];
    case "artifact.remove": return [operation.artifactId];
    case "track.add": return [operation.track.id];
    case "track.remove": return [operation.trackId];
    case "clip.insert": return [operation.trackId, operation.clip.id];
    case "clip.remove": return [operation.clipId];
    case "clip.split": return [operation.clipId, operation.rightClipId];
    case "clip.move": return [operation.clipId, ...(operation.toTrackId ? [operation.toTrackId] : [])];
    case "clip.trim":
    case "clip.replace":
    case "clip.update": return [operation.clipId];
    case "range.deleteRipple": return [
      ...operation.trackIds,
      ...(operation.proposalId ? [operation.proposalId] : []),
      ...Object.values(operation.rightClipIds ?? {}),
    ];
    case "lock.add": return [operation.lock.id];
    case "lock.remove": return [operation.lockId];
  }
}

function statusForCode(code: string): number {
  if (code === "AGENT_SESSION_NOT_FOUND" || code === "AGENT_SESSION_INVALID"
    || code === "AGENT_BOOTSTRAP_DENIED" || code === "APPROVAL_TOKEN_INVALID") return 401;
  if (code === "CAPABILITY_DENIED") return 403;
  if (code === "OBJECT_NOT_FOUND" || code === "NOT_FOUND" || code === "SEQUENCE_NOT_FOUND") return 404;
  if (code === "REVISION_CONFLICT" || code === "IDEMPOTENCY_CONFLICT"
    || code === "APPROVAL_STATE_INVALID" || code === "APPROVAL_STALE" || code === "LOCKED"
    || code === "PRECONDITION_FAILED") return 409;
  if (code === "INVALID_DOCUMENT" || code === "DUPLICATE_ID" || code === "INVALID_OPERATION") return 422;
  if (code === "PROJECT_MISMATCH") return 400;
  return 400;
}

function requiredBootstrap(options: ReferenceHostOptions): string {
  if (!options.agentBootstrapToken) {
    throw new ReferenceHostError(503, "AGENT_ACCESS_UNAVAILABLE",
      "Reference host has no bootstrap credential");
  }
  return options.agentBootstrapToken;
}

function readBearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length <= 7) {
    throw new ReferenceHostError(401, "AGENT_SESSION_NOT_FOUND", "A Bearer Agent credential is required");
  }
  const token = header.slice(7);
  if (token !== token.trim()) {
    throw new ReferenceHostError(401, "AGENT_SESSION_NOT_FOUND", "Bearer credential cannot have surrounding whitespace");
  }
  return token;
}

function readRequestIdHeader(request: IncomingMessage): string | undefined {
  const value = request.headers["x-agentcut-request-id"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 128) {
    throw new ReferenceHostError(400, "INVALID_REQUEST",
      "X-AgentCut-Request-Id must be one stable ID of at most 128 characters");
  }
  return value;
}

function assertSecret(received: string, expected: string, code: string): void {
  const receivedBytes = Buffer.from(received, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (receivedBytes.length !== expectedBytes.length
    || !timingSafeEqual(receivedBytes, expectedBytes)) {
    throw new ReferenceHostError(401, code, "Bootstrap credential is invalid");
  }
}

function readCapabilities(body: Record<string, unknown>): AgentCapability[] {
  const value = body.capabilities;
  const allowed = new Set<string>(AGENT_CAPABILITIES);
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== "string" || !allowed.has(item))) {
    throw new ReferenceHostError(400, "INVALID_REQUEST", "capabilities must be a non-empty supported capability list");
  }
  const capabilities = value as AgentCapability[];
  if (new Set(capabilities).size !== capabilities.length) {
    throw new ReferenceHostError(400, "INVALID_REQUEST", "capabilities cannot contain duplicates");
  }
  return [...capabilities].sort();
}

function readTtlSeconds(body: Record<string, unknown>): number {
  const value = body.ttlSeconds ?? 43_200;
  if (!Number.isSafeInteger(value) || (value as number) < 60 || (value as number) > 86_400) {
    throw new ReferenceHostError(400, "INVALID_REQUEST", "ttlSeconds must be an integer between 60 and 86400");
  }
  return value as number;
}

function hashToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function readStableString(body: Record<string, unknown>, key: string, maxLength: number): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.length > maxLength) {
    throw new ReferenceHostError(400, "INVALID_REQUEST",
      `${key} must be at most ${maxLength} characters without surrounding whitespace`);
  }
  return value;
}

function readRevisionQuery(url: URL, key: string, required: boolean): number | undefined {
  const value = url.searchParams.get(key);
  if (value === null) {
    if (required) {
      throw new ReferenceHostError(400, "INVALID_REQUEST", `${key} is required`);
    }
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new ReferenceHostError(400, "INVALID_REQUEST", `${key} must be a canonical non-negative integer`);
  }
  return parsed;
}

function readBoundedQueryInteger(
  url: URL,
  key: string,
  fallback: number,
  maximum: number,
  minimum = 0,
): number {
  const value = url.searchParams.get(key);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ReferenceHostError(400, "INVALID_REQUEST", `${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function toMicros(time: { value: number; rate: { numerator: number; denominator: number } }): number {
  // IR 语义：seconds = value * rate.denominator / rate.numerator（docs/04）。
  return Math.round(time.value * time.rate.denominator / time.rate.numerator * 1_000_000);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      throw new ReferenceHostError(400, "INVALID_REQUEST", "Request body is too large");
    }
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
    return value as Record<string, unknown>;
  } catch {
    throw new ReferenceHostError(400, "INVALID_REQUEST", "Request body must be a JSON object");
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  allowedOrigin?: string,
): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    ...corsHeaders(allowedOrigin),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  response.end(json);
}

function sendError(response: ServerResponse, error: unknown, allowedOrigin?: string): void {
  if (error instanceof ReferenceHostError) {
    sendJson(response, error.status, {
      error: { code: error.code, message: error.message, details: error.details },
    }, allowedOrigin);
    return;
  }
  if (error instanceof ProjectStoreError) {
    sendJson(response, statusForCode(error.code), {
      error: { code: error.code, message: error.message, details: error.details },
    }, allowedOrigin);
    return;
  }
  sendJson(response, 500, {
    error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) },
  }, allowedOrigin);
}

function corsHeaders(allowedOrigin?: string): Record<string, string> {
  return {
    ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin } : {}),
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-AgentCut-Request-Id",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}
