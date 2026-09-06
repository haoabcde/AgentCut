import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { normalizeAsrResult } from "../packages/asr-engine/dist/index.js";
import { ingestMedia, requireAudioStream } from "../packages/media-ingest/dist/index.js";
import { ProjectStore } from "../packages/project-store/dist/index.js";
import { TALKING_HEAD_EXTENSION_VALIDATORS } from "../packages/host-extensions/dist/index.js";
import { assertProjectDocument } from "../packages/timeline-schema/dist/index.js";

const [sourcePath, rawAsrPath, outputDirectory] = process.argv.slice(2);
if (!sourcePath || !rawAsrPath || !outputDirectory) {
  throw new Error("Usage: node scripts/dogfood-ingest-asr.mjs <source-media> <raw-asr-json> <output-directory>");
}

mkdirSync(outputDirectory, { recursive: true });
const databasePath = join(outputDirectory, "agentcut.sqlite");
if (existsSync(databasePath)) {
  throw new Error(`Refusing to overwrite existing dogfood project ${databasePath}`);
}

const createdAt = new Date().toISOString();
const user = { kind: "user", id: "local_user" };
const workflow = { kind: "workflow", id: "p1_dogfood_asr" };
const ingested = await ingestMedia({
  sourcePath,
  mediaDirectory: join(outputDirectory, "media"),
  actor: user,
  reason: "P1 real-media dogfood import",
  clock: () => createdAt,
});
const videoStream = ingested.probe.streams.find((stream) => stream.type === "video");
const audioStream = requireAudioStream(ingested.probe);
if (!videoStream?.video) throw new Error("Dogfood source must contain video");
const clipDuration = videoStream.duration ?? ingested.probe.duration;
const rawResult = JSON.parse(readFileSync(rawAsrPath, "utf8"));
const artifactsDirectory = join(outputDirectory, "artifacts");
mkdirSync(artifactsDirectory, { recursive: true });
copyFileSync(rawAsrPath, join(artifactsDirectory, basename(rawAsrPath)));
const normalized = normalizeAsrResult({
  asset: ingested.asset,
  audioStreamIndex: audioStream.index,
  rawResult,
  rawResultUri: `artifacts/${basename(rawAsrPath)}`,
  provider: "mlx-whisper",
  model: rawResult.agentcut_provider?.model ?? "unknown",
  providerVersion: rawResult.agentcut_provider?.version ?? "unknown",
  actor: workflow,
  createdAt,
  streamDuration: audioStream.duration ?? ingested.probe.duration,
});

const project = {
  schemaVersion: "0.1.0",
  project: {
    id: "project_p1_real_dogfood",
    name: "P1 真实中文口播 Dogfood",
    createdAt,
    updatedAt: createdAt,
    activeSequenceId: "sequence_main",
    revision: 0,
  },
  assets: [],
  sequences: [{
    id: "sequence_main",
    name: "真实素材主序列",
    canvas: {
      width: videoStream.video.width,
      height: videoStream.video.height,
      background: "#000000",
    },
    frameRate: videoStream.video.nominalFrameRate,
    tracks: [{
      id: "track_v1",
      kind: "video",
      name: "主画面",
      order: 0,
      locked: false,
      enabled: true,
      clips: [],
      transitions: [],
    }],
    locks: [],
    markers: [],
  }],
  styleSpecs: [],
  artifacts: [],
  exportPresets: [],
  versions: [],
  history: { headRevision: 0, records: [] },
};
assertProjectDocument(project, { extensionValidators: TALKING_HEAD_EXTENSION_VALIDATORS });
const store = ProjectStore.create(databasePath, project, {
  checkpointInterval: 1,
  extensionValidators: TALKING_HEAD_EXTENSION_VALIDATORS,
});
try {
  store.commit({
    protocolVersion: "0.1.0",
    transactionId: "tx_dogfood_import",
    idempotencyKey: `dogfood-import:${ingested.asset.contentHash}`,
    projectId: project.project.id,
    sequenceId: "sequence_main",
    baseRevision: 0,
    actor: user,
    reason: "Register immutable real media and main clip",
    preconditions: [],
    operations: [
      { type: "asset.put", asset: ingested.asset },
      {
        type: "clip.insert",
        trackId: "track_v1",
        clip: {
          id: "clip_real_source",
          kind: "media",
          assetId: ingested.asset.id,
          streamIndex: videoStream.index,
          timelineRange: {
            start: { value: 0, rate: clipDuration.rate },
            duration: clipDuration,
          },
          sourceRange: {
            start: { value: 0, rate: clipDuration.rate },
            duration: clipDuration,
          },
          enabled: true,
          provenance: {
            createdBy: user,
            createdAt,
            reason: "Create full-length source clip",
          },
        },
      },
    ],
  });
  store.createJob({
    id: "job_dogfood_asr",
    type: "asr.transcribe",
    payload: {
      assetId: ingested.asset.id,
      audioStreamIndex: audioStream.index,
      provider: normalized.providerArtifact.provider,
      model: normalized.providerArtifact.model,
    },
    maxAttempts: 2,
  });
  store.startJob("job_dogfood_asr");
  store.updateJobProgress("job_dogfood_asr", 0.95, { stage: "normalizing" });
  store.commit({
    protocolVersion: "0.1.0",
    transactionId: "tx_dogfood_transcript",
    idempotencyKey: `dogfood-transcript:${normalized.providerArtifact.payloadHash}`,
    projectId: project.project.id,
    sequenceId: "sequence_main",
    baseRevision: 1,
    actor: workflow,
    reason: "Persist raw ASR provenance and normalized stable Transcript",
    preconditions: [
      { type: "asset_online", assetId: ingested.asset.id },
      { type: "object_exists", objectId: "clip_real_source" },
    ],
    operations: [
      { type: "artifact.put", artifact: normalized.providerArtifact },
      { type: "artifact.put", artifact: normalized.transcript },
    ],
  });
  const job = store.succeedJob("job_dogfood_asr", [
    normalized.providerArtifact.id,
    normalized.transcript.id,
  ]);
  const verification = store.verify();
  const report = {
    databasePath,
    managedMediaPath: ingested.managedPath,
    asset: ingested.asset,
    probe: ingested.probe,
    providerArtifact: normalized.providerArtifact,
    transcript: {
      id: normalized.transcript.id,
      language: normalized.transcript.language,
      wordCount: normalized.transcript.words.length,
      firstWords: normalized.transcript.words.slice(0, 30),
      lastWord: normalized.transcript.words.at(-1),
    },
    quality: normalized.quality,
    job,
    jobEvents: store.listJobEvents(job.id),
    verification,
  };
  writeFileSync(join(outputDirectory, "dogfood-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}
