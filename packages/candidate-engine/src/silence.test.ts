import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { CandidateDetectionError, detectSilences } from "./silence.js";

/**
 * detectSilences 是 Gate「definite_remove precision」与「边界可用率」的源头：
 * 它把 ffmpeg silencedetect 的 stderr 翻译成停顿区间。此前只被高层 candidates
 * 测试以 mock 间接覆盖，真实解析逻辑零直接测试。这里用真实 ffmpeg 生成的
 * 「有声-停顿-有声」音频做集成断言，并单测时间戳解析的边界。
 */

const ffmpegPath = process.env.AGENTCUT_FFMPEG_PATH ?? "ffmpeg";
const directory = mkdtempSync(join(tmpdir(), "agentcut-silence-"));

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function generateSpeechSilence(path: string): void {
  // 1s 440Hz 音 + 1.2s 静音 + 1s 440Hz 音，单文件三段拼接
  const result = spawnSync(ffmpegPath, [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1.2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000",
    "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
    "-map", "[out]", "-c:a", "aac", path,
  ], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr ?? "ffmpeg failed");
  }
}

describe("detectSilences", () => {
  it("detects the silence interval in a real speech-silence-speech audio file", () => {
    const audioPath = join(directory, "speech-silence.m4a");
    generateSpeechSilence(audioPath);
    const silences = detectSilences(audioPath, {
      ffmpegPath,
      noiseDb: -50,
      minimumDurationSeconds: 0.5,
    });
    expect(silences.length).toBeGreaterThanOrEqual(1);
    const first = silences[0]!;
    // 停顿应大致从 1s 开始、持续约 1.2s（允许编码/检测窗口误差）
    const startSec = first.start.value / 1_000_000;
    const durSec = first.duration.value / 1_000_000;
    expect(startSec).toBeGreaterThan(0.5);
    expect(startSec).toBeLessThan(1.5);
    expect(durSec).toBeGreaterThan(0.5);
    expect(durSec).toBeLessThan(2.0);
  });

  it("returns an empty list for continuous tone (no silence above threshold)", () => {
    const audioPath = join(directory, "continuous.m4a");
    const result = spawnSync(ffmpegPath, [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000",
      "-c:a", "aac", audioPath,
    ], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    expect(detectSilences(audioPath, { ffmpegPath, noiseDb: -50 })).toEqual([]);
  });

  it("rejects non-positive minimum duration", () => {
    expect(() => detectSilences("x.m4a", { minimumDurationSeconds: 0 })).toThrow(RangeError);
  });
});
