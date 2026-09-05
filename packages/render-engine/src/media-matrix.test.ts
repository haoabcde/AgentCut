import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile, probeMedia } from "@agentcut/media-ingest";
import { ProjectStore } from "@agentcut/project-store";
import type { AgentCutProjectDocument } from "@agentcut/timeline-schema";
import { afterAll, describe, expect, it } from "vitest";
import { runPersistedRenderJob } from "./workflow.js";

/**
 * G4「扩大素材矩阵」的离线确定性一半：用 lavfi 程序化生成覆盖常见真实口播
 * 边缘形态的合成素材（基准 CFR、HEVC、VFR、高分辨率、高帧率、竖幅、单声道、
 * 96kHz 采样、快速运动），每条都走与 daemon 完全相同的持久化渲染路径
 * （plan → 源 hash 复核 → FFmpeg → 质量门 → 原子发布 → Timeline 登记），
 * 并断言质量门全部 passed 且时长偏差 ≤40ms。
 *
 * 纪律：矩阵只接受「能可靠导出的素材形态」，绝不为了通过率加入静音轨或
 * 旋转元数据这类当前管线明确不支持的形态——那些会在真实素材听审中暴露，
 * 并按规定变成 fixture/回归，而不是在这里被静默隐藏。
 */

const temporaryDirectories: string[] = [];
const ffmpegPath = process.env.AGENTCUT_FFMPEG_PATH ?? "ffmpeg";
const ffprobePath = process.env.AGENTCUT_FFPROBE_PATH ?? "ffprobe";

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface MatrixEntry {
  id: string;
  title: string;
  canvas: { width: number; height: number };
  frameRate: { numerator: number; denominator: number };
  /** 生成容器内媒体的一条 ffmpeg 参数链（不含 -y 与输出文件名）。 */
  args: string[];
  /** 额外的流断言（如 VFR 的帧间隔必须不恒定），防矩阵退化。 */
  verify?: (mediaPath: string) => void;
  /** HDR 条目：期望质量报告带 colorApproximate 诚实标记。 */
  expectColorApproximate?: boolean;
  /**
   * 覆盖 clip 在源上的窗口（缺省为从 0 开始的整段媒体）。越尾条目用它请求
   * 越过源尾部的剪切窗口，复现真实口播「末句词边界微超媒体尾」的形态。
   */
  clip?: { sourceStartSeconds: number; requestedDurationSeconds: number };
}

const MATRIX: MatrixEntry[] = [
  {
    id: "baseline-cfr-h264",
    title: "基准 CFR H.264 + AAC 立体声",
    canvas: { width: 320, height: 180 },
    frameRate: { numerator: 30, denominator: 1 },
    args: [
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    ],
  },
  {
    id: "hevc-hvc1",
    title: "HEVC (hvc1) 输入，手机常见封装",
    canvas: { width: 320, height: 180 },
    frameRate: { numerator: 30, denominator: 1 },
    args: [
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx265", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-c:a", "aac", "-shortest",
    ],
  },
  {
    id: "vfr-mixed-rate",
    title: "VFR 混合帧率（24/30/15fps 段拼接）",
    canvas: { width: 320, height: 180 },
    frameRate: { numerator: 30, denominator: 1 },
    args: [], // 由 generateVfrMedia 特殊生成
    verify: (mediaPath) => {
      // 真 VFR：帧间隔必须不恒定；且时间线时长取容器时长（含编码拖尾），
      // 由真实探针读出，不做任何人工假设。
      const deltas = packetDeltaSignature(mediaPath);
      expect(deltas.distinct).toBeGreaterThan(1);
    },
  },
  {
    id: "uhd-4k",
    title: "4K UHD 3840x2160 降采样到画布",
    canvas: { width: 320, height: 180 },
    frameRate: { numerator: 30, denominator: 1 },
    args: [
      "-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    ],
  },
  {
    id: "high-fps-60",
    title: "60fps 高帧率降到 30fps 序列",
    canvas: { width: 320, height: 180 },
    frameRate: { numerator: 30, denominator: 1 },
    args: [
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=60:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    ],
  },
  {
    id: "portrait-source",
    title: "竖幅 180x320 源（contain 黑边适配横幅画布）",
    canvas: { width: 320, height: 180 },
    frameRate: { numerator: 30, denominator: 1 },
    args: [
      "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    ],
  },
  {
    id: "mono-voice",
    title: "单声道语音轨（领夹麦常见）",
    canvas: { width: 320, height: 180 },
    frameRate: { numerator: 30, denominator: 1 },
    args: [
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-af", "pan=mono|c0=c0",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    ],
  },
  {
    id: "hi-res-audio-96k",
    title: "96kHz 高采样音频重采样到 48kHz",
    canvas: { width: 320, height: 180 },
    frameRate: { numerator: 30, denominator: 1 },
    args: [
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=96000:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    ],
  },
  {
    id: "fast-motion",
    title: "快速运动内容（编码器压力）",
    canvas: { width: 320, height: 180 },
    frameRate: { numerator: 30, denominator: 1 },
    args: [
      "-f", "lavfi", "-i", "mandelbrot=size=320x180:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-t", "2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    ],
  },
  {
    id: "rotated-portrait",
    title: "旋转元数据竖拍（存储 640x360 + rotate=90，画布取显示竖幅）",
    canvas: { width: 360, height: 640 },
    frameRate: { numerator: 30, denominator: 1 },
    args: [], // 由 generateRotatedMedia 特殊生成
    verify: (mediaPath) => {
      const probe = probeMedia(mediaPath, ffprobePath);
      expect(probe.streams.find((stream) => stream.type === "video")?.video)
        .toEqual(expect.objectContaining({ width: 640, height: 360, rotation: 90 }));
    },
  },
  {
    id: "anamorphic-sar",
    title: "非方形像素 NTSC（720x480 SAR 8/9，显示 640x480 4:3）",
    canvas: { width: 640, height: 480 },
    frameRate: { numerator: 30, denominator: 1 },
    args: [
      "-f", "lavfi", "-i", "testsrc2=size=720x480:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-vf", "setsar=8/9",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    ],
    verify: (mediaPath) => {
      const probe = probeMedia(mediaPath, ffprobePath);
      expect(probe.streams.find((stream) => stream.type === "video")?.video)
        .toEqual(expect.objectContaining({ width: 720, height: 480, displayWidth: 640, displayHeight: 480 }));
    },
  },
  {
    id: "hdr-pq",
    title: "HDR10（HEVC 10bit + PQ，检测并诚实标记近似 SDR）",
    canvas: { width: 640, height: 360 },
    frameRate: { numerator: 30, denominator: 1 },
    args: [
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-vf", "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
      "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-c:a", "aac", "-shortest",
    ],
    verify: (mediaPath) => {
      const probe = probeMedia(mediaPath, ffprobePath);
      expect(probe.streams.find((stream) => stream.type === "video")?.video)
        .toEqual(expect.objectContaining({ colorTransfer: "smpte2084" }));
    },
    expectColorApproximate: true,
  },
  {
    id: "tail-overrun-final-segment",
    title: "末段越尾素材（音频短于容器，剪切请求越过全部流尾部）",
    canvas: { width: 320, height: 180 },
    frameRate: { numerator: 30, denominator: 1 },
    args: [], // 由 generateTailOverrunMedia 特殊生成
    verify: (mediaPath) => {
      const probe = probeMedia(mediaPath, ffprobePath);
      const video = probe.streams.find((stream) => stream.type === "video");
      const audio = probe.streams.find((stream) => stream.type === "audio");
      const audioMicros = timeToMicros(audio?.duration);
      const videoMicros = timeToMicros(video?.duration);
      const containerMicros = timeToMicros(probe.duration);
      expect(audioMicros).toBeGreaterThan(0);
      expect(videoMicros).toBeGreaterThan(audioMicros + 500_000);
      expect(containerMicros).toBeGreaterThanOrEqual(videoMicros);
    },
    clip: { sourceStartSeconds: 1, requestedDurationSeconds: 5 },
  },
];

describe("offline media matrix render (G4 expanded matrix, deterministic)", () => {
  for (const entry of MATRIX) {
    it(`renders ${entry.id} (${entry.title}) through the full quality gate`, async () => {
      const fixture = await createMatrixProject(entry);
      const store = ProjectStore.create(fixture.databasePath, fixture.document, { checkpointInterval: 1 });
      try {
        store.createJob({
          id: `job_matrix_${entry.id}`,
          type: "export.render",
          payload: { revision: 0, sequenceId: "sequence_main" },
        });
        const result = await runPersistedRenderJob({
          store,
          jobId: `job_matrix_${entry.id}`,
          projectRoot: fixture.directory,
          sequenceId: "sequence_main",
          transcriptArtifactId: "transcript_fixture",
          actor: { kind: "workflow", id: "render_engine" },
          transactionId: `tx_matrix_${entry.id}`,
          idempotencyKey: `matrix-${entry.id}`,
          ...(process.env.AGENTCUT_FFMPEG_PATH ? { ffmpegPath: process.env.AGENTCUT_FFMPEG_PATH } : {}),
          ...(process.env.AGENTCUT_FFPROBE_PATH ? { ffprobePath: process.env.AGENTCUT_FFPROBE_PATH } : {}),
        });
        expect(result.renderReport.quality).toEqual(expect.objectContaining({
          width: entry.canvas.width,
          height: entry.canvas.height,
          hasAudio: true,
          // 越尾条目的 clip 从 1s 开始，字幕词（0.2–1.3s）在窗口外，无 cue。
          subtitleCueCount: entry.clip ? 0 : 1,
          passed: true,
        }));
        expect(result.renderReport.quality.durationDeltaMillis).toBeLessThanOrEqual(40);
        if (entry.clip) {
          // 钳制+截断路径的核心断言：报告必须披露钳后承诺时长，且输出按它交付。
          expect(result.renderReport.quality.expectedOutputMicros).toBe(2_000_000);
          expect(result.renderReport.warnings.some((warning) => warning.includes("past the end of the source media"))).toBe(true);
        }
        if (entry.expectColorApproximate) {
          expect(result.renderReport.quality.colorApproximate).toBe(true);
          expect(result.renderReport.warnings.some((warning) => warning.includes("HDR"))).toBe(true);
        } else {
          expect(result.renderReport.quality.colorApproximate).toBeUndefined();
        }
        expect(probeMedia(result.outputPath).streams.map((stream) => stream.type))
          .toEqual(expect.arrayContaining(["video", "audio"]));
        expect(store.snapshot().project.revision).toBe(1);
      } finally {
        store.close();
      }
    }, 90_000);
  }
});

async function createMatrixProject(entry: MatrixEntry): Promise<{
  directory: string;
  databasePath: string;
  document: AgentCutProjectDocument;
}> {
  const directory = mkdtempSync(join(tmpdir(), "agentcut-media-matrix-"));
  temporaryDirectories.push(directory);
  const mediaDirectory = join(directory, "media");
  mkdirSync(mediaDirectory);
  const mediaPath = join(mediaDirectory, "source.mp4");
  if (entry.id === "vfr-mixed-rate") {
    generateVfrMedia(mediaPath);
  } else if (entry.id === "rotated-portrait") {
    generateRotatedMedia(mediaPath);
  } else if (entry.id === "tail-overrun-final-segment") {
    generateTailOverrunMedia(mediaPath);
  } else {
    runFfmpeg([...entry.args, mediaPath]);
  }
  entry.verify?.(mediaPath);
  const probe = probeMedia(mediaPath, ffprobePath);
  const contentHash = await hashFile(mediaPath);
  const duration = entry.clip
    ? decimalSeconds(entry.clip.requestedDurationSeconds)
    : probe.duration;
  const document: AgentCutProjectDocument = {
    schemaVersion: "0.1.0",
    project: {
      id: `project_matrix_${entry.id}`,
      name: `Matrix ${entry.id}`,
      createdAt: "2026-08-11T10:00:00Z",
      updatedAt: "2026-08-11T10:00:00Z",
      activeSequenceId: "sequence_main",
      revision: 0,
    },
    assets: [{
      id: "asset_source",
      kind: "video",
      uri: "media/source.mp4",
      contentHash,
      availability: "online",
      provenance: {
        createdBy: { kind: "user", id: "local_user" },
        createdAt: "2026-08-11T10:00:00Z",
        reason: `Media matrix fixture: ${entry.title}`,
      },
      metadata: { mediaProbe: probe },
    }],
    sequences: [{
      id: "sequence_main",
      name: "Main",
      canvas: { ...entry.canvas, background: "#000000" },
      frameRate: entry.frameRate,
      tracks: [{
        id: "track_v1",
        kind: "video",
        name: "Main",
        order: 0,
        locked: false,
        enabled: true,
        clips: [{
          id: "clip_source",
          kind: "media",
          assetId: "asset_source",
          streamIndex: 0,
          timelineRange: { start: micros(0), duration },
          sourceRange: {
            start: decimalSeconds(entry.clip?.sourceStartSeconds ?? 0),
            duration,
          },
          enabled: true,
          provenance: {
            createdBy: { kind: "user", id: "local_user" },
            createdAt: "2026-08-11T10:00:00Z",
            reason: "Matrix render source",
          },
        }],
        transitions: [],
      }],
      locks: [],
      markers: [],
    }],
    styleSpecs: [],
    artifacts: [{
      id: "transcript_fixture",
      kind: "transcript",
      assetId: "asset_source",
      language: "zh",
      audioStreamIndex: 1,
      words: [
        { id: "word_hello", text: "你好", confidence: 0.99, sourceRange: range(200_000, 500_000) },
        { id: "word_world", text: "世界", confidence: 0.99, sourceRange: range(800_000, 500_000) },
      ],
      provenance: {
        createdBy: { kind: "workflow", id: "asr" },
        createdAt: "2026-08-11T10:00:00Z",
        reason: "Matrix fixture transcript",
      },
    }],
    exportPresets: [],
    versions: [],
    history: { headRevision: 0, records: [] },
  };
  // 回归守护：越尾条目的 clip 窗口必须真的越过源尾部，否则本条目退化成普通
  // 全片渲染、不再覆盖「末段钳制 + -t 截断」路径。
  if (entry.clip) {
    const clipRange = document.sequences[0]!.tracks[0]!.clips[0]!.sourceRange;
    const clipEndMicros = timeToMicros(clipRange?.start) + timeToMicros(clipRange?.duration);
    expect(clipEndMicros).toBeGreaterThan(timeToMicros(probe.duration) + 500_000);
  }
  return { directory, databasePath: join(directory, "agentcut.sqlite"), document };
}

/** 三段不同帧率（24/30/15）无损拼接，产生帧间隔不恒定的 VFR 容器。 */
function generateVfrMedia(mediaPath: string): void {
  const segmentDirectory = mkdtempSync(join(tmpdir(), "agentcut-vfr-segments-"));
  temporaryDirectories.push(segmentDirectory);
  const segmentSpecs = [
    { rate: 24, color: "0x7b3294" },
    { rate: 30, color: "0xc2a5cf" },
    { rate: 15, color: "0x008837" },
  ];
  const segmentPaths: string[] = [];
  segmentSpecs.forEach((spec, index) => {
    const segmentPath = join(segmentDirectory, `segment-${index}.mp4`);
    runFfmpeg([
      "-f", "lavfi", "-i", `color=c=${spec.color}:s=320x180:r=${spec.rate}:d=1`,
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      segmentPath,
    ]);
    segmentPaths.push(segmentPath);
  });
  const concatList = join(segmentDirectory, "concat.txt");
  writeFileSync(concatList, segmentPaths.map((path) => `file '${path}'`).join("\n"));
  const concatenatedPath = join(segmentDirectory, "concatenated.mp4");
  runFfmpeg(["-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", concatenatedPath]);
  // 段拼接的视频流时长（3.667s，24fps 段的 B 帧拖尾）比音频（3.023s）长；
  // 统一重编码并把音频重采样后垫长，让两条流对齐到同一时间跨度，
  // 同时保留不恒定的视频帧间隔（真 VFR）。
  runFfmpeg([
    "-i", concatenatedPath,
    "-af", "aresample=48000,apad",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    mediaPath,
  ]);
}

/** 手机竖拍：存储为 640x360 横幅 + Display Matrix rotate=90，显示为 360x640 竖幅。 */
function generateRotatedMedia(mediaPath: string): void {
  const baseDirectory = mkdtempSync(join(tmpdir(), "agentcut-rotate-base-"));
  temporaryDirectories.push(baseDirectory);
  const basePath = join(baseDirectory, "base.mp4");
  runFfmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    basePath,
  ]);
  runFfmpeg(["-display_rotation", "90", "-i", basePath, "-c", "copy", mediaPath]);
}

function runFfmpeg(args: string[]): void {
  const result = spawnSync(ffmpegPath, ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr ?? `ffmpeg exited ${result.status}`);
  }
}

/** 返回视频帧 PTS 间隔的种类数；>1 即 VFR。 */
function packetDeltaSignature(mediaPath: string): { distinct: number } {
  const result = spawnSync(ffprobePath, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "packet=pts_time", "-of", "csv=p=0", mediaPath,
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr ?? "ffprobe failed");
  }
  const points = result.stdout.trim().split("\n").map(Number).sort((a, b) => a - b);
  const deltas = new Set<string>();
  for (let index = 1; index < points.length; index += 1) {
    deltas.add((points[index]! - points[index - 1]!).toFixed(3));
  }
  return { distinct: deltas.size };
}

/**
 * 生成「音频短于容器」的越尾素材：testsrc 视频自带静默音轨保证容器时长 =
 * 视频时长（4s），外挂 3s 正弦替换音频流，最终 视频 4.033s > 音频 3.02s，
 * 与真实口播「末句词边界越过媒体尾」的形态同构。
 */
function generateTailOverrunMedia(mediaPath: string): void {
  runFfmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    mediaPath,
  ]);
}

function decimalSeconds(seconds: number): { value: number; rate: { numerator: 1_000_000; denominator: 1 } } {
  return micros(Math.round(seconds * 1_000_000));
}

function timeToMicros(time: { value: number; rate: { numerator: number; denominator: number } } | undefined): number {
  if (!time) return 0;
  return Math.round(time.value * time.rate.denominator * 1_000_000 / time.rate.numerator);
}

function micros(value: number): { value: number; rate: { numerator: 1_000_000; denominator: 1 } } {
  return { value, rate: { numerator: 1_000_000, denominator: 1 } };
}

function range(start: number, duration: number): {
  start: { value: number; rate: { numerator: 1_000_000; denominator: 1 } };
  duration: { value: number; rate: { numerator: 1_000_000; denominator: 1 } };
} {
  return { start: micros(start), duration: micros(duration) };
}
