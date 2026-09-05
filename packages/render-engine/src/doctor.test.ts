import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateRenderCapabilities, findPingFangFontPaths } from "./doctor.js";

describe("render environment doctor", () => {
  it("rejects an FFmpeg build that cannot burn ASS captions", () => {
    const result = evaluateRenderCapabilities({
      ffmpegVersion: "ffmpeg version 8.1.1",
      ffprobeVersion: "ffprobe version 8.1.1",
      filters: " TS overlay VV->V Overlay video",
      encoders: " V....D libx264 H.264\n A....D aac AAC",
      fontAvailable: true,
      availableBytes: 8 * 1024 ** 3,
    });

    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(["ass_filter"]);
  });

  it("accepts the minimum local rough-cut export toolchain", () => {
    const result = evaluateRenderCapabilities({
      ffmpegVersion: "ffmpeg version 8.1.1",
      ffprobeVersion: "ffprobe version 8.1.1",
      filters: " ... ass V->V Render ASS subtitles\n ... subtitles V->V Render text subtitles",
      encoders: " V....D libx264 H.264\n A....D aac AAC",
      fontAvailable: true,
      availableBytes: 8 * 1024 ** 3,
    });

    expect(result).toEqual({
      ready: true,
      ffmpegVersion: "ffmpeg version 8.1.1",
      ffprobeVersion: "ffprobe version 8.1.1",
      availableBytes: 8 * 1024 ** 3,
      missing: [],
    });
  });

  it("reports every missing prerequisite instead of failing at the first one", () => {
    const result = evaluateRenderCapabilities({
      ffmpegVersion: "",
      ffprobeVersion: "",
      filters: "",
      encoders: "",
      fontAvailable: false,
      availableBytes: 100,
    });

    expect(result.missing).toEqual([
      "ffmpeg",
      "ffprobe",
      "ass_filter",
      "h264_encoder",
      "aac_encoder",
      "pingfang_font",
      "disk_space",
    ]);
  });

  it("discovers a downloadable PingFang asset outside the legacy font directory", () => {
    const root = mkdtempSync(join(tmpdir(), "agentcut-font-doctor-"));
    const asset = join(root, "font.asset", "AssetData");
    mkdirSync(asset, { recursive: true });
    const path = join(asset, "PingFang.ttc");
    writeFileSync(path, "font");

    expect(findPingFangFontPaths([root])).toEqual([path]);
  });
});
