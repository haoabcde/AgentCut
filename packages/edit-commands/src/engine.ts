import { createHash } from "node:crypto";
import { rangesOverlap } from "@agentcut/timeline-engine";
import {
  assertProjectDocument,
  validateProjectDocument,
  type Actor,
  type AgentCutProjectDocument,
  type Clip,
  type LockRegion,
  type Sequence,
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
  #document: AgentCutProjectDocument;
  readonly #records = new Map<string, CommandRecord>();
  readonly #idempotency = new Map<string, string>();

  constructor(document: AgentCutProjectDocument, clock: Clock = () => new Date().toISOString()) {
    assertProjectDocument(document);
    this.#document = structuredClone(document);
    this.#clock = clock;
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

    const result = applyTransaction(this.#document, transaction, this.#clock);
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
): CommitResult {
  assertTransactionEnvelope(document, transaction);
  const working = structuredClone(document);
  const sequence = findSequence(working, transaction.sequenceId);
  checkPreconditions(working, sequence, transaction.actor, transaction.preconditions);

  const inverseOperations: EditOperation[] = [];
  for (const operation of transaction.operations) {
    assertOperationUnlocked(sequence, transaction.actor, operation);
    const inverse = applyOperation(sequence, operation, transaction.actor);
    inverseOperations.unshift(inverse);
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

  const validation = validateProjectDocument(working);
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
  return document.sequences.some((sequence) =>
    sequence.id === objectId
    || sequence.tracks.some((track) =>
      track.id === objectId || track.clips.some((clip) => clip.id === objectId),
    )
    || sequence.locks.some((lock) => lock.id === objectId),
  );
}

function assertOperationUnlocked(sequence: Sequence, actor: Actor, operation: EditOperation): void {
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
  }
}

function operationTouchesProperty(
  operation: Exclude<EditOperation, { type: "lock.add" | "lock.remove" }>,
  objectId: string,
  lockedPath: string,
): boolean {
  if (operation.type === "track.add" || operation.type === "track.remove") return true;
  if (operation.type === "clip.insert" || operation.type === "clip.remove" || operation.type === "clip.replace") {
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
  operation: Exclude<EditOperation, { type: "lock.add" | "lock.remove" }>,
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

function applyOperation(sequence: Sequence, operation: EditOperation, actor: Actor): EditOperation {
  switch (operation.type) {
    case "track.add": {
      assertUniqueObjectId(sequence, operation.track.id);
      const index = checkedInsertIndex(operation.index, sequence.tracks.length);
      sequence.tracks.splice(index, 0, structuredClone(operation.track));
      return { type: "track.remove", trackId: operation.track.id };
    }
    case "track.remove": {
      const { track, index } = findTrack(sequence, operation.trackId);
      sequence.tracks.splice(index, 1);
      return { type: "track.add", track: structuredClone(track), index };
    }
    case "clip.insert": {
      assertUniqueObjectId(sequence, operation.clip.id);
      const { track } = findTrack(sequence, operation.trackId);
      const index = checkedInsertIndex(operation.index, track.clips.length);
      track.clips.splice(index, 0, structuredClone(operation.clip));
      return { type: "clip.remove", clipId: operation.clip.id };
    }
    case "clip.remove": {
      const { clip, track, index } = findClip(sequence, operation.clipId);
      track.clips.splice(index, 1);
      return { type: "clip.insert", trackId: track.id, clip: structuredClone(clip), index };
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
      return {
        type: "clip.move",
        clipId: clip.id,
        toTrackId: track.id,
        toIndex: index,
        start: previousStart,
      };
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
      return inverse;
    }
    case "clip.replace": {
      if (operation.clip.id !== operation.clipId) {
        throw new EditError("INVALID_OPERATION", "Replacement clip ID must not change");
      }
      const { clip, track, index } = findClip(sequence, operation.clipId);
      track.clips[index] = structuredClone(operation.clip);
      return { type: "clip.replace", clipId: clip.id, clip: structuredClone(clip) };
    }
    case "clip.update": {
      const { clip } = findClip(sequence, operation.clipId);
      const before = structuredClone(clip);
      Object.assign(clip, structuredClone(operation.patch));
      return { type: "clip.replace", clipId: clip.id, clip: before };
    }
    case "lock.add": {
      assertUniqueObjectId(sequence, operation.lock.id);
      const index = checkedInsertIndex(operation.index, sequence.locks.length);
      sequence.locks.splice(index, 0, structuredClone(operation.lock));
      return { type: "lock.remove", lockId: operation.lock.id };
    }
    case "lock.remove": {
      const index = sequence.locks.findIndex((lock) => lock.id === operation.lockId);
      if (index < 0) throw new EditError("OBJECT_NOT_FOUND", `Lock ${operation.lockId} does not exist`);
      const lock = sequence.locks[index];
      if (!lock) throw new Error("Invariant violation: lock index disappeared");
      if (lock.owner !== actor.id) throw new EditError("LOCKED", `Only ${lock.owner} can remove lock ${lock.id}`);
      sequence.locks.splice(index, 1);
      return { type: "lock.add", lock: structuredClone(lock), index };
    }
  }
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
