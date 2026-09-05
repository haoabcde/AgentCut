import { describe, expect, it } from "vitest";
import { resolveStudioMediaTools } from "../../../scripts/studio-media-tools.mjs";

describe("Studio media tool selection", () => {
  it("preserves explicit FFmpeg configuration", () => {
    expect(resolveStudioMediaTools({
      AGENTCUT_FFMPEG_PATH: "/custom/ffmpeg",
      AGENTCUT_FFPROBE_PATH: "/custom/ffprobe",
    }, () => false)).toEqual({
      ffmpegPath: "/custom/ffmpeg",
      ffprobePath: "/custom/ffprobe",
    });
  });

  it("selects Homebrew ffmpeg-full and its sibling ffprobe when available", () => {
    const available = new Set([
      "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
      "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe",
    ]);
    expect(resolveStudioMediaTools({}, (path) => available.has(path))).toEqual({
      ffmpegPath: "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
      ffprobePath: "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe",
    });
  });

  it("leaves the daemon on PATH fallback when ffmpeg-full is unavailable", () => {
    expect(resolveStudioMediaTools({}, () => false)).toEqual({});
  });
});
