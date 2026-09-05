export type ReviewState =
  | "normal"
  | "candidate_remove"
  | "candidate_keep"
  | "reviewed_keep"
  | "committed_deleted";

export interface TimeValue {
  value: number;
  rate: { numerator: number; denominator: number };
}

export interface TimeRange {
  start: TimeValue;
  duration: TimeValue;
}

export interface ReviewToken {
  wordId: string;
  text: string;
  sourceRange: TimeRange;
  state: ReviewState;
  decoration: "none" | "candidate_background" | "kept_background" | "strikethrough";
  candidateIds: string[];
  reasonCodes: string[];
  risk?: "low" | "medium" | "high";
  confidence?: number;
  explanationZh?: string;
  proposalId?: string;
  transactionId?: string;
  lockId?: string;
  restorable: boolean;
}

export interface ReviewGap {
  candidateId: string;
  sourceRange: TimeRange;
  previousWordId?: string;
  nextWordId?: string;
  state: Exclude<ReviewState, "normal">;
  decoration: "candidate_background" | "kept_gap" | "committed_gap";
  reasonCodes: string[];
  risk: "low" | "medium" | "high";
  confidence: number;
  explanationZh: string;
  proposalId?: string;
  transactionId?: string;
  lockId?: string;
  restorable: boolean;
}

export interface SpeechGap {
  gapId: string;
  clipId: string;
  sourceRange: TimeRange;
  timelineRange: TimeRange;
  previousWordId?: string;
  nextWordId?: string;
}

export interface CandidateSelection {
  candidateId: string;
  targetKind: "words" | "gap";
  sourceRange: TimeRange;
  wordIds: string[];
  previousWordId?: string;
  nextWordId?: string;
  state: Exclude<ReviewState, "normal">;
  reasonCodes: string[];
  risk: "low" | "medium" | "high";
  confidence: number;
  explanationZh: string;
  evidenceStatus?: "structured" | "legacy_missing";
  evidence?: Array<{
    role: "retained_comparison";
    sourceRange: TimeRange;
    wordIds: string[];
    text: string;
  }>;
  transactionId?: string;
  lockId?: string;
  overlapCandidateIds?: string[];
  overlapDecisionAnchorId?: string;
  overlapResolvedByCandidateId?: string;
}

export interface ApprovalSummary {
  id: string;
  kind: "content_high_risk_delete";
  targetId: string;
  baseRevision: number;
  payloadHash: string;
  state: "pending" | "approved" | "denied" | "consumed" | "expired" | "stale";
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  transactionId?: string;
}

export interface AgentSessionSummary {
  id: string;
  clientId: string;
  capabilities: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  access: {
    total: number;
    allowed: number;
    denied: number;
    lastAccessAt?: string;
  };
}

export interface UiSessionResponse {
  authenticated: boolean;
  expiresAt?: string;
  generation?: number;
  reason?: "missing" | "invalid" | "expired" | "unavailable";
}

export interface UiCredentialRotationResponse extends UiSessionResponse {
  authenticated: true;
  generation: number;
  rotatedAt: string;
  idempotentReplay: boolean;
}

export interface RoughCutUndoTarget {
  transactionId: string;
  committedRevision: number;
  removedDurationSeconds: number;
  labelZh: string;
}

export interface RoughCutReadiness {
  candidatesPending: number;
  candidatesDecided: boolean;
  speechGapsRemaining: number;
  exportSucceeded: boolean;
  exportStale: boolean;
  exportUpToDate: boolean;
  undo: RoughCutUndoTarget | null;
}

export interface ReviewResponse {
  project: { id: string; name: string; revision: number };
  roughCutStatus?: "not_started" | "reviewing" | "rough_cut_ready";
  readiness?: RoughCutReadiness;
  preview?: {
    revision: number;
    durationSeconds: number;
    segments: PreviewSegment[];
  };
  transcript: { id: string; language: string; providerArtifactId?: string };
  media: {
    assetId: string;
    url: string;
    originalFileName: string;
    playback?: {
      assetId: string;
      kind: "source" | "proxy";
      profile?: string;
    };
  };
  review: {
    transcriptId: string;
    projectRevision: number;
    candidates: CandidateSelection[];
    tokens: ReviewToken[];
    gaps: ReviewGap[];
    speechGaps: SpeechGap[];
    summary: {
      normalTokens: number;
      candidateTokens: number;
      deletedTokens: number;
      reviewedKeepTokens: number;
      candidateGaps: number;
      committedGaps: number;
      reviewedKeepGaps: number;
    };
  };
  jobs: Array<{ id: string; status: string; progress: number; type: string }>;
  exports?: ExportJobResponse[];
  approvals?: ApprovalSummary[];
  agentSessions?: AgentSessionSummary[];
  capabilities?: {
    semanticReview: { available: boolean; provider?: string };
  };
}

export interface PreviewSegment {
  clipId: string;
  assetId: string;
  timelineStartSeconds: number;
  sourceStartSeconds: number;
  durationSeconds: number;
}

export interface CandidatePreviewResponse {
  candidateId: string;
  baseRevision: number;
  preview: NonNullable<ReviewResponse["preview"]>;
}

export interface SelectionPreviewResponse {
  wordIds: string[];
  baseRevision: number;
  preview: NonNullable<ReviewResponse["preview"]>;
}

export interface SpeechGapPreviewResponse {
  gapId: string;
  baseRevision: number;
  preview: NonNullable<ReviewResponse["preview"]>;
}

/** 导出预设：source 沿用序列画布；vertical-9-16 输出 1080x1920（cover 中心裁切，近似取景）。 */
export type ExportPreset = "source" | "vertical-9-16";

export interface ExportJobResponse {
  jobId: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";
  progress: number;
  sourceRevision: number;
  preset?: ExportPreset;
  cancelRequested: boolean;
  canCancel: boolean;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  mediaUrl?: string;
  captionUrl?: string;
  captionArtifactId?: string;
  quality?: {
    passed: boolean;
    durationDeltaMillis: number;
    width: number;
    height: number;
    hasAudio: boolean;
    subtitleCueCount: number;
    fitMode?: "contain" | "cover";
    fitModeApproximate?: boolean;
  };
}

export type AlphaBoundaryIssueCode =
  | "swallowed_word"
  | "clipped_syllable"
  | "av_sync"
  | "unnatural_pacing"
  | "other";
export type AlphaTimingBaselineMethod = "stopwatch" | "screen_recording" | "editor_log";
export type AlphaTimingPauseReason = "user" | "idle" | "page_hidden";

export interface AlphaAuditCandidate {
  candidateId: string;
  decision: "definite_remove" | "suggest_remove" | "keep";
  risk: "low" | "medium" | "high";
  reasonCodes: string[];
  confidence: number;
  explanationZh: string;
  targetKind: "words" | "gap";
  wordIds: string[];
  sourceStartMicros: number;
  durationMicros: number;
  text: string;
  state: Exclude<ReviewState, "normal">;
  transactionId?: string;
  committedBy?: { kind: string; id: string };
  humanLabel: "true_positive" | "false_positive" | null;
  humanNote: string | null;
}

export interface AlphaAuditBoundary {
  boundaryId: string;
  assetId: string;
  timelineMicros: number;
  leftSourceEndMicros: number;
  rightSourceStartMicros: number;
  removedDurationMicros: number;
  candidateIds: string[];
  humanUsable: boolean | null;
  humanIssueCodes: AlphaBoundaryIssueCode[];
  humanNote: string | null;
}

export interface AlphaAuditResponse {
  audit: {
    schemaVersion: "1.0";
    project: {
      id: string;
      name: string;
      revision: number;
      sequenceId: string;
      transcriptId: string;
      sourceAssetId: string;
      sourceSha256: string;
      alphaTrial?: { mode: "formal"; enrolledAt: string } | null;
    };
    review: { completed: boolean; pendingCandidateIds: string[] };
    candidates: AlphaAuditCandidate[];
    boundaries: AlphaAuditBoundary[];
    derived: {
      definiteRemovePredicted: number;
      definiteRemoveCommitted: number;
      highRiskAutoDeletedCandidateIds: string[];
      firstHumanDecisionRevision: number | null;
    };
    export: {
      reportId: string;
      sourceRevision: number;
      outputAssetId: string;
      outputSha256: string;
      videoCodec: string;
      audioCodec: string;
      quality: { passed: boolean };
    } | null;
  };
  progress: {
    candidateLabeled: number;
    candidateTotal: number;
    boundaryLabeled: number;
    boundaryTotal: number;
    complete: boolean;
  };
  timing: {
    baseline: {
      manualBaselineSeconds: number;
      method: AlphaTimingBaselineMethod;
      operatorIdHash: string;
      evidenceSha256: string;
    } | null;
    agentCutActiveSeconds: number;
    state: "not_started" | "running" | "paused" | "finished";
    activeSessionId: string | null;
    lastActivityAt: string | null;
    complete: boolean;
  };
  events: Array<{
    sequence: number;
    requestId: string;
    targetType: "candidate" | "boundary" | "correctness" | "timing";
    targetId: string;
    createdAt: string;
  }>;
}

export async function fetchReview(path: string): Promise<ReviewResponse> {
  const response = await fetch(path);
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<ReviewResponse>;
}

export async function fetchCandidatePreview(
  candidateId: string,
  baseRevision: number,
): Promise<CandidatePreviewResponse> {
  const response = await fetch(
    `/api/candidates/${encodeURIComponent(candidateId)}/preview?baseRevision=${baseRevision}`,
  );
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<CandidatePreviewResponse>;
}

export async function previewTranscriptSelection(input: {
  wordIds: string[];
  baseRevision: number;
}): Promise<SelectionPreviewResponse> {
  return postJson("/api/selections/preview", input);
}

export async function previewSpeechGap(input: {
  gapId: string;
  baseRevision: number;
}): Promise<SpeechGapPreviewResponse> {
  return postJson("/api/speech-gaps/preview", input);
}

export async function fetchUiSession(): Promise<UiSessionResponse> {
  const response = await fetch("/api/ui/session", { credentials: "same-origin" });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<UiSessionResponse>;
}

export async function pairUiSession(bootstrapToken: string): Promise<UiSessionResponse> {
  const response = await fetch("/api/ui/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { Authorization: `Bearer ${bootstrapToken}` },
  });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<UiSessionResponse>;
}

export async function rotateUiBootstrap(
  requestId: string,
): Promise<UiCredentialRotationResponse> {
  const response = await fetch("/api/ui/bootstrap/rotate", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId }),
  });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<UiCredentialRotationResponse>;
}

export async function fetchAlphaAudit(path: string): Promise<AlphaAuditResponse> {
  const response = await fetch(path);
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<AlphaAuditResponse>;
}

export async function labelAlphaCandidate(input: {
  requestId: string;
  candidateId: string;
  baseRevision: number;
  sourceSha256: string;
  label: "true_positive" | "false_positive";
  note?: string;
}): Promise<AlphaAuditResponse> {
  return postJson(`/api/alpha-audit/candidates/${encodeURIComponent(input.candidateId)}`, {
    baseRevision: input.baseRevision,
    sourceSha256: input.sourceSha256,
    label: input.label,
    ...(input.note !== undefined ? { note: input.note } : {}),
  }, input.requestId);
}

export async function labelAlphaBoundary(input: {
  requestId: string;
  boundaryId: string;
  baseRevision: number;
  sourceSha256: string;
  usable: boolean;
  issueCodes: AlphaBoundaryIssueCode[];
  note?: string;
}): Promise<AlphaAuditResponse> {
  return postJson(`/api/alpha-audit/boundaries/${encodeURIComponent(input.boundaryId)}`, {
    baseRevision: input.baseRevision,
    sourceSha256: input.sourceSha256,
    usable: input.usable,
    issueCodes: input.issueCodes,
    ...(input.note !== undefined ? { note: input.note } : {}),
  }, input.requestId);
}

interface AlphaTimingBinding {
  baseRevision: number;
  sourceSha256: string;
}

export async function beginAlphaTiming(input: AlphaTimingBinding & {
  requestId: string;
  manualBaselineSeconds: number;
  method: AlphaTimingBaselineMethod;
  operatorId: string;
  evidenceSha256: string;
  sessionId: string;
}): Promise<AlphaAuditResponse> {
  const { requestId, ...body } = input;
  return postJson("/api/alpha-audit/timing/begin", body, requestId);
}

export async function setAlphaTimingBaseline(input: AlphaTimingBinding & {
  requestId: string;
  manualBaselineSeconds: number;
  method: AlphaTimingBaselineMethod;
  operatorId: string;
  evidenceSha256: string;
}): Promise<AlphaAuditResponse> {
  const { requestId, ...body } = input;
  return postJson("/api/alpha-audit/timing/baseline", body, requestId);
}

export async function startAlphaTiming(input: AlphaTimingBinding & {
  requestId: string;
  sessionId: string;
}): Promise<AlphaAuditResponse> {
  const { requestId, ...body } = input;
  return postJson("/api/alpha-audit/timing/start", body, requestId);
}

export async function heartbeatAlphaTiming(input: AlphaTimingBinding & {
  requestId: string;
  sessionId: string;
}): Promise<AlphaAuditResponse> {
  const { requestId, ...body } = input;
  return postJson("/api/alpha-audit/timing/heartbeat", body, requestId);
}

export async function pauseAlphaTiming(input: AlphaTimingBinding & {
  requestId: string;
  sessionId: string;
  reason: AlphaTimingPauseReason;
}): Promise<AlphaAuditResponse> {
  const { requestId, ...body } = input;
  return postJson("/api/alpha-audit/timing/pause", body, requestId);
}

export async function finishAlphaTiming(
  input: AlphaTimingBinding & { requestId: string },
): Promise<AlphaAuditResponse> {
  const { requestId, ...body } = input;
  return postJson("/api/alpha-audit/timing/finish", body, requestId);
}

export async function restoreTransaction(input: {
  requestId: string;
  transactionId: string;
  baseRevision: number;
}): Promise<ReviewResponse> {
  const { requestId, ...body } = input;
  return postReview("/api/restore", body, requestId);
}

export async function analyzeSemanticReview(input: {
  requestId: string;
  baseRevision: number;
}): Promise<ReviewResponse> {
  const { requestId, ...body } = input;
  return postReview("/api/analyze-semantic", body, requestId);
}

export async function generateRoughCut(input: {
  requestId: string;
  baseRevision: number;
}): Promise<ReviewResponse> {
  const { requestId, ...body } = input;
  return postReview("/api/rough-cut/generate", body, requestId);
}

export async function deleteTranscriptSelection(input: {
  requestId: string;
  baseRevision: number;
  wordIds: string[];
}): Promise<ReviewResponse> {
  const { requestId, ...body } = input;
  return postReview("/api/selections/delete", body, requestId);
}

export async function deleteSpeechGap(input: {
  requestId: string;
  baseRevision: number;
  gapId: string;
}): Promise<ReviewResponse> {
  const { requestId, ...body } = input;
  return postReview("/api/speech-gaps/delete", body, requestId);
}

export async function keepRemainingCandidates(input: {
  requestId: string;
  baseRevision: number;
}): Promise<ReviewResponse> {
  const { requestId, ...body } = input;
  return postReview("/api/candidates/keep-remaining", body, requestId);
}

export async function createExport(input: {
  requestId: string;
  baseRevision: number;
  preset?: ExportPreset;
}): Promise<ExportJobResponse> {
  const { requestId, ...body } = input;
  return postJson("/api/exports", body, requestId);
}

export async function fetchExport(jobId: string): Promise<ExportJobResponse> {
  const response = await fetch(`/api/exports/${encodeURIComponent(jobId)}`);
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<ExportJobResponse>;
}

export async function cancelExport(
  jobId: string,
  requestId: string,
): Promise<ExportJobResponse> {
  const response = await fetch(`/api/exports/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId }),
  });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<ExportJobResponse>;
}

export async function reviewCandidate(input: {
  requestId: string;
  candidateId: string;
  action: "accept" | "keep";
  baseRevision: number;
  confirmHighRisk?: boolean;
}): Promise<ReviewResponse> {
  return postReview(
    `/api/candidates/${encodeURIComponent(input.candidateId)}/${input.action}`,
    {
      baseRevision: input.baseRevision,
      ...(input.confirmHighRisk ? { confirmHighRisk: true } : {}),
    },
    input.requestId,
  );
}

export async function batchAcceptCandidates(input: {
  requestId: string;
  candidateIds: string[];
  baseRevision: number;
}): Promise<ReviewResponse> {
  const { requestId, ...body } = input;
  return postReview("/api/candidates/batch-accept", body, requestId);
}

export async function resolveApproval(input: {
  requestId: string;
  approvalId: string;
  baseRevision: number;
  decision: "approve" | "deny";
}): Promise<ReviewResponse> {
  return postReview(
    `/api/approvals/${encodeURIComponent(input.approvalId)}/resolve`,
    { baseRevision: input.baseRevision, decision: input.decision },
    input.requestId,
  );
}

export async function revokeAgentSession(input: {
  requestId: string;
  sessionId: string;
}): Promise<ReviewResponse> {
  return postReview(
    `/api/agent-sessions/${encodeURIComponent(input.sessionId)}/revoke`,
    {},
    input.requestId,
  );
}

export async function reconsiderCandidate(input: {
  requestId: string;
  lockId: string;
  baseRevision: number;
}): Promise<ReviewResponse> {
  return postReview(
    `/api/locks/${encodeURIComponent(input.lockId)}/remove`,
    { baseRevision: input.baseRevision },
    input.requestId,
  );
}

export function seconds(time: TimeValue): number {
  return time.value * time.rate.denominator / time.rate.numerator;
}

export function durationLabel(range: TimeRange): string {
  const value = seconds(range.duration);
  return value >= 1 ? `${value.toFixed(2)} 秒` : `${Math.round(value * 1_000)} 毫秒`;
}

export class ReviewApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ReviewApiError";
  }
}

async function postReview(
  path: string,
  body: Record<string, unknown>,
  requestId: string,
): Promise<ReviewResponse> {
  return postJson(path, body, requestId);
}

async function postJson<T>(path: string, body: object, requestId: string = crypto.randomUUID()): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, requestId }),
  });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<T>;
}

async function responseError(response: Response): Promise<Error> {
  if (response.status === 502 || response.status === 503) {
    return new ReviewApiError(
      response.status,
      "DAEMON_UNAVAILABLE",
      "本地 AgentCut 运行服务未连接。请使用 pnpm studio -- <工程目录> 启动完整工作区。",
    );
  }
  try {
    const body = await response.json() as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    const code = body.error?.code ?? "HTTP_ERROR";
    return new ReviewApiError(
      response.status,
      code,
      code === "INVALID_DOCUMENT"
        ? "剪辑结果未通过工程校验，本次没有写入。请刷新后重试；若仍失败，请保留当前 REV 并检查错误详情。"
        : body.error?.message ?? `${response.status} ${response.statusText}`,
      body.error?.details ?? {},
    );
  } catch {
    return new ReviewApiError(
      response.status,
      "HTTP_ERROR",
      `${response.status} ${response.statusText}`,
    );
  }
}
