import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Actor, Asset, Rate, Time } from "@agentcut/timeline-schema";

export interface MediaStreamProbe {
  index: number;
  type: "video" | "audio" | "subtitle" | "data" | "attachment" | "unknown";
  codec: string;
  duration?: Time;
  video?: {
    width: number;
    height: number;
    /** 显示旋转（度，顺时针），来自 Display Matrix side data；无旋转元数据时为 0。 */
    rotation: number;
    /** 旋转调整后的显示宽高；rotation 为 90/270 时与存储宽高互换，否则相同。 */
    displayWidth: number;
    displayHeight: number;
    /** 像素宽高比 sample_aspect_ratio；缺省按方形像素（1/1）。 */
    pixelAspectRatio: { numerator: number; denominator: number };
    /** 色彩传递特性 color_transfer（如 smpte2084=PQ、arib-std-b67=HLG）；未标记时缺省。 */
    colorTransfer?: string;
    nominalFrameRate: Rate;
    averageFrameRate: Rate;
  };
  audio?: {
    sampleRate: number;
    channels: number;
    channelLayout?: string;
  };
}

export interface MediaProbe {
  containerNames: string[];
  duration: Time;
  sizeBytes: number;
  streams: MediaStreamProbe[];
}

export interface IngestMediaOptions {
  sourcePath: string;
  mediaDirectory: string;
  actor: Actor;
  reason: string;
  clock?: () => string;
  ffprobePath?: string;
  uriPrefix?: string;
}

export interface IngestedMedia {
  asset: Asset;
  probe: MediaProbe;
  managedPath: string;
  deduplicated: boolean;
}

export type MediaIngestErrorCode =
  | "SOURCE_NOT_FOUND"
  | "AUDIO_STREAM_NOT_FOUND"
  | "UNSUPPORTED_MEDIA"
  | "PROBE_FAILED"
  | "COPY_FAILED"
  | "HASH_MISMATCH";

export class MediaIngestError extends Error {
  constructor(
    readonly code: MediaIngestErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MediaIngestError";
  }
}

export function probeMedia(sourcePath: string, ffprobePath = "ffprobe"): MediaProbe {
  assertRegularFile(sourcePath);
  const result = spawnSync(ffprobePath, [
    "-v", "error",
    "-show_entries",
    "format=duration,size,format_name:stream=index,codec_type,codec_name,duration,width,height,sample_aspect_ratio,color_transfer,r_frame_rate,avg_frame_rate,sample_rate,channels,channel_layout:stream_side_data=rotation",
    "-of", "json",
    sourcePath,
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new MediaIngestError("PROBE_FAILED", `ffprobe could not inspect ${basename(sourcePath)}`, {
      cause: result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`),
    });
  }

  try {
    const raw: unknown = JSON.parse(result.stdout);
    return parseProbe(raw);
  } catch (error) {
    if (error instanceof MediaIngestError) throw error;
    throw new MediaIngestError("PROBE_FAILED", "ffprobe returned an invalid response", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function ingestMedia(options: IngestMediaOptions): Promise<IngestedMedia> {
  const probe = probeMedia(options.sourcePath, options.ffprobePath);
  const kind = probe.streams.some((stream) => stream.type === "video")
    ? "video"
    : probe.streams.some((stream) => stream.type === "audio")
      ? "audio"
      : undefined;
  if (!kind) {
    throw new MediaIngestError("UNSUPPORTED_MEDIA", "Only media with a video or audio stream can be imported");
  }

  const contentHash = await hashFile(options.sourcePath);
  const digest = contentHash.slice("sha256:".length);
  const extension = safeExtension(options.sourcePath);
  const managedName = `${digest}${extension}`;
  mkdirSync(options.mediaDirectory, { recursive: true });
  const managedPath = join(options.mediaDirectory, managedName);
  let deduplicated = false;
  if (existsSync(managedPath)) {
    const existingHash = await hashFile(managedPath);
    if (existingHash !== contentHash) {
      throw new MediaIngestError("HASH_MISMATCH", "Managed media path contains unexpected bytes", {
        managedPath,
        expected: contentHash,
        actual: existingHash,
      });
    }
    deduplicated = true;
  } else {
    const temporaryPath = join(
      options.mediaDirectory,
      `.${managedName}.tmp-${process.pid}-${Date.now()}`,
    );
    try {
      copyFileSync(options.sourcePath, temporaryPath);
      const copiedHash = await hashFile(temporaryPath);
      if (copiedHash !== contentHash) {
        throw new MediaIngestError("HASH_MISMATCH", "Copied media does not match its source", {
          expected: contentHash,
          actual: copiedHash,
        });
      }
      renameSync(temporaryPath, managedPath);
    } catch (error) {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      if (error instanceof MediaIngestError) throw error;
      throw new MediaIngestError("COPY_FAILED", `Could not copy ${basename(options.sourcePath)}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const createdAt = (options.clock ?? (() => new Date().toISOString()))();
  const uriPrefix = (options.uriPrefix ?? "media").replace(/^\/+|\/+$/g, "");
  const asset: Asset = {
    id: `asset_${digest.slice(0, 24)}`,
    kind,
    uri: `${uriPrefix}/${managedName}`,
    contentHash,
    availability: "online",
    provenance: {
      createdBy: structuredClone(options.actor),
      createdAt,
      reason: options.reason,
    },
    metadata: {
      originalFileName: basename(options.sourcePath),
      importedAt: createdAt,
      mediaProbe: probe,
    },
  };
  return { asset, probe, managedPath, deduplicated };
}

export async function hashFile(path: string): Promise<string> {
  assertRegularFile(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return `sha256:${hash.digest("hex")}`;
}

export function requireAudioStream(
  probe: MediaProbe,
): MediaStreamProbe & { type: "audio"; audio: NonNullable<MediaStreamProbe["audio"]> } {
  const stream = probe.streams.find((candidate) => candidate.type === "audio");
  if (!stream || stream.type !== "audio" || !stream.audio) {
    throw new MediaIngestError(
      "AUDIO_STREAM_NOT_FOUND",
      "Media has no audio stream and cannot be transcribed",
    );
  }
  return stream as MediaStreamProbe & {
    type: "audio";
    audio: NonNullable<MediaStreamProbe["audio"]>;
  };
}

function parseProbe(value: unknown): MediaProbe {
  const root = asRecord(value, "ffprobe response");
  const format = asRecord(root.format, "ffprobe format");
  const rawStreams = root.streams;
  if (!Array.isArray(rawStreams)) {
    throw new MediaIngestError("PROBE_FAILED", "ffprobe streams must be an array");
  }
  const streams = rawStreams.map(parseStream);
  if (!streams.some((stream) => stream.type === "video" || stream.type === "audio")) {
    throw new MediaIngestError("UNSUPPORTED_MEDIA", "No video or audio stream was found");
  }
  return {
    containerNames: readString(format, "format_name").split(",").filter(Boolean),
    duration: decimalSecondsToTime(readString(format, "duration")),
    sizeBytes: readSafeIntegerString(format, "size"),
    streams,
  };
}

function parseStream(value: unknown): MediaStreamProbe {
  const stream = asRecord(value, "ffprobe stream");
  const type = normalizeStreamType(readString(stream, "codec_type"));
  const parsed: MediaStreamProbe = {
    index: readSafeInteger(stream, "index"),
    type,
    codec: readString(stream, "codec_name"),
  };
  if (typeof stream.duration === "string") parsed.duration = decimalSecondsToTime(stream.duration);
  if (type === "video") {
    const width = readSafeInteger(stream, "width");
    const height = readSafeInteger(stream, "height");
    const rotation = readDisplayRotation(stream);
    const pixelAspectRatio = readAspectRatio(stream.sample_aspect_ratio, "1/1");
    // 显示宽高 = 存储宽高 × 像素宽高比（SAR），旋转 90/270 时交换。
    const sarWidth = Math.max(1, Math.round(width * pixelAspectRatio.numerator / pixelAspectRatio.denominator));
    const quarterTurn = Math.abs(rotation) % 180 === 90;
    parsed.video = {
      width,
      height,
      rotation,
      displayWidth: quarterTurn ? height : sarWidth,
      displayHeight: quarterTurn ? sarWidth : height,
      pixelAspectRatio,
      ...(typeof stream.color_transfer === "string" && stream.color_transfer.trim()
        ? { colorTransfer: stream.color_transfer }
        : {}),
      nominalFrameRate: parseRate(readString(stream, "r_frame_rate")),
      averageFrameRate: parseRate(readString(stream, "avg_frame_rate")),
    };
  } else if (type === "audio") {
    parsed.audio = {
      sampleRate: readSafeIntegerString(stream, "sample_rate"),
      channels: readSafeInteger(stream, "channels"),
      ...(typeof stream.channel_layout === "string"
        ? { channelLayout: stream.channel_layout }
        : {}),
    };
  }
  return parsed;
}

/** 解析 "N/M" 或 "N:M" 形式的比例；缺省或非法值按 1/1（方形像素）处理，不使整个 probe 失败。 */
function readAspectRatio(value: unknown, fallback: string): { numerator: number; denominator: number } {
  if (typeof value !== "string") return parseRate(fallback);
  try {
    const ratio = parseRate(value.replace(":", "/"));
    return ratio.numerator > 0 && ratio.denominator > 0 ? ratio : parseRate(fallback);
  } catch {
    return parseRate(fallback);
  }
}

/** 从 Display Matrix side data 提取显示旋转角度（度）；缺失或非法时按 0 处理。 */
function readDisplayRotation(stream: Record<string, unknown>): number {
  const list = stream.side_data_list;
  if (!Array.isArray(list)) return 0;
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.rotation === "number" && Number.isFinite(record.rotation)) {
      return Math.trunc(record.rotation);
    }
  }
  return 0;
}

function decimalSecondsToTime(value: string): Time {  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new MediaIngestError("PROBE_FAILED", `Invalid duration ${value}`);
  const whole = BigInt(match[1]!);
  const fraction = match[2] ?? "";
  const microsText = fraction.slice(0, 6).padEnd(6, "0");
  let micros = BigInt(microsText || "0");
  if (fraction.length > 6 && Number(fraction[6]) >= 5) micros += 1n;
  const total = whole * 1_000_000n + micros;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MediaIngestError("PROBE_FAILED", "Media duration exceeds safe integer range");
  }
  return { value: Number(total), rate: { numerator: 1_000_000, denominator: 1 } };
}

function parseRate(value: string): Rate {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) throw new MediaIngestError("PROBE_FAILED", `Invalid frame rate ${value}`);
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
    || numerator <= 0 || denominator <= 0) {
    throw new MediaIngestError("PROBE_FAILED", `Invalid frame rate ${value}`);
  }
  return { numerator, denominator };
}

function normalizeStreamType(value: string): MediaStreamProbe["type"] {
  return ["video", "audio", "subtitle", "data", "attachment"].includes(value)
    ? value as MediaStreamProbe["type"]
    : "unknown";
}

function assertRegularFile(path: string): void {
  try {
    if (statSync(path).isFile()) return;
  } catch {
    // Converted into a stable domain error below.
  }
  throw new MediaIngestError("SOURCE_NOT_FOUND", `Media source ${path} is not a regular file`);
}

function safeExtension(path: string): string {
  const extension = extname(path).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".bin";
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MediaIngestError("PROBE_FAILED", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new MediaIngestError("PROBE_FAILED", `ffprobe ${key} must be a non-empty string`);
  }
  return value;
}

function readSafeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new MediaIngestError("PROBE_FAILED", `ffprobe ${key} must be a non-negative integer`);
  }
  return value as number;
}

function readSafeIntegerString(record: Record<string, unknown>, key: string): number {
  const value = readString(record, key);
  if (!/^\d+$/.test(value)) {
    throw new MediaIngestError("PROBE_FAILED", `ffprobe ${key} must be an integer string`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new MediaIngestError("PROBE_FAILED", `ffprobe ${key} exceeds safe integer range`);
  }
  return parsed;
}
