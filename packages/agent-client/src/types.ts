export type RoughCutStatus = "not_started" | "reviewing" | "rough_cut_ready";
export type CandidateState = "candidate_remove" | "candidate_keep" | "reviewed_keep" | "committed_deleted";
export type Risk = "low" | "medium" | "high";
export interface ReviewTimeRange {
  start: { value: number; rate: { numerator: number; denominator: number } };
  duration: { value: number; rate: { numerator: number; denominator: number } };
}
export type AgentCapability =
  | "project:read"
  | "transcript:read"
  | "analysis:local"
  | "analysis:propose"
  | "timeline:write:low_risk_only"
  | "approval:request"
  | "timeline:write:approved"
  | "export:write";

export interface AgentSessionDescriptor {
  id: string;
  projectId: string;
  clientId: string;
  capabilities: AgentCapability[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface AgentSessionCredential {
  session: AgentSessionDescriptor;
  accessToken: string;
}

export interface AgentSessionResponse extends AgentSessionCredential {
  idempotentReplay: boolean;
}

export interface CandidateSummary {
  candidateId: string;
  decision: "definite_remove" | "suggest_remove" | "keep";
  targetKind: "words" | "gap";
  wordIds: string[];
  state: CandidateState;
  reasonCodes: string[];
  risk: Risk;
  confidence: number;
  explanationZh: string;
  sourceStartMicros: number;
  durationMicros: number;
  text: string;
  evidenceStatus?: "structured" | "legacy_missing";
  evidence?: CandidateEvidenceSummary[];
  transactionId?: string;
}

export interface CandidateEvidenceSummary {
  role: "retained_comparison";
  wordIds: string[];
  sourceStartMicros: number;
  durationMicros: number;
  text: string;
}

export type SemanticFindingCategory =
  | "repetition"
  | "restatement"
  | "false_start"
  | "incomplete"
  | "correction";

export interface AgentSemanticFinding {
  category: SemanticFindingCategory;
  removeStartWordId: string;
  removeEndWordId: string;
  keepStartWordId: string | null;
  keepEndWordId: string | null;
  confidence: number;
  explanationZh: string;
}

export interface AgentTranscriptPage {
  protocolVersion: "0.1.0";
  project: { id: string; revision: number };
  transcript: {
    id: string;
    language: string;
    sourceSha256: string;
    totalWords: number;
    offset: number;
    limit: number;
    nextOffset: number | null;
    words: Array<{
      wordId: string;
      index: number;
      text: string;
      startMicros: number;
      durationMicros: number;
      confidence: number;
    }>;
  };
}

export interface ReviewCandidate {
  candidateId: string;
  targetKind: "words" | "gap";
  wordIds: string[];
  state: CandidateState;
  reasonCodes: string[];
  risk: Risk;
  confidence: number;
  explanationZh: string;
  evidenceStatus?: "structured" | "legacy_missing";
  evidence?: Array<{
    role: "retained_comparison";
    sourceRange: ReviewTimeRange;
    wordIds: string[];
    text: string;
  }>;
  transactionId?: string;
  lockId?: string;
  overlapCandidateIds?: string[];
  overlapDecisionAnchorId?: string;
  overlapResolvedByCandidateId?: string;
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

export interface ReviewResponse {
  project: { id: string; name: string; revision: number };
  roughCutStatus: RoughCutStatus;
  preview?: { revision: number; durationSeconds: number };
  transcript: { id: string; language: string; providerArtifactId?: string };
  media: { assetId: string; url: string; originalFileName: string };
  review: {
    transcriptId: string;
    projectRevision: number;
    candidates: ReviewCandidate[];
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
  capabilities?: {
    semanticReview: { available: boolean; provider?: string };
    agentSession?: Pick<AgentSessionDescriptor, "id" | "clientId" | "capabilities" | "expiresAt">;
  };
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
  approvalToken?: string;
}

export interface ApprovalResponse {
  approval: ApprovalSummary;
  idempotentReplay?: boolean;
}

export interface ProjectDiffChange {
  transactionId: string;
  baseRevision: number;
  committedRevision: number;
  actor: { kind: "user" | "agent" | "workflow" | "system"; id: string };
  reason: string;
  operationTypes: string[];
  objectIds: string[];
  beforeHash: string;
  afterHash: string;
  committedAt: string;
}

export interface ProjectDiffResponse {
  projectId: string;
  fromRevision: number;
  toRevision: number;
  headRevision: number;
  changes: ProjectDiffChange[];
}

export interface AgentStatus {
  protocolVersion: "0.1.0";
  project: ReviewResponse["project"];
  roughCutStatus: RoughCutStatus;
  transcript: ReviewResponse["transcript"];
  media: Pick<ReviewResponse["media"], "assetId" | "originalFileName">;
  preview: { revision: number; durationSeconds: number } | null;
  candidates: {
    total: number;
    pending: number;
    committedDeleted: number;
    reviewedKeep: number;
    byRisk: Record<Risk, number>;
  };
  jobs: ReviewResponse["jobs"];
  exports: ExportJobResponse[];
  approvals: ApprovalSummary[];
  capabilities: NonNullable<ReviewResponse["capabilities"]>;
}

export interface AgentCutWireError {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

export interface AlphaAuditResponse {
  audit: {
    project: { id: string; name: string; revision: number; sourceSha256: string };
    review: { completed: boolean; pendingCandidateIds: string[] };
    candidates: CandidateSummary[];
  };
}

/** 协议 core 的工程概要：任何实现本协议的宿主都提供同一形状。 */
export interface AgentProjectSummary {
  protocolVersion: "0.1.0";
  project: {
    id: string;
    name: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    activeSequenceId: string;
  };
  facts: {
    sequenceCount: number;
    clipCount: number;
    artifactCount: number;
    transcriptArtifacts: number;
  };
  capabilities: { extensions: string[] };
  session?: {
    id: string;
    clientId: string;
    capabilities: AgentCapability[];
    expiresAt: string;
  };
}

/**
 * 任意通过宿主校验的 timeline transaction 输入。operations 保持结构化透传：
 * 宿主端的 typed engine 是唯一校验者，客户端不复制 operation schema。
 */
export interface AgentTimelineTransactionInput {
  transactionId: string;
  idempotencyKey: string;
  projectId: string;
  sequenceId: string;
  baseRevision: number;
  reason: string;
  preconditions?: unknown[];
  operations: unknown[];
}

export interface AgentTimelineTransactionResult {
  protocolVersion: "0.1.0";
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
