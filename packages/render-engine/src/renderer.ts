import { spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";
import type { RenderPlan } from "./types.js";
import { RenderError } from "./types.js";

export interface FfmpegRenderOptions {
  workDirectory: string;
  assFileName: string;
  outputFileName: string;
  ffmpegPath?: string;
  signal?: AbortSignal;
}

export function compileFfmpegArgs(
  plan: RenderPlan,
  assFileName: string,
  outputFileName: string,
): string[] {
  assertLocalFileName(assFileName);
  assertLocalFileName(outputFileName);
  const args = ["-hide_banner", "-nostdin", "-y"];
  for (const inputPath of plan.inputPaths) args.push("-i", inputPath);
  const filter: string[] = [];
  const frameRate = `${plan.frameRate.numerator}/${plan.frameRate.denominator}`;
  const segmentDurations = plan.segments.map((segment) =>
    // 段尾越过源媒体尾部时（末句词边界微超、末尾音频短于容器），trim 请求的是
    // 不存在的媒体，concat 会按视频流尾部拉伸使最终段溢出并触发质量门；钳到
    // 真实可用媒体时长（plan.expectedOutputMicros 即钳后总和）。
    Math.min(segment.durationMicros, segment.availableSourceMicros)
  );
  plan.segments.forEach((segment, index) => {
    const start = seconds(segment.sourceStartMicros);
    const duration = seconds(segmentDurations[index]!);
    // 显示宽高与存储宽高的差异（旋转 90/270、非方形像素 SAR）先在滤镜图内
    // 归一化为显示尺寸，再按显示宽高比做 contain/cover 适配；否则 scale 会按
    // 存储宽高比压缩画面（变形/错位）。
    const needsPrefit = segment.sourceDisplayWidth > 0 && segment.sourceDisplayHeight > 0
      && (segment.sourceDisplayWidth !== segment.sourceDisplayHeight
        || segment.sourceDisplayWidth !== plan.width);
    const prefit = needsPrefit
      ? `scale=${segment.sourceDisplayWidth}:${segment.sourceDisplayHeight}`
      : "null";
    filter.push(
      `[${segment.inputIndex}:v:${segment.videoStreamOrdinal}]trim=start=${start}:duration=${duration},setpts=PTS-STARTPTS,${prefit},${videoFitFilter(plan)},setsar=1,fps=${frameRate}[v${index}]`,
      `[${segment.inputIndex}:a:${segment.audioStreamOrdinal}]atrim=start=${start}:duration=${duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${index}]`,
    );
  });
  if (plan.segments.length === 1) {
    filter.push("[v0]null[vcat]", "[a0]anull[acat]");
  } else {
    const inputs = plan.segments.map((_, index) => `[v${index}][a${index}]`).join("");
    filter.push(`${inputs}concat=n=${plan.segments.length}:v=1:a=1[vcat][acat]`);
  }
  filter.push(`[vcat]ass=filename=${assFileName}[vout]`);
  args.push(
    "-filter_complex", filter.join(";"),
    "-map", "[vout]",
    "-map", "[acat]",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    // 按钳后时长之和截断输出：源尾溢出段的视频流尾部比实际媒体长（无 -shortest
    // 时 concat 会把它拉长），而 -shortest 又会被音频 AAC priming/padding 拖短数百
    // 毫秒；两者都会突破质量门 40ms 容差。显式 -t 以 33ms 帧格精度截断，最可靠。
    "-t", seconds(plan.expectedOutputMicros),
    outputFileName,
  );
  return args;
}

export async function runFfmpegRender(
  plan: RenderPlan,
  options: FfmpegRenderOptions,
): Promise<{ rendererVersion: string; stderr: string }> {
  const ffmpegPath = options.ffmpegPath ?? process.env.AGENTCUT_FFMPEG_PATH ?? "ffmpeg";
  const version = ffmpegVersion(ffmpegPath);
  const args = compileFfmpegArgs(plan, options.assFileName, options.outputFileName);
  const stderr = await spawnCollect(ffmpegPath, args, options.workDirectory, options.signal);
  return { rendererVersion: version, stderr };
}

export function ffmpegVersion(ffmpegPath = "ffmpeg"): string {
  const result = spawnSync(ffmpegPath, ["-version"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new RenderError("RENDER_FAILED", "FFmpeg is unavailable", {
      cause: result.error?.message ?? result.stderr.trim(),
    });
  }
  return result.stdout.split("\n")[0]?.trim() || "ffmpeg unknown";
}

function spawnCollect(
  executable: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      ...(signal ? { signal } : {}),
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2_000_000);
    });
    child.on("error", (error) => {
      reject(new RenderError("RENDER_FAILED", "FFmpeg could not start", { cause: error.message }));
    });
    child.on("close", (code, signalName) => {
      if (code === 0) resolve(stderr);
      else reject(new RenderError("RENDER_FAILED", `FFmpeg render failed for ${basename(cwd)}`, {
        exitCode: code,
        signal: signalName,
        stderr: stderr.slice(-20_000),
      }));
    });
  });
}

function seconds(micros: number): string {
  return (micros / 1_000_000).toFixed(6);
}

/**
 * Alpha 画面适配滤镜：
 * - `contain`（默认）：整幅缩放进画布并加黑边，不裁掉任何画面内容；
 * - `cover`：等比放大填满画布后从中心裁切，用于 9:16 等竖屏导出预设。
 *   当前只支持中心裁切，没有人物跟踪；plan/quality report 会如实标注 approximate。
 */
export function videoFitFilter(plan: RenderPlan): string {
  if (plan.fitMode === "cover") {
    return `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=increase,crop=${plan.width}:${plan.height}`;
  }
  return `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

function assertLocalFileName(value: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new RenderError("INVALID_CONFIGURATION", "Render work files must use safe local names");
  }
}
