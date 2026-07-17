import { readFileSync } from "node:fs";
import fc from "fast-check";
import {
  assertProjectDocument,
  type Actor,
  type AgentCutProjectDocument,
  type Clip,
} from "@agentcut/timeline-schema";
import { describe, expect, it } from "vitest";
import { EditError } from "./errors.js";
import { TransactionEngine } from "./engine.js";
import type { EditOperation, EditTransaction } from "./types.js";

const user: Actor = { kind: "user", id: "local_user" };
const agent: Actor = { kind: "agent", id: "codex_session_1" };
const fixedClock = () => "2026-07-17T09:00:00Z";

function fixture(): AgentCutProjectDocument {
  const fixtureUrl = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  assertProjectDocument(value);
  return structuredClone(value);
}

function transaction(
  baseRevision: number,
  operations: EditOperation[],
  overrides: Partial<EditTransaction> = {},
): EditTransaction {
  return {
    protocolVersion: "0.1.0",
    transactionId: `tx_${baseRevision}_${Math.random().toString(36).slice(2)}`,
    idempotencyKey: `key_${baseRevision}_${Math.random().toString(36).slice(2)}`,
    projectId: "project_demo_001",
    sequenceId: "sequence_main",
    baseRevision,
    actor: user,
    reason: "technical validation",
    preconditions: [],
    operations,
    ...overrides,
  };
}

function editableState(document: AgentCutProjectDocument): unknown {
  return {
    assets: document.assets,
    sequences: document.sequences,
    styleSpecs: document.styleSpecs,
    artifacts: document.artifacts,
    exportPresets: document.exportPresets,
    versions: document.versions,
    extensions: document.extensions,
  };
}

describe("transaction engine", () => {
  it("commits multiple operations atomically at one revision", () => {
    const engine = new TransactionEngine(fixture(), fixedClock);
    const result = engine.commit(transaction(0, [
      {
        type: "clip.move",
        clipId: "clip_take_1",
        start: { value: 1_000, rate: { numerator: 1_000, denominator: 1 } },
      },
      { type: "clip.update", clipId: "clip_take_1", patch: { enabled: false } },
    ], { transactionId: "tx_atomic", idempotencyKey: "atomic" }));

    expect(result.document.project.revision).toBe(1);
    expect(result.document.history.headRevision).toBe(1);
    expect(result.document.history.records).toHaveLength(1);
    const clip = result.document.sequences[0]?.tracks[0]?.clips[0];
    expect(clip?.timelineRange.start.value).toBe(1_000);
    expect(clip?.enabled).toBe(false);
    expect(result.record.inverseOperations).toHaveLength(2);
  });

  it("does not mutate state when a later operation fails validation", () => {
    const engine = new TransactionEngine(fixture(), fixedClock);
    const before = engine.snapshot();
    const invalidCaption: Clip = {
      id: "caption_on_video_track",
      kind: "caption",
      timelineRange: {
        start: { value: 0, rate: { numerator: 1_000, denominator: 1 } },
        duration: { value: 500, rate: { numerator: 1_000, denominator: 1 } },
      },
      enabled: true,
      provenance: {
        createdBy: agent,
        createdAt: "2026-07-17T09:00:00Z",
        reason: "invalid test operation",
      },
    };

    expect(() => engine.commit(transaction(0, [
      { type: "clip.update", clipId: "clip_take_1", patch: { enabled: false } },
      { type: "clip.insert", trackId: "track_v1", clip: invalidCaption },
    ]))).toThrowError(EditError);
    expect(engine.snapshot()).toEqual(before);
  });

  it("rejects stale revisions without changing the project", () => {
    const engine = new TransactionEngine(fixture(), fixedClock);
    engine.commit(transaction(0, [
      { type: "clip.update", clipId: "clip_take_1", patch: { enabled: false } },
    ]));
    const beforeConflict = engine.snapshot();
    expect(() => engine.commit(transaction(0, [
      { type: "clip.update", clipId: "clip_take_1", patch: { enabled: true } },
    ]))).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
    expect(engine.snapshot()).toEqual(beforeConflict);
  });

  it("blocks automated edits in a user-protected range", () => {
    const engine = new TransactionEngine(fixture(), fixedClock);
    engine.commit(transaction(0, [{
      type: "lock.add",
      lock: {
        id: "lock_hook",
        owner: "local_user",
        mode: "deny_agent",
        scope: {
          kind: "range",
          range: {
            start: { value: 0, rate: { numerator: 1_000, denominator: 1 } },
            duration: { value: 3_000, rate: { numerator: 1_000, denominator: 1 } },
          },
        },
        createdAt: "2026-07-17T09:00:00Z",
      },
    }], { transactionId: "tx_lock", idempotencyKey: "lock" }));
    const lockedState = engine.snapshot();

    expect(() => engine.commit(transaction(1, [{
      type: "clip.move",
      clipId: "clip_take_1",
      start: { value: 2_000, rate: { numerator: 1_000, denominator: 1 } },
    }], { actor: agent }))).toThrowError(expect.objectContaining({ code: "LOCKED" }));
    expect(engine.snapshot()).toEqual(lockedState);
  });

  it("replays the same idempotency key without a second commit", () => {
    const engine = new TransactionEngine(fixture(), fixedClock);
    const request = transaction(0, [
      { type: "clip.update", clipId: "clip_take_1", patch: { enabled: false } },
    ], { transactionId: "tx_idempotent", idempotencyKey: "same-request" });
    expect(engine.commit(request).idempotentReplay).toBe(false);
    const replay = engine.commit(request);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.document.project.revision).toBe(1);
    expect(replay.document.history.records).toHaveLength(1);
  });

  it("enforces property locks without freezing unrelated clip properties", () => {
    const engine = new TransactionEngine(fixture(), fixedClock);
    engine.commit(transaction(0, [{
      type: "lock.add",
      lock: {
        id: "lock_caption_copy",
        owner: "local_user",
        mode: "deny_agent",
        scope: { kind: "property", objectId: "clip_take_1", path: "/content" },
        createdAt: "2026-07-17T09:00:00Z",
      },
    }], { transactionId: "tx_property_lock", idempotencyKey: "property-lock" }));

    engine.commit(transaction(1, [{
      type: "clip.move",
      clipId: "clip_take_1",
      start: { value: 2_000, rate: { numerator: 1_000, denominator: 1 } },
    }], { actor: agent, transactionId: "tx_move_unrelated", idempotencyKey: "move-unrelated" }));

    expect(() => engine.commit(transaction(2, [{
      type: "clip.update",
      clipId: "clip_take_1",
      patch: { content: { text: "Agent should not overwrite approved copy" } },
    }], { actor: agent }))).toThrowError(expect.objectContaining({ code: "LOCKED" }));
  });

  it("restores editable state through inverse operations", () => {
    const initial = fixture();
    const engine = new TransactionEngine(initial, fixedClock);
    engine.commit(transaction(0, [
      {
        type: "clip.move",
        clipId: "clip_take_1",
        start: { value: 48_000, rate: { numerator: 48_000, denominator: 1 } },
      },
      {
        type: "clip.trim",
        clipId: "clip_take_1",
        timelineRange: {
          start: { value: 48_000, rate: { numerator: 48_000, denominator: 1 } },
          duration: { value: 144_000, rate: { numerator: 48_000, denominator: 1 } },
        },
        sourceRange: {
          start: { value: 96_000, rate: { numerator: 48_000, denominator: 1 } },
          duration: { value: 144_000, rate: { numerator: 48_000, denominator: 1 } },
        },
      },
      { type: "clip.update", clipId: "clip_take_1", patch: { enabled: false } },
    ], { transactionId: "tx_roundtrip", idempotencyKey: "roundtrip" }));
    const undone = engine.undo("tx_roundtrip", user, "tx_undo_roundtrip");
    expect(editableState(undone.document)).toEqual(editableState(initial));
    expect(undone.document.project.revision).toBe(2);
  });

  it("survives 1,000 randomized trim/undo round trips", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 240_000 }),
      fc.integer({ min: 1, max: 240_000 }),
      (start, duration) => {
        const initial = fixture();
        const engine = new TransactionEngine(initial, fixedClock);
        engine.commit(transaction(0, [{
          type: "clip.trim",
          clipId: "clip_take_1",
          timelineRange: {
            start: { value: start, rate: { numerator: 48_000, denominator: 1 } },
            duration: { value: duration, rate: { numerator: 48_000, denominator: 1 } },
          },
          sourceRange: {
            start: { value: start, rate: { numerator: 48_000, denominator: 1 } },
            duration: { value: duration, rate: { numerator: 48_000, denominator: 1 } },
          },
        }], { transactionId: "tx_property", idempotencyKey: "property" }));
        const result = engine.undo("tx_property", user, "tx_property_undo");
        expect(editableState(result.document)).toEqual(editableState(initial));
      },
    ), { numRuns: 1_000 });
  });
});
