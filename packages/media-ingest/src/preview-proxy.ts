import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { extname, join } from "node:path";
import {
  BROWSER_PREVIEW_PROXY_PROFILE,
  createPreviewProxyBinding,
  type Actor,
  type Asset,
  type Time,
} from "@agentcut/timeline-schema";
import { hashFile, probeMedia, type MediaProbe } from "./media-ingest.js";

export interface EnsureBrowserPreviewProxyOptions {
  sourceAsset: Asset;
  sourcePath: string;
  sourceProbe: MediaProbe;
  proxyDirectory: string;
  actor: Actor;
  reason: string;
  clock?: () => string;
  ffmpegPath?: string;
  ffprobePath?: string;
}

export interface BrowserPreviewProxyResult {
  required: boolean;
  asset?: Asset;
  managedPath?: string;
  deduplicated: boolean;
}

export type PreviewProxyErrorCode =
  | "PROXY_RENDER_FAILED"
  | "PROXY_INVALID"
  | "PROXY_PUBLISH_FAILED";

export class PreviewProxyError extends Error {
  constructor(
    readonly code: PreviewProxyErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PreviewProxyError";
  }
}

export function isBrowserPlaybackCompatible(sourcePath: string, probe: MediaProbe): boolean {
  const extension = extname(sourcePath).toLowerCase();
  const video = probe.streams.find((stream) => stream.type === "video");
  const audio = probe.streams.find((stream) => stream.type === "audio");
  return (extension === ".mp4" || extension === ".m4v")
    && video?.codec === "h264"
    && audio?.codec === "aac";
}

export async function ensureBrowserPreviewProxy(
  options: EnsureBrowserPreviewProxyOptions,
): Promise<BrowserPreviewProxyResult> {
  if (isBrowserPlaybackCompatible(options.sourcePath, options.sourceProbe)) {
    return { required: false, deduplicated: false };
  }

  const digest = options.sourceAsset.contentHash.slice("sha256:".length);
  const fileName = `${digest}-${BROWSER_PREVIEW_PROXY_PROFILE}.mp4`;
  mkdirSync(options.proxyDirectory, { recursive: true });
  cleanupWorkFiles(options.proxyDirectory, fileName);
  const managedPath = join(options.proxyDirectory, fileName);
  if (existsSync(managedPath)) {
    return {
      required: true,
      asset: await readVerifiedProxy(options, managedPath),
      managedPath,
      deduplicated: true,
    };
  }

  const temporaryPath = join(
    options.proxyDirectory,
    `.${fileName}.work-${process.pid}-${Date.now()}.mp4`,
  );
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const durationSeconds = timeToSeconds(options.sourceProbe.duration);
  const result = spawnSync(ffmpegPath, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", options.sourcePath,
    "-map", "0:v:0", "-map", "0:a:0",
    "-vf", "scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-pix_fmt", "yuv420p", "-profile:v", "main", "-level:v", "4.0",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-fps_mode", "passthrough", "-avoid_negative_ts", "make_zero",
    "-map_metadata", "-1", "-movflags", "+faststart",
    "-t", durationSeconds.toFixed(6),
    "-f", "mp4", temporaryPath,
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw new PreviewProxyError("PROXY_RENDER_FAILED", "FFmpeg could not create a browser preview proxy", {
      cause: result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`),
      profile: BROWSER_PREVIEW_PROXY_PROFILE,
    });
  }

  try {
    await verifyProxyFile(temporaryPath, options.sourceProbe.duration, options.ffprobePath);
    try {
      // A hard-link publish is atomic and never replaces a complete proxy produced by a
      // concurrent/resumed run. Both paths live in the same managed proxy directory.
      linkSync(temporaryPath, managedPath);
      unlinkSync(temporaryPath);
    } catch (error) {
      if (existsSync(managedPath)) {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      } else {
        throw new PreviewProxyError("PROXY_PUBLISH_FAILED", "Could not atomically publish preview proxy", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      required: true,
      asset: await readVerifiedProxy(options, managedPath),
      managedPath,
      deduplicated: false,
    };
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

async function readVerifiedProxy(
  options: EnsureBrowserPreviewProxyOptions,
  path: string,
): Promise<Asset> {
  const mediaProbe = await verifyProxyFile(path, options.sourceProbe.duration, options.ffprobePath);
  const contentHash = await hashFile(path);
  const digest = options.sourceAsset.contentHash.slice("sha256:".length);
  const createdAt = (options.clock ?? (() => new Date().toISOString()))();
  return {
    id: `asset_preview_${digest.slice(0, 24)}`,
    kind: "generated",
    uri: `proxies/${digest}-${BROWSER_PREVIEW_PROXY_PROFILE}.mp4`,
    contentHash,
    availability: "online",
    provenance: {
      createdBy: structuredClone(options.actor),
      createdAt,
      reason: options.reason,
    },
    metadata: {
      ["agentcut.previewProxy"]: createPreviewProxyBinding(options.sourceAsset),
      mediaProbe,
    },
  };
}

async function verifyProxyFile(
  path: string,
  sourceDuration: Time,
  ffprobePath?: string,
): Promise<MediaProbe> {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new PreviewProxyError("PROXY_INVALID", "Preview proxy is missing or empty", { path });
  }
  let probe: MediaProbe;
  try {
    probe = probeMedia(path, ffprobePath);
  } catch (error) {
    throw new PreviewProxyError("PROXY_INVALID", "Existing preview proxy cannot be probed", {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const video = probe.streams.find((stream) => stream.type === "video");
  const audio = probe.streams.find((stream) => stream.type === "audio");
  const durationDeltaMillis = Math.abs(timeToSeconds(probe.duration) - timeToSeconds(sourceDuration)) * 1_000;
  if (video?.codec !== "h264" || audio?.codec !== "aac" || durationDeltaMillis > 40) {
    throw new PreviewProxyError("PROXY_INVALID", "Preview proxy does not satisfy the browser profile", {
      path,
      videoCodec: video?.codec,
      audioCodec: audio?.codec,
      durationDeltaMillis,
    });
  }
  return probe;
}

function cleanupWorkFiles(directory: string, fileName: string): void {
  const prefix = `.${fileName}.work-`;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith(".mp4")) continue;
    const path = join(directory, name);
    if (statSync(path).isFile()) unlinkSync(path);
  }
}

function timeToSeconds(time: Time): number {
  return time.value * time.rate.denominator / time.rate.numerator;
}
