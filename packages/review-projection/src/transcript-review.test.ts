import { readFileSync } from "node:fs";
import { TransactionEngine, compileEditProposalBundle } from "@agentcut/edit-commands";
import { compileCandidateKeep } from "@agentcut/candidate-engine";
import {
  assertProjectDocument,
  type Actor,
  type AgentCutProjectDocument,
  type CandidateSetArtifact,
  type EditProposalArtifact,
} from "@agentcut/timeline-schema";
import { describe, expect, it } from "vitest";
import { buildTranscriptReviewProjection } from "./transcript-review.js";

const user: Actor = { kind: "user", id: "local_user" };

function fixture(): AgentCutProjectDocument {
  const url = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(url, "utf8"));
  assertProjectDocument(value);
  return structuredClone(value);
}

function analysis(document: AgentCutProjectDocument): {
  candidateSet: CandidateSetArtifact;
  proposal: EditProposalArtifact;
} {
  const candidateSet = document.artifacts.find((artifact) => artifact.kind === "deletionCandidateSet");
  const proposal = document.artifacts.find((artifact) => artifact.kind === "editProposal");
  if (!candidateSet || candidateSet.kind !== "deletionCandidateSet"
    || !proposal || proposal.kind !== "editProposal") {
    throw new Error("Fixture analysis artifacts are missing");
  }
  return { candidateSet, proposal };
}

describe("Transcript review projection", () => {
  it("does not use strikethrough until a proposal is committed", () => {
    const document = fixture();
    const projection = buildTranscriptReviewProjection(document, [], "transcript_main_001");
    const filler = projection.tokens.find((token) => token.wordId === "word_002");
    expect(filler).toEqual(expect.objectContaining({
      state: "candidate_remove",
      decoration: "candidate_background",
      restorable: false,
    }));
    expect(projection.summary.deletedTokens).toBe(0);
    expect(projection.candidates.find((candidate) => candidate.candidateId === "candidate_filler_001"))
      .toEqual(expect.objectContaining({
        targetKind: "words",
        wordIds: ["word_002"],
        sourceRange: analysis(document).candidateSet.candidates[0]!.target.sourceRange,
      }));
  });

  it("projects committed word deletion as strikethrough with its restore transaction", () => {
    const source = fixture();
    const { candidateSet, proposal } = analysis(source);
    source.artifacts = source.artifacts.filter((artifact) =>
      artifact.kind !== "deletionCandidateSet" && artifact.kind !== "editProposal",
    );
    const engine = new TransactionEngine(source, () => "2026-07-18T08:00:00Z");
    const transaction = compileEditProposalBundle(source, candidateSet, proposal, {
      transactionId: "tx_review_commit",
      idempotencyKey: "review-commit",
      actor: user,
    });
    const committed = engine.commit(transaction);
    const projection = buildTranscriptReviewProjection(
      committed.document,
      [committed.record],
      "transcript_main_001",
    );
    expect(projection.tokens.find((token) => token.wordId === "word_002")).toEqual(
      expect.objectContaining({
        state: "committed_deleted",
        decoration: "strikethrough",
        transactionId: "tx_review_commit",
        restorable: true,
      }),
    );
    expect(projection.summary.deletedTokens).toBe(1);

    const undone = engine.undo("tx_review_commit", user, "tx_review_restore");
    const restoredProjection = buildTranscriptReviewProjection(
      undone.document,
      [committed.record, undone.record],
      "transcript_main_001",
    );
    expect(restoredProjection.tokens.every((token) => token.state === "normal")).toBe(true);
  });

  it("projects a kept candidate as reviewed and source-locked", () => {
    const source = fixture();
    const engine = new TransactionEngine(source, () => "2026-07-18T08:00:00Z");
    const kept = engine.commit(compileCandidateKeep(source, {
      candidateId: "candidate_silence_001",
      requestId: "projection_keep_001",
      actor: user,
      createdAt: "2026-07-18T08:00:00Z",
    }));
    const projection = buildTranscriptReviewProjection(
      kept.document,
      [kept.record],
      "transcript_main_001",
    );
    expect(projection.gaps.find((gap) => gap.candidateId === "candidate_silence_001")).toEqual(
      expect.objectContaining({
        state: "reviewed_keep",
        decoration: "kept_gap",
        lockId: expect.stringMatching(/^lock_candidate_keep_/),
      }),
    );
    expect(projection.summary).toEqual(expect.objectContaining({
      candidateGaps: 0,
      reviewedKeepGaps: 1,
    }));
    expect(projection.candidates.find((candidate) =>
      candidate.candidateId === "candidate_silence_001",
    )).toEqual(expect.objectContaining({
      state: "reviewed_keep",
      lockId: expect.stringMatching(/^lock_candidate_keep_/),
    }));
  });

  it("uses newest equal-state metadata consistently in the inspector and tokens", () => {
    const document = fixture();
    const { candidateSet } = analysis(document);
    const updatedSet = structuredClone(candidateSet);
    updatedSet.id = "candidate_set_updated_risk";
    updatedSet.detectorVersion = "talking-head-mechanical/0.2.0";
    const updatedCandidate = updatedSet.candidates.find((candidate) =>
      candidate.id === "candidate_filler_001",
    );
    if (!updatedCandidate) throw new Error("Fixture filler candidate missing");
    updatedCandidate.risk = "high";
    updatedCandidate.confidence = 0.4;
    updatedCandidate.explanationZh = "低置信度候选，必须试听确认。";
    document.artifacts.push(updatedSet);

    const projection = buildTranscriptReviewProjection(document, [], "transcript_main_001");
    expect(projection.candidates.find((candidate) =>
      candidate.candidateId === "candidate_filler_001",
    )).toEqual(expect.objectContaining({
      risk: "high",
      confidence: 0.4,
      explanationZh: "低置信度候选，必须试听确认。",
    }));
    expect(projection.tokens.find((token) => token.wordId === "word_002")).toEqual(
      expect.objectContaining({
        risk: "high",
        confidence: 0.4,
        explanationZh: "低置信度候选，必须试听确认。",
      }),
    );
  });

  it("projects retained comparison evidence as stable words, range, and display text", () => {
    const document = fixture();
    const { candidateSet } = analysis(document);
    const candidate = candidateSet.candidates.find((item) => item.id === "candidate_filler_001");
    if (!candidate) throw new Error("Fixture filler candidate missing");
    candidate.reasonCodes = ["restatement"];
    candidate.evidence = [{
      role: "retained_comparison",
      target: {
        kind: "words",
        wordIds: ["word_003", "word_004"],
        sourceRange: {
          start: { value: 2_000, rate: { numerator: 1_000, denominator: 1 } },
          duration: { value: 1_400, rate: { numerator: 1_000, denominator: 1 } },
        },
      },
    }];

    const projection = buildTranscriptReviewProjection(document, [], "transcript_main_001");
    expect(projection.candidates.find((item) => item.candidateId === candidate.id)?.evidence)
      .toEqual([{
        role: "retained_comparison",
        wordIds: ["word_003", "word_004"],
        sourceRange: candidate.evidence[0]!.target.sourceRange,
        text: "今天我们聊聊 Agent",
      }]);
    expect(projection.candidates.find((item) => item.candidateId === candidate.id)?.evidenceStatus)
      .toBe("structured");
  });

  it("marks historical repetition candidates whose retained evidence was never persisted", () => {
    const document = fixture();
    const { candidateSet } = analysis(document);
    const candidate = candidateSet.candidates.find((item) => item.id === "candidate_filler_001");
    if (!candidate) throw new Error("Fixture filler candidate missing");
    candidate.reasonCodes = ["repetition"];

    const projection = buildTranscriptReviewProjection(document, [], "transcript_main_001");
    const projected = projection.candidates.find((item) => item.candidateId === candidate.id);
    expect(projected?.evidenceStatus).toBe("legacy_missing");
    expect(projected?.evidence).toBeUndefined();
  });

  it("groups overlapping pending candidates behind the higher-risk word decision", () => {
    const document = fixture();
    const { candidateSet } = analysis(document);
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

    const projection = buildTranscriptReviewProjection(document, [], "transcript_main_001");
    expect(projection.candidates.find((candidate) =>
      candidate.candidateId === wordCandidate.id,
    )).toEqual(expect.objectContaining({
      overlapDecisionAnchorId: wordCandidate.id,
      overlapCandidateIds: [gapCandidate.id],
    }));
    expect(projection.candidates.find((candidate) =>
      candidate.candidateId === gapCandidate.id,
    )).toEqual(expect.objectContaining({
      overlapDecisionAnchorId: wordCandidate.id,
      overlapCandidateIds: [wordCandidate.id],
    }));
  });
});
