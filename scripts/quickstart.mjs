#!/usr/bin/env node
/**
 * Quickstart (docs/19 P5): seed a demo project, start the AgentCut reference
 * host on 127.0.0.1, and print everything an MCP client or plain HTTP agent
 * needs to run one read → discover → propose (transaction) → review (diff)
 * loop. No cloud services; the bootstrap token is local to this demo run.
 *
 * Usage: pnpm quickstart [--project-dir <dir>] [--port <port>]
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const FIXTURE = join(REPO_ROOT, "packages/timeline-schema/fixtures/minimal-project.json");

function parseArgs(argv) {
  let projectDir = join(REPO_ROOT, ".agentcut-quickstart");
  let port = 4318;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--project-dir" && next) { projectDir = resolve(next); index += 1; continue; }
    if (arg === "--port" && next) { port = Number(next); index += 1; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be a valid TCP port");
  }
  return { projectDir, port };
}

function ensureBuilt() {
  const required = [
    join(REPO_ROOT, "apps/reference-host/dist/index.js"),
    join(REPO_ROOT, "packages/project-store/dist/index.js"),
    join(REPO_ROOT, "apps/mcp-server/dist/cli.js"),
  ];
  if (required.every((path) => existsSync(path))) return;
  process.stdout.write("[quickstart] building workspace (pnpm build)…\n");
  const build = spawnSync("pnpm", ["build"], { cwd: REPO_ROOT, stdio: "inherit" });
  if (build.status !== 0) throw new Error("pnpm build failed");
}

const { projectDir, port } = parseArgs(process.argv.slice(2));
ensureBuilt();

const { ProjectStore } = await import("../packages/project-store/dist/index.js");
const { createReferenceHost } = await import("../apps/reference-host/dist/index.js");

// Demo database is recreated on every run so the walkthrough always starts at revision 0.
rmSync(projectDir, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });
const databasePath = join(projectDir, "project.sqlite");
ProjectStore.create(databasePath, JSON.parse(readFileSync(FIXTURE, "utf8"))).close();

const bootstrapToken = randomBytes(24).toString("hex");
const server = createReferenceHost({
  databasePath,
  agentBootstrapToken: bootstrapToken,
});
server.listen(port, "127.0.0.1", () => {
  const baseUrl = `http://127.0.0.1:${port}`;
  const mcpEntry = {
    command: "node",
    args: [join(REPO_ROOT, "apps/mcp-server/dist/cli.js")],
    env: {
      AGENTCUT_DAEMON_URL: baseUrl,
      AGENTCUT_AGENT_BOOTSTRAP_TOKEN: bootstrapToken,
    },
  };
  const mcpConfig = { mcpServers: { agentcut: mcpEntry } };
  const output = `
AgentCut reference host is running.

  Host:         ${baseUrl}
  Demo project: ${databasePath}  (fixture project, recreated on each run)
  Demo token:   ${bootstrapToken}   (localhost demo only — do not reuse)

Connect an MCP client and ask it, in your own words, to disable clip
"clip_take_1" — the agent should read the project, discover the timeline,
commit one atomic transaction, and show it in the diff. Host-side acceptance:
revision 0 → 1, exactly one diff change.

  Claude Code:    claude mcp add-json agentcut '${JSON.stringify(mcpEntry)}'
  Codex (TOML):
      [mcp_servers.agentcut]
      command = "node"
      args = ["${mcpEntry.args[0]}"]
      env = { AGENTCUT_DAEMON_URL = "${baseUrl}", AGENTCUT_AGENT_BOOTSTRAP_TOKEN = "${bootstrapToken}" }
  Any other MCP host: config written to ${join(projectDir, "mcp.json")}

Prefer plain HTTP? One full propose → review loop:

  # 1. exchange the bootstrap token for a scoped, expiring session credential
  SESSION=$(curl -s -X POST ${baseUrl}/api/agent/sessions \\
    -H 'Authorization: Bearer ${bootstrapToken}' \\
    -H 'Content-Type: application/json' \\
    -d '{"requestId":"quickstart-session-001","clientId":"quickstart",
         "capabilities":["project:read","transcript:read","timeline:write:low_risk_only"],
         "ttlSeconds":3600}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')

  # 2. read the project (revision) and discover the timeline structure
  curl -s ${baseUrl}/api/agent/project -H "Authorization: Bearer $SESSION"
  curl -s ${baseUrl}/api/agent/timeline -H "Authorization: Bearer $SESSION"

  # 3. propose + commit one atomic edit, then review the diff
  curl -s -X POST ${baseUrl}/api/agent/timeline/transactions \\
    -H "Authorization: Bearer $SESSION" -H 'Content-Type: application/json' \\
    -H 'x-agentcut-request-id: quickstart-tx-001' \\
    -d '{"protocolVersion":"0.1.0","transactionId":"quickstart-tx-001",
         "idempotencyKey":"quickstart-tx-001","projectId":"project_demo_001",
         "sequenceId":"sequence_main","baseRevision":0,
         "actor":{"kind":"agent","id":"quickstart"},"reason":"quickstart demo",
         "preconditions":[],
         "operations":[{"type":"clip.update","clipId":"clip_take_1","patch":{"enabled":false}}]}'
  curl -s "${baseUrl}/api/agent/project/diff?fromRevision=0" -H "Authorization: Bearer $SESSION"

Spec: docs/protocol/agentcut-protocol-0.1.md · Conformance suite: packages/conformance
Press Ctrl+C to stop.
`;
  process.stdout.write(output);
  const configPath = join(projectDir, "mcp.json");
  writeFileSync(configPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  process.stdout.write("\n[quickstart] reference host stopped (demo data kept in .agentcut-quickstart/)\n");
  process.exit(0);
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
