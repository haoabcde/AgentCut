import { existsSync, readdirSync, statfsSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

export type RenderCapabilityIssue =
  | "ffmpeg"
  | "ffprobe"
  | "ass_filter"
  | "h264_encoder"
  | "aac_encoder"
  | "pingfang_font"
  | "disk_space";

export interface RenderCapabilityInputs {
  ffmpegVersion: string;
  ffprobeVersion: string;
  filters: string;
  encoders: string;
  fontAvailable: boolean;
  availableBytes: number;
}

export interface RenderCapabilityReport {
  ready: boolean;
  ffmpegVersion: string;
  ffprobeVersion: string;
  availableBytes: number;
  missing: RenderCapabilityIssue[];
}

export interface InspectRenderEnvironmentOptions {
  projectRoot: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  minimumAvailableBytes?: number;
  fontPaths?: string[];
}

const DEFAULT_MINIMUM_AVAILABLE_BYTES = 1024 ** 3;
const DEFAULT_FONT_PATHS = [
  "/System/Library/Fonts/PingFang.ttc",
  "/System/Library/Fonts/PingFang SC.ttc",
  "/System/Library/PrivateFrameworks/FontServices.framework/Versions/A/Resources/Reserved/PingFangUI.ttc",
];
const DEFAULT_FONT_SEARCH_ROOTS = [
  "/System/Library/AssetsV2/com_apple_MobileAsset_Font8",
];

export function evaluateRenderCapabilities(
  input: RenderCapabilityInputs,
  minimumAvailableBytes = DEFAULT_MINIMUM_AVAILABLE_BYTES,
): RenderCapabilityReport {
  const missing: RenderCapabilityIssue[] = [];
  if (!input.ffmpegVersion.trim()) missing.push("ffmpeg");
  if (!input.ffprobeVersion.trim()) missing.push("ffprobe");
  if (!/(^|\s)ass(?=\s|$)/m.test(input.filters)) missing.push("ass_filter");
  if (!/(^|\s)libx264(?=\s|$)/m.test(input.encoders)) missing.push("h264_encoder");
  if (!/(^|\s)aac(?=\s|$)/m.test(input.encoders)) missing.push("aac_encoder");
  if (!input.fontAvailable) missing.push("pingfang_font");
  if (input.availableBytes < minimumAvailableBytes) missing.push("disk_space");
  return {
    ready: missing.length === 0,
    ffmpegVersion: firstLine(input.ffmpegVersion),
    ffprobeVersion: firstLine(input.ffprobeVersion),
    availableBytes: input.availableBytes,
    missing,
  };
}

export function inspectRenderEnvironment(
  options: InspectRenderEnvironmentOptions,
): RenderCapabilityReport {
  const ffmpegPath = options.ffmpegPath ?? process.env.AGENTCUT_FFMPEG_PATH ?? "ffmpeg";
  const ffprobePath = options.ffprobePath ?? process.env.AGENTCUT_FFPROBE_PATH ?? "ffprobe";
  const ffmpegVersion = commandOutput(ffmpegPath, ["-version"]);
  const ffprobeVersion = commandOutput(ffprobePath, ["-version"]);
  const filters = commandOutput(ffmpegPath, ["-hide_banner", "-filters"]);
  const encoders = commandOutput(ffmpegPath, ["-hide_banner", "-encoders"]);
  const stats = statfsSync(options.projectRoot);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const fontPaths = options.fontPaths
    ?? [...DEFAULT_FONT_PATHS, ...findPingFangFontPaths(DEFAULT_FONT_SEARCH_ROOTS)];
  return evaluateRenderCapabilities({
    ffmpegVersion,
    ffprobeVersion,
    filters,
    encoders,
    fontAvailable: fontPaths.some(existsSync),
    availableBytes,
  }, options.minimumAvailableBytes ?? DEFAULT_MINIMUM_AVAILABLE_BYTES);
}

export function findPingFangFontPaths(searchRoots: readonly string[]): string[] {
  const found: string[] = [];
  for (const root of searchRoots) {
    if (!existsSync(root)) continue;
    try {
      for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
        const name = basename(entry);
        if (name === "PingFang.ttc" || name === "PingFangUI.ttc") {
          found.push(join(root, entry));
        }
      }
    } catch {
      // A protected system font directory should produce a missing capability, not crash the doctor.
    }
  }
  return found.sort();
}

function commandOutput(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) return "";
  return `${result.stdout}${result.stderr}`;
}

function firstLine(value: string): string {
  return value.split("\n")[0]?.trim() ?? "";
}
