import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  detectSilences,
  generateTalkingHeadCandidates,
} from "../packages/candidate-engine/dist/index.js";
import { ProjectStore } from "../packages/project-store/dist/index.js";
import { TALKING_HEAD_EXTENSION_VALIDATORS } from "../packages/host-extensions/dist/index.js";
import { buildTranscriptReviewProjection } from "../packages/review-projection/dist/index.js";

const [databasePath, mediaPath] = process.argv.slice(2);
if (!databasePath || !mediaPath) {
  throw new Error("Usage: node scripts/dogfood-analyze-candidates.mjs <project.sqlite> <managed-media>");
}

const store = ProjectStore.open(databasePath, {
  checkpointInterval: 1,
  extensionValidators: TALKING_HEAD_EXTENSION_VALIDATORS,
});
try {
  const document = store.snapshot();
  const transcript = [...document.artifacts].reverse().find((artifact) =>
    artifact.kind === "transcript",
  );
  if (!transcript || transcript.kind !== "transcript") throw new Error("Project has no Transcript");
  const sequence = document.sequences.find((item) => item.id === document.project.activeSequenceId);
  const clip = sequence?.tracks.flatMap((track) => track.clips).find((item) =>
    item.assetId === transcript.assetId,
  );
  if (!sequence || !clip) throw new Error("Transcript source clip is unavailable");
  const silences = detectSilences(mediaPath, { noiseDb: -40, minimumDurationSeconds: 0.5 });
  const generated = generateTalkingHeadCandidates({
    document,
    transcriptArtifactId: transcript.id,
    sequenceId: sequence.id,
    clipId: clip.id,
    silences,
    actor: { kind: "workflow", id: "talking_head_candidates_v1" },
    createdAt: new Date().toISOString(),
  });
  const transactionId = `tx_candidate_analysis_${generated.candidateSet.id}`;
  store.commit({
    protocolVersion: "0.1.0",
    transactionId,
    idempotencyKey: `candidate-analysis:${generated.candidateSet.id}`,
    projectId: document.project.id,
    sequenceId: sequence.id,
    baseRevision: document.project.revision,
    actor: { kind: "workflow", id: "talking_head_candidates_v1" },
    reason: "Persist conservative talking-head candidates for review",
    preconditions: [
      { type: "asset_online", assetId: transcript.assetId },
      { type: "object_exists", objectId: clip.id },
    ],
    operations: [{ type: "artifact.put", artifact: generated.candidateSet }],
  });
  const snapshot = store.snapshot();
  const projection = buildTranscriptReviewProjection(snapshot, store.listRecords(), transcript.id);
  const report = {
    sourceRevision: document.project.revision,
    committedRevision: snapshot.project.revision,
    silenceIntervals: silences,
    candidateReport: generated.report,
    candidates: generated.candidateSet.candidates,
    reviewSummary: projection.summary,
    verification: store.verify(),
  };
  writeFileSync(
    join(dirname(databasePath), "candidate-analysis-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}
