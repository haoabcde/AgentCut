#!/usr/bin/env node
/**
 * Live verification for `pnpm quickstart` (docs/19 Gate P5 evidence).
 *
 * Boots the quickstart reference host on a scratch port, then drives the
 * exact plain-HTTP walkthrough it prints — session bootstrap → project read
 * → timeline discovery → atomic transaction (with an impersonated actor, to
 * prove the host forces session identity) → idempotent replay → diff —
 * asserting host state at each step. Exits non-zero on any mismatch.
 *
 * Usage: node scripts/verify-quickstart.mjs [--port 4319]
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 4319;
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  console.error("FAIL: --port must be a valid TCP port");
  process.exit(1);
}
const repoRoot = new URL("..", import.meta.url).pathname;
const baseUrl = `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function jsonFetch(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, body: await response.json() };
}

const server = spawn(
  process.execPath,
  [join(repoRoot, "scripts/quickstart.mjs"), "--port", String(port)],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

let exitCode = 0;
try {
  // 0. wait for the host to answer /api/health
  let healthy = false;
  for (let attempt = 0; attempt < 60 && !healthy; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      healthy = response.ok;
    } catch { /* not up yet */ }
    if (!healthy) await sleep(500);
  }
  assert(healthy, "reference host did not answer /api/health within 30s");
  console.log("PASS health: /api/health ok");

  // 1. bootstrap → scoped session
  let token;
  for (let attempt = 0; attempt < 10 && !token; attempt += 1) {
    token = /Demo token:\s+([a-f0-9]+)/.exec(output)?.[1];
    if (!token) await sleep(200);
  }
  assert(token, "could not read the demo bootstrap token from quickstart output");
  const session = await jsonFetch("/api/agent/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      requestId: "verify-quickstart-session-001",
      clientId: "quickstart-verify",
      capabilities: ["project:read", "transcript:read", "timeline:write:low_risk_only"],
      ttlSeconds: 3600,
    }),
  });
  assert(session.status === 201,
    `session bootstrap expected 201, got ${session.status}: ${JSON.stringify(session.body)}`);
  const accessToken = session.body.accessToken;
  assert(typeof accessToken === "string" && accessToken.startsWith("agc_"),
    "accessToken missing or not agc_-prefixed");
  console.log(`PASS session: 201, accessToken issued, ${session.body.session?.capabilities?.length} capabilities`);

  const auth = { Authorization: `Bearer ${accessToken}` };

  // 2. project read at revision 0
  const project = await jsonFetch("/api/agent/project", { headers: auth });
  assert(project.status === 200, `project read expected 200, got ${project.status}`);
  assert(project.body.project.id === "project_demo_001",
    `unexpected project id ${project.body.project?.id}`);
  assert(project.body.project.revision === 0,
    `expected seeded revision 0, got ${project.body.project?.revision}`);
  console.log(`PASS project: ${project.body.project.id} revision=${project.body.project.revision}`);

  // 3. timeline discovery read (spec §6.4)
  const timeline = await jsonFetch("/api/agent/timeline", { headers: auth });
  assert(timeline.status === 200, `timeline read expected 200, got ${timeline.status}`);
  assert(timeline.body.timeline?.sequenceId === "sequence_main",
    `timeline did not expose sequence_main: ${JSON.stringify(timeline.body.timeline ?? null)}`);
  console.log("PASS timeline: sequence_main discovered");

  // 4. atomic transaction — body claims a user actor; host must force the session identity
  const transaction = {
    protocolVersion: "0.1.0",
    transactionId: "verify-quickstart-tx-001",
    idempotencyKey: "verify-quickstart-tx-001",
    projectId: "project_demo_001",
    sequenceId: "sequence_main",
    baseRevision: 0,
    actor: { kind: "user", id: "impersonator" },
    reason: "quickstart live verification",
    preconditions: [],
    operations: [{ type: "clip.update", clipId: "clip_take_1", patch: { enabled: false } }],
  };
  const commit = await jsonFetch("/api/agent/timeline/transactions", {
    method: "POST",
    headers: { ...auth, "x-agentcut-request-id": "verify-quickstart-tx-001" },
    body: JSON.stringify(transaction),
  });
  assert(commit.status === 201,
    `transaction expected 201, got ${commit.status}: ${JSON.stringify(commit.body)}`);
  assert(commit.body.revision === 1, `expected revision 1 after commit, got ${commit.body.revision}`);
  assert(commit.body.idempotentReplay === false, "first commit must not be an idempotent replay");
  console.log(`PASS transaction: revision 0→1, inverseOperations=${commit.body.record?.inverseOperationCount}`);

  // 5. exact retry → idempotent replay, no second revision (spec §7.4)
  const retry = await jsonFetch("/api/agent/timeline/transactions", {
    method: "POST",
    headers: { ...auth, "x-agentcut-request-id": "verify-quickstart-tx-001" },
    body: JSON.stringify(transaction),
  });
  assert(retry.status === 200, `idempotent replay expected 200, got ${retry.status}`);
  assert(retry.body.idempotentReplay === true, "retry with the same idempotencyKey must replay");
  assert(retry.body.revision === 1, `replay must not advance revision, got ${retry.body.revision}`);
  console.log("PASS idempotent replay: 200 replay=true, revision stays 1");

  // 6. diff: exactly one change, actor forced to the session identity
  const diff = await jsonFetch("/api/agent/project/diff?fromRevision=0", { headers: auth });
  assert(diff.status === 200, `diff expected 200, got ${diff.status}`);
  const changes = diff.body.changes ?? [];
  assert(changes.length === 1, `expected exactly one diff change, got ${changes.length}`);
  assert(JSON.stringify(changes[0].operationTypes) === JSON.stringify(["clip.update"]),
    `unexpected operationTypes ${JSON.stringify(changes[0].operationTypes)}`);
  assert(changes[0].objectIds?.includes("clip_take_1"),
    `clip_take_1 missing from objectIds ${JSON.stringify(changes[0].objectIds)}`);
  assert(changes[0].actor?.kind === "agent" && changes[0].actor?.id === "quickstart-verify",
    `host must force session identity as actor, got ${JSON.stringify(changes[0].actor)}`);
  console.log(`PASS diff: 1 change (clip.update on clip_take_1), actor forced to ${changes[0].actor?.kind}/${changes[0].actor?.id}`);

  console.log("\nQUICKSTART VERIFY: ALL CHECKS PASSED");
} catch (error) {
  exitCode = 1;
  console.error(`\nQUICKSTART VERIFY: FAILED — ${error.message}`);
  console.error(`--- quickstart output (tail) ---\n${output.slice(-2000)}`);
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => server.once("exit", resolve)), sleep(3_000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  console.log("[verify] quickstart host stopped");
}
process.exit(exitCode);
