import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type {
  AgentCutProjectDocument,
  Asset,
  TranscriptArtifact,
} from "@agentcut/timeline-schema";
import type { MediaStreamProbe } from "@agentcut/media-ingest";
import { generateCaptionCues, mapTranscriptToTimeline } from "./captions.js";
import { evaluateTimelineSegments } from "./preview.js";
import { RenderError, type RenderPlan, type RenderSegment } from "./types.js";

export interface BuildRenderPlanOptions {
  document: AgentCutProjectDocument;
  projectRoot: string;
  sequenceId: string;
  transcriptArtifactId: string;
  maximumCaptionCharacters?: number;
  /** 输出画幅；缺省使用序列画布。竖屏等导出预设通过该覆盖进入同一确定性 plan。 */
  outputWidth?: number;
  outputHeight?: number;
  /** 画面适配模式；缺省 `contain`，保持既有导出语义不变。 */
  fitMode?: "contain" | "cover";
}

export function buildRenderPlan(options: BuildRenderPlanOptions): RenderPlan {
  const sequence = options.document.sequences.find((candidate) => candidate.id === options.sequenceId);
  if (!sequence) {
    throw new RenderError("UNSUPPORTED_TIMELINE", `Sequence ${options.sequenceId} does not exist`);
  }
  const width = options.outputWidth ?? sequence.canvas.width;
  const height = options.outputHeight ?? sequence.canvas.height;
  const fitMode = options.fitMode ?? "contain";
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2) {
    throw new RenderError("INVALID_CONFIGURATION", "Render output dimensions must be integers >= 2", {
      outputWidth: options.outputWidth,
      outputHeight: options.outputHeight,
    });
  }
  if (fitMode === "cover" && width === sequence.canvas.width && height === sequence.canvas.height) {
    throw new RenderError(
      "UNSUPPORTED_FIT_MODE",
      "cover fit only makes sense for an export preset whose aspect differs from the sequence canvas",
      { canvas: sequence.canvas, outputWidth: width, outputHeight: height },
    );
  }
  const transcript = findTranscript(options.document, options.transcriptArtifactId);
  const evaluatedTimeline = evaluateTimelineSegments(
    options.document,
    options.sequenceId,
    options.transcriptArtifactId,
  );
  const clipById = new Map(sequence.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip]));
  const inputPaths: string[] = [];
  const inputIndexes = new Map<string, number>();
  const segments: RenderSegment[] = [];
  for (const evaluated of evaluatedTimeline.segments) {
    const clip = clipById.get(evaluated.clipId)!;
    const asset = findOnlineAsset(options.document, evaluated.assetId);
    const inputPath = resolveManagedPath(options.projectRoot, asset);
    let inputIndex = inputIndexes.get(inputPath);
    if (inputIndex === undefined) {
      inputIndex = inputPaths.length;
      inputIndexes.set(inputPath, inputIndex);
      inputPaths.push(inputPath);
    }
    const probe = readMediaProbe(asset);
    const videoStreamOrdinal = streamOrdinal(probe.streams, clip.streamIndex!, "video");
    const audioStreamOrdinal = streamOrdinal(probe.streams, transcript.audioStreamIndex, "audio");
    const videoStream = probe.streams.find((stream) => stream.type === "video" && stream.index === clip.streamIndex);
    const audioStream = probe.streams.find((stream) => stream.type === "audio" && stream.index === transcript.audioStreamIndex);
    const sourceDisplayWidth = videoStream?.video?.displayWidth ?? 0;
    const sourceDisplayHeight = videoStream?.video?.displayHeight ?? 0;
    // 段尾可能越过源媒体尾部（末句词边界微超、末尾音频短于视频）。请求不存在的
    // 媒体时 concat 会按视频流尾部拉伸，最终段长溢出并触发质量门；可用上界按
    // 视频/转写音频两条流各自的流时长取较小者（AAC 帧粒度下流时长是真实可解码
    // 跨度的上界），随 plan 带给渲染端钳住 trim 时长。旧 fixture 缺流时长时按
    // 请求时长放行（不钳制），与修复前行为一致。
    const videoBound = streamDurationMicros(videoStream?.duration ?? probe.duration);
    const audioBound = streamDurationMicros(audioStream?.duration ?? probe.duration);
    const assetMicros = videoBound === null || audioBound === null
      ? null
      : Math.min(videoBound, audioBound);
    const availableSourceMicros = assetMicros === null
      ? evaluated.durationMicros
      : Math.max(0, assetMicros - evaluated.sourceStartMicros);
    segments.push({
      clipId: evaluated.clipId,
      assetId: asset.id,
      inputPath,
      inputIndex,
      videoStreamOrdinal,
      audioStreamOrdinal,
      sourceStartMicros: evaluated.sourceStartMicros,
      durationMicros: evaluated.durationMicros,
      timelineStartMicros: evaluated.timelineStartMicros,
      sourceDisplayWidth,
      sourceDisplayHeight,
      availableSourceMicros,
      ...(videoStream?.video?.colorTransfer
        ? { sourceColorTransfer: videoStream.video.colorTransfer }
        : {}),
    });
  }
  const mapping = mapTranscriptToTimeline(
    options.document,
    options.transcriptArtifactId,
    options.sequenceId,
  );
  const cues = generateCaptionCues(mapping.words, {
    maximumCharacters: options.maximumCaptionCharacters ?? 16,
  });
  const baseWarnings = mapping.partialWordIds.length > 0
    ? [`${mapping.partialWordIds.length} transcript words cross a cut boundary and were omitted`]
    : [];
  const timelineDuration = micros(evaluatedTimeline.durationMicros);
  const expectedOutputMicros = segments.reduce(
    (total, segment) => total + Math.min(segment.durationMicros, segment.availableSourceMicros),
    0,
  );
  const warnings = [...baseWarnings];
  if (expectedOutputMicros < evaluatedTimeline.durationMicros) {
    const droppedMillis = Math.round((evaluatedTimeline.durationMicros - expectedOutputMicros) / 1_000);
    warnings.push(
      `final segment(s) request ${droppedMillis}ms past the end of the source media; output ends at the last decodable frame (末段请求越过源媒体尾部，导出在源尾结束)`,
    );
  }
  if (fitMode === "cover") {
    warnings.push(
      `cover fit is center-crop only (no subject tracking); approximate framing for ${width}x${height}`,
    );
  }
  const sourceHdr = segments.some((segment) => isHdrTransfer(segment.sourceColorTransfer));
  if (sourceHdr) {
    warnings.push(
      "input source is HDR (PQ/HLG); current pipeline does not tone-map, output is approximate SDR (高光/色彩在 bt709 播放器上可能失真)",
    );
  }
  const hashPayload = {
    projectId: options.document.project.id,
    sequenceId: sequence.id,
    sourceRevision: options.document.project.revision,
    canvas: sequence.canvas,
    output: { width, height, fitMode },
    frameRate: sequence.frameRate,
    assets: [...new Set(segments.map((segment) => segment.assetId))].map((assetId) => {
      const asset = options.document.assets.find((candidate) => candidate.id === assetId)!;
      return { assetId, path: resolveManagedPath(options.projectRoot, asset), contentHash: asset.contentHash };
    }),
    segments,
    cues,
  };
  return {
    planHash: `sha256:${createHash("sha256").update(JSON.stringify(hashPayload)).digest("hex")}`,
    projectId: options.document.project.id,
    sourceRevision: options.document.project.revision,
    sequenceId: sequence.id,
    transcriptArtifactId: transcript.id,
    width,
    height,
    frameRate: structuredClone(sequence.frameRate),
    fitMode,
    timelineDuration,
    expectedOutputMicros,
    inputPaths,
    segments,
    cues,
    removedWordIds: mapping.removedWordIds,
    partialWordIds: mapping.partialWordIds,
    warnings,
    sourceHdr,
  };
}

/** PQ / HLG 传递特性视为 HDR；当前管线不色调映射，输出近似 SDR。 */
function isHdrTransfer(transfer: string | undefined): boolean {
  return transfer === "smpte2084" || transfer === "arib-std-b67";
}

function findTranscript(document: AgentCutProjectDocument, id: string): TranscriptArtifact {
  const transcript = document.artifacts.find((artifact) => artifact.id === id);
  if (!transcript || transcript.kind !== "transcript") {
    throw new RenderError("UNSUPPORTED_TIMELINE", `Transcript ${id} does not exist`);
  }
  return transcript;
}

function findOnlineAsset(document: AgentCutProjectDocument, id: string): Asset {
  const asset = document.assets.find((candidate) => candidate.id === id);
  if (!asset || asset.availability !== "online") {
    throw new RenderError("SOURCE_NOT_FOUND", `Asset ${id} is not online`);
  }
  return asset;
}

function resolveManagedPath(projectRoot: string, asset: Asset): string {
  const root = resolve(projectRoot);
  const path = resolve(root, asset.uri);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new RenderError("SOURCE_NOT_FOUND", `Asset ${asset.id} escapes the project root`);
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new RenderError("SOURCE_NOT_FOUND", `Asset ${asset.id} bytes are missing`, { path });
  }
  return path;
}

interface ProbeMetadata {
  streams: MediaStreamProbe[];
  /** 容器时长（Time）；可能缺失（旧 fixture），此时流时长也缺则不钳制。 */
  duration?: { value: number; rate: { numerator: number; denominator: number } };
}

function readMediaProbe(asset: Asset): ProbeMetadata {
  const probe = asset.metadata?.mediaProbe;
  if (!probe || typeof probe !== "object" || Array.isArray(probe)) {
    throw new RenderError("UNSUPPORTED_TIMELINE", `Asset ${asset.id} has no media probe metadata`);
  }
  const record = probe as Record<string, unknown>;
  const streams = record.streams;
  if (!Array.isArray(streams) || streams.some((stream) =>
    !stream || typeof stream !== "object" || Array.isArray(stream)
      || !Number.isSafeInteger((stream as Record<string, unknown>).index)
      || typeof (stream as Record<string, unknown>).type !== "string",
  )) {
    throw new RenderError("UNSUPPORTED_TIMELINE", `Asset ${asset.id} has invalid stream metadata`);
  }
  return {
    streams: streams as MediaStreamProbe[],
    ...(isTimeValue(record.duration) ? { duration: record.duration } : {}),
  };
}

function isTimeValue(value: unknown): value is { value: number; rate: { numerator: number; denominator: number } } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const time = value as Record<string, unknown>;
  const rate = time.rate as Record<string, unknown> | undefined;
  return Number.isSafeInteger(time.value)
    && !!rate
    && Number.isSafeInteger(rate.numerator)
    && Number.isSafeInteger(rate.denominator)
    && (rate.numerator as number) > 0
    && (rate.denominator as number) > 0;
}

/** Time → 微秒；缺省时返回 null（调用方决定兜底策略）。 */
function streamDurationMicros(
  time: { value: number; rate: { numerator: number; denominator: number } } | undefined,
): number | null {
  if (!time) return null;
  return Math.round(time.value * time.rate.denominator * 1_000_000 / time.rate.numerator);
}

function streamOrdinal(
  streams: Array<{ index: number; type: string }>,
  globalIndex: number,
  type: "video" | "audio",
): number {
  const typed = streams.filter((stream) => stream.type === type);
  const ordinal = typed.findIndex((stream) => stream.index === globalIndex);
  if (ordinal < 0) {
    throw new RenderError(
      "UNSUPPORTED_TIMELINE",
      `Global stream ${globalIndex} is not a ${type} stream`,
    );
  }
  return ordinal;
}

function micros(value: number): { value: number; rate: { numerator: 1_000_000; denominator: 1 } } {  return { value, rate: microsRate() };
}

function microsRate(): { numerator: 1_000_000; denominator: 1 } {
  return { numerator: 1_000_000, denominator: 1 };
}
