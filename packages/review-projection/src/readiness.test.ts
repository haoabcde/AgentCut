import { describe, expect, it } from "vitest";
import type { CommandRecord } from "@agentcut/edit-commands";
import { buildRoughCutReadiness, type RoughCutReadinessInput } from "./readiness.js";
import type { TranscriptReviewCandidate, TranscriptReviewProjection } from "./transcript-review.js";

function timeRange(startMicros: number, durationMicros: number) {
  const rate = { numerator: 1_000_000, denominator: 1 };
  return {
    start: { value: startMicros, rate },
    duration: { value: durationMicros, rate },
  };
}

function candidate(overrides: Partial<TranscriptReviewCandidate>): TranscriptReviewCandidate {
  return {
    candidateId: "c1",
    targetKind: "words",
    sourceRange: timeRange(0, 500_000),
    wordIds: ["w1"],
    state: "candidate_remove",
    reasonCodes: ["silence"],
    risk: "low",
    confidence: 0.9,
    explanationZh: "",
    restorable: false,
    ...overrides,
  };
}

function review(candidates: TranscriptReviewCandidate[]): TranscriptReviewProjection {
  return {
    transcriptId: "t1",
    projectRevision: 1,
    candidates,
    tokens: [],
    gaps: [],
    summary: {
      normalTokens: 0,
      candidateTokens: 0,
      deletedTokens: 0,
      reviewedKeepTokens: 0,
      candidateGaps: 0,
      committedGaps: 0,
      reviewedKeepGaps: 0,
    },
  };
}

function record(transactionId: string, committedRevision: number): CommandRecord {
  return {
    transactionId,
    projectId: "p",
    baseRevision: committedRevision - 1,
    committedRevision,
    request: {
      protocolVersion: "0.1.0",
      transactionId,
      idempotencyKey: transactionId,
      projectId: "p",
      sequenceId: "s",
      baseRevision: committedRevision - 1,
      actor: { kind: "user", id: "u" },
      reason: "",
      preconditions: [],
      operations: [],
    },
    inverseOperations: [],
    beforeHash: "a",
    afterHash: "b",
    committedAt: "2026-01-01T00:00:00.000Z",
  };
}

function input(overrides: Partial<RoughCutReadinessInput>): RoughCutReadinessInput {
  return {
    review: review([]),
    speechGaps: [],
    currentRevision: 1,
    exports: [],
    records: [],
    ...overrides,
  };
}

describe("buildRoughCutReadiness", () => {
  it("treats decided candidates as independent from speech gaps and export", () => {
    const result = buildRoughCutReadiness(input({
      review: review([
        candidate({ candidateId: "done", state: "reviewed_keep", restorable: false }),
      ]),
      speechGaps: [{
        gapId: "g1",
        clipId: "clip1",
        sourceRange: timeRange(0, 200_000),
        timelineRange: timeRange(0, 200_000),
      }],
      currentRevision: 5,
      exports: [{ status: "succeeded", sourceRevision: 3 }],
    }));
    expect(result.candidatesDecided).toBe(true);
    expect(result.candidatesPending).toBe(0);
    expect(result.speechGapsRemaining).toBe(1);
    expect(result.exportSucceeded).toBe(true);
    expect(result.exportUpToDate).toBe(false);
    expect(result.exportStale).toBe(true);
    expect(result.undo).toBeNull();
  });

  it("counts pending candidates and reports a fresh export as up to date", () => {
    const result = buildRoughCutReadiness(input({
      review: review([
        candidate({ candidateId: "p1", state: "candidate_remove" }),
        candidate({ candidateId: "p2", state: "candidate_keep" }),
      ]),
      currentRevision: 4,
      exports: [{ status: "succeeded", sourceRevision: 3 }],
    }));
    expect(result.candidatesDecided).toBe(false);
    expect(result.candidatesPending).toBe(2);
    expect(result.exportUpToDate).toBe(true);
    expect(result.exportStale).toBe(false);
  });

  it("resolves the most recent restorable deletion and merges a batch into one undo", () => {
    const result = buildRoughCutReadiness(input({
      review: review([
        candidate({
          candidateId: "old",
          state: "committed_deleted",
          restorable: true,
          transactionId: "tx_old",
          sourceRange: timeRange(0, 400_000),
        }),
        candidate({
          candidateId: "batch_a",
          state: "committed_deleted",
          restorable: true,
          transactionId: "tx_batch",
          sourceRange: timeRange(0, 300_000),
        }),
        candidate({
          candidateId: "batch_b",
          state: "committed_deleted",
          restorable: true,
          transactionId: "tx_batch",
          targetKind: "gap",
          sourceRange: timeRange(0, 200_000),
        }),
      ]),
      currentRevision: 6,
      records: [record("tx_old", 2), record("tx_batch", 5)],
    }));
    expect(result.undo).toEqual({
      transactionId: "tx_batch",
      committedRevision: 5,
      removedDurationSeconds: 0.5,
      labelZh: "口播内容",
    });
  });

  it("labels a gap-only deletion as speech-free footage", () => {
    const result = buildRoughCutReadiness(input({
      review: review([
        candidate({
          candidateId: "gap1",
          state: "committed_deleted",
          restorable: true,
          transactionId: "tx_gap",
          targetKind: "gap",
          wordIds: [],
          sourceRange: timeRange(0, 250_000),
        }),
      ]),
      records: [record("tx_gap", 3)],
    }));
    expect(result.undo?.labelZh).toBe("无口播画面");
    expect(result.undo?.removedDurationSeconds).toBe(0.25);
  });

  it("ignores committed candidates whose transaction is no longer in the log", () => {
    const result = buildRoughCutReadiness(input({
      review: review([
        candidate({
          candidateId: "ghost",
          state: "committed_deleted",
          restorable: true,
          transactionId: "tx_missing",
        }),
      ]),
      records: [],
    }));
    expect(result.undo).toBeNull();
  });
});
