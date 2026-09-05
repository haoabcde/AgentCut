import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Asset } from "@agentcut/timeline-schema";
import { hashFile, ingestMedia, MediaIngestError, probeMedia, requireAudioStream } from "./media-ingest.js";
import { ensureBrowserPreviewProxy, isBrowserPlaybackCompatible } from "./preview-proxy.js";

const actor = { kind: "user" as const, id: "local_user" };
const directory = mkdtempSync(join(tmpdir(), "agentcut-media-ingest-"));
const sourcePath = join(directory, "中文 测试源.mp4");
const ffmpegPath = process.env.AGENTCUT_FFMPEG_PATH ?? "ffmpeg";
const ffprobePath = process.env.AGENTCUT_FFPROBE_PATH ?? "ffprobe";

beforeAll(() => {
  const result = spawnSync(ffmpegPath, [
    "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30000/1001:duration=1.2",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.2",
    "-c:v", "mpeg4", "-c:a", "aac", "-shortest", "-y", sourcePath,
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("media ingest", () => {
  it("probes exact container, stream, duration, frame-rate, and audio metadata", () => {
    const probe = probeMedia(sourcePath);
    expect(probe.containerNames).toContain("mp4");
    expect(probe.sizeBytes).toBe(readFileSync(sourcePath).byteLength);
    expect(probe.duration.value).toBeGreaterThanOrEqual(1_000_000);
    expect(probe.streams).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "video",
        codec: "mpeg4",
        video: expect.objectContaining({
          width: 320,
          height: 180,
          rotation: 0,
          displayWidth: 320,
          displayHeight: 180,
          pixelAspectRatio: { numerator: 1, denominator: 1 },
          nominalFrameRate: { numerator: 30_000, denominator: 1_001 },
        }),
      }),
      expect.objectContaining({
        type: "audio",
        codec: "aac",
        audio: expect.objectContaining({ sampleRate: 48_000, channels: 1 }),
      }),
    ]));
  });

  it("derives display dimensions from the Display Matrix rotation (phone portrait)", () => {
    const basePath = join(directory, "rotation-base.mp4");
    const base = spawnSync(ffmpegPath, [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", basePath,
    ], { encoding: "utf8" });
    if (base.status !== 0) throw new Error(base.stderr);
    const rotatedPath = join(directory, "rotation-90.mp4");
    const rotated = spawnSync(ffmpegPath, [
      "-v", "error", "-y", "-display_rotation", "90", "-i", basePath, "-c", "copy", rotatedPath,
    ], { encoding: "utf8" });
    if (rotated.status !== 0) throw new Error(rotated.stderr);
    const probe = probeMedia(rotatedPath);
    const video = probe.streams.find((stream) => stream.type === "video");
    expect(video?.video).toEqual(expect.objectContaining({
      width: 640,
      height: 360,
      rotation: 90,
      displayWidth: 360,
      displayHeight: 640,
    }));
  });

  it("derives display dimensions from non-square pixels (anamorphic SAR)", () => {
    const anamorphicPath = join(directory, "anamorphic.mp4");
    const generated = spawnSync(ffmpegPath, [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=720x480:rate=30:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-vf", "setsar=32/27",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", anamorphicPath,
    ], { encoding: "utf8" });
    if (generated.status !== 0) throw new Error(generated.stderr);
    const probe = probeMedia(anamorphicPath);
    const video = probe.streams.find((stream) => stream.type === "video");
    expect(video?.video).toEqual(expect.objectContaining({
      width: 720,
      height: 480,
      rotation: 0,
      pixelAspectRatio: { numerator: 32, denominator: 27 },
      displayWidth: 853,
      displayHeight: 480,
    }));
  });

  it("copies by content hash atomically and deduplicates a repeated import", async () => {
    const mediaDirectory = join(directory, "project", "media");
    const first = await ingestMedia({
      sourcePath,
      mediaDirectory,
      actor,
      reason: "真实文件导入测试",
      clock: () => "2026-07-18T05:00:00Z",
    });
    expect(first.deduplicated).toBe(false);
    expect(first.asset.id).toMatch(/^asset_[0-9a-f]{24}$/);
    expect(first.asset.uri).toMatch(/^media\/[0-9a-f]{64}\.mp4$/);
    expect(existsSync(first.managedPath)).toBe(true);
    expect(readFileSync(first.managedPath)).toEqual(readFileSync(sourcePath));

    const second = await ingestMedia({
      sourcePath,
      mediaDirectory,
      actor,
      reason: "重复导入应去重",
      clock: () => "2026-07-18T05:01:00Z",
    });
    expect(second.deduplicated).toBe(true);
    expect(second.asset.contentHash).toBe(first.asset.contentHash);
    expect(second.managedPath).toBe(first.managedPath);
  });

  it("keeps browser-compatible H.264/AAC MP4 on the immutable source path", async () => {
    const browserSource = join(directory, "browser-source.mp4");
    const generated = spawnSync(ffmpegPath, [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=0.6",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", browserSource,
    ], { encoding: "utf8" });
    if (generated.status !== 0) throw new Error(generated.stderr);
    const probe = probeMedia(browserSource, ffprobePath);
    expect(isBrowserPlaybackCompatible(browserSource, probe)).toBe(true);
    await expect(ensureBrowserPreviewProxy({
      sourceAsset: await sourceAsset("asset_browser_source", browserSource),
      sourcePath: browserSource,
      sourceProbe: probe,
      proxyDirectory: join(directory, "browser-source-proxies"),
      actor,
      reason: "Compatibility test",
      ffmpegPath,
      ffprobePath,
    })).resolves.toEqual({ required: false, deduplicated: false });
  });

  it("atomically creates and adopts a source-hash-bound HEVC browser proxy", async () => {
    const hevcSource = join(directory, "phone-hevc.mov");
    const generated = spawnSync(ffmpegPath, [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=0.8",
      "-f", "lavfi", "-i", "sine=frequency=550:sample_rate=48000:duration=0.8",
      "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p",
      "-x265-params", "log-level=error:pools=1:frame-threads=1",
      "-c:a", "aac", "-shortest", hevcSource,
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (generated.status !== 0) throw new Error(generated.stderr);
    const probe = probeMedia(hevcSource, ffprobePath);
    expect(isBrowserPlaybackCompatible(hevcSource, probe)).toBe(false);
    const asset = await sourceAsset("asset_hevc_source", hevcSource);
    const proxyDirectory = join(directory, "hevc-proxies");
    const options = {
      sourceAsset: asset,
      sourcePath: hevcSource,
      sourceProbe: probe,
      proxyDirectory,
      actor,
      reason: "Create deterministic browser preview",
      clock: () => "2026-08-13T00:00:00.000Z",
      ffmpegPath,
      ffprobePath,
    };
    const first = await ensureBrowserPreviewProxy(options);
    expect(first).toEqual(expect.objectContaining({ required: true, deduplicated: false }));
    expect(first.asset).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^asset_preview_/),
      kind: "generated",
      availability: "online",
      contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      metadata: expect.objectContaining({
        "agentcut.previewProxy": {
          schemaVersion: "1.0",
          profile: "browser-h264-aac-1280-v1",
          sourceAssetId: asset.id,
          sourceContentHash: asset.contentHash,
        },
      }),
    }));
    const outputProbe = probeMedia(first.managedPath!, ffprobePath);
    expect(outputProbe.streams).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "video", codec: "h264" }),
      expect.objectContaining({ type: "audio", codec: "aac" }),
    ]));

    const resumed = await ensureBrowserPreviewProxy({
      ...options,
      clock: () => "2026-08-13T00:01:00.000Z",
    });
    expect(resumed).toEqual(expect.objectContaining({
      required: true,
      deduplicated: true,
      managedPath: first.managedPath,
    }));
    expect(resumed.asset?.contentHash).toBe(first.asset?.contentHash);
    expect(readdirSync(proxyDirectory).filter((name) => name.includes(".work-"))).toEqual([]);
  });

  it("returns typed errors for missing and invalid media", () => {
    expect(() => probeMedia(join(directory, "missing.mov"))).toThrowError(
      expect.objectContaining({ code: "SOURCE_NOT_FOUND" }),
    );
    const invalidPath = join(directory, "invalid.mp4");
    writeFileSync(invalidPath, "not media");
    expect(() => probeMedia(invalidPath)).toThrowError(MediaIngestError);
  });

  it("reports a typed transcription preflight error for video without audio", () => {
    const silentPath = join(directory, "silent.mp4");
    const result = spawnSync(ffmpegPath, [
      "-v", "error",
      "-f", "lavfi", "-i", "color=size=64x64:rate=25:duration=0.2",
      "-c:v", "mpeg4", "-an", "-y", silentPath,
    ], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    expect(() => requireAudioStream(probeMedia(silentPath))).toThrowError(
      expect.objectContaining({ code: "AUDIO_STREAM_NOT_FOUND" }),
    );
  });
});

async function sourceAsset(id: string, path: string): Promise<Asset> {
  return {
    id,
    kind: "video",
    uri: `media/${basename(path)}`,
    contentHash: await hashFile(path),
    availability: "online",
    provenance: {
      createdBy: actor,
      createdAt: "2026-08-13T00:00:00.000Z",
      reason: "Test source",
    },
  };
}
