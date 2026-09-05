import { readFileSync } from "node:fs";
import { TransactionEngine, compileEditProposalBundle } from "@agentcut/edit-commands";
import {
  assertProjectDocument,
  type AgentCutProjectDocument,
  type CandidateSetArtifact,
  type EditProposalArtifact,
} from "@agentcut/timeline-schema";
import { describe, expect, it } from "vitest";
import {
  candidateReviewLockId,
  compileCandidateAcceptance,
  compileCandidateAcceptBatch,
  compileCandidateKeep,
  compileCandidateKeepBatch,
  compileManualSelectionDeletion,
  compileManualSpeechGapDeletion,
  compileCandidateUnlock,
  computeCandidateAcceptanceApprovalPayloadHash,
} from "./review.js";

const user = { kind: "user" as const, id: "local_user" };
const agent = { kind: "agent" as const, id: "codex" };
const clock = () => "2026-07-18T09:00:00Z";

function fixture(): AgentCutProjectDocument {
  const url = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(url, "utf8"));
  assertProjectDocument(value);
  return structuredClone(value);
}

function sourceAnalysis(document: AgentCutProjectDocument): {
  candidateSet: CandidateSetArtifact;
  proposal: EditProposalArtifact;
} {
  const candidateSet = document.artifacts.find((item) => item.kind === "deletionCandidateSet");
  const proposal = document.artifacts.find((item) => item.kind === "editProposal");
  if (!candidateSet || candidateSet.kind !== "deletionCandidateSet"
    || !proposal || proposal.kind !== "editProposal") throw new Error("Fixture analysis is missing");
  return { candidateSet, proposal };
}

describe("candidate review workflow", () => {
  it("binds high-risk approval payloads to the exact revision and candidate definition", () => {
    const document = fixture();
    const { candidateSet } = sourceAnalysis(document);
    candidateSet.candidates[0]!.risk = "high";
    const first = computeCandidateAcceptanceApprovalPayloadHash(document, "candidate_filler_001");
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(computeCandidateAcceptanceApprovalPayloadHash(document, "candidate_filler_001")).toBe(first);

    const changedRevision = structuredClone(document);
    changedRevision.project.revision += 1;
    expect(computeCandidateAcceptanceApprovalPayloadHash(changedRevision, "candidate_filler_001"))
      .not.toBe(first);
    candidateSet.candidates[0]!.explanationZh = "changed evidence";
    expect(computeCandidateAcceptanceApprovalPayloadHash(document, "candidate_filler_001"))
      .not.toBe(first);
    expect(() => computeCandidateAcceptanceApprovalPayloadHash(document, "candidate_silence_001"))
      .toThrowError(expect.objectContaining({ code: "APPROVAL_NOT_REQUIRED" }));
  });

  it("accepts a remaining candidate against the latest split clip", () => {
    const document = fixture();
    const { candidateSet, proposal } = sourceAnalysis(document);
    candidateSet.evidenceContracts = ["retained-comparison-v1"];
    document.artifacts = document.artifacts.filter((artifact) =>
      artifact.kind !== "deletionCandidateSet" && artifact.kind !== "editProposal",
    );
    const engine = new TransactionEngine(document, clock);
    const first = engine.commit(compileEditProposalBundle(document, candidateSet, proposal, {
      transactionId: "tx_first_candidate",
      idempotencyKey: "first-candidate",
      actor: agent,
    }));
    const accepted = engine.commit(compileCandidateAcceptance(first.document, {
      candidateId: "candidate_silence_001",
      requestId: "accept_silence_001",
      actor: user,
      createdAt: clock(),
    }));
    expect(accepted.document.project.revision).toBe(2);
    expect(accepted.record.request.operations.map((operation) => operation.type)).toEqual([
      "artifact.put",
      "artifact.put",
      "range.deleteRipple",
    ]);
    expect(accepted.document.artifacts.find((artifact) =>
      artifact.kind === "deletionCandidateSet" && artifact.detectorVersion === "human-review/0.1.0",
    )).toEqual(expect.objectContaining({
      evidenceContracts: ["retained-comparison-v1"],
    }));
    expect(accepted.document.sequences[0]?.tracks[0]?.clips).toHaveLength(2);
  });

  it("keeps a candidate with a source-bound agent lock and can reconsider it", () => {
    const document = fixture();
    const engine = new TransactionEngine(document, clock);
    const kept = engine.commit(compileCandidateKeep(document, {
      candidateId: "candidate_silence_001",
      requestId: "keep_silence_001",
      actor: user,
      createdAt: clock(),
    }));
    const lockId = candidateReviewLockId("candidate_silence_001");
    expect(kept.document.sequences[0]?.locks).toContainEqual(expect.objectContaining({
      id: lockId,
      mode: "deny_agent",
      scope: expect.objectContaining({ kind: "source_range", assetId: "asset_camera_a" }),
    }));
    expect(() => compileCandidateAcceptance(kept.document, {
      candidateId: "candidate_silence_001",
      requestId: "agent_attempt",
      actor: agent,
      createdAt: clock(),
    })).toThrowError(expect.objectContaining({ code: "CANDIDATE_ALREADY_REVIEWED" }));

    const unlocked = engine.commit(compileCandidateUnlock(kept.document, {
      lockId,
      requestId: "unlock_silence_001",
      actor: user,
    }));
    expect(unlocked.document.sequences[0]?.locks).toHaveLength(0);
  });

  it("resolves an overlapping lower-priority candidate in the same reversible decision", () => {
    const document = fixture();
    const { candidateSet } = sourceAnalysis(document);
    const wordCandidate = candidateSet.candidates.find((candidate) =>
      candidate.id === "candidate_filler_001",
    )!;
    const gapCandidate = candidateSet.candidates.find((candidate) =>
      candidate.id === "candidate_silence_001",
    )!;
    wordCandidate.risk = "high";
    if (gapCandidate.target.kind !== "gap") throw new Error("Fixture gap candidate missing");
    gapCandidate.target.nextWordId = "word_003";
    gapCandidate.target.sourceRange.duration.value = 350;
    const engine = new TransactionEngine(document, clock);

    const accepted = engine.commit(compileCandidateAcceptance(document, {
      candidateId: wordCandidate.id,
      requestId: "accept_overlap_anchor",
      actor: user,
      createdAt: clock(),
      allowHighRisk: true,
      resolveOverlapCandidateIds: [gapCandidate.id],
    }));
    expect(accepted.record.request.operations.map((operation) => operation.type)).toEqual([
      "artifact.put",
      "artifact.put",
      "range.deleteRipple",
      "lock.add",
    ]);
    expect(accepted.document.sequences[0]?.locks).toContainEqual(expect.objectContaining({
      id: candidateReviewLockId(gapCandidate.id),
      note: `agentcut:candidate_overlap_group:${wordCandidate.id}:${gapCandidate.id}`,
    }));

    const restored = engine.undo(accepted.record.transactionId, user, "restore_overlap_anchor");
    expect(restored.document.sequences[0]?.locks).toHaveLength(0);
    expect(restored.document.sequences[0]?.tracks[0]?.clips).toHaveLength(1);
  });

  it("unlocks an entire overlap keep group when its anchor is reconsidered", () => {
    const document = fixture();
    const { candidateSet } = sourceAnalysis(document);
    const wordCandidate = candidateSet.candidates.find((candidate) =>
      candidate.id === "candidate_filler_001",
    )!;
    const gapCandidate = candidateSet.candidates.find((candidate) =>
      candidate.id === "candidate_silence_001",
    )!;
    wordCandidate.risk = "high";
    if (gapCandidate.target.kind !== "gap") throw new Error("Fixture gap candidate missing");
    gapCandidate.target.nextWordId = "word_003";
    gapCandidate.target.sourceRange.duration.value = 350;
    const engine = new TransactionEngine(document, clock);
    const kept = engine.commit(compileCandidateKeep(document, {
      candidateId: wordCandidate.id,
      requestId: "keep_overlap_anchor",
      actor: user,
      createdAt: clock(),
      resolveOverlapCandidateIds: [gapCandidate.id],
    }));
    expect(kept.document.sequences[0]?.locks).toHaveLength(2);

    const unlocked = engine.commit(compileCandidateUnlock(kept.document, {
      lockId: candidateReviewLockId(wordCandidate.id),
      requestId: "unlock_overlap_anchor",
      actor: user,
    }));
    expect(unlocked.record.request.operations).toHaveLength(2);
    expect(unlocked.document.sequences[0]?.locks).toHaveLength(0);
  });

  it("compiles a contiguous manual word selection into an auditable Ripple deletion", () => {
    const document = fixture();
    const transaction = compileManualSelectionDeletion(document, {
      wordIds: ["word_003", "word_004"],
      requestId: "manual_words_003_004",
      actor: user,
      createdAt: clock(),
    });

    expect(transaction.operations.map((operation) => operation.type)).toEqual([
      "artifact.put",
      "artifact.put",
      "range.deleteRipple",
    ]);
    expect(transaction.operations[0]).toEqual(expect.objectContaining({
      artifact: expect.objectContaining({
        kind: "deletionCandidateSet",
        candidates: [expect.objectContaining({
          reasonCodes: ["manual"],
          target: expect.objectContaining({
            kind: "words",
            wordIds: ["word_003", "word_004"],
            sourceRange: {
              start: { value: 2_000_000, rate: { numerator: 1_000_000, denominator: 1 } },
              duration: { value: 1_400_000, rate: { numerator: 1_000_000, denominator: 1 } },
            },
          }),
        })],
      }),
    }));

    const committed = new TransactionEngine(document, clock).commit(transaction);
    expect(committed.document.sequences[0]?.tracks[0]?.clips).toHaveLength(2);
  });

  it("rejects a manual selection that skips transcript words", () => {
    expect(() => compileManualSelectionDeletion(fixture(), {
      wordIds: ["word_001", "word_003"],
      requestId: "manual_non_contiguous",
      actor: user,
      createdAt: clock(),
    })).toThrowError(expect.objectContaining({ code: "INVALID_SELECTION" }));
  });

  it("compiles a Transcript-free source gap into an auditable Ripple deletion", () => {
    const document = fixture();
    const transaction = compileManualSpeechGapDeletion(document, {
      sourceRange: {
        start: { value: 3_400, rate: { numerator: 1_000, denominator: 1 } },
        duration: { value: 500, rate: { numerator: 1_000, denominator: 1 } },
      },
      previousWordId: "word_004",
      requestId: "manual_gap_after_word_004",
      actor: user,
      createdAt: clock(),
    });

    expect(transaction.operations.map((operation) => operation.type)).toEqual([
      "artifact.put",
      "artifact.put",
      "range.deleteRipple",
    ]);
    expect(transaction.operations[0]).toEqual(expect.objectContaining({
      artifact: expect.objectContaining({
        kind: "deletionCandidateSet",
        detectorVersion: "human-speech-gap/0.1.0",
        candidates: [expect.objectContaining({
          reasonCodes: ["manual"],
          target: expect.objectContaining({
            kind: "gap",
            previousWordId: "word_004",
          }),
        })],
      }),
    }));
    const committed = new TransactionEngine(document, clock).commit(transaction);
    expect(committed.document.project.revision).toBe(1);
    expect(committed.record.inverseOperations.length).toBeGreaterThan(0);
  });

  it("rejects a speech gap that overlaps a Transcript word", () => {
    expect(() => compileManualSpeechGapDeletion(fixture(), {
      sourceRange: {
        start: { value: 3_200, rate: { numerator: 1_000, denominator: 1 } },
        duration: { value: 500, rate: { numerator: 1_000, denominator: 1 } },
      },
      previousWordId: "word_004",
      requestId: "manual_gap_overlaps_word",
      actor: user,
      createdAt: clock(),
    })).toThrowError(expect.objectContaining({ code: "INVALID_SELECTION" }));
  });

  it("keeps all remaining candidates in one revision", () => {
    const document = fixture();
    const transaction = compileCandidateKeepBatch(document, {
      candidateIds: ["candidate_filler_001", "candidate_silence_001"],
      requestId: "keep_remaining",
      actor: user,
      createdAt: clock(),
    });

    expect(transaction.operations).toHaveLength(2);
    const committed = new TransactionEngine(document, clock).commit(transaction);
    expect(committed.document.project.revision).toBe(1);
    expect(committed.document.sequences[0]?.locks.map((lock) => lock.id)).toEqual([
      candidateReviewLockId("candidate_filler_001"),
      candidateReviewLockId("candidate_silence_001"),
    ]);
  });
});

function batchFixture(): {
  document: AgentCutProjectDocument;
  extraCandidateId: string;
} {
  const document = fixture();
  const candidateSet = document.artifacts.find((item) =>
    item.kind === "deletionCandidateSet" && item.id === "candidate_set_main_001",
  );
  if (!candidateSet || candidateSet.kind !== "deletionCandidateSet") {
    throw new Error("Fixture candidate set is missing");
  }
  candidateSet.candidates.push({
    id: "candidate_repeat_extra",
    target: {
      kind: "words",
      wordIds: ["word_003", "word_004"],
      sourceRange: {
        start: { value: 2000, rate: { numerator: 1000, denominator: 1 } },
        duration: { value: 1400, rate: { numerator: 1000, denominator: 1 } },
      },
    },
    reasonCodes: ["repetition"],
    decision: "definite_remove",
    risk: "low",
    confidence: 0.9,
    explanationZh: "测试用重复候选。",
  });
  return { document, extraCandidateId: "candidate_repeat_extra" };
}

describe("candidate batch acceptance", () => {
  it("accepts multiple low/medium candidates as one reversible transaction", () => {
    const { document, extraCandidateId } = batchFixture();
    const transaction = compileCandidateAcceptBatch(document, {
      candidateIds: ["candidate_filler_001", "candidate_silence_001", extraCandidateId],
      requestId: "batch_accept_001",
      actor: user,
      createdAt: clock(),
    });
    expect(transaction.transactionId).toBe("tx_review_accept_batch_batch_accept_001");
    expect(transaction.idempotencyKey).toBe("review:accept-batch:batch_accept_001");
    expect(transaction.operations.map((operation) => operation.type)).toEqual([
      "artifact.put",
      "artifact.put",
      "range.deleteRipple",
      "range.deleteRipple",
    ]);
    const batchSet = transaction.operations[0] as Extract<
      (typeof transaction.operations)[number],
      { type: "artifact.put" }
    >;
    const batchProposal = transaction.operations[1] as Extract<
      (typeof transaction.operations)[number],
      { type: "artifact.put" }
    >;
    expect(batchSet.artifact.kind).toBe("deletionCandidateSet");
    if (batchSet.artifact.kind !== "deletionCandidateSet") throw new Error("unreachable");
    expect(batchSet.artifact.candidates.map((candidate) => candidate.id)).toEqual([
      "candidate_filler_001",
      "candidate_silence_001",
      extraCandidateId,
    ]);
    expect(batchProposal.artifact.kind).toBe("editProposal");
    if (batchProposal.artifact.kind !== "editProposal") throw new Error("unreachable");
    expect(batchProposal.artifact.selectedCandidateIds).toEqual([
      "candidate_filler_001",
      "candidate_silence_001",
      extraCandidateId,
    ]);
    expect(batchProposal.artifact.estimatedRemovedDuration.value).toBe(1_700_000);

    const engine = new TransactionEngine(document, clock);
    const committed = engine.commit(transaction);
    expect(committed.document.project.revision).toBe(1);
    const restored = engine.undo(transaction.transactionId, user, "restore_batch_001");
    expect(restored.document.project.revision).toBe(2);
    expect(restored.document.sequences[0]?.tracks[0]?.clips).toHaveLength(1);
    expect(restored.document.artifacts.some((artifact) =>
      artifact.kind === "deletionCandidateSet"
      && artifact.candidates.some((candidate) => candidate.id === extraCandidateId)
      && artifact.id === batchSet.artifact.id,
    )).toBe(false);
  });

  it("rejects high-risk candidates without individual confirmation", () => {
    const { document, extraCandidateId } = batchFixture();
    const candidateSet = document.artifacts.find((item) =>
      item.kind === "deletionCandidateSet" && item.id === "candidate_set_main_001",
    )!;
    if (candidateSet.kind !== "deletionCandidateSet") throw new Error("unreachable");
    candidateSet.candidates.find((candidate) => candidate.id === extraCandidateId)!.risk = "high";
    expect(() => compileCandidateAcceptBatch(document, {
      candidateIds: ["candidate_filler_001", extraCandidateId],
      requestId: "batch_high_risk",
      actor: user,
      createdAt: clock(),
    })).toThrowError(expect.objectContaining({ code: "HIGH_RISK_CONFIRMATION_REQUIRED" }));
  });

  it("rejects candidates that are already kept and locked", () => {
    const document = fixture();
    const engine = new TransactionEngine(document, clock);
    const kept = engine.commit(compileCandidateKeep(document, {
      candidateId: "candidate_silence_001",
      requestId: "keep_before_batch",
      actor: user,
      createdAt: clock(),
    }));
    expect(() => compileCandidateAcceptBatch(kept.document, {
      candidateIds: ["candidate_filler_001", "candidate_silence_001"],
      requestId: "batch_after_keep",
      actor: user,
      createdAt: clock(),
    })).toThrowError(expect.objectContaining({ code: "CANDIDATE_ALREADY_REVIEWED" }));
  });

  it("locks overlap group members when accepting their anchor in a batch", () => {
    const document = fixture();
    const { candidateSet } = sourceAnalysis(document);
    const wordCandidate = candidateSet.candidates.find((candidate) =>
      candidate.id === "candidate_filler_001",
    )!;
    const gapCandidate = candidateSet.candidates.find((candidate) =>
      candidate.id === "candidate_silence_001",
    )!;
    if (gapCandidate.target.kind !== "gap") throw new Error("Fixture gap candidate missing");
    gapCandidate.target.nextWordId = "word_003";
    gapCandidate.target.sourceRange.duration.value = 350;
    const transaction = compileCandidateAcceptBatch(document, {
      candidateIds: [wordCandidate.id],
      requestId: "batch_overlap_anchor",
      actor: user,
      createdAt: clock(),
      resolveOverlapCandidateIds: { [wordCandidate.id]: [gapCandidate.id] },
    });
    expect(transaction.operations.at(-1)).toEqual(expect.objectContaining({
      type: "lock.add",
      lock: expect.objectContaining({
        id: candidateReviewLockId(gapCandidate.id),
        note: `agentcut:candidate_overlap_group:${wordCandidate.id}:${gapCandidate.id}`,
      }),
    }));

    const engine = new TransactionEngine(document, clock);
    const committed = engine.commit(transaction);
    expect(committed.document.sequences[0]?.locks).toHaveLength(1);
    const restored = engine.undo(transaction.transactionId, user, "restore_batch_overlap");
    expect(restored.document.sequences[0]?.locks).toHaveLength(0);
    expect(restored.document.sequences[0]?.tracks[0]?.clips).toHaveLength(1);
  });

  it("rejects a group member selected for deletion together with its anchor", () => {
    const document = fixture();
    const { candidateSet } = sourceAnalysis(document);
    const wordCandidate = candidateSet.candidates.find((candidate) =>
      candidate.id === "candidate_filler_001",
    )!;
    const gapCandidate = candidateSet.candidates.find((candidate) =>
      candidate.id === "candidate_silence_001",
    )!;
    if (gapCandidate.target.kind !== "gap") throw new Error("Fixture gap candidate missing");
    gapCandidate.target.nextWordId = "word_003";
    gapCandidate.target.sourceRange.duration.value = 350;
    expect(() => compileCandidateAcceptBatch(document, {
      candidateIds: [wordCandidate.id, gapCandidate.id],
      requestId: "batch_anchor_plus_member",
      actor: user,
      createdAt: clock(),
      resolveOverlapCandidateIds: { [wordCandidate.id]: [gapCandidate.id] },
    })).toThrowError(expect.objectContaining({ code: "INVALID_SELECTION" }));
  });

  it("rejects an overlap anchor that is not part of the selected batch", () => {
    expect(() => compileCandidateAcceptBatch(fixture(), {
      candidateIds: ["candidate_filler_001"],
      requestId: "batch_unknown_anchor",
      actor: user,
      createdAt: clock(),
      resolveOverlapCandidateIds: { candidate_silence_001: ["candidate_filler_001"] },
    })).toThrowError(expect.objectContaining({ code: "INVALID_SELECTION" }));
  });

  it("rejects empty or duplicated candidate lists", () => {
    const document = fixture();
    expect(() => compileCandidateAcceptBatch(document, {
      candidateIds: [],
      requestId: "batch_empty",
      actor: user,
      createdAt: clock(),
    })).toThrowError(expect.objectContaining({ code: "INVALID_SELECTION" }));
    expect(() => compileCandidateAcceptBatch(document, {
      candidateIds: ["candidate_filler_001", "candidate_filler_001"],
      requestId: "batch_duplicate",
      actor: user,
      createdAt: clock(),
    })).toThrowError(expect.objectContaining({ code: "INVALID_SELECTION" }));
  });

  it("rejects candidates that live in a different sequence", () => {
    const { document, extraCandidateId } = batchFixture();
    document.artifacts.push({
      id: "candidate_set_other_sequence",
      kind: "deletionCandidateSet",
      transcriptArtifactId: "transcript_main_001",
      sequenceId: "sequence_other",
      clipId: "clip_take_1",
      projectRevision: 0,
      detectorVersion: "test/0.1.0",
      candidates: [{
        id: "candidate_other_sequence",
        target: {
          kind: "words",
          wordIds: ["word_001"],
          sourceRange: {
            start: { value: 1000, rate: { numerator: 1000, denominator: 1 } },
            duration: { value: 600, rate: { numerator: 1000, denominator: 1 } },
          },
        },
        reasonCodes: ["manual"],
        decision: "definite_remove",
        risk: "low",
        confidence: 1,
        explanationZh: "测试用异序列候选。",
      }],
      provenance: {
        createdBy: { kind: "user", id: "local_user" },
        createdAt: clock(),
        reason: "测试异序列候选",
        sourceArtifactIds: ["transcript_main_001"],
      },
    });
    expect(() => compileCandidateAcceptBatch(document, {
      candidateIds: [extraCandidateId, "candidate_other_sequence"],
      requestId: "batch_cross_sequence",
      actor: user,
      createdAt: clock(),
    })).toThrowError(expect.objectContaining({ code: "INVALID_SELECTION" }));
  });
});
