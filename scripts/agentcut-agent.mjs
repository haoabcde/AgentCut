import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadAgentCredential } from "./agentcut-credentials.mjs";

let agentCredential;
try {
  agentCredential = loadAgentCredential();
  if (agentCredential.kind === "bootstrap") {
    process.env.AGENTCUT_AGENT_BOOTSTRAP_TOKEN = agentCredential.bootstrapToken;
  } else if (!process.env.AGENTCUT_DAEMON_URL) {
    process.env.AGENTCUT_DAEMON_URL = agentCredential.daemonUrl;
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
  process.exitCode = 5;
}

const cliPath = resolve("packages/agent-client/dist/cli.js");
const build = process.exitCode === undefined ? spawnSync(
  "pnpm",
  ["--filter", "@agentcut/agent-client", "build"],
  { cwd: process.cwd(), encoding: "utf8" },
) : undefined;
if (build?.stdout) process.stderr.write(build.stdout);
if (build?.stderr) process.stderr.write(build.stderr);
if (build && (build.error || build.status !== 0)) {
  process.stderr.write(`${JSON.stringify({
    error: {
      code: "CLI_BUILD_FAILED",
      message: build.error?.message ?? `Agent CLI build exited with ${build.status}`,
    },
  })}\n`);
  process.exitCode = 7;
}

if (process.exitCode === undefined) {
  const { runAgentCli } = await import(pathToFileURL(cliPath).href);
  process.exitCode = await runAgentCli(process.argv.slice(2), {
    ...(agentCredential?.kind === "session" ? { session: agentCredential.credential } : {}),
  });
}
