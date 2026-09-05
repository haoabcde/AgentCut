import { readFileSync } from "node:fs";
import {
  assertProjectDocument,
  type Actor,
  type AgentCutProjectDocument,
  type EditProposalArtifact,
} from "@agentcut/timeline-schema";
import { describe, expect, it } from "vitest";
import { TransactionEngine } from "./engine.js";
import { EditError } from "./errors.js";
import {
  compileEditProposal,
  compileEditProposalBundle,
  computeEditProposalPayloadHash,
} from "./proposal.js";

const user: Actor = { kind: "user", id: "local_user" };
const fixedClock = () => "2026-07-17T09:00:00Z";

function fixture(): AgentCutProjectDocument {
  const fixtureUrl = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  assertProjectDocument(value);
  return structuredClone(value);
}

function proposal(document: AgentCutProjectDocument): EditProposalArtifact {
  const artifact = document.artifacts.find((candidate) => candidate.kind === "editProposal");
  if (!artifact || artifact.kind !== "editProposal") throw new Error("Fixture proposal is missing");
  return structuredClone(artifact);
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

describe("edit proposal compiler", () => {
  it("compiles a revision-bound candidate into a snapped ripple transaction", () => {
    const document = fixture();
    const compiled = compileEditProposal(document, proposal(document), {
      transactionId: "tx_apply_proposal",
      idempotencyKey: "apply-proposal",
      actor: user,
    });

    expect(compiled).toEqual(expect.objectContaining({
      projectId: "project_demo_001",
      sequenceId: "sequence_main",
      baseRevision: 0,
      operations: [{
        type: "range.deleteRipple",
        range: {
          start: { value: 21, rate: { numerator: 30_000, denominator: 1_001 } },
          duration: { value: 6, rate: { numerator: 30_000, denominator: 1_001 } },
        },
        trackIds: ["track_v1"],
        proposalId: "proposal_main_001",
        rightClipIds: { clip_take_1: "clip_take_1__proposal_main_001__right_1" },
      }],
    }));

    const engine = new TransactionEngine(document, fixedClock);
    const committed = engine.commit(compiled);
    const clips = committed.document.sequences[0]?.tracks[0]?.clips;
    expect(clips?.map((clip) => clip.id)).toEqual([
      "clip_take_1",
      "clip_take_1__proposal_main_001__right_1",
    ]);
    expect(clips?.[0]?.timelineRange.duration.value).toBe(21);
    expect(clips?.[1]?.timelineRange.start.value).toBe(21);
    expect(clips?.[1]?.sourceRange?.start.value).toBe(57);
    expect(clips?.[1]?.sourceRange?.duration.value).toBe(273);
  });

  it("merges adjacent selected candidate ranges before compilation", () => {
    const document = fixture();
    const selected = proposal(document);
    selected.selectedCandidateIds = ["candidate_silence_001", "candidate_filler_001"];
    selected.estimatedRemovedDuration.value = 300;
    selected.payloadHash = computeEditProposalPayloadHash(selected);

    const compiled = compileEditProposal(document, selected, {
      transactionId: "tx_merge_candidates",
      idempotencyKey: "merge-candidates",
      actor: user,
    });
    expect(compiled.operations).toHaveLength(1);
    expect(compiled.operations[0]).toEqual(expect.objectContaining({
      type: "range.deleteRipple",
      range: {
        start: { value: 18, rate: { numerator: 30_000, denominator: 1_001 } },
        duration: { value: 9, rate: { numerator: 30_000, denominator: 1_001 } },
      },
    }));
  });

  it("compiles disjoint candidates from right to left so earlier time remains stable", () => {
    const document = fixture();
    const candidateSet = document.artifacts.find(
      (artifact) => artifact.kind === "deletionCandidateSet",
    );
    if (!candidateSet || candidateSet.kind !== "deletionCandidateSet") {
      throw new Error("Fixture candidate set is missing");
    }
    candidateSet.candidates.push({
      id: "candidate_word_003",
      target: {
        kind: "words",
        wordIds: ["word_003"],
        sourceRange: {
          start: { value: 2_000, rate: { numerator: 1_000, denominator: 1 } },
          duration: { value: 400, rate: { numerator: 1_000, denominator: 1 } },
        },
      },
      reasonCodes: ["manual"],
      decision: "suggest_remove",
      risk: "medium",
      confidence: 1,
      explanationZh: "测试右到左编译。",
    });
    const selected = proposal(document);
    selected.selectedCandidateIds = ["candidate_filler_001", "candidate_word_003"];
    selected.estimatedRemovedDuration.value = 600;
    selected.payloadHash = computeEditProposalPayloadHash(selected);

    const compiled = compileEditProposal(document, selected, {
      transactionId: "tx_disjoint_candidates",
      idempotencyKey: "disjoint-candidates",
      actor: user,
    });
    expect(compiled.operations).toHaveLength(2);
    expect(compiled.operations.map((operation) => operation.type === "range.deleteRipple"
      ? operation.range.start.value
      : -1)).toEqual([30, 21]);

    const engine = new TransactionEngine(document, fixedClock);
    const committed = engine.commit(compiled);
    expect(committed.document.sequences[0]?.tracks[0]?.clips).toHaveLength(3);
  });

  it("bounds generated clip IDs after repeated ripple-edit lineage growth", () => {
    const document = fixture();
    const clip = document.sequences[0]?.tracks[0]?.clips[0];
    const candidateSet = document.artifacts.find(
      (artifact) => artifact.kind === "deletionCandidateSet",
    );
    if (!clip || !candidateSet || candidateSet.kind !== "deletionCandidateSet") {
      throw new Error("Fixture clip or candidate set is missing");
    }
    const longClipId = `clip_real_source__${"proposal_review_right__".repeat(7)}`;
    expect(longClipId.length).toBeGreaterThan(160);
    expect(longClipId.length).toBeLessThanOrEqual(200);
    clip.id = longClipId;
    candidateSet.clipId = longClipId;
    assertProjectDocument(document);

    const compiled = compileEditProposal(document, proposal(document), {
      transactionId: "tx_long_lineage",
      idempotencyKey: "long-lineage",
      actor: user,
    });
    const operation = compiled.operations[0];
    if (!operation || operation.type !== "range.deleteRipple") {
      throw new Error("Expected one ripple deletion");
    }
    const rightClipId = operation.rightClipIds?.[longClipId];
    expect(rightClipId).toMatch(/^clip_split_[0-9a-f]{32}_1$/);
    expect(rightClipId?.length).toBeLessThanOrEqual(200);

    const repeated = compileEditProposal(document, proposal(document), {
      transactionId: "tx_long_lineage_repeated",
      idempotencyKey: "long-lineage-repeated",
      actor: user,
    });
    const repeatedOperation = repeated.operations[0];
    expect(repeatedOperation?.type === "range.deleteRipple"
      ? repeatedOperation.rightClipIds?.[longClipId]
      : undefined).toBe(rightClipId);

    const committed = new TransactionEngine(document, fixedClock).commit(compiled);
    assertProjectDocument(committed.document);
    expect(committed.document.sequences[0]?.tracks[0]?.clips[1]?.id).toBe(rightClipId);
  });

  it("rejects payload tampering and stale proposal revisions", () => {
    const document = fixture();
    const tampered = proposal(document);
    tampered.selectedCandidateIds = ["candidate_silence_001"];
    expect(() => compileEditProposal(document, tampered, {
      transactionId: "tx_tampered",
      idempotencyKey: "tampered",
      actor: user,
    })).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));

    const stale = proposal(document);
    stale.projectRevision = 1;
    stale.payloadHash = computeEditProposalPayloadHash(stale);
    expect(() => compileEditProposal(document, stale, {
      transactionId: "tx_stale",
      idempotencyKey: "stale",
      actor: user,
    })).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
  });

  it("uses typed edit errors for compiler failures", () => {
    const document = fixture();
    const invalid = proposal(document);
    invalid.candidateSetArtifactId = "candidate_set_missing";
    invalid.payloadHash = computeEditProposalPayloadHash(invalid);
    expect(() => compileEditProposal(document, invalid, {
      transactionId: "tx_missing_set",
      idempotencyKey: "missing-set",
      actor: user,
    })).toThrowError(EditError);
  });

  it("publishes candidate set, proposal, and ripple edit in one bound revision", () => {
    const original = fixture();
    const candidateSet = original.artifacts.find(
      (artifact) => artifact.kind === "deletionCandidateSet",
    );
    const selectedProposal = proposal(original);
    if (!candidateSet || candidateSet.kind !== "deletionCandidateSet") {
      throw new Error("Fixture candidate set is missing");
    }
    const document = structuredClone(original);
    document.artifacts = document.artifacts.filter((artifact) =>
      artifact.kind !== "deletionCandidateSet" && artifact.kind !== "editProposal",
    );
    const compiled = compileEditProposalBundle(document, candidateSet, selectedProposal, {
      transactionId: "tx_analysis_bundle",
      idempotencyKey: "analysis-bundle",
      actor: user,
    });
    expect(compiled.operations.slice(0, 2).map((operation) => operation.type)).toEqual([
      "artifact.put",
      "artifact.put",
    ]);
    expect(compiled.preconditions).not.toContainEqual({
      type: "object_exists",
      objectId: candidateSet.id,
    });

    const engine = new TransactionEngine(document, fixedClock);
    const committed = engine.commit(compiled);
    expect(committed.document.project.revision).toBe(1);
    expect(committed.document.artifacts.map((artifact) => artifact.id)).toEqual(expect.arrayContaining([
      candidateSet.id,
      selectedProposal.id,
    ]));
    expect(committed.document.sequences[0]?.tracks[0]?.clips).toHaveLength(2);
    const undone = engine.undo("tx_analysis_bundle", user, "tx_undo_analysis_bundle");
    expect(editableState(undone.document)).toEqual(editableState(document));
  });
});
