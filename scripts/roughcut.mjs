import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRoughCutProject,
  parseRoughCutCliArguments,
} from "../packages/rough-cut-workflow/dist/index.js";
import { inspectRenderEnvironment } from "../packages/render-engine/dist/index.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const input = parseRoughCutCliArguments(process.argv.slice(2));
const projectRoot = resolve(input.projectRoot);
mkdirSync(projectRoot, { recursive: true });
const renderCapability = inspectRenderEnvironment({
  projectRoot,
  ...(process.env.AGENTCUT_FFMPEG_PATH
    ? { ffmpegPath: process.env.AGENTCUT_FFMPEG_PATH }
    : {}),
  ...(process.env.AGENTCUT_FFPROBE_PATH
    ? { ffprobePath: process.env.AGENTCUT_FFPROBE_PATH }
    : {}),
  ...(process.env.AGENTCUT_FFMPEG_PATH
    ? { ffmpegPath: process.env.AGENTCUT_FFMPEG_PATH }
    : {}),
});
const created = await createRoughCutProject({
  sourcePath: resolve(input.sourcePath),
  projectRoot,
  ...(input.name ? { name: input.name } : {}),
  alphaTrial: input.alphaTrial,
  model: process.env.AGENTCUT_ASR_MODEL ?? "mlx-community/whisper-large-v3-turbo",
  pythonPath: resolve(repositoryRoot, "packages/asr-worker/.venv/bin/python"),
  workerScriptPath: resolve(repositoryRoot, "packages/asr-worker/transcribe.py"),
  ...(process.env.AGENTCUT_FFPROBE_PATH
    ? { ffprobePath: process.env.AGENTCUT_FFPROBE_PATH }
    : {}),
});

console.log(JSON.stringify({
  ...created,
  renderCapability,
  next: `pnpm studio -- ${projectRoot}`,
}, null, 2));
