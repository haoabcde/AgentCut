import { createHash } from "node:crypto";
import {
  addTime,
  compareTime,
  convertTime,
  rangeEnd,
  subtractTime,
} from "@agentcut/timeline-engine";
import type {
  Actor,
  AgentCutProjectDocument,
  CandidateSetArtifact,
  Clip,
  EditProposalArtifact,
  Time,
  TimeRange,
  Track,
} from "@agentcut/timeline-schema";
import { assertProjectDocument } from "@agentcut/timeline-schema";
import { EditError } from "./errors.js";
import type { EditOperation, EditTransaction } from "./types.js";

export interface CompileProposalOptions {
  transactionId: string;
  idempotencyKey: string;
  actor: Actor;
  reason?: string;
}

export function computeEditProposalPayloadHash(proposal: EditProposalArtifact): string {
  const payload = {
    candidateSetArtifactId: proposal.candidateSetArtifactId,
    projectRevision: proposal.projectRevision,
    selectedCandidateIds: proposal.selectedCandidateIds,
    estimatedRemovedDuration: proposal.estimatedRemovedDuration,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

export function compileEditProposal(
  document: AgentCutProjectDocument,
  proposal: EditProposalArtifact,
  options: CompileProposalOptions,
): EditTransaction {
  if (proposal.projectRevision !== document.project.revision) {
    throw new EditError("REVISION_CONFLICT", "Edit proposal is bound to a stale project revision", {
      expected: document.project.revision,
      received: proposal.projectRevision,
    });
  }
  const expectedHash = computeEditProposalPayloadHash(proposal);
  if (proposal.payloadHash !== expectedHash) {
    throw new EditError("PRECONDITION_FAILED", "Edit proposal payload hash does not match its contents", {
      expected: expectedHash,
      received: proposal.payloadHash,
    });
  }
  const candidateSet = findCandidateSet(document, proposal.candidateSetArtifactId);
  if (candidateSet.projectRevision !== proposal.projectRevision) {
    throw new EditError("REVISION_CONFLICT", "Candidate set and proposal revisions do not match");
  }
  const { track, clip } = findBoundClip(document, candidateSet);
  if (!clip.sourceRange) {
    throw new EditError("INVALID_OPERATION", `Bound clip ${clip.id} has no source range`);
  }
  if (compareTime(clip.timelineRange.duration, clip.sourceRange.duration) !== 0) {
    throw new EditError(
      "INVALID_OPERATION",
      `Proposal compilation does not support time-warped clip ${clip.id}`,
    );
  }

  const candidates = new Map(candidateSet.candidates.map((candidate) => [candidate.id, candidate]));
  const sourceRanges = proposal.selectedCandidateIds.map((candidateId) => {
    const candidate = candidates.get(candidateId);
    if (!candidate) {
      throw new EditError("OBJECT_NOT_FOUND", `Candidate ${candidateId} does not exist in the bound set`);
    }
    return candidate.target.sourceRange;
  });
  const timelineRanges = mergeRanges(sourceRanges.map((range) =>
    mapSourceRangeToTimeline(clip, range),
  ));
  const operations = buildRippleOperations(document, proposal, track, clip, timelineRanges);
  if (operations.length === 0) {
    throw new EditError("INVALID_OPERATION", "Edit proposal produces no deletion operations");
  }

  return {
    protocolVersion: "0.1.0",
    transactionId: options.transactionId,
    idempotencyKey: options.idempotencyKey,
    projectId: document.project.id,
    sequenceId: candidateSet.sequenceId,
    baseRevision: document.project.revision,
    actor: options.actor,
    reason: options.reason ?? proposal.provenance.reason,
    preconditions: [
      { type: "object_exists", objectId: candidateSet.id },
      { type: "object_exists", objectId: candidateSet.clipId },
      { type: "asset_online", assetId: clip.assetId! },
      { type: "range_unlocked", range: enclosingRange(timelineRanges), trackIds: [track.id] },
    ],
    operations,
  };
}

export function compileEditProposalBundle(
  document: AgentCutProjectDocument,
  candidateSet: CandidateSetArtifact,
  proposal: EditProposalArtifact,
  options: CompileProposalOptions,
): EditTransaction {
  if (document.artifacts.some((artifact) =>
    artifact.id === candidateSet.id || artifact.id === proposal.id,
  )) {
    throw new EditError(
      "DUPLICATE_ID",
      "Bundled candidate set and proposal must not already exist in the project",
    );
  }
  if (proposal.candidateSetArtifactId !== candidateSet.id) {
    throw new EditError("INVALID_OPERATION", "Proposal is not bound to the bundled candidate set");
  }
  const staged = structuredClone(document);
  staged.artifacts.push(structuredClone(candidateSet), structuredClone(proposal));
  try {
    assertProjectDocument(staged);
  } catch (error) {
    throw new EditError("INVALID_DOCUMENT", "Bundled analysis artifacts are invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const compiled = compileEditProposal(staged, proposal, options);
  return {
    ...compiled,
    preconditions: compiled.preconditions.filter((precondition) =>
      precondition.type !== "object_exists" || precondition.objectId !== candidateSet.id,
    ),
    operations: [
      { type: "artifact.put", artifact: structuredClone(candidateSet) },
      { type: "artifact.put", artifact: structuredClone(proposal) },
      ...compiled.operations,
    ],
  };
}

function findCandidateSet(
  document: AgentCutProjectDocument,
  candidateSetId: string,
): CandidateSetArtifact {
  const artifact = document.artifacts.find((candidate) => candidate.id === candidateSetId);
  if (!artifact || artifact.kind !== "deletionCandidateSet") {
    throw new EditError("OBJECT_NOT_FOUND", `Candidate set ${candidateSetId} does not exist`);
  }
  return artifact;
}

function findBoundClip(
  document: AgentCutProjectDocument,
  candidateSet: CandidateSetArtifact,
): { track: Track; clip: Clip } {
  const sequence = document.sequences.find((candidate) => candidate.id === candidateSet.sequenceId);
  if (!sequence) {
    throw new EditError("SEQUENCE_NOT_FOUND", `Sequence ${candidateSet.sequenceId} does not exist`);
  }
  for (const track of sequence.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === candidateSet.clipId);
    if (clip) return { track, clip };
  }
  throw new EditError("OBJECT_NOT_FOUND", `Clip ${candidateSet.clipId} does not exist`);
}

function mapSourceRangeToTimeline(clip: Clip, sourceRange: TimeRange): TimeRange {
  if (!clip.sourceRange) throw new Error("Invariant violation: source range disappeared");
  try {
    const sourceRate = clip.sourceRange.start.rate;
    const snappedStart = convertTime(sourceRange.start, sourceRate, "nearest");
    const snappedEnd = convertTime(rangeEnd(sourceRange), sourceRate, "nearest");
    if (compareTime(snappedEnd, snappedStart) <= 0) {
      throw new EditError(
        "INVALID_OPERATION",
        "Selected source range is shorter than one timeline unit after boundary snapping",
      );
    }
    const offset = subtractTime(snappedStart, clip.sourceRange.start, clip.timelineRange.start.rate);
    return {
      start: addTime(clip.timelineRange.start, offset, clip.timelineRange.start.rate),
      duration: subtractTime(snappedEnd, snappedStart, clip.timelineRange.duration.rate),
    };
  } catch (error) {
    if (error instanceof EditError) throw error;
    throw new EditError("INVALID_OPERATION", "Cannot map proposal source time to the bound clip", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = structuredClone(ranges).sort((left, right) => compareTime(left.start, right.start));
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || compareTime(range.start, rangeEnd(previous)) > 0) {
      merged.push(range);
      continue;
    }
    const end = compareTime(rangeEnd(range), rangeEnd(previous)) > 0
      ? rangeEnd(range, previous.start.rate)
      : rangeEnd(previous, previous.start.rate);
    previous.duration = subtractTime(end, previous.start, previous.duration.rate);
  }
  return merged;
}

function buildRippleOperations(
  document: AgentCutProjectDocument,
  proposal: EditProposalArtifact,
  track: Track,
  clip: Clip,
  ranges: TimeRange[],
): EditOperation[] {
  const descending = [...ranges].sort((left, right) => compareTime(right.start, left.start));
  let originalSegmentEnd = rangeEnd(clip.timelineRange, clip.timelineRange.start.rate);
  const existingIds = new Set(document.sequences.flatMap((sequence) =>
    sequence.tracks.flatMap((candidateTrack) => candidateTrack.clips.map((candidateClip) => candidateClip.id)),
  ));

  return descending.map((range, index) => {
    const end = rangeEnd(range, clip.timelineRange.start.rate);
    const splitsOriginal = compareTime(range.start, clip.timelineRange.start) > 0
      && compareTime(end, originalSegmentEnd) < 0;
    const operation: Extract<EditOperation, { type: "range.deleteRipple" }> = {
      type: "range.deleteRipple",
      range,
      trackIds: [track.id],
      proposalId: proposal.id,
    };
    if (splitsOriginal) {
      const rightClipId = generatedRightClipId(clip.id, proposal.id, index + 1);
      if (existingIds.has(rightClipId)) {
        throw new EditError("DUPLICATE_ID", `Generated clip ID ${rightClipId} already exists`);
      }
      existingIds.add(rightClipId);
      operation.rightClipIds = { [clip.id]: rightClipId };
    }
    if (compareTime(range.start, clip.timelineRange.start) > 0) {
      originalSegmentEnd = range.start;
    }
    return operation;
  });
}

const MAX_OBJECT_ID_LENGTH = 200;

function generatedRightClipId(clipId: string, proposalId: string, splitNumber: number): string {
  const readableId = `${clipId}__${proposalId}__right_${splitNumber}`;
  if (readableId.length <= MAX_OBJECT_ID_LENGTH) return readableId;

  // Repeated ripple edits may split the right-hand result again. Hash the full
  // lineage instead of recursively embedding it so generated IDs stay stable,
  // unique in practice, and within the Timeline schema's 200-character limit.
  const digest = createHash("sha256")
    .update(`${clipId}\0${proposalId}\0${splitNumber}`)
    .digest("hex")
    .slice(0, 32);
  return `clip_split_${digest}_${splitNumber}`;
}

function enclosingRange(ranges: TimeRange[]): TimeRange {
  const first = ranges[0];
  if (!first) throw new Error("Invariant violation: no proposal ranges");
  const last = ranges[ranges.length - 1] ?? first;
  return {
    start: structuredClone(first.start),
    duration: subtractTime(rangeEnd(last), first.start, first.duration.rate),
  };
}
