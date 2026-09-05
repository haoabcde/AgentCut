import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { runPersistedAsrJob, type PersistedAsrJobOptions } from "@agentcut/asr-engine";
import {
  ensureBrowserPreviewProxy,
  hashFile,
  ingestMedia,
  isBrowserPlaybackCompatible,
  probeMedia,
  requireAudioStream,
  type IngestedMedia,
  type MediaProbe,
} from "@agentcut/media-ingest";
import { ProjectStore, type ProjectJob } from "@agentcut/project-store";
import {
  assertProjectDocument,
  createAlphaTrialEnrollment,
  findPreviewProxyAsset,
  readAlphaTrialEnrollment,
  type AgentCutProjectDocument,
  type Asset,
  type Rate,
} from "@agentcut/timeline-schema";

export type ProjectResumeState = "complete" | "transcription_required";

export interface InitialProjectOptions {
  projectId: string;
  name: string;
  createdAt: string;
  width: number;
  height: number;
  frameRate: Rate;
  alphaTrial?: boolean;
}

export interface CreateRoughCutProjectOptions {
  sourcePath: string;
  projectRoot: string;
  name?: string;
  model?: string;
  pythonPath: string;
  workerScriptPath: string;
  ffprobePath?: string;
  ffmpegPath?: string;
  asrRun?: NonNullable<PersistedAsrJobOptions["run"]>;
  clock?: () => string;
  alphaTrial?: boolean;
}

export interface CreateRoughCutProjectResult {
  databasePath: string;
  projectRoot: string;
  sourceHash: string;
  projectId: string;
  projectRevision: number;
  transcriptArtifactId: string;
  resumed: boolean;
  alphaTrial: boolean;
  playbackAssetId: string;
  playbackKind: "source" | "proxy";
}

export class RoughCutWorkflowError extends Error {
  constructor(
    readonly code: "PROJECT_SOURCE_CONFLICT" | "PROJECT_RESUME_UNSAFE" | "PROJECT_TRIAL_CONFLICT" | "VIDEO_STREAM_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "RoughCutWorkflowError";
  }
}

export function buildInitialRoughCutProject(options: InitialProjectOptions): AgentCutProjectDocument {
  const document: AgentCutProjectDocument = {
    schemaVersion: "0.1.0",
    project: {
      id: options.projectId,
      name: options.name,
      createdAt: options.createdAt,
      updatedAt: options.createdAt,
      activeSequenceId: "sequence_main",
      revision: 0,
    },
    assets: [],
    sequences: [{
      id: "sequence_main",
      name: "口播主序列",
      canvas: { width: options.width, height: options.height, background: "#000000" },
      frameRate: structuredClone(options.frameRate),
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
    ...(options.alphaTrial ? {
      extensions: {
        "agentcut.alphaTrial": createAlphaTrialEnrollment(options.createdAt),
      },
    } : {}),
  };
  assertProjectDocument(document);
  return document;
}

export function assessProjectResume(
  document: AgentCutProjectDocument,
  sourceHash: string,
): ProjectResumeState {
  const matchingAsset = document.assets.find((asset) =>
    asset.kind === "video" && asset.contentHash === sourceHash,
  );
  if (!matchingAsset) {
    throw new RoughCutWorkflowError(
      "PROJECT_SOURCE_CONFLICT",
      "Existing AgentCut project belongs to different source media; refusing to overwrite it",
    );
  }
  return document.artifacts.some((artifact) =>
    artifact.kind === "transcript" && artifact.assetId === matchingAsset.id,
  ) ? "complete" : "transcription_required";
}

export function assertAlphaTrialResumeMode(
  document: AgentCutProjectDocument,
  requested: boolean,
): void {
  const existing = readAlphaTrialEnrollment(document) !== null;
  if (existing === requested) return;
  throw new RoughCutWorkflowError(
    "PROJECT_TRIAL_CONFLICT",
    existing
      ? "Existing project is a formal Alpha trial; rerun with --alpha-trial"
      : "Existing project is not a formal Alpha trial; create a new project directory for formal evidence",
  );
}

export async function createRoughCutProject(
  options: CreateRoughCutProjectOptions,
): Promise<CreateRoughCutProjectResult> {
  const sourcePath = resolve(options.sourcePath);
  const projectRoot = resolve(options.projectRoot);
  const databasePath = join(projectRoot, "agentcut.sqlite");
  const sourceHash = await hashFile(sourcePath);
  let resumed = false;
  let store: ProjectStore;
  let asset: IngestedMedia["asset"];
  let sourceProbe: MediaProbe;
  let previewProxyAsset: Asset | undefined;
  let audioStreamIndex: number;
  let audioDuration: ReturnType<typeof requireAudioStream>["duration"];

  if (existsSync(databasePath)) {
    resumed = true;
    store = ProjectStore.open(databasePath);
    const document = store.snapshot();
    try {
      assertAlphaTrialResumeMode(document, options.alphaTrial === true);
    } catch (error) {
      store.close();
      throw error;
    }
    const resumeState = assessProjectResume(document, sourceHash);
    asset = document.assets.find((candidate) =>
      candidate.kind === "video" && candidate.contentHash === sourceHash,
    )!;
    if (resumeState === "complete") {
      const transcript = document.artifacts.find((artifact) =>
        artifact.kind === "transcript" && artifact.assetId === asset.id,
      )!;
      const completed = result(store, databasePath, projectRoot, sourceHash, transcript.id, true);
      store.close();
      return completed;
    }
    sourceProbe = probeMedia(sourcePath, options.ffprobePath);
    const audio = requireAudioStream(sourceProbe);
    audioStreamIndex = audio.index;
    audioDuration = audio.duration ?? sourceProbe.duration;
    previewProxyAsset = findPreviewProxyAsset(document, asset);
  } else {
    mkdirSync(projectRoot, { recursive: true });
    const createdAt = (options.clock ?? (() => new Date().toISOString()))();
    const ingested = await ingestMedia({
      sourcePath,
      mediaDirectory: join(projectRoot, "media"),
      actor: { kind: "user", id: "local_user" },
      reason: "Create rough-cut project from local media",
      clock: () => createdAt,
      ...(options.ffprobePath ? { ffprobePath: options.ffprobePath } : {}),
    });
    asset = ingested.asset;
    sourceProbe = ingested.probe;
    const video = ingested.probe.streams.find((stream) => stream.type === "video");
    if (!video?.video) {
      throw new RoughCutWorkflowError("VIDEO_STREAM_NOT_FOUND", "Rough-cut project requires video");
    }
    const audio = requireAudioStream(ingested.probe);
    audioStreamIndex = audio.index;
    audioDuration = audio.duration ?? ingested.probe.duration;
    const clipDuration = video.duration ?? ingested.probe.duration;
    const digest = sourceHash.slice("sha256:".length);
    const document = buildInitialRoughCutProject({
      projectId: `project_${digest.slice(0, 24)}`,
      name: options.name?.trim() || basename(sourcePath),
      createdAt,
      width: video.video.displayWidth,
      height: video.video.displayHeight,
      frameRate: video.video.nominalFrameRate,
      alphaTrial: options.alphaTrial === true,
    });
    const previewProxy = await ensureBrowserPreviewProxy({
      sourceAsset: asset,
      sourcePath: ingested.managedPath,
      sourceProbe: ingested.probe,
      proxyDirectory: join(projectRoot, "proxies"),
      actor: { kind: "workflow", id: "preview_proxy_v1" },
      reason: "Create source-hash-bound browser preview proxy",
      clock: () => createdAt,
      ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
      ...(options.ffprobePath ? { ffprobePath: options.ffprobePath } : {}),
    });
    previewProxyAsset = previewProxy.asset;
    store = ProjectStore.create(databasePath, document, { checkpointInterval: 1 });
    store.commit({
      protocolVersion: "0.1.0",
      transactionId: "tx_roughcut_import",
      idempotencyKey: `roughcut-import:${sourceHash}`,
      projectId: document.project.id,
      sequenceId: "sequence_main",
      baseRevision: 0,
      actor: { kind: "user", id: "local_user" },
      reason: "Register immutable source media and full-length main clip",
      preconditions: [],
      operations: [
        { type: "asset.put", asset },
        ...(previewProxyAsset ? [{ type: "asset.put" as const, asset: previewProxyAsset }] : []),
        {
          type: "clip.insert",
          trackId: "track_v1",
          clip: {
            id: "clip_source_main",
            kind: "media",
            assetId: asset.id,
            streamIndex: video.index,
            timelineRange: {
              start: { value: 0, rate: structuredClone(clipDuration.rate) },
              duration: structuredClone(clipDuration),
            },
            sourceRange: {
              start: { value: 0, rate: structuredClone(clipDuration.rate) },
              duration: structuredClone(clipDuration),
            },
            enabled: true,
            provenance: {
              createdBy: { kind: "workflow", id: "rough_cut_bootstrap_v1" },
              createdAt,
              reason: "Create full-length source clip",
            },
          },
        },
      ],
    });
  }

  try {
    if (!previewProxyAsset && !isBrowserPlaybackCompatible(resolve(projectRoot, asset.uri), sourceProbe!)) {
      const document = store.snapshot();
      const previewProxy = await ensureBrowserPreviewProxy({
        sourceAsset: asset,
        sourcePath: resolve(projectRoot, asset.uri),
        sourceProbe: sourceProbe!,
        proxyDirectory: join(projectRoot, "proxies"),
        actor: { kind: "workflow", id: "preview_proxy_v1" },
        reason: "Resume interrupted project with browser preview proxy",
        ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
        ...(options.ffprobePath ? { ffprobePath: options.ffprobePath } : {}),
      });
      if (previewProxy.asset) {
        store.commit({
          protocolVersion: "0.1.0",
          transactionId: "tx_roughcut_preview_proxy",
          idempotencyKey: `roughcut-preview-proxy:${sourceHash}`,
          projectId: document.project.id,
          sequenceId: document.project.activeSequenceId,
          baseRevision: document.project.revision,
          actor: { kind: "workflow", id: "preview_proxy_v1" },
          reason: "Register browser preview proxy before Transcript review",
          preconditions: [{ type: "object_exists", objectId: asset.id }],
          operations: [{ type: "asset.put", asset: previewProxy.asset }],
        });
        previewProxyAsset = previewProxy.asset;
      }
    }
    const job = ensureAsrJob(store, asset.id, audioStreamIndex, options.model);
    const artifactsDirectory = join(projectRoot, "artifacts");
    mkdirSync(artifactsDirectory, { recursive: true });
    const rawResultPath = join(artifactsDirectory, "asr-provider-result.json");
    const model = options.model ?? "mlx-community/whisper-large-v3-turbo";
    const normalized = await runPersistedAsrJob({
      store,
      jobId: job.id,
      runner: {
        pythonPath: resolve(options.pythonPath),
        workerScriptPath: resolve(options.workerScriptPath),
        inputPath: resolve(projectRoot, asset.uri),
        outputPath: rawResultPath,
        model,
        language: "zh",
      },
      asset,
      audioStreamIndex,
      streamDuration: audioDuration!,
      rawResultUri: "artifacts/asr-provider-result.json",
      providerVersion: "mlx-whisper-0.4.3",
      actor: { kind: "workflow", id: "rough_cut_asr_v1" },
      transactionId: "tx_roughcut_transcript",
      idempotencyKey: `roughcut-transcript:${sourceHash}:${model}`,
      reason: "Transcribe rough-cut source into stable Chinese word ranges",
      ...(options.asrRun ? { run: options.asrRun } : {}),
    });
    return result(
      store,
      databasePath,
      projectRoot,
      sourceHash,
      normalized.transcript.id,
      resumed,
    );
  } finally {
    store.close();
  }
}

function ensureAsrJob(
  store: ProjectStore,
  assetId: string,
  audioStreamIndex: number,
  requestedModel?: string,
): ProjectJob {
  const jobId = "job_roughcut_asr";
  try {
    const job = store.getJob(jobId);
    if (job.status === "failed" && job.retryable) return store.retryJob(jobId);
    if (job.status !== "pending") {
      throw new RoughCutWorkflowError(
        "PROJECT_RESUME_UNSAFE",
        `Cannot safely resume ASR job in state ${job.status}; inspect the persisted job before retrying`,
      );
    }
    return job;
  } catch (error) {
    if (!isCode(error, "JOB_NOT_FOUND")) throw error;
    return store.createJob({
      id: jobId,
      type: "asr.transcribe",
      maxAttempts: 2,
      payload: {
        assetId,
        audioStreamIndex,
        provider: "mlx-whisper",
        model: requestedModel ?? "mlx-community/whisper-large-v3-turbo",
      },
    });
  }
}

function result(
  store: ProjectStore,
  databasePath: string,
  projectRoot: string,
  sourceHash: string,
  transcriptArtifactId: string,
  resumed: boolean,
): CreateRoughCutProjectResult {
  const document = store.snapshot();
  const source = document.assets.find((asset) =>
    asset.kind === "video" && asset.contentHash === sourceHash,
  )!;
  const proxy = findPreviewProxyAsset(document, source);
  const value = {
    databasePath,
    projectRoot,
    sourceHash,
    projectId: document.project.id,
    projectRevision: document.project.revision,
    transcriptArtifactId,
    resumed,
    alphaTrial: readAlphaTrialEnrollment(document) !== null,
    playbackAssetId: proxy?.id ?? source.id,
    playbackKind: proxy ? "proxy" as const : "source" as const,
  };
  return value;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
