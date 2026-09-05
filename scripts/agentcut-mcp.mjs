import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadAgentCredential } from "./agentcut-credentials.mjs";

try {
  const credential = loadAgentCredential();
  if (credential.kind === "bootstrap") {
    process.env.AGENTCUT_AGENT_BOOTSTRAP_TOKEN = credential.bootstrapToken;
  } else {
    process.env.AGENTCUT_AGENT_SESSION_CREDENTIAL = Buffer.from(
      JSON.stringify(credential.credential),
      "utf8",
    ).toString("base64url");
    if (!process.env.AGENTCUT_DAEMON_URL) process.env.AGENTCUT_DAEMON_URL = credential.daemonUrl;
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    error: {
      code: typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "AGENT_CREDENTIALS_INVALID",
      message: error instanceof Error ? error.message : String(error),
    },
  })}\n`);
  process.exitCode = 7;
}

const build = process.exitCode === undefined ? spawnSync(
  "pnpm",
  ["--filter", "@agentcut/mcp-server", "build"],
  { cwd: process.cwd(), encoding: "utf8" },
) : undefined;
if (build?.stdout) process.stderr.write(build.stdout);
if (build?.stderr) process.stderr.write(build.stderr);
if (build && (build.error || build.status !== 0)) {
  process.stderr.write(`${JSON.stringify({
    error: {
      code: "MCP_BUILD_FAILED",
      message: build.error?.message ?? `AgentCut MCP build exited with ${build.status}`,
    },
  })}\n`);
  process.exit(7);
}

if (process.exitCode === undefined) {
  await import(pathToFileURL(resolve("apps/mcp-server/dist/cli.js")).href);
}
