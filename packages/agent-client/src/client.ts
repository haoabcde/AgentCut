import { randomUUID } from "node:crypto";
import type {
  AgentCapability,
  ApprovalResponse,
  AgentCutWireError,
  AgentProjectSummary,
  AgentSessionCredential,
  AgentSessionDescriptor,
  AgentSessionResponse,
  AgentStatus,
  AgentSemanticFinding,
  AgentTimelineTransactionInput,
  AgentTimelineTransactionResult,
  AgentTranscriptPage,
  AlphaAuditResponse,
  CandidateSummary,
  ExportJobResponse,
  ExportPreset,
  ProjectDiffResponse,
  ReviewResponse,
  Risk,
} from "./types.js";

export interface AgentCutClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  bootstrapToken?: string;
  session?: AgentSessionCredential;
  clientId?: string;
  sessionRequestId?: string;
  requestedCapabilities?: AgentCapability[];
  sessionTtlSeconds?: number;
}

export class AgentCutClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AgentCutClientError";
  }
}

export class AgentCutClient {
  readonly #baseUrl: URL;
  readonly #fetcher: typeof fetch;
  readonly #bootstrapToken: string | undefined;
  readonly #clientId: string;
  readonly #sessionRequestId: string;
  readonly #requestedCapabilities: AgentCapability[];
  readonly #sessionTtlSeconds: number;
  #sessionPromise: Promise<AgentSessionCredential> | undefined;

  constructor(options: AgentCutClientOptions = {}) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? "http://127.0.0.1:4317");
    this.#fetcher = options.fetcher ?? fetch;
    this.#bootstrapToken = options.bootstrapToken;
    this.#clientId = options.clientId ?? "agentcut-agent";
    this.#sessionRequestId = options.sessionRequestId ?? `session-${randomUUID()}`;
    this.#requestedCapabilities = [...(options.requestedCapabilities ?? [
      "project:read",
      "transcript:read",
      "analysis:local",
      "analysis:propose",
      "timeline:write:low_risk_only",
      "approval:request",
      "timeline:write:approved",
      "export:write",
    ])];
    this.#sessionTtlSeconds = options.sessionTtlSeconds ?? 43_200;
    if (options.session) this.#sessionPromise = Promise.resolve(structuredClone(options.session));
  }

  async review(): Promise<ReviewResponse> {
    return this.#request<ReviewResponse>("GET", "/api/agent/status");
  }

  async status(): Promise<AgentStatus> {
    const review = await this.review();
    return summarizeStatus(review, (await this.session()).session);
  }

  async candidates(): Promise<CandidateSummary[]> {
    const response = await this.#request<AlphaAuditResponse>("GET", "/api/agent/candidates");
    return response.audit.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      decision: candidate.decision,
      targetKind: candidate.targetKind,
      wordIds: [...candidate.wordIds],
      state: candidate.state,
      reasonCodes: [...candidate.reasonCodes],
      risk: candidate.risk,
      confidence: candidate.confidence,
      explanationZh: candidate.explanationZh,
      sourceStartMicros: candidate.sourceStartMicros,
      durationMicros: candidate.durationMicros,
      text: candidate.text,
      ...(candidate.evidenceStatus ? { evidenceStatus: candidate.evidenceStatus } : {}),
      ...(candidate.evidence?.length ? {
        evidence: candidate.evidence.map((evidence) => ({
          ...evidence,
          wordIds: [...evidence.wordIds],
        })),
      } : {}),
      ...(candidate.transactionId ? { transactionId: candidate.transactionId } : {}),
    }));
  }

  async transcript(input: { offset?: number; limit?: number } = {}): Promise<AgentTranscriptPage> {
    const params = new URLSearchParams();
    if (input.offset !== undefined) {
      const offset = requiredRevision(input.offset, "offset");
      if (offset > 10_000_000) {
        throw new AgentCutClientError(0, "INVALID_INPUT", "offset must be an integer from 0 to 10000000");
      }
      params.set("offset", String(offset));
    }
    if (input.limit !== undefined) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
        throw new AgentCutClientError(0, "INVALID_INPUT", "limit must be an integer from 1 to 500");
      }
      params.set("limit", String(input.limit));
    }
    const query = params.size > 0 ? `?${params}` : "";
    return this.#request<AgentTranscriptPage>("GET", `/api/agent/transcript${query}`);
  }

  async proposeSemanticFindings(input: {
    baseRevision: number;
    requestId: string;
    findings: AgentSemanticFinding[];
  }): Promise<AgentStatus> {
    if (!Array.isArray(input.findings) || input.findings.length < 1 || input.findings.length > 100) {
      throw new AgentCutClientError(0, "INVALID_INPUT", "findings must contain 1 to 100 items");
    }
    const review = await this.#request<ReviewResponse>(
      "POST",
      "/api/agent/semantic-findings",
      input,
    );
    return summarizeStatus(review, (await this.session()).session);
  }

  async generateRoughCut(input: { baseRevision: number; requestId: string }): Promise<AgentStatus> {
    const review = await this.#request<ReviewResponse>("POST", "/api/agent/rough-cut/generate", input);
    return summarizeStatus(review, (await this.session()).session);
  }

  async analyzeSemantic(input: { baseRevision: number; requestId: string }): Promise<AgentStatus> {
    const review = await this.#request<ReviewResponse>("POST", "/api/agent/analyze-semantic", input);
    return summarizeStatus(review, (await this.session()).session);
  }

  async startExport(input: {
    baseRevision: number;
    requestId: string;
    preset?: ExportPreset;
  }): Promise<ExportJobResponse> {
    const { preset, ...binding } = input;
    if (preset !== undefined && preset !== "source" && preset !== "vertical-9-16") {
      throw new AgentCutClientError(400, "INVALID_INPUT", `Unsupported export preset: ${String(preset)}`);
    }
    return this.#request<ExportJobResponse>(
      "POST",
      "/api/agent/exports",
      preset === undefined ? binding : { ...binding, preset },
    );
  }

  async exportStatus(jobId: string): Promise<ExportJobResponse> {
    return this.#request<ExportJobResponse>("GET", `/api/agent/exports/${encodeURIComponent(requiredText(jobId, "jobId"))}`);
  }

  async cancelExport(input: { jobId: string; requestId: string }): Promise<ExportJobResponse> {
    const jobId = encodeURIComponent(requiredText(input.jobId, "jobId"));
    return this.#request<ExportJobResponse>(
      "POST",
      `/api/agent/exports/${jobId}/cancel`,
      { requestId: requiredText(input.requestId, "requestId") },
    );
  }

  async projectDiff(input: { fromRevision: number; toRevision?: number }): Promise<ProjectDiffResponse> {
    const fromRevision = requiredRevision(input.fromRevision, "fromRevision");
    const params = new URLSearchParams({ fromRevision: String(fromRevision) });
    if (input.toRevision !== undefined) {
      params.set("toRevision", String(requiredRevision(input.toRevision, "toRevision")));
    }
    return this.#request<ProjectDiffResponse>("GET", `/api/agent/project/diff?${params}`);
  }

  /** 协议 core：任何实现本协议的宿主（包括无媒体管线的 reference host）都提供。 */
  async project(): Promise<AgentProjectSummary> {
    return this.#request<AgentProjectSummary>("GET", "/api/agent/project");
  }

  /** 协议 core：提交任意 typed operations 组合的原子事务，宿主端 engine 负责校验与执行。 */
  async applyTimelineTransaction(
    input: AgentTimelineTransactionInput,
  ): Promise<AgentTimelineTransactionResult> {
    if (!Array.isArray(input.operations) || input.operations.length === 0) {
      throw new AgentCutClientError(0, "INVALID_INPUT", "operations must contain at least one operation");
    }
    return this.#request<AgentTimelineTransactionResult>(
      "POST",
      "/api/agent/timeline/transactions",
      {
        protocolVersion: "0.1.0",
        preconditions: [],
        ...input,
      },
    );
  }

  async requestCandidateApproval(input: {
    candidateId: string;
    baseRevision: number;
    requestId: string;
  }): Promise<ApprovalResponse> {
    return this.#request<ApprovalResponse>("POST", "/api/agent/approvals", input);
  }

  async approvalStatus(approvalId: string): Promise<ApprovalResponse> {
    return this.#request<ApprovalResponse>(
      "GET",
      `/api/agent/approvals/${encodeURIComponent(requiredText(approvalId, "approvalId"))}`,
    );
  }

  async applyApproval(input: {
    approvalId: string;
    approvalToken: string;
    baseRevision: number;
    requestId: string;
  }): Promise<AgentStatus> {
    const review = await this.#request<ReviewResponse>(
      "POST",
      `/api/agent/approvals/${encodeURIComponent(requiredText(input.approvalId, "approvalId"))}/apply`,
      {
        approvalToken: requiredText(input.approvalToken, "approvalToken"),
        baseRevision: input.baseRevision,
        requestId: input.requestId,
      },
    );
    return summarizeStatus(review, (await this.session()).session);
  }

  session(): Promise<AgentSessionCredential> {
    this.#sessionPromise ??= this.#createSession();
    return this.#sessionPromise;
  }

  async #request<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
    const session = await this.session();
    const requestId = body && "requestId" in body && typeof body.requestId === "string"
      ? body.requestId
      : body && "idempotencyKey" in body && typeof body.idempotencyKey === "string"
        ? body.idempotencyKey
        : undefined;
    return this.#fetchJson<T>(method, path, body, {
      Authorization: `Bearer ${session.accessToken}`,
      ...(requestId ? { "X-AgentCut-Request-Id": requestId } : {}),
    });
  }

  async #createSession(): Promise<AgentSessionCredential> {
    if (!this.#bootstrapToken) {
      throw new AgentCutClientError(
        0,
        "AGENT_CREDENTIALS_MISSING",
        "AgentCut Agent credentials are required; start Studio and configure its credential file",
      );
    }
    const response = await this.#fetchJson<AgentSessionResponse>("POST", "/api/agent/sessions", {
      requestId: this.#sessionRequestId,
      clientId: this.#clientId,
      capabilities: this.#requestedCapabilities,
      ttlSeconds: this.#sessionTtlSeconds,
    }, { Authorization: `Bearer ${this.#bootstrapToken}` });
    return { session: structuredClone(response.session), accessToken: response.accessToken };
  }

  async #fetchJson<T>(
    method: "GET" | "POST",
    path: string,
    body?: object,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetcher(new URL(path, this.#baseUrl), {
        method,
        headers: {
          Accept: "application/json",
          "X-AgentCut-Client": "agentcut-agent/0.1.0",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new AgentCutClientError(
        0,
        "DAEMON_UNAVAILABLE",
        `AgentCut daemon is unavailable at ${this.#baseUrl.origin}`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (!response.ok) throw await responseError(response);
    return response.json() as Promise<T>;
  }
}

export function summarizeStatus(
  review: ReviewResponse,
  agentSession?: AgentSessionDescriptor,
): AgentStatus {
  const byRisk: Record<Risk, number> = { low: 0, medium: 0, high: 0 };
  for (const candidate of review.review.candidates) byRisk[candidate.risk] += 1;
  const capabilities = structuredClone(review.capabilities ?? {
    semanticReview: { available: false },
  });
  if (agentSession && !capabilities.agentSession) {
    capabilities.agentSession = {
      id: agentSession.id,
      clientId: agentSession.clientId,
      capabilities: [...agentSession.capabilities],
      expiresAt: agentSession.expiresAt,
    };
  }
  return {
    protocolVersion: "0.1.0",
    project: structuredClone(review.project),
    roughCutStatus: review.roughCutStatus,
    transcript: structuredClone(review.transcript),
    media: {
      assetId: review.media.assetId,
      originalFileName: review.media.originalFileName,
    },
    preview: review.preview
      ? { revision: review.preview.revision, durationSeconds: review.preview.durationSeconds }
      : null,
    candidates: {
      total: review.review.candidates.length,
      pending: review.review.candidates.filter((candidate) =>
        candidate.state === "candidate_remove" || candidate.state === "candidate_keep",
      ).length,
      committedDeleted: review.review.candidates.filter((candidate) =>
        candidate.state === "committed_deleted",
      ).length,
      reviewedKeep: review.review.candidates.filter((candidate) =>
        candidate.state === "reviewed_keep",
      ).length,
      byRisk,
    },
    jobs: review.jobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
    })),
    exports: structuredClone(review.exports ?? []),
    approvals: structuredClone(review.approvals ?? []),
    capabilities,
  };
}

async function responseError(response: Response): Promise<AgentCutClientError> {
  let body: AgentCutWireError = {};
  try {
    body = await response.json() as AgentCutWireError;
  } catch {
    // A non-JSON daemon/proxy response remains a structured HTTP error.
  }
  return new AgentCutClientError(
    response.status,
    body.error?.code ?? "HTTP_ERROR",
    body.error?.message ?? `${response.status} ${response.statusText}`,
    body.error?.details ?? {},
  );
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AgentCut daemon URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("AgentCut daemon URL cannot include credentials, query, or fragment");
  }
  url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return url;
}

function requiredText(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} cannot be empty`);
  return value;
}

function requiredRevision(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}
