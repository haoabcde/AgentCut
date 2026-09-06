import { createHash } from "node:crypto";
import {
  addTime,
  compareTime,
  convertTime,
  rangeEnd,
  rangesOverlap,
  subtractTime,
} from "@agentcut/timeline-engine";
import {
  assertProjectDocument,
  validateProjectDocument,
  type Actor,
  type AgentCutProjectDocument,
  type Asset,
  type Clip,
  type ExtensionValidator,
  type LockRegion,
  type ProjectArtifact,
  type Sequence,
  type Time,
  type TimeRange,
  type Track,
} from "@agentcut/timeline-schema";
import { EditError } from "./errors.js";
import type {
  CommandRecord,
  CommitResult,
  EditOperation,
  EditTransaction,
  Precondition,
} from "./types.js";

export type Clock = () => string;

export class TransactionEngine {
  readonly #clock: Clock;
  readonly #extensionValidators: readonly ExtensionValidator[];
  #document: AgentCutProjectDocument;
  readonly #records = new Map<string, CommandRecord>();
  readonly #idempotency = new Map<string, string>();

  constructor(
    document: AgentCutProjectDocument,
    clock: Clock = () => new Date().toISOString(),
    options: { extensionValidators?: readonly ExtensionValidator[] } = {},
  ) {
    assertProjectDocument(document, { extensionValidators: options.extensionValidators });
    this.#document = structuredClone(document);
    this.#clock = clock;
    this.#extensionValidators = options.extensionValidators ?? [];
  }

  snapshot(): AgentCutProjectDocument {
    return structuredClone(this.#document);
  }

  getRecord(transactionId: string): CommandRecord | undefined {
    const record = this.#records.get(transactionId);
    return record ? structuredClone(record) : undefined;
  }

  commit(transaction: EditTransaction): CommitResult {
    const previousTransactionId = this.#idempotency.get(transaction.idempotencyKey);
    if (previousTransactionId) {
      if (previousTransactionId !== transaction.transactionId) {
        throw new EditError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was already used by another transaction",
          { idempotencyKey: transaction.idempotencyKey, previousTransactionId },
        );
      }
      const record = this.#records.get(previousTransactionId);
      if (!record) throw new Error("Invariant violation: missing idempotent command record");
      return { document: this.snapshot(), record: structuredClone(record), idempotentReplay: true };
    }

    const result = applyTransaction(this.#document, transaction, this.#clock, this.#extensionValidators);
    this.#document = result.document;
    this.#records.set(transaction.transactionId, structuredClone(result.record));
    this.#idempotency.set(transaction.idempotencyKey, transaction.transactionId);
    return result;
  }

  undo(transactionId: string, actor: Actor, undoTransactionId: string): CommitResult {
    const record = this.#records.get(transactionId);
    if (!record) {
      throw new EditError("OBJECT_NOT_FOUND", `Command ${transactionId} does not exist`);
    }
    return this.commit({
      protocolVersion: "0.1.0",
      transactionId: undoTransactionId,
      idempotencyKey: `undo:${transactionId}:${this.#document.project.revision}`,
      projectId: this.#document.project.id,
      sequenceId: record.request.sequenceId,
      baseRevision: this.#document.project.revision,
      actor,
      reason: `Undo ${transactionId}: ${record.request.reason}`,
      preconditions: [],
      operations: structuredClone(record.inverseOperations),
    });
  }
}

export function applyTransaction(
  document: AgentCutProjectDocument,
  transaction: EditTransaction,
  clock: Clock = () => new Date().toISOString(),
  extensionValidators: readonly ExtensionValidator[] = [],
): CommitResult {
  assertTransactionEnvelope(document, transaction);
  const working = structuredClone(document);
  const sequence = findSequence(working, transaction.sequenceId);
  checkPreconditions(working, sequence, transaction.actor, transaction.preconditions);

  const inverseOperations: EditOperation[] = [];
  for (const operation of transaction.operations) {
    assertOperationUnlocked(sequence, transaction.actor, operation);
    const inverse = applyOperation(working, sequence, operation, transaction.actor);
    inverseOperations.unshift(...inverse);
  }

  const committedAt = clock();
  const beforeHash = hashProjectState(document);
  working.project.revision += 1;
  working.project.updatedAt = committedAt;
  working.history.headRevision = working.project.revision;
  const afterHash = hashProjectState(working);
  const record: CommandRecord = {
    transactionId: transaction.transactionId,
    projectId: transaction.projectId,
    baseRevision: transaction.baseRevision,
    committedRevision: working.project.revision,
    request: structuredClone(transaction),
    inverseOperations,
    beforeHash,
    afterHash,
    committedAt,
  };
  working.history.records.push({
    transactionId: record.transactionId,
    baseRevision: record.baseRevision,
    committedRevision: record.committedRevision,
    actor: `${transaction.actor.kind}:${transaction.actor.id}`,
    reason: transaction.reason,
    beforeHash,
    afterHash,
    committedAt,
  });

  const validation = validateProjectDocument(working, { extensionValidators });
  if (!validation.valid) {
    throw new EditError("INVALID_DOCUMENT", "Transaction produced an invalid project document", {
      errors: validation.errors,
    });
  }
  return { document: working, record, idempotentReplay: false };
}

function assertTransactionEnvelope(
  document: AgentCutProjectDocument,
  transaction: EditTransaction,
): void {
  if (transaction.projectId !== document.project.id) {
    throw new EditError("PROJECT_MISMATCH", "Transaction targets another project");
  }
  if (transaction.baseRevision !== document.project.revision) {
    throw new EditError("REVISION_CONFLICT", "Transaction base revision is stale", {
      expected: document.project.revision,
      received: transaction.baseRevision,
    });
  }
  if (!transaction.transactionId || !transaction.idempotencyKey || !transaction.reason) {
    throw new EditError("INVALID_OPERATION", "Transaction ID, idempotency key and reason are required");
  }
  if (transaction.operations.length === 0) {
    throw new EditError("INVALID_OPERATION", "Transaction must contain at least one operation");
  }
}

function findSequence(document: AgentCutProjectDocument, sequenceId: string): Sequence {
  const sequence = document.sequences.find((candidate) => candidate.id === sequenceId);
  if (!sequence) throw new EditError("SEQUENCE_NOT_FOUND", `Sequence ${sequenceId} does not exist`);
  return sequence;
}

function findTrack(sequence: Sequence, trackId: string): { track: Track; index: number } {
  const index = sequence.tracks.findIndex((track) => track.id === trackId);
  if (index < 0) throw new EditError("OBJECT_NOT_FOUND", `Track ${trackId} does not exist`);
  const track = sequence.tracks[index];
  if (!track) throw new Error("Invariant violation: track index disappeared");
  return { track, index };
}

function findClip(sequence: Sequence, clipId: string): { clip: Clip; track: Track; index: number } {
  for (const track of sequence.tracks) {
    const index = track.clips.findIndex((clip) => clip.id === clipId);
    if (index >= 0) {
      const clip = track.clips[index];
      if (!clip) throw new Error("Invariant violation: clip index disappeared");
      return { clip, track, index };
    }
  }
  throw new EditError("OBJECT_NOT_FOUND", `Clip ${clipId} does not exist`);
}

function checkPreconditions(
  document: AgentCutProjectDocument,
  sequence: Sequence,
  actor: Actor,
  preconditions: Precondition[],
): void {
  for (const precondition of preconditions) {
    if (precondition.type === "object_exists") {
      if (!objectExists(document, precondition.objectId)) {
        throw new EditError("PRECONDITION_FAILED", `Object ${precondition.objectId} does not exist`);
      }
    } else if (precondition.type === "asset_online") {
      const asset = document.assets.find((candidate) => candidate.id === precondition.assetId);
      if (!asset || asset.availability !== "online") {
        throw new EditError("PRECONDITION_FAILED", `Asset ${precondition.assetId} is not online`);
      }
    } else {
      const blocked = sequence.locks.some((lock) => {
        if (!lockBlocksActor(lock, actor) || lock.scope.kind !== "range") return false;
        const lockedTrackIds = lock.scope.trackIds;
        const lockedRange = lock.scope.range;
        const trackMatches = !precondition.trackIds
          || !lockedTrackIds
          || precondition.trackIds.some((trackId) => lockedTrackIds.includes(trackId));
        return trackMatches && rangesOverlap(lockedRange, precondition.range);
      });
      if (blocked) throw new EditError("PRECONDITION_FAILED", "Requested range is locked");
    }
  }
}

function objectExists(document: AgentCutProjectDocument, objectId: string): boolean {
  if (document.project.id === objectId) return true;
  if (document.assets.some((asset) => asset.id === objectId)) return true;
  if (document.artifacts.some((artifact) => artifact.id === objectId)) return true;
  return document.sequences.some((sequence) =>
    sequence.id === objectId
    || sequence.tracks.some((track) =>
      track.id === objectId || track.clips.some((clip) => clip.id === objectId),
    )
    || sequence.locks.some((lock) => lock.id === objectId),
  );
}

function assertOperationUnlocked(sequence: Sequence, actor: Actor, operation: EditOperation): void {
  if (
    operation.type === "asset.put"
    || operation.type === "asset.remove"
    || operation.type === "artifact.put"
    || operation.type === "artifact.remove"
  ) return;
  if (operation.type === "lock.add") return;
  if (operation.type === "lock.remove") {
    const lock = sequence.locks.find((candidate) => candidate.id === operation.lockId);
    if (!lock) throw new EditError("OBJECT_NOT_FOUND", `Lock ${operation.lockId} does not exist`);
    if (lock.owner !== actor.id) {
      throw new EditError("LOCKED", `Only ${lock.owner} can remove lock ${lock.id}`);
    }
    return;
  }

  const affected = affectedByOperation(sequence, operation);
  for (const trackId of affected.trackIds) {
    const track = sequence.tracks.find((candidate) => candidate.id === trackId);
    if (track?.locked) throw new EditError("LOCKED", `Track ${trackId} is locked`);
  }
  for (const lock of sequence.locks) {
    if (!lockBlocksActor(lock, actor)) continue;
    if (lock.scope.kind === "track" && affected.trackIds.has(lock.scope.trackId)) {
      throw new EditError("LOCKED", `Operation intersects track lock ${lock.id}`);
    }
    if (lock.scope.kind === "clip" && affected.clipIds.has(lock.scope.clipId)) {
      throw new EditError("LOCKED", `Operation intersects clip lock ${lock.id}`);
    }
    if (lock.scope.kind === "property" && affected.clipIds.has(lock.scope.objectId)) {
      if (operationTouchesProperty(operation, lock.scope.objectId, lock.scope.path)) {
        throw new EditError("LOCKED", `Operation intersects property lock ${lock.id}`);
      }
    }
    if (lock.scope.kind === "range") {
      const lockedTrackIds = lock.scope.trackIds;
      const lockedRange = lock.scope.range;
      const relevantTrack = !lockedTrackIds
        || [...affected.trackIds].some((trackId) => lockedTrackIds.includes(trackId));
      if (relevantTrack && affected.ranges.some((range) => rangesOverlap(lockedRange, range))) {
        throw new EditError("LOCKED", `Operation intersects range lock ${lock.id}`);
      }
    }
    if (lock.scope.kind === "source_range" && operationTouchesSourceRange(
      sequence,
      operation,
      lock.scope.assetId,
      lock.scope.range,
    )) {
      throw new EditError("LOCKED", `Operation intersects source range lock ${lock.id}`);
    }
  }
}

function operationTouchesSourceRange(
  sequence: Sequence,
  operation: Exclude<
    EditOperation,
    {
      type: "asset.put" | "asset.remove" | "artifact.put" | "artifact.remove" | "lock.add" | "lock.remove"
    }
  >,
  assetId: string,
  lockedRange: TimeRange,
): boolean {
  if (operation.type === "range.deleteRipple") {
    return operation.trackIds.some((trackId) => {
      const { track } = findTrack(sequence, trackId);
      return track.clips.some((clip) => {
        const sourceSlice = sourceSliceForTimelineRange(clip, operation.range);
        return clip.assetId === assetId && sourceSlice !== undefined
          && rangesOverlap(sourceSlice, lockedRange);
      });
    });
  }
  if (operation.type === "track.remove") {
    return findTrack(sequence, operation.trackId).track.clips.some((clip) =>
      clip.assetId === assetId && clip.sourceRange !== undefined
        && rangesOverlap(clip.sourceRange, lockedRange),
    );
  }
  if (
    operation.type === "clip.remove"
    || operation.type === "clip.trim"
    || operation.type === "clip.replace"
  ) {
    const current = findClip(sequence, operation.clipId).clip;
    if (current.assetId === assetId && current.sourceRange
      && rangesOverlap(current.sourceRange, lockedRange)) return true;
    return operation.type === "clip.replace"
      && operation.clip.assetId === assetId
      && operation.clip.sourceRange !== undefined
      && rangesOverlap(operation.clip.sourceRange, lockedRange);
  }
  return false;
}

function sourceSliceForTimelineRange(clip: Clip, timelineRange: TimeRange): TimeRange | undefined {
  if (!clip.sourceRange || !rangesOverlap(clip.timelineRange, timelineRange)) return undefined;
  if (compareTime(clip.timelineRange.duration, clip.sourceRange.duration) !== 0) {
    throw new EditError(
      "INVALID_OPERATION",
      `Source range locks do not support time-warped clip ${clip.id}`,
    );
  }
  const clipEnd = rangeEnd(clip.timelineRange, clip.timelineRange.start.rate);
  const requestedEnd = rangeEnd(timelineRange, clip.timelineRange.start.rate);
  const overlapStart = compareTime(clip.timelineRange.start, timelineRange.start) >= 0
    ? clip.timelineRange.start
    : timelineRange.start;
  const overlapEnd = compareTime(clipEnd, requestedEnd) <= 0 ? clipEnd : requestedEnd;
  const elapsed = subtractTime(overlapStart, clip.timelineRange.start, clip.sourceRange.start.rate);
  const duration = subtractTime(overlapEnd, overlapStart, clip.sourceRange.duration.rate);
  return {
    start: addTime(clip.sourceRange.start, elapsed, clip.sourceRange.start.rate),
    duration,
  };
}

function operationTouchesProperty(
  operation: Exclude<
    EditOperation,
    {
      type: "asset.put" | "asset.remove" | "artifact.put" | "artifact.remove" | "lock.add" | "lock.remove"
    }
  >,
  objectId: string,
  lockedPath: string,
): boolean {
  if (operation.type === "track.add" || operation.type === "track.remove") return true;
  if (operation.type === "range.deleteRipple") return true;
  if (
    operation.type === "clip.insert"
    || operation.type === "clip.remove"
    || operation.type === "clip.replace"
    || operation.type === "clip.split"
  ) {
    return true;
  }
  if (operation.clipId !== objectId) return false;
  let changedPaths: string[];
  if (operation.type === "clip.move") {
    changedPaths = ["/timelineRange/start"];
  } else if (operation.type === "clip.trim") {
    changedPaths = ["/timelineRange", "/sourceRange"];
  } else {
    changedPaths = Object.keys(operation.patch).map((key) => `/${key}`);
  }
  return changedPaths.some((changedPath) => pathsIntersect(changedPath, lockedPath));
}

function pathsIntersect(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function lockBlocksActor(lock: LockRegion, actor: Actor): boolean {
  return lock.mode === "owner_only"
    ? actor.id !== lock.owner
    : actor.kind === "agent" || actor.kind === "workflow";
}

function affectedByOperation(
  sequence: Sequence,
  operation: Exclude<
    EditOperation,
    {
      type: "asset.put" | "asset.remove" | "artifact.put" | "artifact.remove" | "lock.add" | "lock.remove"
    }
  >,
): { trackIds: Set<string>; clipIds: Set<string>; ranges: TimeRange[] } {
  if (operation.type === "track.add") {
    return {
      trackIds: new Set([operation.track.id]),
      clipIds: new Set(operation.track.clips.map((clip) => clip.id)),
      ranges: operation.track.clips.map((clip) => clip.timelineRange),
    };
  }
  if (operation.type === "track.remove") {
    const { track } = findTrack(sequence, operation.trackId);
    return {
      trackIds: new Set([track.id]),
      clipIds: new Set(track.clips.map((clip) => clip.id)),
      ranges: track.clips.map((clip) => clip.timelineRange),
    };
  }
  if (operation.type === "clip.insert") {
    return {
      trackIds: new Set([operation.trackId]),
      clipIds: new Set([operation.clip.id]),
      ranges: [operation.clip.timelineRange],
    };
  }
  if (operation.type === "range.deleteRipple") {
    const trackIds = new Set(operation.trackIds);
    const clipIds = new Set<string>();
    const ranges: TimeRange[] = [operation.range];
    const deletionEnd = rangeEnd(operation.range, operation.range.start.rate);
    for (const trackId of trackIds) {
      const { track } = findTrack(sequence, trackId);
      for (const clip of track.clips) {
        if (
          rangesOverlap(clip.timelineRange, operation.range)
          || compareTime(clip.timelineRange.start, deletionEnd) >= 0
        ) {
          clipIds.add(clip.id);
          ranges.push(clip.timelineRange);
        }
      }
    }
    return { trackIds, clipIds, ranges };
  }
  const found = findClip(sequence, operation.clipId);
  const destinationTrackId = operation.type === "clip.move" && operation.toTrackId
    ? operation.toTrackId
    : found.track.id;
  const targetRange = operation.type === "clip.move"
    ? { start: operation.start, duration: found.clip.timelineRange.duration }
    : operation.type === "clip.trim"
      ? operation.timelineRange
      : operation.type === "clip.replace"
        ? operation.clip.timelineRange
        : found.clip.timelineRange;
  return {
    trackIds: new Set([found.track.id, destinationTrackId]),
    clipIds: new Set([found.clip.id]),
    ranges: [found.clip.timelineRange, targetRange],
  };
}

function applyOperation(
  document: AgentCutProjectDocument,
  sequence: Sequence,
  operation: EditOperation,
  actor: Actor,
): EditOperation[] {
  switch (operation.type) {
    case "asset.put": {
      if (objectExists(document, operation.asset.id)) {
        throw new EditError("DUPLICATE_ID", `Object ID ${operation.asset.id} already exists`);
      }
      const index = checkedInsertIndex(operation.index, document.assets.length);
      document.assets.splice(index, 0, structuredClone(operation.asset));
      return [{ type: "asset.remove", assetId: operation.asset.id }];
    }
    case "asset.remove": {
      const { asset, index } = findAsset(document, operation.assetId);
      document.assets.splice(index, 1);
      return [{ type: "asset.put", asset: structuredClone(asset), index }];
    }
    case "artifact.put": {
      if (objectExists(document, operation.artifact.id)) {
        throw new EditError("DUPLICATE_ID", `Object ID ${operation.artifact.id} already exists`);
      }
      const index = checkedInsertIndex(operation.index, document.artifacts.length);
      document.artifacts.splice(index, 0, structuredClone(operation.artifact));
      return [{ type: "artifact.remove", artifactId: operation.artifact.id }];
    }
    case "artifact.remove": {
      const { artifact, index } = findArtifact(document, operation.artifactId);
      document.artifacts.splice(index, 1);
      return [{ type: "artifact.put", artifact: structuredClone(artifact), index }];
    }
    case "track.add": {
      assertUniqueObjectId(sequence, operation.track.id);
      const index = checkedInsertIndex(operation.index, sequence.tracks.length);
      sequence.tracks.splice(index, 0, structuredClone(operation.track));
      return [{ type: "track.remove", trackId: operation.track.id }];
    }
    case "track.remove": {
      const { track, index } = findTrack(sequence, operation.trackId);
      sequence.tracks.splice(index, 1);
      return [{ type: "track.add", track: structuredClone(track), index }];
    }
    case "clip.insert": {
      assertUniqueObjectId(sequence, operation.clip.id);
      const { track } = findTrack(sequence, operation.trackId);
      const index = checkedInsertIndex(operation.index, track.clips.length);
      track.clips.splice(index, 0, structuredClone(operation.clip));
      return [{ type: "clip.remove", clipId: operation.clip.id }];
    }
    case "clip.remove": {
      const { clip, track, index } = findClip(sequence, operation.clipId);
      track.clips.splice(index, 1);
      return [{ type: "clip.insert", trackId: track.id, clip: structuredClone(clip), index }];
    }
    case "clip.split": {
      const { clip, track, index } = findClip(sequence, operation.clipId);
      assertUniqueObjectId(sequence, operation.rightClipId);
      const clipEnd = rangeEnd(clip.timelineRange, clip.timelineRange.start.rate);
      if (
        compareTime(operation.at, clip.timelineRange.start) <= 0
        || compareTime(operation.at, clipEnd) >= 0
      ) {
        throw new EditError("INVALID_OPERATION", "Split point must be strictly inside the clip range");
      }
      const original = structuredClone(clip);
      const leftDuration = subtractTime(
        operation.at,
        clip.timelineRange.start,
        clip.timelineRange.duration.rate,
      );
      const rightDuration = subtractTime(
        clip.timelineRange.duration,
        leftDuration,
        clip.timelineRange.duration.rate,
      );
      const right = structuredClone(clip);
      right.id = operation.rightClipId;
      clip.timelineRange.duration = leftDuration;
      right.timelineRange = {
        start: addTime(original.timelineRange.start, leftDuration, original.timelineRange.start.rate),
        duration: rightDuration,
      };
      if (original.sourceRange) {
        if (compareTime(original.timelineRange.duration, original.sourceRange.duration) !== 0) {
          throw new EditError(
            "INVALID_OPERATION",
            "Splitting clips with time-warped source ranges is not supported",
          );
        }
        const sourceLeftDuration = convertTime(leftDuration, original.sourceRange.duration.rate);
        clip.sourceRange = {
          start: structuredClone(original.sourceRange.start),
          duration: sourceLeftDuration,
        };
        right.sourceRange = {
          start: addTime(
            original.sourceRange.start,
            sourceLeftDuration,
            original.sourceRange.start.rate,
          ),
          duration: subtractTime(
            original.sourceRange.duration,
            sourceLeftDuration,
            original.sourceRange.duration.rate,
          ),
        };
      }
      track.clips.splice(index + 1, 0, right);
      return [
        { type: "clip.remove", clipId: right.id },
        { type: "clip.replace", clipId: original.id, clip: original },
      ];
    }
    case "range.deleteRipple": {
      return applyRippleDelete(sequence, operation);
    }
    case "clip.move": {
      const { clip, track, index } = findClip(sequence, operation.clipId);
      const previousStart = structuredClone(clip.timelineRange.start);
      const destination = operation.toTrackId ? findTrack(sequence, operation.toTrackId).track : track;
      if (destination !== track) {
        track.clips.splice(index, 1);
        const destinationIndex = checkedInsertIndex(operation.toIndex, destination.clips.length);
        destination.clips.splice(destinationIndex, 0, clip);
      } else if (operation.toIndex !== undefined && operation.toIndex !== index) {
        track.clips.splice(index, 1);
        const destinationIndex = checkedInsertIndex(operation.toIndex, track.clips.length);
        track.clips.splice(destinationIndex, 0, clip);
      }
      clip.timelineRange.start = structuredClone(operation.start);
      return [{
        type: "clip.move",
        clipId: clip.id,
        toTrackId: track.id,
        toIndex: index,
        start: previousStart,
      }];
    }
    case "clip.trim": {
      const { clip } = findClip(sequence, operation.clipId);
      const inverse: EditOperation = {
        type: "clip.trim",
        clipId: clip.id,
        timelineRange: structuredClone(clip.timelineRange),
        ...(clip.sourceRange ? { sourceRange: structuredClone(clip.sourceRange) } : {}),
      };
      clip.timelineRange = structuredClone(operation.timelineRange);
      if (operation.sourceRange) clip.sourceRange = structuredClone(operation.sourceRange);
      else delete clip.sourceRange;
      return [inverse];
    }
    case "clip.replace": {
      if (operation.clip.id !== operation.clipId) {
        throw new EditError("INVALID_OPERATION", "Replacement clip ID must not change");
      }
      const { clip, track, index } = findClip(sequence, operation.clipId);
      track.clips[index] = structuredClone(operation.clip);
      return [{ type: "clip.replace", clipId: clip.id, clip: structuredClone(clip) }];
    }
    case "clip.update": {
      const { clip } = findClip(sequence, operation.clipId);
      const before = structuredClone(clip);
      Object.assign(clip, structuredClone(operation.patch));
      return [{ type: "clip.replace", clipId: clip.id, clip: before }];
    }
    case "lock.add": {
      assertUniqueObjectId(sequence, operation.lock.id);
      const index = checkedInsertIndex(operation.index, sequence.locks.length);
      sequence.locks.splice(index, 0, structuredClone(operation.lock));
      return [{ type: "lock.remove", lockId: operation.lock.id }];
    }
    case "lock.remove": {
      const index = sequence.locks.findIndex((lock) => lock.id === operation.lockId);
      if (index < 0) throw new EditError("OBJECT_NOT_FOUND", `Lock ${operation.lockId} does not exist`);
      const lock = sequence.locks[index];
      if (!lock) throw new Error("Invariant violation: lock index disappeared");
      if (lock.owner !== actor.id) throw new EditError("LOCKED", `Only ${lock.owner} can remove lock ${lock.id}`);
      sequence.locks.splice(index, 1);
      return [{ type: "lock.add", lock: structuredClone(lock), index }];
    }
  }
}

function findAsset(
  document: AgentCutProjectDocument,
  assetId: string,
): { asset: Asset; index: number } {
  const index = document.assets.findIndex((asset) => asset.id === assetId);
  if (index < 0) throw new EditError("OBJECT_NOT_FOUND", `Asset ${assetId} does not exist`);
  const asset = document.assets[index];
  if (!asset) throw new Error("Invariant violation: asset index disappeared");
  return { asset, index };
}

function applyRippleDelete(
  sequence: Sequence,
  operation: Extract<EditOperation, { type: "range.deleteRipple" }>,
): EditOperation[] {
  if (operation.range.duration.value === 0) {
    throw new EditError("INVALID_OPERATION", "Ripple deletion range must have positive duration");
  }
  if (operation.trackIds.length === 0) {
    throw new EditError("INVALID_OPERATION", "Ripple deletion must target at least one track");
  }
  const uniqueTrackIds = new Set(operation.trackIds);
  if (uniqueTrackIds.size !== operation.trackIds.length) {
    throw new EditError("INVALID_OPERATION", "Ripple deletion track IDs must be unique");
  }

  const mappings = operation.rightClipIds ?? {};
  const mappedIds = Object.values(mappings);
  if (new Set(mappedIds).size !== mappedIds.length) {
    throw new EditError("DUPLICATE_ID", "Ripple deletion right-side clip IDs must be unique");
  }
  for (const mappedId of mappedIds) assertUniqueObjectId(sequence, mappedId);

  const beforeTracks = operation.trackIds.map((trackId) => {
    const { track } = findTrack(sequence, trackId);
    return { track, clips: structuredClone(track.clips) };
  });
  const usedMappings = new Set<string>();
  for (const { track } of beforeTracks) {
    track.clips = transformTrackForRipple(track.clips, operation, usedMappings);
  }
  for (const mappedClipId of Object.keys(mappings)) {
    if (!usedMappings.has(mappedClipId)) {
      throw new EditError(
        "INVALID_OPERATION",
        `Right-side clip ID was supplied for clip ${mappedClipId}, but no split was required`,
      );
    }
  }

  const inverse: EditOperation[] = [];
  for (const { track, clips: before } of beforeTracks) {
    const beforeIds = new Set(before.map((clip) => clip.id));
    for (const clip of track.clips) {
      if (!beforeIds.has(clip.id)) inverse.push({ type: "clip.remove", clipId: clip.id });
    }

    const afterById = new Map(track.clips.map((clip) => [clip.id, clip]));
    before.forEach((clip, index) => {
      const after = afterById.get(clip.id);
      if (!after) {
        inverse.push({ type: "clip.insert", trackId: track.id, clip, index });
      } else if (!sameValue(clip, after)) {
        inverse.push({ type: "clip.replace", clipId: clip.id, clip });
      }
    });
  }
  return inverse;
}

function transformTrackForRipple(
  clips: Clip[],
  operation: Extract<EditOperation, { type: "range.deleteRipple" }>,
  usedMappings: Set<string>,
): Clip[] {
  const deletionStart = operation.range.start;
  const deletionEnd = rangeEnd(operation.range, deletionStart.rate);
  const transformed: Clip[] = [];

  for (const clip of clips) {
    const clipStart = clip.timelineRange.start;
    const clipEnd = rangeEnd(clip.timelineRange, clipStart.rate);
    const overlaps = compareTime(clipStart, deletionEnd) < 0
      && compareTime(deletionStart, clipEnd) < 0;
    if (!overlaps) {
      const next = structuredClone(clip);
      if (compareTime(clipStart, deletionEnd) >= 0) {
        next.timelineRange.start = subtractTime(
          clipStart,
          operation.range.duration,
          clipStart.rate,
        );
      }
      transformed.push(next);
      continue;
    }

    const hasLeft = compareTime(clipStart, deletionStart) < 0;
    const hasRight = compareTime(clipEnd, deletionEnd) > 0;
    if (hasLeft) {
      transformed.push(sliceClip(clip, clipStart, deletionStart, clipStart, clip.id));
    }
    if (hasRight) {
      let rightId = clip.id;
      if (hasLeft) {
        const mappedId = operation.rightClipIds?.[clip.id];
        if (!mappedId) {
          throw new EditError(
            "INVALID_OPERATION",
            `Ripple deletion splits clip ${clip.id}; rightClipIds.${clip.id} is required`,
          );
        }
        usedMappings.add(clip.id);
        rightId = mappedId;
      }
      transformed.push(sliceClip(clip, deletionEnd, clipEnd, deletionStart, rightId));
    }
  }
  return transformed;
}

function sliceClip(
  clip: Clip,
  sourceTimelineStart: Time,
  sourceTimelineEnd: Time,
  resultTimelineStart: Time,
  id: string,
): Clip {
  try {
    const result = structuredClone(clip);
    const sliceDuration = subtractTime(
      sourceTimelineEnd,
      sourceTimelineStart,
      clip.timelineRange.duration.rate,
    );
    result.id = id;
    result.timelineRange = {
      start: convertTime(resultTimelineStart, clip.timelineRange.start.rate),
      duration: sliceDuration,
    };
    if (clip.sourceRange) {
      if (compareTime(clip.timelineRange.duration, clip.sourceRange.duration) !== 0) {
        throw new EditError(
          "INVALID_OPERATION",
          `Ripple deletion does not support time-warped clip ${clip.id}`,
        );
      }
      const elapsed = subtractTime(
        sourceTimelineStart,
        clip.timelineRange.start,
        clip.sourceRange.start.rate,
      );
      result.sourceRange = {
        start: addTime(clip.sourceRange.start, elapsed, clip.sourceRange.start.rate),
        duration: convertTime(sliceDuration, clip.sourceRange.duration.rate),
      };
    }
    return result;
  } catch (error) {
    if (error instanceof EditError) throw error;
    throw new EditError(
      "INVALID_OPERATION",
      `Ripple deletion cannot represent an exact slice for clip ${clip.id}`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findArtifact(
  document: AgentCutProjectDocument,
  artifactId: string,
): { artifact: ProjectArtifact; index: number } {
  const index = document.artifacts.findIndex((artifact) => artifact.id === artifactId);
  if (index < 0) throw new EditError("OBJECT_NOT_FOUND", `Artifact ${artifactId} does not exist`);
  const artifact = document.artifacts[index];
  if (!artifact) throw new Error("Invariant violation: artifact index disappeared");
  return { artifact, index };
}

function assertUniqueObjectId(sequence: Sequence, id: string): void {
  const exists = sequence.id === id
    || sequence.tracks.some((track) =>
      track.id === id || track.clips.some((clip) => clip.id === id),
    )
    || sequence.locks.some((lock) => lock.id === id);
  if (exists) throw new EditError("DUPLICATE_ID", `Object ID ${id} already exists`);
}

function checkedInsertIndex(index: number | undefined, length: number): number {
  const resolved = index ?? length;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > length) {
    throw new EditError("INVALID_OPERATION", `Insert index ${resolved} is out of bounds`);
  }
  return resolved;
}

export function hashProjectState(document: AgentCutProjectDocument): string {
  const core = structuredClone(document);
  core.history = { headRevision: core.history.headRevision, records: [] };
  return `sha256:${createHash("sha256").update(JSON.stringify(core)).digest("hex")}`;
}
