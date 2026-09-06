import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createLowRiskProposal,
  detectSilences,
  generateTalkingHeadCandidates,
} from "../packages/candidate-engine/dist/index.js";
import { compileEditProposalBundle } from "../packages/edit-commands/dist/index.js";
import { ProjectStore } from "../packages/project-store/dist/index.js";
import { TALKING_HEAD_EXTENSION_VALIDATORS } from "../packages/host-extensions/dist/index.js";
import { buildTranscriptReviewProjection } from "../packages/review-projection/dist/index.js";

const [databasePath, mediaPath] = process.argv.slice(2);
if (!databasePath || !mediaPath) {
  throw new Error("Usage: node scripts/dogfood-apply-candidates.mjs <project.sqlite> <managed-media>");
}

const store = ProjectStore.open(databasePath, {
  checkpointInterval: 1,
  extensionValidators: TALKING_HEAD_EXTENSION_VALIDATORS,
});
try {
  const initial = store.snapshot();
  const transcript = [...initial.artifacts].reverse().find((artifact) => artifact.kind === "transcript");
  if (!transcript || transcript.kind !== "transcript") throw new Error("Project has no Transcript");
  const silences = detectSilences(mediaPath, { noiseDb: -40, minimumDurationSeconds: 0.5 });
  const workflow = { kind: "workflow", id: "talking_head_candidates_v1" };
  const agent = { kind: "agent", id: "codex" };

  const createBundle = (document, suffix) => {
    const generated = generateTalkingHeadCandidates({
      document,
      transcriptArtifactId: transcript.id,
      sequenceId: "sequence_main",
      clipId: "clip_real_source",
      silences,
      actor: workflow,
      createdAt: new Date().toISOString(),
    });
    const proposal = createLowRiskProposal(generated.candidateSet, {
      actor: agent,
      createdAt: new Date().toISOString(),
      reason: "Apply definite low-risk silence and filler candidates",
    });
    const transaction = compileEditProposalBundle(
      document,
      generated.candidateSet,
      proposal,
      {
        transactionId: `tx_dogfood_candidates_${suffix}`,
        idempotencyKey: `dogfood-candidates:${suffix}:${proposal.payloadHash}`,
        actor: agent,
        reason: "Apply reviewed low-risk talking-head cleanup",
      },
    );
    return { generated, proposal, transaction };
  };

  const first = createBundle(initial, "first");
  const firstCommit = store.commit(first.transaction);
  const firstRecord = firstCommit.record;
  const restored = store.undo(firstRecord.transactionId, agent, "tx_dogfood_candidates_restore");
  if (JSON.stringify(editableState(restored.document)) !== JSON.stringify(editableState(initial))) {
    throw new Error("Dogfood candidate undo did not restore the initial editable state");
  }

  const second = createBundle(restored.document, "second");
  const finalCommit = store.commit(second.transaction);
  const finalClipEndMicros = Math.max(...finalCommit.document.sequences
    .flatMap((sequence) => sequence.tracks)
    .flatMap((track) => track.clips)
    .map((clip) => {
      const start = toMicros(clip.timelineRange.start);
      const duration = toMicros(clip.timelineRange.duration);
      return start + duration;
    }));
  const review = buildTranscriptReviewProjection(
    finalCommit.document,
    store.listRecords(),
    transcript.id,
  );
  const report = {
    sourceRevision: initial.project.revision,
    silenceIntervals: silences,
    firstPass: {
      candidateReport: first.generated.report,
      selectedCandidateIds: first.proposal.selectedCandidateIds,
      estimatedRemovedDuration: first.proposal.estimatedRemovedDuration,
      committedRevision: firstCommit.document.project.revision,
      transactionId: firstRecord.transactionId,
    },
    restore: {
      committedRevision: restored.document.project.revision,
      restoredEditableState: true,
    },
    secondPass: {
      candidateReport: second.generated.report,
      selectedCandidateIds: second.proposal.selectedCandidateIds,
      estimatedRemovedDuration: second.proposal.estimatedRemovedDuration,
      committedRevision: finalCommit.document.project.revision,
      transactionId: finalCommit.record.transactionId,
      clipCount: finalCommit.document.sequences[0]?.tracks[0]?.clips.length,
      finalTimelineEndMicros: finalClipEndMicros,
    },
    review: {
      summary: review.summary,
      committedTokens: review.tokens.filter((token) => token.state === "committed_deleted"),
      committedGaps: review.gaps.filter((gap) => gap.state === "committed_deleted"),
      candidateTokens: review.tokens.filter((token) => token.state === "candidate_remove"),
      candidateGaps: review.gaps.filter((gap) => gap.state === "candidate_remove"),
    },
    verification: store.verify(),
  };
  const reportPath = join(dirname(databasePath), "candidate-apply-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}

function editableState(document) {
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

function toMicros(time) {
  return Math.round(time.value * time.rate.denominator * 1_000_000 / time.rate.numerator);
}
