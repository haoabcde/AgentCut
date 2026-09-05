import type { CommandRecord } from "@agentcut/edit-commands";
import { compareTime, rangesOverlap } from "@agentcut/timeline-engine";
import type {
  AgentCutProjectDocument,
  CandidateSetArtifact,
  DeletionCandidate,
  DeletionReasonCode,
  TimeRange,
  TranscriptArtifact,
} from "@agentcut/timeline-schema";

export type ReviewState =
  | "normal"
  | "candidate_remove"
  | "candidate_keep"
  | "reviewed_keep"
  | "committed_deleted";

export interface TranscriptReviewToken {
  wordId: string;
  text: string;
  sourceRange: TimeRange;
  state: ReviewState;
  decoration: "none" | "candidate_background" | "kept_background" | "strikethrough";
  candidateIds: string[];
  reasonCodes: DeletionReasonCode[];
  risk?: "low" | "medium" | "high";
  confidence?: number;
  explanationZh?: string;
  proposalId?: string;
  transactionId?: string;
  lockId?: string;
  restorable: boolean;
}

export interface TranscriptReviewGap {
  candidateId: string;
  sourceRange: TimeRange;
  previousWordId?: string;
  nextWordId?: string;
  state: Exclude<ReviewState, "normal">;
  decoration: "candidate_background" | "kept_gap" | "committed_gap";
  reasonCodes: DeletionReasonCode[];
  risk: "low" | "medium" | "high";
  confidence: number;
  explanationZh: string;
  proposalId?: string;
  transactionId?: string;
  lockId?: string;
  restorable: boolean;
}

export interface TranscriptReviewEvidence {
  role: "retained_comparison";
  sourceRange: TimeRange;
  wordIds: string[];
  text: string;
}

export interface TranscriptReviewCandidate {
  candidateId: string;
  targetKind: "words" | "gap";
  sourceRange: TimeRange;
  wordIds: string[];
  previousWordId?: string;
  nextWordId?: string;
  state: Exclude<ReviewState, "normal">;
  reasonCodes: DeletionReasonCode[];
  risk: "low" | "medium" | "high";
  confidence: number;
  explanationZh: string;
  evidenceStatus?: "structured" | "legacy_missing";
  evidence?: TranscriptReviewEvidence[];
  proposalId?: string;
  transactionId?: string;
  lockId?: string;
  overlapCandidateIds?: string[];
  overlapDecisionAnchorId?: string;
  overlapResolvedByCandidateId?: string;
  restorable: boolean;
}

export interface TranscriptReviewProjection {
  transcriptId: string;
  projectRevision: number;
  candidates: TranscriptReviewCandidate[];
  tokens: TranscriptReviewToken[];
  gaps: TranscriptReviewGap[];
  summary: {
    normalTokens: number;
    candidateTokens: number;
    deletedTokens: number;
    reviewedKeepTokens: number;
    candidateGaps: number;
    committedGaps: number;
    reviewedKeepGaps: number;
  };
}

interface CommitBinding {
  proposalId: string;
  transactionId: string;
}

interface CandidateBinding {
  candidate: DeletionCandidate;
  commit?: CommitBinding;
  keepLockId?: string;
  overlapResolvedByCandidateId?: string;
}

const KEEP_NOTE_PREFIX = "agentcut:candidate_keep:";
const OVERLAP_GROUP_NOTE_PREFIX = "agentcut:candidate_overlap_group:";

export function buildTranscriptReviewProjection(
  document: AgentCutProjectDocument,
  records: CommandRecord[],
  transcriptId: string,
): TranscriptReviewProjection {
  const transcript = findTranscript(document, transcriptId);
  const candidateSets = document.artifacts.filter((artifact): artifact is CandidateSetArtifact =>
    artifact.kind === "deletionCandidateSet" && artifact.transcriptArtifactId === transcriptId,
  );
  const proposals = document.artifacts.filter((artifact) => artifact.kind === "editProposal");
  const commitByProposal = new Map<string, CommitBinding>();
  const keepLockByCandidate = new Map<string, {
    lockId: string;
    overlapResolvedByCandidateId?: string;
  }>();
  for (const lock of document.sequences.flatMap((sequence) => sequence.locks)) {
    const binding = candidateFromReviewLock(lock.note);
    if (!binding) continue;
    keepLockByCandidate.set(binding.candidateId, {
      lockId: lock.id,
      ...(binding.overlapResolvedByCandidateId
        ? { overlapResolvedByCandidateId: binding.overlapResolvedByCandidateId }
        : {}),
    });
  }
  for (const proposal of proposals) {
    const record = [...records].reverse().find((candidateRecord) =>
      candidateRecord.request.operations.some((operation) =>
        operation.type === "range.deleteRipple" && operation.proposalId === proposal.id,
      ),
    );
    if (record) {
      commitByProposal.set(proposal.id, {
        proposalId: proposal.id,
        transactionId: record.transactionId,
      });
    }
  }

  const candidatesByWord = new Map<string, CandidateBinding[]>();
  const gapsByCandidate = new Map<string, TranscriptReviewGap>();
  const reviewCandidatesById = new Map<string, TranscriptReviewCandidate>();
  for (const candidateSet of candidateSets) {
    const boundProposals = proposals.filter((proposal) =>
      proposal.candidateSetArtifactId === candidateSet.id,
    );
    for (const candidate of candidateSet.candidates) {
      const selectedProposal = boundProposals.find((proposal) =>
        proposal.selectedCandidateIds.includes(candidate.id) && commitByProposal.has(proposal.id),
      );
      const commit = selectedProposal ? commitByProposal.get(selectedProposal.id) : undefined;
      const keepLock = keepLockByCandidate.get(candidate.id);
      const keepLockId = keepLock?.lockId;
      const binding: CandidateBinding = {
        candidate,
        ...(commit ? { commit } : {}),
        ...(!commit && keepLockId ? { keepLockId } : {}),
        ...(!commit && keepLock?.overlapResolvedByCandidateId
          ? { overlapResolvedByCandidateId: keepLock.overlapResolvedByCandidateId }
          : {}),
      };
      const reviewCandidate = projectReviewCandidate(binding, transcript);
      const previousCandidate = reviewCandidatesById.get(candidate.id);
      if (!previousCandidate
        || reviewPriority(reviewCandidate.state) >= reviewPriority(previousCandidate.state)) {
        reviewCandidatesById.set(candidate.id, reviewCandidate);
      }
      if (candidate.target.kind === "words") {
        for (const wordId of candidate.target.wordIds) {
          const existing = candidatesByWord.get(wordId) ?? [];
          const previousIndex = existing.findIndex((item) => item.candidate.id === candidate.id);
          if (previousIndex < 0) {
            existing.push(binding);
          } else if (reviewPriority(reviewCandidate.state)
            >= reviewPriority(projectReviewCandidate(existing[previousIndex]!, transcript).state)) {
            existing[previousIndex] = binding;
          }
          candidatesByWord.set(wordId, existing);
        }
      } else {
        const state = commit
          ? "committed_deleted"
          : keepLockId
            ? "reviewed_keep"
          : candidate.decision === "suggest_keep"
            ? "candidate_keep"
            : "candidate_remove";
        const projected: TranscriptReviewGap = {
          candidateId: candidate.id,
          sourceRange: structuredClone(candidate.target.sourceRange),
          ...(candidate.target.previousWordId
            ? { previousWordId: candidate.target.previousWordId }
            : {}),
          ...(candidate.target.nextWordId ? { nextWordId: candidate.target.nextWordId } : {}),
          state,
          decoration: commit ? "committed_gap" : keepLockId ? "kept_gap" : "candidate_background",
          reasonCodes: [...candidate.reasonCodes],
          risk: candidate.risk,
          confidence: candidate.confidence,
          explanationZh: candidate.explanationZh,
          ...(commit ? {
            proposalId: commit.proposalId,
            transactionId: commit.transactionId,
          } : {}),
          ...(!commit && keepLockId ? { lockId: keepLockId } : {}),
          restorable: Boolean(commit),
        };
        const previous = gapsByCandidate.get(candidate.id);
        if (!previous || reviewPriority(projected.state) >= reviewPriority(previous.state)) {
          gapsByCandidate.set(candidate.id, projected);
        }
      }
    }
  }

  const tokens = transcript.words.map((word): TranscriptReviewToken => {
    const matches = candidatesByWord.get(word.id) ?? [];
    const committed = matches.find((match) => match.commit);
    const kept = matches.find((match) => match.keepLockId);
    const strongest = committed ?? kept ?? matches.find((match) => match.candidate.decision !== "suggest_keep")
      ?? matches[0];
    if (!strongest) {
      return {
        wordId: word.id,
        text: word.text,
        sourceRange: structuredClone(word.sourceRange),
        state: "normal",
        decoration: "none",
        candidateIds: [],
        reasonCodes: [],
        restorable: false,
      };
    }
    const state = strongest.commit
      ? "committed_deleted"
      : strongest.keepLockId
        ? "reviewed_keep"
      : strongest.candidate.decision === "suggest_keep"
        ? "candidate_keep"
        : "candidate_remove";
    return {
      wordId: word.id,
      text: word.text,
      sourceRange: structuredClone(word.sourceRange),
      state,
      decoration: strongest.commit
        ? "strikethrough"
        : strongest.keepLockId
          ? "kept_background"
          : "candidate_background",
      candidateIds: [...new Set(matches.map((match) => match.candidate.id))],
      reasonCodes: [...new Set(matches.flatMap((match) => match.candidate.reasonCodes))],
      risk: strongest.candidate.risk,
      confidence: strongest.candidate.confidence,
      explanationZh: strongest.candidate.explanationZh,
      ...(strongest.commit ? {
        proposalId: strongest.commit.proposalId,
        transactionId: strongest.commit.transactionId,
      } : {}),
      ...(!strongest.commit && strongest.keepLockId ? { lockId: strongest.keepLockId } : {}),
      restorable: Boolean(strongest.commit),
    };
  });
  const gaps = [...gapsByCandidate.values()].sort((left, right) =>
    compareTime(left.sourceRange.start, right.sourceRange.start),
  );
  const candidates = decoratePendingOverlapGroups([...reviewCandidatesById.values()]).sort((left, right) =>
    compareTime(left.sourceRange.start, right.sourceRange.start)
      || left.candidateId.localeCompare(right.candidateId),
  );
  return {
    transcriptId,
    projectRevision: document.project.revision,
    candidates,
    tokens,
    gaps,
    summary: {
      normalTokens: tokens.filter((token) => token.state === "normal").length,
      candidateTokens: tokens.filter((token) =>
        token.state === "candidate_remove" || token.state === "candidate_keep",
      ).length,
      deletedTokens: tokens.filter((token) => token.state === "committed_deleted").length,
      reviewedKeepTokens: tokens.filter((token) => token.state === "reviewed_keep").length,
      candidateGaps: gaps.filter((gap) =>
        gap.state === "candidate_remove" || gap.state === "candidate_keep",
      ).length,
      committedGaps: gaps.filter((gap) => gap.state === "committed_deleted").length,
      reviewedKeepGaps: gaps.filter((gap) => gap.state === "reviewed_keep").length,
    },
  };
}

function projectReviewCandidate(
  binding: CandidateBinding,
  transcript: TranscriptArtifact,
): TranscriptReviewCandidate {
  const { candidate, commit, keepLockId } = binding;
  const words = new Map(transcript.words.map((word) => [word.id, word]));
  const expectsComparison = candidate.reasonCodes.some((reason) =>
    reason === "repetition" || reason === "restatement" || reason === "correction",
  );
  const hasComparison = candidate.evidence?.some((evidence) =>
    evidence.role === "retained_comparison",
  ) === true;
  const state = commit
    ? "committed_deleted"
    : keepLockId
      ? "reviewed_keep"
      : candidate.decision === "suggest_keep"
        ? "candidate_keep"
        : "candidate_remove";
  return {
    candidateId: candidate.id,
    targetKind: candidate.target.kind,
    sourceRange: structuredClone(candidate.target.sourceRange),
    wordIds: candidate.target.kind === "words" ? [...candidate.target.wordIds] : [],
    ...(candidate.target.kind === "gap" && candidate.target.previousWordId
      ? { previousWordId: candidate.target.previousWordId }
      : {}),
    ...(candidate.target.kind === "gap" && candidate.target.nextWordId
      ? { nextWordId: candidate.target.nextWordId }
      : {}),
    state,
    reasonCodes: [...candidate.reasonCodes],
    risk: candidate.risk,
    confidence: candidate.confidence,
    explanationZh: candidate.explanationZh,
    ...(expectsComparison ? {
      evidenceStatus: hasComparison ? "structured" as const : "legacy_missing" as const,
    } : {}),
    ...(candidate.evidence?.length ? {
      evidence: candidate.evidence.map((evidence) => ({
        role: evidence.role,
        sourceRange: structuredClone(evidence.target.sourceRange),
        wordIds: [...evidence.target.wordIds],
        text: evidence.target.wordIds.map((wordId) => words.get(wordId)?.text ?? "").join(""),
      })),
    } : {}),
    ...(commit ? {
      proposalId: commit.proposalId,
      transactionId: commit.transactionId,
    } : {}),
    ...(!commit && keepLockId ? { lockId: keepLockId } : {}),
    ...(!commit && binding.overlapResolvedByCandidateId
      ? { overlapResolvedByCandidateId: binding.overlapResolvedByCandidateId }
      : {}),
    restorable: Boolean(commit),
  };
}

function decoratePendingOverlapGroups(
  candidates: TranscriptReviewCandidate[],
): TranscriptReviewCandidate[] {
  const pending = candidates.filter((candidate) =>
    candidate.state === "candidate_remove" || candidate.state === "candidate_keep",
  );
  const remaining = new Set(pending.map((candidate) => candidate.candidateId));
  const byId = new Map(pending.map((candidate) => [candidate.candidateId, candidate]));
  const groups = new Map<string, { candidateIds: string[]; anchorId: string }>();

  while (remaining.size > 0) {
    const first = remaining.values().next().value as string;
    const queue = [first];
    const component: TranscriptReviewCandidate[] = [];
    remaining.delete(first);
    while (queue.length > 0) {
      const current = byId.get(queue.shift()!)!;
      component.push(current);
      for (const candidateId of [...remaining]) {
        const candidate = byId.get(candidateId)!;
        if (!rangesOverlap(current.sourceRange, candidate.sourceRange)) continue;
        remaining.delete(candidateId);
        queue.push(candidateId);
      }
    }
    if (component.length < 2) continue;
    const anchor = [...component].sort(compareOverlapDecisionPriority)[0]!;
    const candidateIds = component.map((candidate) => candidate.candidateId).sort();
    for (const candidate of component) {
      groups.set(candidate.candidateId, { candidateIds, anchorId: anchor.candidateId });
    }
  }

  return candidates.map((candidate) => {
    const group = groups.get(candidate.candidateId);
    if (!group) return candidate;
    return {
      ...candidate,
      overlapCandidateIds: group.candidateIds.filter((candidateId) =>
        candidateId !== candidate.candidateId,
      ),
      overlapDecisionAnchorId: group.anchorId,
    };
  });
}

function compareOverlapDecisionPriority(
  left: TranscriptReviewCandidate,
  right: TranscriptReviewCandidate,
): number {
  return overlapPriority(right) - overlapPriority(left)
    || compareTime(left.sourceRange.start, right.sourceRange.start)
    || left.candidateId.localeCompare(right.candidateId);
}

function overlapPriority(candidate: TranscriptReviewCandidate): number {
  const risk = candidate.risk === "high" ? 300 : candidate.risk === "medium" ? 200 : 100;
  const target = candidate.targetKind === "words" ? 20 : 0;
  const semantic = candidate.reasonCodes.some((reason) =>
    reason === "repetition" || reason === "restatement" || reason === "correction",
  ) ? 10 : 0;
  return risk + target + semantic;
}

function candidateFromReviewLock(note: string | undefined): {
  candidateId: string;
  overlapResolvedByCandidateId?: string;
} | undefined {
  if (note?.startsWith(KEEP_NOTE_PREFIX)) {
    return { candidateId: note.slice(KEEP_NOTE_PREFIX.length) };
  }
  if (!note?.startsWith(OVERLAP_GROUP_NOTE_PREFIX)) return undefined;
  const [anchorId, candidateId, trailing] = note.slice(OVERLAP_GROUP_NOTE_PREFIX.length).split(":");
  if (!anchorId || !candidateId || trailing !== undefined) return undefined;
  return {
    candidateId,
    ...(candidateId !== anchorId ? { overlapResolvedByCandidateId: anchorId } : {}),
  };
}

function reviewPriority(state: ReviewState): number {
  if (state === "committed_deleted") return 3;
  if (state === "reviewed_keep") return 2;
  if (state === "candidate_remove") return 1;
  return 0;
}

function findTranscript(document: AgentCutProjectDocument, transcriptId: string): TranscriptArtifact {
  const artifact = document.artifacts.find((candidate) => candidate.id === transcriptId);
  if (!artifact || artifact.kind !== "transcript") {
    throw new TypeError(`Transcript ${transcriptId} does not exist`);
  }
  return artifact;
}
