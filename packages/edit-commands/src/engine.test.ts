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

  it("keeps a source range lock attached after an earlier ripple edit", () => {
    const engine = new TransactionEngine(fixture(), fixedClock);
    engine.commit(transaction(0, [{
      type: "lock.add",
      lock: {
        id: "lock_keep_filler_source",
        owner: "local_user",
        mode: "deny_agent",
        scope: {
          kind: "source_range",
          assetId: "asset_camera_a",
          range: {
            start: { value: 51, rate: { numerator: 30_000, denominator: 1_001 } },
            duration: { value: 6, rate: { numerator: 30_000, denominator: 1_001 } },
          },
        },
        createdAt: "2026-07-17T09:00:00Z",
        note: "Keep reviewed candidate in source media",
      },
    }], { transactionId: "tx_source_lock", idempotencyKey: "source-lock" }));

    engine.commit(transaction(1, [{
      type: "range.deleteRipple",
      range: {
        start: { value: 0, rate: { numerator: 30_000, denominator: 1_001 } },
        duration: { value: 3, rate: { numerator: 30_000, denominator: 1_001 } },
      },
      trackIds: ["track_v1"],
    }], {
      transactionId: "tx_user_ripple_before_lock",
      idempotencyKey: "user-ripple-before-lock",
    }));

    expect(() => engine.commit(transaction(2, [{
      type: "range.deleteRipple",
      range: {
        start: { value: 18, rate: { numerator: 30_000, denominator: 1_001 } },
        duration: { value: 6, rate: { numerator: 30_000, denominator: 1_001 } },
      },
      trackIds: ["track_v1"],
    }], { actor: agent }))).toThrowError(expect.objectContaining({ code: "LOCKED" }));
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

  it("splits a media clip with exact timeline and source ranges, then restores it", () => {
    const initial = fixture();
    const engine = new TransactionEngine(initial, fixedClock);
    const split = engine.commit(transaction(0, [{
      type: "clip.split",
      clipId: "clip_take_1",
      at: { value: 150, rate: { numerator: 30_000, denominator: 1_001 } },
      rightClipId: "clip_take_1_right",
    }], { transactionId: "tx_split", idempotencyKey: "split" }));

    const clips = split.document.sequences[0]?.tracks[0]?.clips;
    expect(clips).toHaveLength(2);
    expect(clips?.[0]?.timelineRange.duration.value).toBe(150);
    expect(clips?.[0]?.sourceRange?.duration.value).toBe(150);
    expect(clips?.[1]).toEqual(expect.objectContaining({
      id: "clip_take_1_right",
      timelineRange: expect.objectContaining({
        start: { value: 150, rate: { numerator: 30_000, denominator: 1_001 } },
        duration: { value: 150, rate: { numerator: 30_000, denominator: 1_001 } },
      }),
      sourceRange: expect.objectContaining({
        start: { value: 180, rate: { numerator: 30_000, denominator: 1_001 } },
        duration: { value: 150, rate: { numerator: 30_000, denominator: 1_001 } },
      }),
    }));

    const undone = engine.undo("tx_split", user, "tx_undo_split");
    expect(editableState(undone.document)).toEqual(editableState(initial));
  });

  it("rejects split points on clip boundaries without changing state", () => {
    const engine = new TransactionEngine(fixture(), fixedClock);
    const before = engine.snapshot();
    expect(() => engine.commit(transaction(0, [{
      type: "clip.split",
      clipId: "clip_take_1",
      at: { value: 0, rate: { numerator: 30_000, denominator: 1_001 } },
      rightClipId: "clip_take_1_right",
    }]))).toThrowError(expect.objectContaining({ code: "INVALID_OPERATION" }));
    expect(engine.snapshot()).toEqual(before);
  });

  it("publishes immutable artifacts through typed operations and can undo them", () => {
    const initial = fixture();
    const sourceTranscript = initial.artifacts.find((artifact) => artifact.kind === "transcript");
    if (!sourceTranscript) throw new Error("Fixture transcript is missing");
    const nextTranscript = structuredClone(sourceTranscript);
    nextTranscript.id = "transcript_main_002";
    nextTranscript.provenance = {
      createdBy: user,
      createdAt: fixedClock(),
      reason: "Correct transcript text without changing stable word IDs",
      sourceArtifactIds: [sourceTranscript.id],
    };
    nextTranscript.words[0] = { ...nextTranscript.words[0]!, text: "大家好！" };

    const engine = new TransactionEngine(initial, fixedClock);
    const published = engine.commit(transaction(0, [{
      type: "artifact.put",
      artifact: nextTranscript,
    }], { transactionId: "tx_artifact_put", idempotencyKey: "artifact-put" }));
    expect(published.document.artifacts.some((artifact) => artifact.id === nextTranscript.id)).toBe(true);
    const undone = engine.undo("tx_artifact_put", user, "tx_undo_artifact_put");
    expect(editableState(undone.document)).toEqual(editableState(initial));
  });

  it("does not remove artifacts that remain referenced", () => {
    const engine = new TransactionEngine(fixture(), fixedClock);
    const before = engine.snapshot();
    expect(() => engine.commit(transaction(0, [{
      type: "artifact.remove",
      artifactId: "transcript_main_001",
    }]))).toThrowError(expect.objectContaining({ code: "INVALID_DOCUMENT" }));
    expect(engine.snapshot()).toEqual(before);
  });

  it("registers imported assets atomically and rejects removal while referenced", () => {
    const initial = fixture();
    const engine = new TransactionEngine(initial, fixedClock);
    const registered = engine.commit(transaction(0, [{
      type: "asset.put",
      asset: {
        id: "asset_imported_b",
        kind: "video",
        uri: "media/imported-b.mp4",
        contentHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        availability: "online",
        provenance: {
          createdBy: user,
          createdAt: fixedClock(),
          reason: "Import a probed local media file",
        },
      },
    }], { transactionId: "tx_asset_put", idempotencyKey: "asset-put" }));
    expect(registered.document.assets.map((asset) => asset.id)).toContain("asset_imported_b");
    const undone = engine.undo("tx_asset_put", user, "tx_undo_asset_put");
    expect(editableState(undone.document)).toEqual(editableState(initial));

    const referenced = new TransactionEngine(initial, fixedClock);
    const before = referenced.snapshot();
    expect(() => referenced.commit(transaction(0, [{
      type: "asset.remove",
      assetId: "asset_camera_a",
    }]))).toThrowError(expect.objectContaining({ code: "INVALID_DOCUMENT" }));
    expect(referenced.snapshot()).toEqual(before);
  });

  it("ripple-deletes the middle of a media clip with exact source slices and undo", () => {
    const initial = fixture();
    const engine = new TransactionEngine(initial, fixedClock);
    const result = engine.commit(transaction(0, [{
      type: "range.deleteRipple",
      range: {
        start: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
        duration: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
      },
      trackIds: ["track_v1"],
      rightClipIds: { clip_take_1: "clip_take_1_after_cut" },
    }], { transactionId: "tx_ripple_middle", idempotencyKey: "ripple-middle" }));

    expect(result.document.sequences[0]?.tracks[0]?.clips).toEqual([
      expect.objectContaining({
        id: "clip_take_1",
        timelineRange: expect.objectContaining({
          start: { value: 0, rate: { numerator: 30_000, denominator: 1_001 } },
          duration: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
        }),
        sourceRange: expect.objectContaining({
          start: { value: 30, rate: { numerator: 30_000, denominator: 1_001 } },
          duration: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
        }),
      }),
      expect.objectContaining({
        id: "clip_take_1_after_cut",
        timelineRange: expect.objectContaining({
          start: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
          duration: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
        }),
        sourceRange: expect.objectContaining({
          start: { value: 230, rate: { numerator: 30_000, denominator: 1_001 } },
          duration: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
        }),
      }),
    ]);

    const undone = engine.undo("tx_ripple_middle", user, "tx_undo_ripple_middle");
    expect(editableState(undone.document)).toEqual(editableState(initial));
  });

  it("ripple-trims a clip at the sequence head while preserving its ID", () => {
    const engine = new TransactionEngine(fixture(), fixedClock);
    const result = engine.commit(transaction(0, [{
      type: "range.deleteRipple",
      range: {
        start: { value: 0, rate: { numerator: 30_000, denominator: 1_001 } },
        duration: { value: 50, rate: { numerator: 30_000, denominator: 1_001 } },
      },
      trackIds: ["track_v1"],
    }]));

    const clip = result.document.sequences[0]?.tracks[0]?.clips[0];
    expect(clip?.id).toBe("clip_take_1");
    expect(clip?.timelineRange).toEqual({
      start: { value: 0, rate: { numerator: 30_000, denominator: 1_001 } },
      duration: { value: 250, rate: { numerator: 30_000, denominator: 1_001 } },
    });
    expect(clip?.sourceRange).toEqual({
      start: { value: 80, rate: { numerator: 30_000, denominator: 1_001 } },
      duration: { value: 250, rate: { numerator: 30_000, denominator: 1_001 } },
    });
  });

  it("shifts later clips left and restores their original positions on undo", () => {
    const initial = fixture();
    const track = initial.sequences[0]?.tracks[0];
    const first = track?.clips[0];
    if (!track || !first) throw new Error("Fixture video clip is missing");
    const second = structuredClone(first);
    second.id = "clip_take_2";
    second.timelineRange = {
      start: { value: 300, rate: { numerator: 30_000, denominator: 1_001 } },
      duration: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
    };
    second.sourceRange = {
      start: { value: 330, rate: { numerator: 30_000, denominator: 1_001 } },
      duration: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
    };
    track.clips.push(second);
    const engine = new TransactionEngine(initial, fixedClock);
    const result = engine.commit(transaction(0, [{
      type: "range.deleteRipple",
      range: {
        start: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
        duration: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
      },
      trackIds: ["track_v1"],
      rightClipIds: { clip_take_1: "clip_take_1_after_cut" },
    }], { transactionId: "tx_ripple_shift", idempotencyKey: "ripple-shift" }));

    const shifted = result.document.sequences[0]?.tracks[0]?.clips.find(
      (clip) => clip.id === "clip_take_2",
    );
    expect(shifted?.timelineRange.start.value).toBe(200);
    const undone = engine.undo("tx_ripple_shift", user, "tx_undo_ripple_shift");
    expect(editableState(undone.document)).toEqual(editableState(initial));
  });

  it("rejects ambiguous middle ripple cuts without a right-side clip ID", () => {
    const engine = new TransactionEngine(fixture(), fixedClock);
    const before = engine.snapshot();
    expect(() => engine.commit(transaction(0, [{
      type: "range.deleteRipple",
      range: {
        start: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
        duration: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
      },
      trackIds: ["track_v1"],
    }]))).toThrowError(expect.objectContaining({ code: "INVALID_OPERATION" }));
    expect(engine.snapshot()).toEqual(before);
  });

  it("blocks Agent ripple deletion when it intersects a user range lock", () => {
    const engine = new TransactionEngine(fixture(), fixedClock);
    engine.commit(transaction(0, [{
      type: "lock.add",
      lock: {
        id: "lock_ripple_region",
        owner: "local_user",
        mode: "deny_agent",
        scope: {
          kind: "range",
          range: {
            start: { value: 50, rate: { numerator: 30_000, denominator: 1_001 } },
            duration: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
          },
          trackIds: ["track_v1"],
        },
        createdAt: fixedClock(),
      },
    }], { transactionId: "tx_ripple_lock", idempotencyKey: "ripple-lock" }));
    const before = engine.snapshot();

    expect(() => engine.commit(transaction(1, [{
      type: "range.deleteRipple",
      range: {
        start: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
        duration: { value: 100, rate: { numerator: 30_000, denominator: 1_001 } },
      },
      trackIds: ["track_v1"],
      rightClipIds: { clip_take_1: "clip_take_1_after_cut" },
    }], { actor: agent }))).toThrowError(expect.objectContaining({ code: "LOCKED" }));
    expect(engine.snapshot()).toEqual(before);
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

  it("round-trips randomized lifecycles covering every 0.1 operation", () => {
    fc.assert(fc.property(
      fc.integer({ min: 60, max: 240 }),
      fc.nat(10_000),
      fc.nat(10_000),
      fc.integer({ min: 1, max: 120 }),
      (splitAt, startSeed, durationSeed, gapDuration) => {
        const initial = fixture();
        const engine = new TransactionEngine(initial, fixedClock);
        const rippleStart = 1 + (startSeed % (splitAt - 2));
        const rippleDuration = 1 + (durationSeed % (splitAt - rippleStart - 1));
        const committedIds: string[] = [];
        let revision = 0;
        const commit = (name: string, operations: EditOperation[]): void => {
          const transactionId = `tx_lifecycle_${name}`;
          engine.commit(transaction(revision, operations, {
            transactionId,
            idempotencyKey: `lifecycle-${name}`,
          }));
          committedIds.push(transactionId);
          revision += 1;
        };

        commit("split", [{
          type: "clip.split",
          clipId: "clip_take_1",
          at: { value: splitAt, rate: { numerator: 30_000, denominator: 1_001 } },
          rightClipId: "clip_lifecycle_split_right",
        }]);
        commit("ripple", [{
          type: "range.deleteRipple",
          range: {
            start: { value: rippleStart, rate: { numerator: 30_000, denominator: 1_001 } },
            duration: { value: rippleDuration, rate: { numerator: 30_000, denominator: 1_001 } },
          },
          trackIds: ["track_v1"],
          rightClipIds: { clip_take_1: "clip_lifecycle_ripple_right" },
        }]);
        commit("main_update", [{
          type: "clip.update",
          clipId: "clip_lifecycle_ripple_right",
          patch: { enabled: false, metadata: { randomized: true } },
        }]);
        commit("lock_add", [{
          type: "lock.add",
          lock: {
            id: "lock_lifecycle",
            owner: "local_user",
            mode: "owner_only",
            scope: { kind: "clip", clipId: "clip_lifecycle_ripple_right" },
            createdAt: fixedClock(),
          },
        }]);
        commit("lock_remove", [{ type: "lock.remove", lockId: "lock_lifecycle" }]);
        commit("track_add", [{
          type: "track.add",
          track: {
            id: "track_lifecycle_audio",
            kind: "audio",
            name: "随机生命周期音轨",
            order: 1,
            locked: false,
            enabled: true,
            clips: [],
            transitions: [],
          },
        }]);
        const gap: Clip = {
          id: "gap_lifecycle",
          kind: "gap",
          timelineRange: {
            start: { value: 0, rate: { numerator: 30_000, denominator: 1_001 } },
            duration: { value: gapDuration, rate: { numerator: 30_000, denominator: 1_001 } },
          },
          enabled: true,
          provenance: { createdBy: user, createdAt: fixedClock(), reason: "random lifecycle" },
        };
        commit("clip_insert", [{ type: "clip.insert", trackId: "track_lifecycle_audio", clip: gap }]);
        commit("clip_move", [{
          type: "clip.move",
          clipId: gap.id,
          start: { value: 3, rate: { numerator: 30_000, denominator: 1_001 } },
        }]);
        commit("clip_trim", [{
          type: "clip.trim",
          clipId: gap.id,
          timelineRange: {
            start: { value: 3, rate: { numerator: 30_000, denominator: 1_001 } },
            duration: { value: gapDuration + 1, rate: { numerator: 30_000, denominator: 1_001 } },
          },
        }]);
        commit("clip_replace", [{
          type: "clip.replace",
          clipId: gap.id,
          clip: {
            ...structuredClone(gap),
            timelineRange: {
              start: { value: 4, rate: { numerator: 30_000, denominator: 1_001 } },
              duration: { value: gapDuration + 2, rate: { numerator: 30_000, denominator: 1_001 } },
            },
          },
        }]);
        commit("clip_remove", [{ type: "clip.remove", clipId: gap.id }]);
        commit("track_remove", [{ type: "track.remove", trackId: "track_lifecycle_audio" }]);
        commit("artifact_put", [{
          type: "artifact.put",
          artifact: {
            id: "transcript_lifecycle",
            kind: "transcript",
            assetId: "asset_camera_a",
            language: "zh-CN",
            audioStreamIndex: 0,
            words: [{
              id: "word_lifecycle",
              text: "测试",
              sourceRange: {
                start: { value: 4_000, rate: { numerator: 1_000, denominator: 1 } },
                duration: { value: 100, rate: { numerator: 1_000, denominator: 1 } },
              },
              confidence: 1,
            }],
            provenance: { createdBy: user, createdAt: fixedClock(), reason: "random lifecycle" },
          },
        }]);
        commit("artifact_remove", [{ type: "artifact.remove", artifactId: "transcript_lifecycle" }]);

        for (const transactionId of committedIds.reverse()) {
          engine.undo(transactionId, user, `undo_${transactionId}`);
        }
        expect(editableState(engine.snapshot())).toEqual(editableState(initial));
      },
    ), { numRuns: 100 });
  });
});
