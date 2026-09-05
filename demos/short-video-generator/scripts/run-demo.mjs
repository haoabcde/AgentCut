import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const asrPython = resolve(repositoryRoot, "packages/asr-worker/.venv/bin/python");
const asrScript = resolve(repositoryRoot, "packages/asr-worker/transcribe.py");
export const ffmpegPath = process.env.AGENTCUT_FFMPEG_PATH ?? "ffmpeg";
export const ffprobePath = process.env.AGENTCUT_FFPROBE_PATH ?? "ffprobe";

export const defaultOutputDir = "/tmp/agentcut-shorts-demo";

const syntheticScript = `Hello and welcome to the Future of Work podcast. I'm your host, Alex.
Today, we're going to explore how artificial intelligence is reshaping the way we work.
First, AI is not just replacing repetitive tasks. It is changing how teams collaborate, how decisions are made, and how creative work happens.
The bottleneck is no longer execution. It is taste, judgment, and strategy.
Second, remote work is becoming the default. But the real challenge is staying focused when our tools keep interrupting us.
The best teams write things down, record short videos, and protect deep work blocks.
Third, learning is now a permanent part of any career. Skills that matter today may be outdated in three years.
So here's the question. In a world where AI can do more of the work, what becomes uniquely human? I believe it is empathy, storytelling, and the ability to ask better questions.
Thanks for listening. Share this episode with someone thinking about the future of work.`;

export async function runPipeline(options) {
  const { inputPath: providedInput, outputDir, onProgress } = options;
  let progress = 0;
  const emit = (stage, detail, overrideProgress) => {
    if (overrideProgress !== undefined) progress = overrideProgress;
    const payload = { stage, detail, progress: Math.min(100, Math.round(progress)), time: Date.now() };
    if (onProgress) onProgress(payload);
    else console.log(`[${stage}] ${detail} (${payload.progress}%)`);
  };

  mkdirSync(outputDir, { recursive: true });

  emit("prepare", "Starting pipeline...", 0);
  const inputPath = providedInput ?? await generateSyntheticPodcast(outputDir, emit);
  emit("input", inputPath, 15);

  emit("asr", "Running English ASR with AgentCut mlx-whisper worker...", 18);
  const asrResult = await runAsr(inputPath, outputDir, emit);
  const duration = await probeDuration(inputPath);
  const wordCount = asrResult.segments?.flatMap((s) => s.words ?? []).length ?? 0;
  emit("asr", `Transcribed ${wordCount} words`, 60);

  emit("select", "Picking highlight clips...", 65);
  const highlights = pickHighlights(asrResult, duration, 3, 25, 40);
  emit("select", `Selected ${highlights.length} clips`, 70);

  const results = [];
  const renderShare = 30 / Math.max(1, highlights.length);
  for (let i = 0; i < highlights.length; i += 1) {
    const clip = highlights[i];
    const clipDir = join(outputDir, `clip-${String(i + 1).padStart(2, "0")}`);
    mkdirSync(clipDir, { recursive: true });
    const assPath = join(clipDir, "subtitles.ass");
    const outputPath = join(clipDir, "short.mp4");
    writeFileSync(assPath, buildAss(clip.words, "Future of Work"), "utf8");
    const renderStart = 70 + i * renderShare;
    emit("render", `Rendering clip ${i + 1}/${highlights.length}...`, renderStart);
    renderShort(inputPath, clip.start, clip.end, assPath, outputPath);
    results.push({ index: i + 1, start: clip.start, end: clip.end, text: clip.text, path: outputPath });
    emit("render", `Clip ${i + 1}: ${clip.start.toFixed(2)}s - ${clip.end.toFixed(2)}s`, renderStart + renderShare - 2);
  }

  const report = { input: inputPath, duration, highlights: results };
  writeFileSync(join(outputDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  emit("done", report, 100);
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const useSynthetic = args.includes("--synthetic") || args.length === 0;
  const outputDir = process.env.SHORTS_OUTPUT_DIR ?? defaultOutputDir;

  let inputPath;
  if (useSynthetic) {
    inputPath = undefined;
  } else {
    inputPath = resolve(args.find((a) => !a.startsWith("--")) ?? "");
    if (!existsSync(inputPath)) {
      throw new Error(`Input not found: ${inputPath}. Use --synthetic to generate a sample podcast.`);
    }
  }

  await runPipeline({ inputPath, outputDir });
}

async function generateSyntheticPodcast(outputDir, emit) {
  const scriptPath = join(outputDir, "podcast-script.txt");
  const audioPath = join(outputDir, "podcast.aiff");
  const videoPath = join(outputDir, "podcast.mp4");
  writeFileSync(scriptPath, syntheticScript, "utf8");

  emit("synthetic", "Synthesizing sample podcast audio with system TTS...");
  await execFile("say", ["-v", "Alex", "-o", audioPath, "-f", scriptPath]);

  const duration = parseFloat(await probeRaw(audioPath, "format=duration"));
  emit("synthetic", `Audio duration: ${duration.toFixed(1)}s`);

  emit("synthetic", "Building sample podcast video with neutral background...");
  await execFile(ffmpegPath, [
    "-f", "lavfi", "-i", `color=c=0x0f172a:s=1920x1080:d=${duration}`,
    "-i", audioPath,
    "-vf", `drawtext=fontfile=/System/Library/Fonts/STHeiti%20Medium.ttc:fontsize=56:fontcolor=white:x=(w-text_w)/2:y=120:text='Future of Work Podcast',drawtext=fontfile=/System/Library/Fonts/STHeiti%20Medium.ttc:fontsize=32:fontcolor=0x94a3b8:x=(w-text_w)/2:y=200:text='AI and the Future of Work'`,
    "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-shortest", videoPath,
  ]);

  return videoPath;
}

async function runAsr(inputPath, outputDir, emit) {
  const outputPath = join(outputDir, "asr-result.json");
  if (existsSync(outputPath)) {
    emit("asr", "Reusing existing ASR result.");
    return JSON.parse(readFileSync(outputPath, "utf8"));
  }
  emit("asr", "Running English ASR with AgentCut mlx-whisper worker...");
  await execFile(asrPython, [
    asrScript,
    "--input", inputPath,
    "--output", outputPath,
    "--model", process.env.AGENTCUT_ASR_MODEL ?? "mlx-community/whisper-large-v3-turbo",
    "--language", "en",
  ]);
  return JSON.parse(readFileSync(outputPath, "utf8"));
}

async function probeDuration(inputPath) {
  return parseFloat(await probeRaw(inputPath, "format=duration"));
}

async function probeRaw(inputPath, entries) {
  const { stdout } = await execFile(ffprobePath, [
    "-v", "error",
    "-show_entries", entries,
    "-of", "default=noprint_wrappers=1:nokey=1",
    inputPath,
  ], { stdio: ["ignore", "pipe", "inherit"] });
  return stdout.trim();
}

function pickHighlights(asrResult, duration, count, minDuration, maxDuration) {
  const segments = asrResult.segments ?? [];
  if (segments.length === 0) throw new Error("ASR produced no segments");

  const candidates = [];
  for (let i = 0; i < segments.length; i += 1) {
    let start = segments[i].start;
    let end = segments[i].end;
    const words = [];
    for (let j = i; j < segments.length; j += 1) {
      end = segments[j].end;
      words.push(...(segments[j].words ?? []));
      const length = end - start;
      if (length >= minDuration && length <= maxDuration) {
        candidates.push({ start, end, words, text: words.map((w) => w.word).join(" ") });
        break;
      }
      if (length > maxDuration) break;
    }
  }

  if (candidates.length === 0) {
    const clipLength = Math.max(minDuration, duration / count);
    const split = [];
    for (let i = 0; i < count; i += 1) {
      const start = i * clipLength;
      const end = Math.min(start + clipLength, duration);
      if (end - start >= minDuration) {
        split.push({ start, end, words: [], text: "" });
      }
    }
    return split;
  }

  candidates.forEach((c) => { c.density = c.words.length / (c.end - c.start); });
  candidates.sort((a, b) => b.density - a.density);

  const selected = [];
  for (const candidate of candidates) {
    if (selected.length >= count) break;
    const overlap = selected.some((s) => candidate.start < s.end && candidate.end > s.start);
    if (!overlap) selected.push(candidate);
  }

  if (selected.length < count && selected.length > 0) {
    const lastSelectedEnd = Math.max(...selected.map((s) => s.end));
    const tailStart = lastSelectedEnd + 2;
    if (duration - tailStart >= 12) {
      const tailWords = segments.flatMap((s) => s.words ?? []).filter((w) => w.start >= tailStart && w.end <= duration);
      selected.push({ start: tailStart, end: duration, words: tailWords, text: tailWords.map((w) => w.word).join(" ") });
    }
  }

  selected.sort((a, b) => a.start - b.start);
  return selected.map((s) => ({ start: s.start, end: s.end, words: s.words, text: s.text }));
}

function buildAss(words, title) {
  const lines = groupWordsIntoLines(words, 10);
  const events = lines.map(({ start, end, text }) => {
    return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${text}`;
  }).join("\n");

  return `[Script Info]
Title: AgentCut Shorts Demo
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,PingFang SC,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,4,0,2,80,80,160,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}`;
}

function groupWordsIntoLines(words, maxWordsPerLine) {
  const lines = [];
  let current = [];
  for (const word of words) {
    if (current.length >= maxWordsPerLine) {
      lines.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) lines.push(current);

  return lines.map((group) => ({
    start: group[0].start,
    end: group[group.length - 1].end,
    text: group.map((w) => w.word).join(" ").replace(/\s+/g, " ").trim(),
  }));
}

function formatAssTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const centis = Math.floor((secs % 1) * 100);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(Math.floor(secs)).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

function renderShort(inputPath, start, end, assPath, outputPath) {
  const duration = end - start;
  const title = "Future of Work";
  const fontfile = "/System/Library/Fonts/STHeiti Medium.ttc";
  const drawTitle = `drawtext=fontfile=${fontfile}:fontsize=48:fontcolor=white:x=60:y=60:text='${title}'`;
  const drawProgress = `drawtext=fontfile=${fontfile}:fontsize=28:fontcolor=0x94a3b8:x=60:y=118:text='AI podcast clip'`;

  const vf = `split[orig][copy];[copy]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20[bg];[orig]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,ass='${assPath}',${drawTitle},${drawProgress},format=yuv420p`;

  const proc = spawnSync(ffmpegPath, [
    "-ss", String(start),
    "-t", String(duration),
    "-i", inputPath,
    "-vf", vf,
    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-y", outputPath,
  ], { stdio: "inherit" });
  if (proc.status !== 0) throw new Error("Render failed");
}

function execFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(`Command failed with code ${code}: ${command} ${args.join(" ")}`));
    });
  });
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
