#!/usr/bin/env node
/**
 * P3 真实 Agent E2E（docs/19 §3 P3）：让真实的 Claude Code / Codex CLI 经 MCP
 * 对一个真实 reference-host 完成一次完整剪辑会话（读工程 → 发现时间线 → 读
 * transcript → 提交事务 → 读 diff 确认），并以宿主状态为独立证据做验收。
 *
 * 用法：
 *   node scripts/agent-e2e.mjs --agent claude
 *   node scripts/agent-e2e.mjs --agent codex
 *
 * 产物：宿主状态断言（本脚本独立验证，不信任 agent 自述）+ 会话日志
 * （默认 /tmp/agentcut-agent-e2e/<timestamp>-<agent>.log）。
 * 脚本可重复执行：每次运行使用全新临时工程数据库。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { createReferenceHost } from "../apps/reference-host/dist/index.js";
import { ProjectStore } from "../packages/project-store/dist/index.js";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const MCP_CLI = join(REPO_ROOT, "apps/mcp-server/dist/cli.js");
const FIXTURE = join(REPO_ROOT, "packages/timeline-schema/fixtures/minimal-project.json");
const BOOTSTRAP_TOKEN = "agent-e2e-bootstrap-token";
const MCP_CLIENT_ID = "agentcut-mcp";

function parseArgs(argv) {
  let agent;
  let logDir = "/tmp/agentcut-agent-e2e";
  let timeoutMs = 300_000;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--agent" && next) { agent = next; index += 1; continue; }
    if (arg === "--log-dir" && next) { logDir = next; index += 1; continue; }
    if (arg === "--timeout-ms" && next) { timeoutMs = Number(next); index += 1; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (agent !== "claude" && agent !== "codex") {
    throw new Error("--agent must be 'claude' or 'codex'");
  }
  return { agent, logDir, timeoutMs };
}

function ensureBuilt() {
  const required = [
    MCP_CLI,
    join(REPO_ROOT, "apps/reference-host/dist/index.js"),
    join(REPO_ROOT, "packages/project-store/dist/index.js"),
  ];
  if (required.every((path) => existsSync(path))) return;
  process.stdout.write("[agent-e2e] building workspace packages (pnpm build)…\n");
  execFileSync("pnpm", ["build"], { cwd: REPO_ROOT, stdio: "inherit" });
}

function startReferenceHost(databasePath) {
  const server = createReferenceHost({
    databasePath,
    agentBootstrapToken: BOOTSTRAP_TOKEN,
  });
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveListen({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function httpJson(baseUrl, path, token) {
  const response = await fetch(new URL(path, baseUrl), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}`);
  return response.json();
}

const PROMPT = `You are driving a local video-editing host through MCP tools named agentcut_*.
Use ONLY those MCP tools — do not use the shell, do not read or write files.

Steps, in order:
1. Call agentcut_project_get to read the project summary and its current revision.
2. Call agentcut_timeline_get to discover the tracks and clips.
3. Call agentcut_transcript_get once with limit 2 to sample the transcript.
4. Commit exactly ONE atomic timeline transaction via agentcut_timeline_apply_transaction
   that disables the first video clip: operation type "clip.update" with patch {"enabled": false},
   addressing the clipId you discovered in step 2, baseRevision equal to the revision from step 1,
   a unique transactionId and idempotencyKey of your choosing, and a short reason.
5. Call agentcut_project_diff with fromRevision = the revision from step 1 and confirm your
   transaction appears with actor id "${MCP_CLIENT_ID}".

Do not create any other transaction. If a call fails, report the error instead of retrying
more than once.

Finish by replying with one final line of JSON only:
{"projectRevision": <number>, "clipId": "<string>", "diffConfirmed": <boolean>}`;

function buildClaudeArgs(mcpConfigPath) {
  const tools = [
    "agentcut_project_get",
    "agentcut_timeline_get",
    "agentcut_transcript_get",
    "agentcut_timeline_apply_transaction",
    "agentcut_project_diff",
  ].map((tool) => `mcp__agentcut__${tool}`);
  return ["-p", PROMPT, "--mcp-config", mcpConfigPath, "--allowedTools", tools.join(",")];
}

function buildCodexArgs(baseUrl) {
  const tomlString = (value) => JSON.stringify(value);
  return [
    "exec",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "-c", `mcp_servers.agentcut.command=${tomlString("node")}`,
    "-c", `mcp_servers.agentcut.args=${tomlString([MCP_CLI])}`,
    "-c", `mcp_servers.agentcut.env={ AGENTCUT_DAEMON_URL = ${tomlString(baseUrl)}, AGENTCUT_AGENT_BOOTSTRAP_TOKEN = ${tomlString(BOOTSTRAP_TOKEN)} }`,
    PROMPT,
  ];
}

function runAgent(agent, args, options) {
  const { logPath, cwd, timeoutMs } = options;
  const command = agent === "claude" ? "claude" : "codex";
  const env = { ...process.env };
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      writeFileSync(
        logPath,
        `# command: ${command} ${args.join(" ")}\n\n# stdout\n${stdout}\n\n# stderr\n${stderr}\n`,
      );
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

async function main() {
  const { agent, logDir, timeoutMs } = parseArgs(process.argv.slice(2));
  ensureBuilt();

  const directory = mkdtempSync(join(tmpdir(), "agentcut-agent-e2e-"));
  const databasePath = join(directory, "agentcut.sqlite");
  ProjectStore.create(databasePath, JSON.parse(readFileSync(FIXTURE, "utf8"))).close();
  const { server, baseUrl } = await startReferenceHost(databasePath);
  process.stdout.write(`[agent-e2e] reference host listening at ${baseUrl}\n`);

  mkdirSync(logDir, { recursive: true });
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const logPath = join(logDir, `${stamp}-${agent}.log`);

  try {
    // 首个 session（bootstrap 换 token 由 MCP server 内的 agent-client 完成）。
    const sessionResponse = await fetch(new URL("/api/agent/sessions", baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${BOOTSTRAP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: `agent-e2e-verify-${stamp}`,
        clientId: "agent-e2e-verifier",
        capabilities: ["project:read", "transcript:read"],
        ttlSeconds: 3_600,
      }),
    });
    if (sessionResponse.status !== 201) throw new Error("verifier session creation failed");
    const verifierToken = (await sessionResponse.json()).accessToken;

    const before = await httpJson(baseUrl, "/api/agent/project", verifierToken);
    const revisionBefore = before.project.revision;

    let args;
    let cwd = directory;
    if (agent === "claude") {
      const mcpConfigPath = join(directory, "mcp-config.json");
      writeFileSync(mcpConfigPath, JSON.stringify({
        mcpServers: {
          agentcut: {
            command: "node",
            args: [MCP_CLI],
            env: {
              AGENTCUT_DAEMON_URL: baseUrl,
              AGENTCUT_AGENT_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
            },
          },
        },
      }, null, 2));
      args = buildClaudeArgs(mcpConfigPath);
    } else {
      args = buildCodexArgs(baseUrl);
    }

    process.stdout.write(`[agent-e2e] running ${agent} (non-interactive)…\n`);
    const { code, signal } = await runAgent(agent, args, { logPath, cwd, timeoutMs });
    const durationMs = Date.now() - startedAt.getTime();
    process.stdout.write(`[agent-e2e] ${agent} exited (code=${code}, signal=${signal}, ${(durationMs / 1000).toFixed(1)}s)\n`);
    if (signal) throw new Error(`${agent} was killed by timeout after ${timeoutMs} ms`);

    // 独立验收：以宿主状态为准，不信任 agent 的自述。
    const after = await httpJson(baseUrl, "/api/agent/project", verifierToken);
    const revisionAfter = after.project.revision;
    const diff = await httpJson(baseUrl, `/api/agent/project/diff?fromRevision=${revisionBefore}`, verifierToken);
    const timeline = await httpJson(baseUrl, "/api/agent/timeline", verifierToken);
    const failures = [];
    if (revisionAfter !== revisionBefore + 1) {
      failures.push(`expected revision ${revisionBefore + 1}, got ${revisionAfter}`);
    }
    if (diff.changes.length !== 1) {
      failures.push(`expected exactly 1 transaction in diff, got ${diff.changes.length}`);
    }
    const change = diff.changes[0];
    if (change) {
      if (change.actor?.kind !== "agent" || change.actor?.id !== MCP_CLIENT_ID) {
        failures.push(`actor must be forced to ${MCP_CLIENT_ID}, got ${JSON.stringify(change.actor)}`);
      }
      if (!change.operationTypes?.includes("clip.update")) {
        failures.push(`expected clip.update in ${JSON.stringify(change.operationTypes)}`);
      }
      if (!change.objectIds?.includes("clip_take_1")) {
        failures.push(`expected clip_take_1 in ${JSON.stringify(change.objectIds)}`);
      }
    }
    const clip = timeline.timeline.clips.find((entry) => entry.clipId === "clip_take_1");
    if (clip?.enabled !== false) {
      failures.push(`clip_take_1 must be disabled, got enabled=${clip?.enabled}`);
    }

    const report = {
      agent,
      startedAt: startedAt.toISOString(),
      durationMs,
      exitCode: code,
      revisionBefore,
      revisionAfter,
      diffChange: change ?? null,
      failures,
      verdict: failures.length === 0 ? "pass" : "fail",
      logPath,
    };
    const reportPath = `${logPath.replace(/\.log$/, "")}.report.json`;
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write(`[agent-e2e] host-state verification: ${report.verdict}\n`);
    for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`);
    process.stdout.write(`[agent-e2e] log: ${logPath}\n[agent-e2e] report: ${reportPath}\n`);
    process.exitCode = report.verdict === "pass" ? 0 : 1;
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

await main();
