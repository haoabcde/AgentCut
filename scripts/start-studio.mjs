import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ensureAgentCredentialFile, ensureUiCredentialFile } from "./agentcut-credentials.mjs";
import { resolveStudioMediaTools } from "./studio-media-tools.mjs";

const projectArgument = process.argv.slice(2).find((argument) => argument !== "--");
if (!projectArgument) {
  throw new Error("Usage: pnpm studio -- <project-directory>");
}

const projectRoot = resolve(projectArgument);
const databasePath = join(projectRoot, "agentcut.sqlite");
if (!existsSync(databasePath)) {
  throw new Error(`AgentCut project database does not exist: ${databasePath}`);
}
const agentCredential = ensureAgentCredentialFile(projectRoot);
const uiCredential = ensureUiCredentialFile(projectRoot);
console.log(`Agent credentials: ${agentCredential.credentialPath}`);

const build = spawnSync("pnpm", ["build"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const port = process.env.AGENTCUT_PORT ?? "4317";
console.log(`Studio pairing URL: http://127.0.0.1:${port}/#ui-bootstrap=${encodeURIComponent(uiCredential.bootstrapToken)}`);
const semanticBaseUrl = process.env.AGENTCUT_SEMANTIC_BASE_URL ?? "http://127.0.0.1:1234/v1";
const semanticModel = process.env.AGENTCUT_SEMANTIC_MODEL
  ?? await discoverLocalSemanticModel(semanticBaseUrl);
if (semanticModel) console.log(`Local semantic review model: ${semanticModel}`);
else console.log("Local semantic review is unavailable: LM Studio model server was not detected.");
const mediaTools = resolveStudioMediaTools();
if (mediaTools.ffmpegPath) console.log(`FFmpeg export runtime: ${mediaTools.ffmpegPath}`);
const daemon = spawn("node", ["apps/local-daemon/dist/cli.js"], {
  stdio: "inherit",
  env: {
    ...process.env,
    AGENTCUT_PROJECT_DB: databasePath,
    AGENTCUT_PROJECT_ROOT: projectRoot,
    AGENTCUT_PORT: port,
    AGENTCUT_SEMANTIC_BASE_URL: semanticBaseUrl,
    AGENTCUT_AGENT_BOOTSTRAP_TOKEN: agentCredential.bootstrapToken,
    AGENTCUT_UI_CREDENTIAL_PATH: uiCredential.credentialPath,
    ...(mediaTools.ffmpegPath ? { AGENTCUT_FFMPEG_PATH: mediaTools.ffmpegPath } : {}),
    ...(mediaTools.ffprobePath ? { AGENTCUT_FFPROBE_PATH: mediaTools.ffprobePath } : {}),
    ...(semanticModel ? { AGENTCUT_SEMANTIC_MODEL: semanticModel } : {}),
  },
});

const stop = (signal) => {
  if (!daemon.killed) daemon.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
daemon.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

async function discoverLocalSemanticModel(baseUrl) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;
    const payload = await response.json();
    const models = Array.isArray(payload?.data)
      ? payload.data.map((item) => item?.id).filter((id) => typeof id === "string")
      : [];
    const chatModels = models.filter((id) => !/embed/i.test(id));
    return chatModels.find((id) => /26b|32b|70b/i.test(id)) ?? chatModels[0];
  } catch {
    return undefined;
  }
}
