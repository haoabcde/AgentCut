import { readFileSync } from "node:fs";
import { TransactionEngine, compileEditProposalBundle } from "@agentcut/edit-commands";
import {
  assertProjectDocument,
  type Actor,
  type AgentCutProjectDocument,
  type CandidateSetArtifact,
  type EditProposalArtifact,
} from "@agentcut/timeline-schema";
import { describe, expect, it } from "vitest";
import { AlphaAuditError, createAlphaAuditDraft } from "./audit.js";

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

function commitFixture(actor: Actor, mutate?: (candidateSet: CandidateSetArtifact) => void) {
  const source = fixture();
  const { candidateSet, proposal } = analysis(source);
  mutate?.(candidateSet);
  source.artifacts = source.artifacts.filter((artifact) =>
    artifact.kind !== "deletionCandidateSet" && artifact.kind !== "editProposal",
  );
  const engine = new TransactionEngine(source, () => "2026-07-31T02:00:00Z");
  const transaction = compileEditProposalBundle(source, candidateSet, proposal, {
    transactionId: "tx_audit_commit",
    idempotencyKey: "audit-commit",
    actor,
  });
  return engine.commit(transaction);
}

describe("Alpha project audit draft", () => {
  it("extracts auditable candidate rows and actual Timeline source discontinuities", () => {
    const committed = commitFixture({ kind: "user", id: "reviewer" });

    const draft = createAlphaAuditDraft(committed.document, [committed.record]);

    expect(draft).toEqual(expect.objectContaining({
      schemaVersion: "1.0",
      project: {
        id: "project_demo_001",
        name: "中文口播技术验证",
        revision: 1,
        sequenceId: "sequence_main",
        transcriptId: "transcript_main_001",
        sourceAssetId: "asset_camera_a",
        sourceSha256: `sha256:${"a".repeat(64)}`,
      },
      review: {
        completed: false,
        pendingCandidateIds: ["candidate_silence_001"],
      },
      derived: {
        definiteRemovePredicted: 1,
        definiteRemoveCommitted: 1,
        highRiskAutoDeletedCandidateIds: [],
        firstHumanDecisionRevision: 1,
      },
      export: null,
    }));
    expect(draft.candidates).toContainEqual(expect.objectContaining({
      candidateId: "candidate_filler_001",
      decision: "definite_remove",
      risk: "low",
      text: "嗯",
      state: "committed_deleted",
      transactionId: "tx_audit_commit",
      committedBy: { kind: "user", id: "reviewer" },
      humanLabel: null,
      humanNote: null,
    }));
    expect(draft.boundaries).toEqual([expect.objectContaining({
      boundaryId: "boundary_asset_camera_a_1701700_1901900",
      assetId: "asset_camera_a",
      leftSourceEndMicros: 1_701_700,
      rightSourceStartMicros: 1_901_900,
      removedDurationMicros: 200_200,
      candidateIds: ["candidate_filler_001"],
      humanUsable: null,
      humanIssueCodes: [],
      humanNote: null,
    })]);
  });

  it("flags a workflow-committed high-risk candidate without inventing a human label", () => {
    const committed = commitFixture(
      { kind: "workflow", id: "unsafe_auto_editor" },
      (candidateSet) => {
        candidateSet.candidates[0]!.risk = "high";
        candidateSet.candidates[0]!.decision = "suggest_remove";
      },
    );

    const draft = createAlphaAuditDraft(committed.document, [committed.record]);

    expect(draft.derived.highRiskAutoDeletedCandidateIds).toEqual(["candidate_filler_001"]);
    expect(draft.derived.firstHumanDecisionRevision).toBeNull();
    expect(draft.candidates.find((candidate) => candidate.candidateId === "candidate_filler_001"))
      .toEqual(expect.objectContaining({
        risk: "high",
        committedBy: { kind: "workflow", id: "unsafe_auto_editor" },
        humanLabel: null,
      }));
  });

  it("treats a user restore of an automated deletion as the first human content decision", () => {
    const automated = commitFixture({ kind: "workflow", id: "low_risk_auto_editor" });
    const engine = new TransactionEngine(automated.document, () => "2026-07-31T02:05:00Z");
    const restored = engine.commit({
      protocolVersion: "0.1.0",
      transactionId: "tx_restore_alpha_audit",
      idempotencyKey: "restore:alpha-audit",
      projectId: automated.record.projectId,
      sequenceId: automated.record.request.sequenceId,
      baseRevision: automated.document.project.revision,
      actor: { kind: "user", id: "reviewer" },
      reason: `Restore ${automated.record.transactionId} from Transcript review`,
      preconditions: [],
      operations: structuredClone(automated.record.inverseOperations),
    });

    const draft = createAlphaAuditDraft(restored.document, [automated.record, restored.record]);

    expect(draft.derived.firstHumanDecisionRevision).toBe(2);
  });

  it("rejects a project without exactly one transcript-bound source", () => {
    const document = fixture();
    document.artifacts = document.artifacts.filter((artifact) => artifact.kind !== "transcript");

    expect(() => createAlphaAuditDraft(document, [])).toThrowError(new AlphaAuditError(
      "TRANSCRIPT_MISSING",
      "Alpha audit requires exactly one Transcript artifact; found 0",
    ));
  });
});
