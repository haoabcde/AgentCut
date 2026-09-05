import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { hashFile, probeMedia } from "@agentcut/media-ingest";
import type { ProjectStore } from "@agentcut/project-store";
import type {
  Actor,
  Asset,
  CaptionDocumentArtifact,
  RenderReportArtifact,
  Time,
} from "@agentcut/timeline-schema";
import { formatAss, formatSrt } from "./captions.js";
import { buildRenderPlan } from "./plan.js";
import { runFfmpegRender } from "./renderer.js";
import { RenderError, type RenderPlan } from "./types.js";

export interface PersistedRenderJobOptions {
  store: ProjectStore;
  jobId: string;
  projectRoot: string;
  sequenceId: string;
  transcriptArtifactId: string;
  actor: Actor;
  transactionId: string;
  idempotencyKey: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  signal?: AbortSignal;
  clock?: () => string;
  existingOutputPolicy?: "reject" | "recover_or_preserve";
  /** 导出预设的画幅/适配覆盖；缺省沿用序列画布与 contain。 */
  output?: { width: number; height: number; fitMode?: "contain" | "cover" };
}

export interface PersistedRenderResult {
  plan: RenderPlan;
  outputPath: string;
  captionPath: string;
  outputAsset: Asset;
  captionArtifact: CaptionDocumentArtifact;
  renderReport: RenderReportArtifact;
}

export async function runPersistedRenderJob(
  options: PersistedRenderJobOptions,
): Promise<PersistedRenderResult> {
  options.store.startJob(options.jobId);
  const clock = options.clock ?? (() => new Date().toISOString());
  const workId = createHash("sha256").update(options.jobId).digest("hex").slice(0, 16);
  const rendersDirectory = join(options.projectRoot, "renders");
  const workDirectory = join(rendersDirectory, `.work-${workId}`);
  let finalizedPaths: string[] = [];
  try {
    assertRenderNotCancelled(options, "planning");
    const document = options.store.snapshot();
    const plan = buildRenderPlan({
      document,
      projectRoot: options.projectRoot,
      sequenceId: options.sequenceId,
      transcriptArtifactId: options.transcriptArtifactId,
      ...(options.output
        ? {
          outputWidth: options.output.width,
          outputHeight: options.output.height,
          ...(options.output.fitMode ? { fitMode: options.output.fitMode } : {}),
        }
        : {}),
    });
    await assertRenderSourcesUnchanged(document, plan);
    assertRenderNotCancelled(options, "source_verification");
    const paths = renderOutputPathPairs(options.projectRoot, document.project.id, plan, options.jobId);
    let { outputPath, captionPath } = paths.primary;
    if (existsSync(outputPath) || existsSync(captionPath)) {
      if (options.existingOutputPolicy !== "recover_or_preserve") {
        throw new RenderError(
          "OUTPUT_EXISTS",
          "Render output already exists; AgentCut will not overwrite a completed artifact",
          { outputPath, captionPath },
        );
      }
      const recovered = await recoverPublishedResult({
        options,
        document,
        plan,
        outputPath,
        captionPath,
        clock,
      });
      if (recovered) {
        registerPersistedResult(options, recovered);
        return recovered;
      }
      ({ outputPath, captionPath } = paths.safeRetry);
      if (existsSync(outputPath) || existsSync(captionPath)) {
        throw new RenderError(
          "OUTPUT_EXISTS",
          "Safe retry outputs already exist; AgentCut preserved all files and refused to overwrite them",
          { outputPath, captionPath },
        );
      }
    }
    mkdirSync(rendersDirectory, { recursive: true });
    if (existsSync(workDirectory)) rmSync(workDirectory, { recursive: true, force: true });
    mkdirSync(workDirectory);
    const assFileName = "captions.ass";
    const srtFileName = "captions.srt";
    const outputFileName = "output.mp4";
    writeFileSync(join(workDirectory, assFileName), formatAss(plan.cues, plan.width, plan.height));
    writeFileSync(join(workDirectory, srtFileName), formatSrt(plan.cues));
    options.store.updateJobProgress(options.jobId, 0.1, {
      stage: "rendering",
      planHash: plan.planHash,
      segmentCount: plan.segments.length,
      subtitleCueCount: plan.cues.length,
    });
    assertRenderNotCancelled(options, "before_ffmpeg");
    const render = await runFfmpegRender(plan, {
      workDirectory,
      assFileName,
      outputFileName,
      ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    assertRenderNotCancelled(options, "after_ffmpeg");
    const temporaryOutput = join(workDirectory, outputFileName);
    const temporaryCaption = join(workDirectory, srtFileName);
    const result = await buildPersistedResult({
      options,
      document,
      plan,
      mediaBytesPath: temporaryOutput,
      captionBytesPath: temporaryCaption,
      outputPath,
      captionPath,
      rendererVersion: render.rendererVersion,
      clock,
    });
    assertRenderNotCancelled(options, "quality_verification");
    await assertRenderSourcesUnchanged(document, plan);
    options.store.updateJobProgress(options.jobId, 0.9, {
      stage: "finalizing",
      quality: result.renderReport.quality,
    });
    const latest = options.store.snapshot();
    if (latest.project.revision !== plan.sourceRevision) {
      throw new RenderError("REVISION_CONFLICT", "Project changed while render was running", {
        expected: plan.sourceRevision,
        actual: latest.project.revision,
      });
    }
    assertRenderNotCancelled(options, "before_publish");
    renameSync(temporaryOutput, outputPath);
    finalizedPaths.push(outputPath);
    renameSync(temporaryCaption, captionPath);
    finalizedPaths.push(captionPath);
    registerPersistedResult(options, result);
    finalizedPaths = [];
    return result;
  } catch (error) {
    for (const path of finalizedPaths) {
      if (existsSync(path)) unlinkSync(path);
    }
    const job = options.store.getJob(options.jobId);
    if (job.status === "running") {
      const code = errorCode(error);
      if (job.cancelRequested || options.signal?.aborted || code === "RENDER_CANCELLED") {
        if (!job.cancelRequested) options.store.requestJobCancellation(options.jobId);
        options.store.markJobCancelled(options.jobId);
      } else {
        options.store.failJob(options.jobId, {
          code,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof RenderError ? { details: error.details } : {}),
        }, { retryable: code === "RENDER_FAILED" || code === "PROBE_FAILED" });
      }
    }
    throw error;
  } finally {
    if (existsSync(workDirectory)) rmSync(workDirectory, { recursive: true, force: true });
  }
}

export async function recoverRunningPersistedRenderJob(
  options: PersistedRenderJobOptions,
): Promise<PersistedRenderResult | null> {
  const job = options.store.getJob(options.jobId);
  if (job.status !== "running") {
    throw new RenderError(
      "INVALID_CONFIGURATION",
      `Export recovery requires a running job; ${options.jobId} is ${job.status}`,
    );
  }
  if (job.cancelRequested || options.signal?.aborted) {
    if (!job.cancelRequested) options.store.requestJobCancellation(options.jobId);
    options.store.markJobCancelled(options.jobId);
    removeRenderWorkDirectory(options.projectRoot, options.jobId);
    return null;
  }
  const clock = options.clock ?? (() => new Date().toISOString());
  const document = options.store.snapshot();
  const plan = buildRenderPlan({
    document,
    projectRoot: options.projectRoot,
    sequenceId: options.sequenceId,
    transcriptArtifactId: options.transcriptArtifactId,
    ...(options.output
      ? {
        outputWidth: options.output.width,
        outputHeight: options.output.height,
        ...(options.output.fitMode ? { fitMode: options.output.fitMode } : {}),
      }
      : {}),
  });
  await assertRenderSourcesUnchanged(document, plan);
  const paths = renderOutputPathPairs(options.projectRoot, document.project.id, plan, options.jobId);
  for (const pair of [paths.primary, paths.safeRetry]) {
    const recovered = await recoverPublishedResult({
      options,
      document,
      plan,
      outputPath: pair.outputPath,
      captionPath: pair.captionPath,
      clock,
    });
    if (!recovered) continue;
    const latest = options.store.getJob(options.jobId);
    if (latest.cancelRequested || options.signal?.aborted) {
      if (!latest.cancelRequested) options.store.requestJobCancellation(options.jobId);
      options.store.markJobCancelled(options.jobId);
      return null;
    }
    registerPersistedResult(options, recovered);
    return recovered;
  }
  return null;
}

function assertRenderNotCancelled(options: PersistedRenderJobOptions, stage: string): void {
  const job = options.store.getJob(options.jobId);
  if (!job.cancelRequested && !options.signal?.aborted) return;
  throw new RenderError("RENDER_CANCELLED", "Export was cancelled before artifact commit", {
    stage,
  });
}

function removeRenderWorkDirectory(projectRoot: string, jobId: string): void {
  const workId = createHash("sha256").update(jobId).digest("hex").slice(0, 16);
  const workDirectory = join(projectRoot, "renders", `.work-${workId}`);
  if (existsSync(workDirectory)) rmSync(workDirectory, { recursive: true, force: true });
}

function renderOutputPathPairs(
  projectRoot: string,
  projectId: string,
  plan: RenderPlan,
  jobId: string,
): {
  primary: { outputPath: string; captionPath: string };
  safeRetry: { outputPath: string; captionPath: string };
} {
  const rendersDirectory = join(projectRoot, "renders");
  const planDigest = plan.planHash.slice("sha256:".length, "sha256:".length + 12);
  const safeProjectId = projectId.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  const outputBase = `agentcut-${safeProjectId}-r${plan.sourceRevision}-${planDigest}`;
  const workId = createHash("sha256").update(jobId).digest("hex").slice(0, 8);
  return {
    primary: {
      outputPath: join(rendersDirectory, `${outputBase}.mp4`),
      captionPath: join(rendersDirectory, `${outputBase}.srt`),
    },
    safeRetry: {
      outputPath: join(rendersDirectory, `${outputBase}-safe-retry-${workId}.mp4`),
      captionPath: join(rendersDirectory, `${outputBase}-safe-retry-${workId}.srt`),
    },
  };
}

async function recoverPublishedResult(input: {
  options: PersistedRenderJobOptions;
  document: ReturnType<ProjectStore["snapshot"]>;
  plan: RenderPlan;
  outputPath: string;
  captionPath: string;
  clock: () => string;
}): Promise<PersistedRenderResult | null> {
  if (!existsSync(input.outputPath) || !existsSync(input.captionPath)) return null;
  try {
    if (readFileSync(input.captionPath, "utf8") !== formatSrt(input.plan.cues)) return null;
    const result = await buildPersistedResult({
      options: input.options,
      document: input.document,
      plan: input.plan,
      mediaBytesPath: input.outputPath,
      captionBytesPath: input.captionPath,
      outputPath: input.outputPath,
      captionPath: input.captionPath,
      rendererVersion: "recovered verified output; original renderer version unavailable",
      clock: input.clock,
    });
    input.options.store.updateJobProgress(input.options.jobId, 0.85, {
      stage: "recovering_published_output",
      planHash: input.plan.planHash,
      quality: result.renderReport.quality,
    });
    return result;
  } catch {
    return null;
  }
}

async function buildPersistedResult(input: {
  options: PersistedRenderJobOptions;
  document: ReturnType<ProjectStore["snapshot"]>;
  plan: RenderPlan;
  mediaBytesPath: string;
  captionBytesPath: string;
  outputPath: string;
  captionPath: string;
  rendererVersion: string;
  clock: () => string;
}): Promise<PersistedRenderResult> {
  const probe = probeMedia(
    input.mediaBytesPath,
    input.options.ffprobePath ?? process.env.AGENTCUT_FFPROBE_PATH,
  );
  const quality = inspectRenderQuality(input.plan, probe);
  if (!quality.passed) {
    throw new RenderError("QUALITY_FAILED", "Rendered output failed deterministic quality checks", {
      quality,
    });
  }
  const outputContentHash = await hashFile(input.mediaBytesPath);
  const captionContentHash = await hashFile(input.captionBytesPath);
  const outputDigest = outputContentHash.slice("sha256:".length);
  const createdAt = input.clock();
  const captionArtifact: CaptionDocumentArtifact = {
    id: `captions_${createHash("sha256")
      .update(`${input.plan.planHash}:${captionContentHash}`).digest("hex").slice(0, 24)}`,
    kind: "captionDocument",
    transcriptArtifactId: input.options.transcriptArtifactId,
    sequenceId: input.options.sequenceId,
    projectRevision: input.plan.sourceRevision,
    language: findTranscriptLanguage(input.document, input.options.transcriptArtifactId),
    format: "srt",
    uri: projectUri(input.options.projectRoot, input.captionPath),
    contentHash: captionContentHash,
    cues: structuredClone(input.plan.cues),
    provenance: {
      createdBy: structuredClone(input.options.actor),
      createdAt,
      reason: "Generate cut-aware subtitles from stable Transcript words",
      sourceArtifactIds: [input.options.transcriptArtifactId],
    },
  };
  const outputAsset: Asset = {
    id: `asset_${outputDigest.slice(0, 24)}`,
    kind: "generated",
    uri: projectUri(input.options.projectRoot, input.outputPath),
    contentHash: outputContentHash,
    availability: "online",
    provenance: {
      createdBy: structuredClone(input.options.actor),
      createdAt,
      reason: `Render sequence ${input.options.sequenceId} with burned captions`,
      sourceArtifactIds: [captionArtifact.id],
    },
    metadata: {
      originalFileName: input.outputPath.split(sep).at(-1),
      mediaProbe: probe,
      sourceRevision: input.plan.sourceRevision,
      planHash: input.plan.planHash,
    },
  };
  const video = probe.streams.find((stream) => stream.type === "video")!;
  const audio = probe.streams.find((stream) => stream.type === "audio")!;
  const renderReport: RenderReportArtifact = {
    id: `render_${createHash("sha256")
      .update(`${input.plan.planHash}:${outputContentHash}`).digest("hex").slice(0, 24)}`,
    kind: "renderReport",
    sequenceId: input.options.sequenceId,
    projectRevision: input.plan.sourceRevision,
    outputAssetId: outputAsset.id,
    captionArtifactId: captionArtifact.id,
    renderer: "ffmpeg",
    rendererVersion: input.rendererVersion,
    planHash: input.plan.planHash,
    duration: structuredClone(probe.duration),
    fileSizeBytes: statSync(input.mediaBytesPath).size,
    videoCodec: video.codec,
    audioCodec: audio.codec,
    quality,
    warnings: structuredClone(input.plan.warnings),
    provenance: {
      createdBy: structuredClone(input.options.actor),
      createdAt,
      reason: "Verify and persist deterministic FFmpeg render",
      sourceArtifactIds: [input.options.transcriptArtifactId, captionArtifact.id],
    },
  };
  return {
    plan: input.plan,
    outputPath: input.outputPath,
    captionPath: input.captionPath,
    outputAsset,
    captionArtifact,
    renderReport,
  };
}

function registerPersistedResult(
  options: PersistedRenderJobOptions,
  result: PersistedRenderResult,
): void {
  options.store.commit({
    protocolVersion: "0.1.0",
    transactionId: options.transactionId,
    idempotencyKey: options.idempotencyKey,
    projectId: result.plan.projectId,
    sequenceId: result.plan.sequenceId,
    baseRevision: result.plan.sourceRevision,
    actor: options.actor,
    reason: "Register cut-aware subtitles and verified MP4 render",
    preconditions: [
      { type: "object_exists", objectId: options.transcriptArtifactId },
    ],
    operations: [
      { type: "asset.put", asset: result.outputAsset },
      { type: "artifact.put", artifact: result.captionArtifact },
      { type: "artifact.put", artifact: result.renderReport },
    ],
  });
  options.store.succeedJob(options.jobId, [
    result.outputAsset.id,
    result.captionArtifact.id,
    result.renderReport.id,
  ]);
}

function inspectRenderQuality(plan: RenderPlan, probe: ReturnType<typeof probeMedia>): RenderReportArtifact["quality"] {
  const requestedMicros = toMicros(plan.timelineDuration);
  // 末段越尾时渲染只承诺钳后时长（expectedOutputMicros），质量门对可交付
  // 时长保持 40ms；差值本身已由 plan warnings 诚实披露。
  const expectedMicros = plan.expectedOutputMicros;
  const actualMicros = toMicros(probe.duration);
  const durationDeltaMillis = Math.abs(actualMicros - expectedMicros) / 1_000;
  const video = probe.streams.find((stream) => stream.type === "video");
  const audio = probe.streams.find((stream) => stream.type === "audio");
  const dimensionsMatch = video?.video?.width === plan.width && video.video.height === plan.height;
  const passed = durationDeltaMillis <= 40 && dimensionsMatch && audio !== undefined;
  return {
    timelineDuration: structuredClone(plan.timelineDuration),
    outputDuration: structuredClone(probe.duration),
    ...(expectedMicros !== requestedMicros ? { expectedOutputMicros: expectedMicros } : {}),
    durationDeltaMillis,
    width: video?.video?.width ?? 0,
    height: video?.video?.height ?? 0,
    hasAudio: audio !== undefined,
    subtitleCueCount: plan.cues.length,
    passed,
    fitMode: plan.fitMode,
    // Alpha 的 cover 只有中心裁切、没有人物跟踪，必须在质量报告中保持近似标记。
    ...(plan.fitMode === "cover" ? { fitModeApproximate: true } : {}),
    // HDR 源不色调映射，输出近似 SDR，诚实标记。
    ...(plan.sourceHdr ? { colorApproximate: true } : {}),
  };
}

async function assertRenderSourcesUnchanged(
  document: ReturnType<ProjectStore["snapshot"]>,
  plan: RenderPlan,
): Promise<void> {
  const actualHashByPath = new Map<string, string>();
  const verifiedAssetIds = new Set<string>();
  for (const segment of plan.segments) {
    if (verifiedAssetIds.has(segment.assetId)) continue;
    verifiedAssetIds.add(segment.assetId);
    const asset = document.assets.find((candidate) => candidate.id === segment.assetId);
    if (!asset) {
      throw new RenderError("SOURCE_NOT_FOUND", `Render source ${segment.assetId} disappeared`);
    }
    let actual = actualHashByPath.get(segment.inputPath);
    if (!actual) {
      try {
        actual = await hashFile(segment.inputPath);
      } catch (error) {
        throw new RenderError(
          "SOURCE_NOT_FOUND",
          `Render source ${segment.assetId} could not be verified`,
          {
            assetId: segment.assetId,
            path: segment.inputPath,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      actualHashByPath.set(segment.inputPath, actual);
    }
    if (actual !== asset.contentHash) {
      throw new RenderError(
        "SOURCE_INTEGRITY_FAILED",
        `Render source ${segment.assetId} no longer matches its imported content hash`,
        {
          assetId: segment.assetId,
          path: segment.inputPath,
          expected: asset.contentHash,
          actual,
        },
      );
    }
  }
}

function findTranscriptLanguage(
  document: ReturnType<ProjectStore["snapshot"]>,
  transcriptArtifactId: string,
): string {
  const transcript = document.artifacts.find((artifact) => artifact.id === transcriptArtifactId);
  if (!transcript || transcript.kind !== "transcript") {
    throw new RenderError("UNSUPPORTED_TIMELINE", `Transcript ${transcriptArtifactId} disappeared`);
  }
  return transcript.language;
}

function projectUri(projectRoot: string, path: string): string {
  const value = relative(projectRoot, path);
  if (!value || value.startsWith("..") || value.split(sep).includes("..")) {
    throw new RenderError("INVALID_CONFIGURATION", "Render output escapes the project root");
  }
  return value.split(sep).join("/");
}

function errorCode(error: unknown): string {
  if (error instanceof RenderError) return error.code;
  if (typeof error === "object" && error && "code" in error) return String(error.code);
  return "RENDER_WORKFLOW_FAILED";
}

function toMicros(time: Time): number {
  return Math.round(time.value * time.rate.denominator * 1_000_000 / time.rate.numerator);
}
