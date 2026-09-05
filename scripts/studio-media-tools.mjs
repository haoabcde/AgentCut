import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const FFMPEG_FULL_CANDIDATES = [
  "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
  "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
];

export function resolveStudioMediaTools(env = process.env, fileExists = existsSync) {
  const configuredFfmpeg = optionalEnvPath(env.AGENTCUT_FFMPEG_PATH);
  const configuredFfprobe = optionalEnvPath(env.AGENTCUT_FFPROBE_PATH);
  const ffmpegPath = configuredFfmpeg
    ?? FFMPEG_FULL_CANDIDATES.find((candidate) => fileExists(candidate));
  const siblingFfprobe = ffmpegPath ? join(dirname(ffmpegPath), "ffprobe") : undefined;
  const ffprobePath = configuredFfprobe
    ?? (siblingFfprobe && fileExists(siblingFfprobe) ? siblingFfprobe : undefined);
  return {
    ...(ffmpegPath ? { ffmpegPath } : {}),
    ...(ffprobePath ? { ffprobePath } : {}),
  };
}

function optionalEnvPath(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
