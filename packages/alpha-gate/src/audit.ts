import type { CommandRecord } from "@agentcut/edit-commands";
import { evaluateTimelineSegments } from "@agentcut/render-engine";
import { buildTranscriptReviewProjection, type ReviewState } from "@agentcut/review-projection";
import { convertTime } from "@agentcut/timeline-engine";
import { readAlphaTrialEnrollment } from "@agentcut/host-extensions";
import type {
  AgentCutProjectDocument,
  Actor,
  DeletionCandidate,
  DeletionReasonCode,
  RenderReportArtifact,
  TranscriptArtifact,
} from "@agentcut/timeline-schema";

export class AlphaAuditError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AlphaAuditError";
  }
}

export interface AlphaAuditCandidate {
  candidateId: string;
  decision: DeletionCandidate["decision"];
  risk: DeletionCandidate["risk"];
  reasonCodes: DeletionReasonCode[];
  confidence: number;
  explanationZh: string;
  targetKind: "words" | "gap";
  wordIds: string[];
  sourceStartMicros: number;
  durationMicros: number;
  text: string;
  evidenceStatus?: "structured" | "legacy_missing";
  evidence?: Array<{
    role: "retained_comparison";
    wordIds: string[];
    sourceStartMicros: number;
    durationMicros: number;
    text: string;
  }>;
  state: Exclude<ReviewState, "normal">;
  transactionId?: string;
  committedBy?: Actor;
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
  humanIssueCodes: Array<"swallowed_word" | "clipped_syllable" | "av_sync" | "unnatural_pacing" | "other">;
  humanNote: string | null;
}

export interface AlphaAuditDraft {
  schemaVersion: "1.0";
  project: {
    id: string;
    name: string;
    revision: number;
    sequenceId: string;
    transcriptId: string;
    sourceAssetId: string;
    sourceSha256: string;
    alphaTrial?: {
      mode: "formal";
      enrolledAt: string;
    } | null;
  };
  review: {
    completed: boolean;
    pendingCandidateIds: string[];
  };
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
    quality: RenderReportArtifact["quality"];
  } | null;
}

const MICROS_RATE = { numerator: 1_000_000, denominator: 1 } as const;

export function createAlphaAuditDraft(
  document: AgentCutProjectDocument,
  records: CommandRecord[],
): AlphaAuditDraft {
  const transcripts = document.artifacts.filter((artifact): artifact is TranscriptArtifact =>
    artifact.kind === "transcript",
  );
  if (transcripts.length !== 1) {
    throw new AlphaAuditError(
      "TRANSCRIPT_MISSING",
      `Alpha audit requires exactly one Transcript artifact; found ${transcripts.length}`,
    );
  }
  const transcript = transcripts[0]!;
  const sourceAsset = document.assets.find((asset) => asset.id === transcript.assetId);
  if (!sourceAsset) {
    throw new AlphaAuditError(
      "SOURCE_ASSET_MISSING",
      `Transcript ${transcript.id} references missing asset ${transcript.assetId}`,
    );
  }
  const sequenceId = document.project.activeSequenceId;
  const projection = buildTranscriptReviewProjection(document, records, transcript.id);
  const projectedById = new Map(projection.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const latestCandidates = latestCandidateDefinitions(document, transcript.id);
  const wordsById = new Map(transcript.words.map((word) => [word.id, word]));
  const recordsByTransaction = new Map(records.map((record) => [record.transactionId, record]));
  const humanDecisionRevisions = records.filter(isHumanContentDecision)
    .map((record) => record.committedRevision);

  const candidates = [...latestCandidates.values()].map((candidate): AlphaAuditCandidate => {
    const projected = projectedById.get(candidate.id);
    if (!projected) {
      throw new AlphaAuditError("CANDIDATE_PROJECTION_MISSING", `Candidate ${candidate.id} is not projectable`);
    }
    const transactionId = projected.transactionId;
    const record = transactionId ? recordsByTransaction.get(transactionId) : undefined;
    return {
      candidateId: candidate.id,
      decision: candidate.decision,
      risk: candidate.risk,
      reasonCodes: [...candidate.reasonCodes],
      confidence: candidate.confidence,
      explanationZh: candidate.explanationZh,
      targetKind: candidate.target.kind,
      wordIds: candidate.target.kind === "words" ? [...candidate.target.wordIds] : [],
      sourceStartMicros: toMicros(candidate.target.sourceRange.start),
      durationMicros: toMicros(candidate.target.sourceRange.duration),
      text: candidateText(candidate, wordsById),
      ...(projected.evidenceStatus ? { evidenceStatus: projected.evidenceStatus } : {}),
      ...(candidate.evidence?.length ? {
        evidence: candidate.evidence.map((evidence) => ({
          role: evidence.role,
          wordIds: [...evidence.target.wordIds],
          sourceStartMicros: toMicros(evidence.target.sourceRange.start),
          durationMicros: toMicros(evidence.target.sourceRange.duration),
          text: evidence.target.wordIds.map((wordId) => wordsById.get(wordId)?.text ?? "").join(""),
        })),
      } : {}),
      state: projected.state,
      ...(transactionId ? { transactionId } : {}),
      ...(record ? { committedBy: structuredClone(record.request.actor) } : {}),
      humanLabel: null,
      humanNote: null,
    };
  }).sort((left, right) =>
    left.sourceStartMicros - right.sourceStartMicros || left.candidateId.localeCompare(right.candidateId),
  );

  const pendingCandidateIds = candidates.filter((candidate) =>
    candidate.state === "candidate_remove" || candidate.state === "candidate_keep",
  ).map((candidate) => candidate.candidateId);
  const timeline = evaluateTimelineSegments(document, sequenceId, transcript.id);
  const boundaries = timelineBoundaries(timeline.segments, candidates);
  const latestRender = [...document.artifacts].reverse().find((artifact): artifact is RenderReportArtifact =>
    artifact.kind === "renderReport",
  );
  const alphaTrial = alphaTrialBinding(document);

  return {
    schemaVersion: "1.0",
    project: {
      id: document.project.id,
      name: document.project.name,
      revision: document.project.revision,
      sequenceId,
      transcriptId: transcript.id,
      sourceAssetId: sourceAsset.id,
      sourceSha256: sourceAsset.contentHash,
      ...(alphaTrial ? { alphaTrial } : {}),
    },
    review: {
      completed: pendingCandidateIds.length === 0,
      pendingCandidateIds,
    },
    candidates,
    boundaries,
    derived: {
      definiteRemovePredicted: candidates.filter((candidate) =>
        candidate.decision === "definite_remove",
      ).length,
      definiteRemoveCommitted: candidates.filter((candidate) =>
        candidate.decision === "definite_remove" && candidate.state === "committed_deleted",
      ).length,
      highRiskAutoDeletedCandidateIds: candidates.filter((candidate) =>
        candidate.risk === "high" && candidate.state === "committed_deleted"
          && candidate.committedBy?.kind === "workflow",
      ).map((candidate) => candidate.candidateId),
      firstHumanDecisionRevision: humanDecisionRevisions.length > 0
        ? Math.min(...humanDecisionRevisions)
        : null,
    },
    export: latestRender ? renderEvidence(document, latestRender) : null,
  };
}

function alphaTrialBinding(
  document: AgentCutProjectDocument,
): { mode: "formal"; enrolledAt: string } | null {
  const enrollment = readAlphaTrialEnrollment(document);
  return enrollment ? { mode: enrollment.mode, enrolledAt: enrollment.enrolledAt } : null;
}

function isHumanContentDecision(record: CommandRecord): boolean {
  if (record.request.actor.kind !== "user") return false;
  if (record.request.idempotencyKey.startsWith("restore:")) return true;
  return record.request.operations.some((operation) =>
    operation.type === "range.deleteRipple"
      || operation.type === "lock.add"
      || operation.type === "lock.remove",
  );
}

function latestCandidateDefinitions(
  document: AgentCutProjectDocument,
  transcriptId: string,
): Map<string, DeletionCandidate> {
  const candidates = new Map<string, DeletionCandidate>();
  for (const artifact of document.artifacts) {
    if (artifact.kind !== "deletionCandidateSet" || artifact.transcriptArtifactId !== transcriptId) continue;
    for (const candidate of artifact.candidates) candidates.set(candidate.id, candidate);
  }
  return candidates;
}

function candidateText(
  candidate: DeletionCandidate,
  wordsById: Map<string, TranscriptArtifact["words"][number]>,
): string {
  if (candidate.target.kind === "words") {
    return candidate.target.wordIds.map((wordId) => wordsById.get(wordId)?.text ?? `[${wordId}]`).join("");
  }
  const previous = candidate.target.previousWordId
    ? wordsById.get(candidate.target.previousWordId)?.text ?? ""
    : "";
  const next = candidate.target.nextWordId ? wordsById.get(candidate.target.nextWordId)?.text ?? "" : "";
  return `${previous}[停顿]${next}`;
}

function timelineBoundaries(
  segments: ReturnType<typeof evaluateTimelineSegments>["segments"],
  candidates: AlphaAuditCandidate[],
): AlphaAuditBoundary[] {
  const boundaries: AlphaAuditBoundary[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const left = segments[index - 1]!;
    const right = segments[index]!;
    if (left.assetId !== right.assetId) continue;
    const leftSourceEndMicros = left.sourceStartMicros + left.durationMicros;
    const rightSourceStartMicros = right.sourceStartMicros;
    if (rightSourceStartMicros <= leftSourceEndMicros) continue;
    const matchingCandidateIds = candidates.filter((candidate) => {
      if (candidate.state !== "committed_deleted") return false;
      const candidateEnd = candidate.sourceStartMicros + candidate.durationMicros;
      return candidate.sourceStartMicros <= rightSourceStartMicros && candidateEnd >= leftSourceEndMicros;
    }).map((candidate) => candidate.candidateId);
    boundaries.push({
      boundaryId: `boundary_${left.assetId}_${leftSourceEndMicros}_${rightSourceStartMicros}`,
      assetId: left.assetId,
      timelineMicros: right.timelineStartMicros,
      leftSourceEndMicros,
      rightSourceStartMicros,
      removedDurationMicros: rightSourceStartMicros - leftSourceEndMicros,
      candidateIds: matchingCandidateIds,
      humanUsable: null,
      humanIssueCodes: [],
      humanNote: null,
    });
  }
  return boundaries;
}

function renderEvidence(
  document: AgentCutProjectDocument,
  report: RenderReportArtifact,
): NonNullable<AlphaAuditDraft["export"]> {
  const output = document.assets.find((asset) => asset.id === report.outputAssetId);
  if (!output) {
    throw new AlphaAuditError(
      "RENDER_OUTPUT_MISSING",
      `Render report ${report.id} references missing output asset ${report.outputAssetId}`,
    );
  }
  return {
    reportId: report.id,
    sourceRevision: report.projectRevision,
    outputAssetId: output.id,
    outputSha256: output.contentHash,
    videoCodec: report.videoCodec,
    audioCodec: report.audioCodec,
    quality: structuredClone(report.quality),
  };
}

function toMicros(time: { value: number; rate: { numerator: number; denominator: number } }): number {
  return convertTime(time, MICROS_RATE, "nearest").value;
}
