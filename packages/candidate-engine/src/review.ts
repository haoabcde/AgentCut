import { createHash } from "node:crypto";
import {
  compileEditProposalBundle,
  computeEditProposalPayloadHash,
  type EditTransaction,
} from "@agentcut/edit-commands";
import { compareTime, convertTime, rangeEnd, rangesOverlap } from "@agentcut/timeline-engine";
import type {
  Actor,
  AgentCutProjectDocument,
  CandidateSetArtifact,
  DeletionCandidate,
  EditProposalArtifact,
  TimeRange,
  TranscriptArtifact,
} from "@agentcut/timeline-schema";
import { CandidateDetectionError } from "./silence.js";

const KEEP_NOTE_PREFIX = "agentcut:candidate_keep:";
const OVERLAP_GROUP_NOTE_PREFIX = "agentcut:candidate_overlap_group:";

export interface CandidateReviewOptions {
  candidateId: string;
  requestId: string;
  actor: Actor;
  createdAt: string;
  allowHighRisk?: boolean;
  resolveOverlapCandidateIds?: string[];
}

export interface ManualSelectionOptions {
  wordIds: string[];
  requestId: string;
  actor: Actor;
  createdAt: string;
}

export interface ManualSpeechGapOptions {
  sourceRange: TimeRange;
  previousWordId?: string;
  nextWordId?: string;
  requestId: string;
  actor: Actor;
  createdAt: string;
}

export interface CandidateKeepBatchOptions {
  candidateIds: string[];
  requestId: string;
  actor: Actor;
  createdAt: string;
}

export interface CandidateAcceptBatchOptions {
  candidateIds: string[];
  requestId: string;
  actor: Actor;
  createdAt: string;
  /** Overlap group members to lock as alternatives, keyed by selected anchor candidate ID. */
  resolveOverlapCandidateIds?: Record<string, string[]>;
}

export function computeCandidateAcceptanceApprovalPayloadHash(
  document: AgentCutProjectDocument,
  candidateId: string,
): string {
  const { candidateSet, candidate } = findCandidate(document, candidateId);
  if (candidate.risk !== "high") {
    throw new CandidateDetectionError(
      "APPROVAL_NOT_REQUIRED",
      `Candidate ${candidateId} is not high risk`,
    );
  }
  return `sha256:${createHash("sha256").update(canonicalJson({
    action: "candidate.accept",
    projectId: document.project.id,
    baseRevision: document.project.revision,
    candidateSetId: candidateSet.id,
    transcriptArtifactId: candidateSet.transcriptArtifactId,
    sequenceId: candidateSet.sequenceId,
    candidate,
  })).digest("hex")}`;
}

export function compileCandidateAcceptance(
  document: AgentCutProjectDocument,
  options: CandidateReviewOptions,
): EditTransaction {
  const source = findCandidate(document, options.candidateId);
  if (hasCandidateKeepLock(document, options.candidateId)) {
    throw new CandidateDetectionError(
      "CANDIDATE_ALREADY_REVIEWED",
      `Candidate ${options.candidateId} is kept and must be unlocked before acceptance`,
    );
  }
  if (source.candidate.risk === "high" && !options.allowHighRisk) {
    throw new CandidateDetectionError(
      "HIGH_RISK_CONFIRMATION_REQUIRED",
      `Candidate ${options.candidateId} requires explicit high-risk confirmation`,
    );
  }
  const transcript = findTranscript(document, source.candidateSet.transcriptArtifactId);
  const current = findCurrentClip(
    document,
    source.candidateSet.sequenceId,
    transcript.assetId,
    source.candidate.target.sourceRange,
  );
  const suffix = digest([
    document.project.id,
    document.project.revision,
    options.candidateId,
    options.requestId,
  ].join(":"));
  const candidateSet: CandidateSetArtifact = {
    id: `candidates_review_${suffix}`,
    kind: "deletionCandidateSet",
    transcriptArtifactId: transcript.id,
    sequenceId: source.candidateSet.sequenceId,
    clipId: current.clipId,
    projectRevision: document.project.revision,
    detectorVersion: "human-review/0.1.0",
    ...(source.candidateSet.evidenceContracts?.length ? {
      evidenceContracts: [...source.candidateSet.evidenceContracts],
    } : {}),
    candidates: [structuredClone(source.candidate)],
    provenance: {
      createdBy: structuredClone(options.actor),
      createdAt: options.createdAt,
      reason: `User accepted candidate ${options.candidateId}`,
      sourceArtifactIds: [transcript.id, source.candidateSet.id],
    },
  };
  const proposal: EditProposalArtifact = {
    id: `proposal_review_${suffix}`,
    kind: "editProposal",
    candidateSetArtifactId: candidateSet.id,
    projectRevision: document.project.revision,
    selectedCandidateIds: [options.candidateId],
    estimatedRemovedDuration: structuredClone(source.candidate.target.sourceRange.duration),
    payloadHash: "",
    provenance: {
      createdBy: structuredClone(options.actor),
      createdAt: options.createdAt,
      reason: `Apply user-reviewed candidate ${options.candidateId}`,
      sourceArtifactIds: [candidateSet.id],
    },
  };
  proposal.payloadHash = computeEditProposalPayloadHash(proposal);
  const transaction = compileEditProposalBundle(document, candidateSet, proposal, {
    transactionId: `tx_review_accept_${options.requestId}`,
    idempotencyKey: `review:accept:${options.requestId}`,
    actor: options.actor,
    reason: `Accept reviewed deletion candidate ${options.candidateId}`,
  });
  transaction.operations.push(...compileOverlapResolutionLocks(document, source, options));
  return transaction;
}

export function compileCandidateAcceptBatch(
  document: AgentCutProjectDocument,
  options: CandidateAcceptBatchOptions,
): EditTransaction {
  if (options.candidateIds.length === 0
    || new Set(options.candidateIds).size !== options.candidateIds.length) {
    throw new CandidateDetectionError(
      "INVALID_SELECTION",
      "Batch acceptance requires one or more unique candidate IDs",
    );
  }
  const sources = options.candidateIds.map((candidateId) => findCandidate(document, candidateId));
  for (const { candidate } of sources) {
    if (hasCandidateKeepLock(document, candidate.id)) {
      throw new CandidateDetectionError(
        "CANDIDATE_ALREADY_REVIEWED",
        `Candidate ${candidate.id} is kept and must be unlocked before acceptance`,
      );
    }
    if (candidate.risk === "high") {
      throw new CandidateDetectionError(
        "HIGH_RISK_CONFIRMATION_REQUIRED",
        `Candidate ${candidate.id} is high risk; batch acceptance requires individual confirmation`,
      );
    }
  }
  const firstSet = sources[0]!.candidateSet;
  const transcript = findTranscript(document, firstSet.transcriptArtifactId);
  const clipIds = new Set<string>();
  for (const { candidate, candidateSet } of sources) {
    if (candidateSet.sequenceId !== firstSet.sequenceId
      || candidateSet.transcriptArtifactId !== firstSet.transcriptArtifactId) {
      throw new CandidateDetectionError(
        "INVALID_SELECTION",
        "Batch candidates must belong to one transcript and one sequence",
      );
    }
    const current = findCurrentClip(
      document,
      candidateSet.sequenceId,
      transcript.assetId,
      candidate.target.sourceRange,
    );
    clipIds.add(current.clipId);
  }
  if (clipIds.size !== 1) {
    throw new CandidateDetectionError(
      "INVALID_SELECTION",
      "Batch candidates must be contained in one editable clip",
    );
  }
  const resolveOverlapCandidateIds = options.resolveOverlapCandidateIds ?? {};
  const members = new Set(Object.values(resolveOverlapCandidateIds).flat());
  if (options.candidateIds.some((candidateId) => members.has(candidateId))) {
    throw new CandidateDetectionError(
      "INVALID_SELECTION",
      "An overlap group member cannot be deleted together with its anchor",
    );
  }
  for (const [anchorId, memberIds] of Object.entries(resolveOverlapCandidateIds)) {
    const anchorSource = sources.find(({ candidate }) => candidate.id === anchorId);
    if (!anchorSource) {
      throw new CandidateDetectionError(
        "INVALID_SELECTION",
        `Overlap anchor ${anchorId} is not part of the selected batch`,
      );
    }
    assertOverlapResolutionCandidates(document, anchorSource, [anchorId, ...memberIds]);
  }
  const evidenceContracts = [
    ...new Set(sources.flatMap(({ candidateSet }) => candidateSet.evidenceContracts ?? [])),
  ];
  const suffix = digest([
    document.project.id,
    document.project.revision,
    options.candidateIds.join(":"),
    options.requestId,
  ].join(":"));
  const candidateSet: CandidateSetArtifact = {
    id: `candidates_review_batch_${suffix}`,
    kind: "deletionCandidateSet",
    transcriptArtifactId: transcript.id,
    sequenceId: firstSet.sequenceId,
    clipId: [...clipIds][0]!,
    projectRevision: document.project.revision,
    detectorVersion: "human-review/0.1.0",
    ...(evidenceContracts.length > 0 ? { evidenceContracts } : {}),
    candidates: sources.map(({ candidate }) => structuredClone(candidate)),
    provenance: {
      createdBy: structuredClone(options.actor),
      createdAt: options.createdAt,
      reason: `User accepted ${options.candidateIds.length} candidates in one review batch`,
      sourceArtifactIds: [transcript.id, ...new Set(sources.map(({ candidateSet }) =>
        candidateSet.id))],
    },
  };
  const totalMicros = sources.reduce((total, { candidate }) =>
    total + convertTime(candidate.target.sourceRange.duration, microsRate(), "nearest").value,
    0,
  );
  const proposal: EditProposalArtifact = {
    id: `proposal_review_batch_${suffix}`,
    kind: "editProposal",
    candidateSetArtifactId: candidateSet.id,
    projectRevision: document.project.revision,
    selectedCandidateIds: [...options.candidateIds],
    estimatedRemovedDuration: { value: totalMicros, rate: microsRate() },
    payloadHash: "",
    provenance: {
      createdBy: structuredClone(options.actor),
      createdAt: options.createdAt,
      reason: `Apply ${options.candidateIds.length} user-reviewed candidates in one batch`,
      sourceArtifactIds: [candidateSet.id],
    },
  };
  proposal.payloadHash = computeEditProposalPayloadHash(proposal);
  const transaction = compileEditProposalBundle(document, candidateSet, proposal, {
    transactionId: `tx_review_accept_batch_${options.requestId}`,
    idempotencyKey: `review:accept-batch:${options.requestId}`,
    actor: options.actor,
    reason: `Accept ${options.candidateIds.length} reviewed deletion candidates in one batch`,
  });
  for (const [anchorId, memberIds] of Object.entries(resolveOverlapCandidateIds)) {
    const anchorSource = sources.find(({ candidate }) => candidate.id === anchorId)!;
    transaction.operations.push(...compileOverlapResolutionLocks(document, anchorSource, {
      ...options,
      candidateId: anchorId,
      resolveOverlapCandidateIds: memberIds,
    }));
  }
  return transaction;
}

export function compileCandidateKeep(
  document: AgentCutProjectDocument,
  options: CandidateReviewOptions,
): EditTransaction {
  const source = findCandidate(document, options.candidateId);
  const transcript = findTranscript(document, source.candidateSet.transcriptArtifactId);
  findCurrentClip(
    document,
    source.candidateSet.sequenceId,
    transcript.assetId,
    source.candidate.target.sourceRange,
  );
  const sequence = document.sequences.find((item) => item.id === source.candidateSet.sequenceId);
  if (!sequence) {
    throw new CandidateDetectionError(
      "CANDIDATE_UNAVAILABLE",
      `Sequence ${source.candidateSet.sequenceId} no longer exists`,
    );
  }
  const candidateIds = [options.candidateId, ...(options.resolveOverlapCandidateIds ?? [])];
  assertOverlapResolutionCandidates(document, source, candidateIds);
  const grouped = candidateIds.length > 1;
  return {
    protocolVersion: "0.1.0",
    transactionId: `tx_review_keep_${options.requestId}`,
    idempotencyKey: `review:keep:${options.requestId}`,
    projectId: document.project.id,
    sequenceId: sequence.id,
    baseRevision: document.project.revision,
    actor: structuredClone(options.actor),
    reason: `Keep and protect reviewed candidate ${options.candidateId}`,
    preconditions: [],
    operations: candidateIds.map((candidateId) => candidateKeepLockOperation(
      document,
      candidateId,
      options,
      grouped ? options.candidateId : undefined,
    )),
  };
}

export function compileManualSelectionDeletion(
  document: AgentCutProjectDocument,
  options: ManualSelectionOptions,
): EditTransaction {
  const transcript = latestTranscript(document);
  const indexes = options.wordIds.map((wordId) =>
    transcript.words.findIndex((word) => word.id === wordId),
  );
  if (indexes.length === 0 || indexes.some((index) => index < 0)
    || new Set(options.wordIds).size !== options.wordIds.length
    || indexes.some((index, position) => position > 0 && index !== indexes[position - 1]! + 1)) {
    throw new CandidateDetectionError(
      "INVALID_SELECTION",
      "Manual deletion requires one non-empty contiguous Transcript word range",
    );
  }
  const words = indexes.map((index) => transcript.words[index]!);
  const start = convertTime(words[0]!.sourceRange.start, microsRate(), "nearest");
  const end = convertTime(rangeEnd(words.at(-1)!.sourceRange), microsRate(), "nearest");
  const sourceRange: TimeRange = {
    start,
    duration: { value: end.value - start.value, rate: microsRate() },
  };
  const sequenceId = document.project.activeSequenceId;
  const current = findCurrentClip(document, sequenceId, transcript.assetId, sourceRange);
  const suffix = digest([
    document.project.id,
    document.project.revision,
    options.wordIds.join(":"),
    options.requestId,
  ].join(":"));
  const candidateId = `candidate_manual_${suffix}`;
  const candidateSet: CandidateSetArtifact = {
    id: `candidates_manual_${suffix}`,
    kind: "deletionCandidateSet",
    transcriptArtifactId: transcript.id,
    sequenceId,
    clipId: current.clipId,
    projectRevision: document.project.revision,
    detectorVersion: "human-selection/0.1.0",
    candidates: [{
      id: candidateId,
      target: { kind: "words", wordIds: [...options.wordIds], sourceRange },
      reasonCodes: ["manual"],
      decision: "definite_remove",
      risk: "low",
      confidence: 1,
      explanationZh: "用户在同步文稿中明确选择并删除此范围。",
    }],
    provenance: {
      createdBy: structuredClone(options.actor),
      createdAt: options.createdAt,
      reason: "Create an explicit user-selected Transcript deletion",
      sourceArtifactIds: [transcript.id],
    },
  };
  const proposal: EditProposalArtifact = {
    id: `proposal_manual_${suffix}`,
    kind: "editProposal",
    candidateSetArtifactId: candidateSet.id,
    projectRevision: document.project.revision,
    selectedCandidateIds: [candidateId],
    estimatedRemovedDuration: structuredClone(sourceRange.duration),
    payloadHash: "",
    provenance: {
      createdBy: structuredClone(options.actor),
      createdAt: options.createdAt,
      reason: "Apply an explicit user-selected Transcript deletion",
      sourceArtifactIds: [candidateSet.id],
    },
  };
  proposal.payloadHash = computeEditProposalPayloadHash(proposal);
  return compileEditProposalBundle(document, candidateSet, proposal, {
    transactionId: `tx_manual_delete_${options.requestId}`,
    idempotencyKey: `manual:delete:${options.requestId}`,
    actor: options.actor,
    reason: "Delete user-selected Transcript words",
  });
}

export function compileManualSpeechGapDeletion(
  document: AgentCutProjectDocument,
  options: ManualSpeechGapOptions,
): EditTransaction {
  const transcript = latestTranscript(document);
  const sourceRange: TimeRange = {
    start: convertTime(options.sourceRange.start, microsRate(), "nearest"),
    duration: convertTime(options.sourceRange.duration, microsRate(), "nearest"),
  };
  if (sourceRange.duration.value <= 0 || transcript.words.some((word) =>
    rangesOverlap(word.sourceRange, sourceRange)
  )) {
    throw new CandidateDetectionError(
      "INVALID_SELECTION",
      "Manual speech-gap deletion requires one positive range without Transcript words",
    );
  }
  const previous = options.previousWordId
    ? transcript.words.find((word) => word.id === options.previousWordId)
    : undefined;
  const next = options.nextWordId
    ? transcript.words.find((word) => word.id === options.nextWordId)
    : undefined;
  if ((options.previousWordId && !previous) || (options.nextWordId && !next)
    || (previous && compareTime(rangeEnd(previous.sourceRange), sourceRange.start) > 0)
    || (next && compareTime(next.sourceRange.start, rangeEnd(sourceRange)) < 0)) {
    throw new CandidateDetectionError(
      "INVALID_SELECTION",
      "Manual speech-gap anchors no longer bound the selected source range",
    );
  }
  const sequenceId = document.project.activeSequenceId;
  const current = findCurrentClip(document, sequenceId, transcript.assetId, sourceRange);
  const suffix = digest([
    document.project.id,
    document.project.revision,
    sourceRange.start.value,
    sourceRange.duration.value,
    options.requestId,
  ].join(":"));
  const candidateId = `candidate_manual_gap_${suffix}`;
  const candidateSet: CandidateSetArtifact = {
    id: `candidates_manual_gap_${suffix}`,
    kind: "deletionCandidateSet",
    transcriptArtifactId: transcript.id,
    sequenceId,
    clipId: current.clipId,
    projectRevision: document.project.revision,
    detectorVersion: "human-speech-gap/0.1.0",
    candidates: [{
      id: candidateId,
      target: {
        kind: "gap",
        sourceRange,
        ...(options.previousWordId ? { previousWordId: options.previousWordId } : {}),
        ...(options.nextWordId ? { nextWordId: options.nextWordId } : {}),
      },
      reasonCodes: ["manual"],
      decision: "definite_remove",
      risk: "low",
      confidence: 1,
      explanationZh: "用户在当前初剪中明确选择并删除无口播画面。",
    }],
    provenance: {
      createdBy: structuredClone(options.actor),
      createdAt: options.createdAt,
      reason: "Create an explicit user-selected speech-gap deletion",
      sourceArtifactIds: [transcript.id],
    },
  };
  const proposal: EditProposalArtifact = {
    id: `proposal_manual_gap_${suffix}`,
    kind: "editProposal",
    candidateSetArtifactId: candidateSet.id,
    projectRevision: document.project.revision,
    selectedCandidateIds: [candidateId],
    estimatedRemovedDuration: structuredClone(sourceRange.duration),
    payloadHash: "",
    provenance: {
      createdBy: structuredClone(options.actor),
      createdAt: options.createdAt,
      reason: "Apply an explicit user-selected speech-gap deletion",
      sourceArtifactIds: [candidateSet.id],
    },
  };
  proposal.payloadHash = computeEditProposalPayloadHash(proposal);
  return compileEditProposalBundle(document, candidateSet, proposal, {
    transactionId: `tx_manual_gap_delete_${options.requestId}`,
    idempotencyKey: `manual:gap-delete:${options.requestId}`,
    actor: options.actor,
    reason: "Delete user-selected video without Transcript speech",
  });
}

export function compileCandidateKeepBatch(
  document: AgentCutProjectDocument,
  options: CandidateKeepBatchOptions,
): EditTransaction {
  if (options.candidateIds.length === 0
    || new Set(options.candidateIds).size !== options.candidateIds.length) {
    throw new CandidateDetectionError(
      "INVALID_SELECTION",
      "Keeping remaining candidates requires unique candidate IDs",
    );
  }
  const transactions = options.candidateIds.map((candidateId, index) =>
    compileCandidateKeep(document, {
      candidateId,
      requestId: `${options.requestId}_${index}`,
      actor: options.actor,
      createdAt: options.createdAt,
    }),
  );
  const sequenceId = transactions[0]!.sequenceId;
  if (transactions.some((transaction) => transaction.sequenceId !== sequenceId)) {
    throw new CandidateDetectionError(
      "INVALID_SELECTION",
      "Remaining candidates must belong to one active sequence",
    );
  }
  return {
    protocolVersion: "0.1.0",
    transactionId: `tx_review_keep_batch_${options.requestId}`,
    idempotencyKey: `review:keep-batch:${options.requestId}`,
    projectId: document.project.id,
    sequenceId,
    baseRevision: document.project.revision,
    actor: structuredClone(options.actor),
    reason: "Keep and protect all remaining reviewed candidates",
    preconditions: [],
    operations: transactions.flatMap((transaction) => transaction.operations),
  };
}

export function compileCandidateUnlock(
  document: AgentCutProjectDocument,
  input: { lockId: string; requestId: string; actor: Actor },
): EditTransaction {
  const sequence = document.sequences.find((item) =>
    item.locks.some((lock) => lock.id === input.lockId),
  );
  if (!sequence) {
    throw new CandidateDetectionError("CANDIDATE_UNAVAILABLE", `Lock ${input.lockId} does not exist`);
  }
  const selectedLock = sequence.locks.find((lock) => lock.id === input.lockId)!;
  const overlapAnchorId = overlapAnchorIdFromReviewLock(selectedLock.note);
  const lockIds = overlapAnchorId
    ? sequence.locks.filter((lock) => overlapAnchorIdFromReviewLock(lock.note) === overlapAnchorId)
      .map((lock) => lock.id)
    : [input.lockId];
  return {
    protocolVersion: "0.1.0",
    transactionId: `tx_review_unlock_${input.requestId}`,
    idempotencyKey: `review:unlock:${input.requestId}`,
    projectId: document.project.id,
    sequenceId: sequence.id,
    baseRevision: document.project.revision,
    actor: structuredClone(input.actor),
    reason: `Unlock reviewed candidate decision ${input.lockId}`,
    preconditions: [],
    operations: lockIds.map((lockId) => ({ type: "lock.remove" as const, lockId })),
  };
}

export function candidateReviewLockId(candidateId: string): string {
  return `lock_candidate_keep_${digest(candidateId)}`;
}

export function candidateIdFromReviewLock(note: string | undefined): string | undefined {
  if (note?.startsWith(KEEP_NOTE_PREFIX)) return note.slice(KEEP_NOTE_PREFIX.length);
  if (!note?.startsWith(OVERLAP_GROUP_NOTE_PREFIX)) return undefined;
  const [, candidateId, trailing] = note.slice(OVERLAP_GROUP_NOTE_PREFIX.length).split(":");
  return candidateId && trailing === undefined ? candidateId : undefined;
}

function hasCandidateKeepLock(document: AgentCutProjectDocument, candidateId: string): boolean {
  return document.sequences.some((sequence) => sequence.locks.some((lock) =>
    candidateIdFromReviewLock(lock.note) === candidateId,
  ));
}

function compileOverlapResolutionLocks(
  document: AgentCutProjectDocument,
  source: { candidateSet: CandidateSetArtifact; candidate: DeletionCandidate },
  options: CandidateReviewOptions,
): EditTransaction["operations"] {
  const candidateIds = options.resolveOverlapCandidateIds ?? [];
  if (candidateIds.length === 0) return [];
  assertOverlapResolutionCandidates(document, source, [options.candidateId, ...candidateIds]);
  return candidateIds.map((candidateId) => candidateKeepLockOperation(
    document,
    candidateId,
    options,
    options.candidateId,
  ));
}

function assertOverlapResolutionCandidates(
  document: AgentCutProjectDocument,
  source: { candidateSet: CandidateSetArtifact; candidate: DeletionCandidate },
  candidateIds: string[],
): void {
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new CandidateDetectionError("INVALID_SELECTION", "Overlap resolution requires unique candidates");
  }
  const candidates: Array<{ id: string; source: ReturnType<typeof findCandidate> }> = [];
  for (const candidateId of candidateIds) {
    const overlap = findCandidate(document, candidateId);
    if (overlap.candidateSet.sequenceId !== source.candidateSet.sequenceId
      || overlap.candidateSet.transcriptArtifactId !== source.candidateSet.transcriptArtifactId) {
      throw new CandidateDetectionError(
        "INVALID_SELECTION",
        `Candidate ${candidateId} is not in the selected overlap group`,
      );
    }
    if (hasCandidateKeepLock(document, candidateId)) {
      throw new CandidateDetectionError(
        "CANDIDATE_ALREADY_REVIEWED",
        `Candidate ${candidateId} is already kept and locked`,
      );
    }
    candidates.push({ id: candidateId, source: overlap });
  }
  const connected = new Set([source.candidate.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (connected.has(candidate.id)) continue;
      if (!candidates.some((member) => connected.has(member.id)
        && rangesOverlap(
          member.source.candidate.target.sourceRange,
          candidate.source.candidate.target.sourceRange,
        ))) continue;
      connected.add(candidate.id);
      changed = true;
    }
  }
  if (connected.size !== candidates.length) {
    throw new CandidateDetectionError(
      "INVALID_SELECTION",
      "Overlap resolution candidates must form one connected source-range group",
    );
  }
}

function candidateKeepLockOperation(
  document: AgentCutProjectDocument,
  candidateId: string,
  options: Pick<CandidateReviewOptions, "actor" | "createdAt">,
  overlapAnchorId?: string,
): Extract<EditTransaction["operations"][number], { type: "lock.add" }> {
  const source = findCandidate(document, candidateId);
  const transcript = findTranscript(document, source.candidateSet.transcriptArtifactId);
  findCurrentClip(
    document,
    source.candidateSet.sequenceId,
    transcript.assetId,
    source.candidate.target.sourceRange,
  );
  return {
    type: "lock.add",
    lock: {
      id: candidateReviewLockId(candidateId),
      owner: options.actor.id,
      mode: "deny_agent",
      scope: {
        kind: "source_range",
        assetId: transcript.assetId,
        range: structuredClone(source.candidate.target.sourceRange),
      },
      createdAt: options.createdAt,
      note: overlapAnchorId
        ? `${OVERLAP_GROUP_NOTE_PREFIX}${overlapAnchorId}:${candidateId}`
        : `${KEEP_NOTE_PREFIX}${candidateId}`,
    },
  };
}

function overlapAnchorIdFromReviewLock(note: string | undefined): string | undefined {
  if (!note?.startsWith(OVERLAP_GROUP_NOTE_PREFIX)) return undefined;
  const [anchorId, candidateId, trailing] = note.slice(OVERLAP_GROUP_NOTE_PREFIX.length).split(":");
  return anchorId && candidateId && trailing === undefined ? anchorId : undefined;
}

function findCandidate(
  document: AgentCutProjectDocument,
  candidateId: string,
): { candidateSet: CandidateSetArtifact; candidate: DeletionCandidate } {
  for (const artifact of [...document.artifacts].reverse()) {
    if (artifact.kind !== "deletionCandidateSet") continue;
    const candidate = artifact.candidates.find((item) => item.id === candidateId);
    if (candidate) return { candidateSet: artifact, candidate };
  }
  throw new CandidateDetectionError("CANDIDATE_UNAVAILABLE", `Candidate ${candidateId} does not exist`);
}

function findTranscript(document: AgentCutProjectDocument, transcriptId: string): TranscriptArtifact {
  const artifact = document.artifacts.find((item) => item.id === transcriptId);
  if (!artifact || artifact.kind !== "transcript") {
    throw new CandidateDetectionError("CANDIDATE_UNAVAILABLE", `Transcript ${transcriptId} is missing`);
  }
  return artifact;
}

function latestTranscript(document: AgentCutProjectDocument): TranscriptArtifact {
  const artifact = [...document.artifacts].reverse().find((item) => item.kind === "transcript");
  if (!artifact || artifact.kind !== "transcript") {
    throw new CandidateDetectionError("CANDIDATE_UNAVAILABLE", "Project has no Transcript");
  }
  return artifact;
}

function findCurrentClip(
  document: AgentCutProjectDocument,
  sequenceId: string,
  assetId: string,
  sourceRange: TimeRange,
): { clipId: string } {
  const sequence = document.sequences.find((item) => item.id === sequenceId);
  const clip = sequence?.tracks.flatMap((track) => track.clips).find((item) =>
    item.assetId === assetId && item.sourceRange && rangeContains(item.sourceRange, sourceRange),
  );
  if (!clip) {
    throw new CandidateDetectionError(
      "CANDIDATE_UNAVAILABLE",
      "Candidate source range is no longer present in one editable clip",
    );
  }
  return { clipId: clip.id };
}

function rangeContains(container: TimeRange, child: TimeRange): boolean {
  return compareTime(container.start, child.start) <= 0
    && compareTime(rangeEnd(container), rangeEnd(child)) >= 0;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function microsRate(): { numerator: 1_000_000; denominator: 1 } {
  return { numerator: 1_000_000, denominator: 1 };
}
