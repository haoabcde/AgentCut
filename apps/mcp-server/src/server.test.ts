import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeAgentHandoffCredentialFile } from "../../../scripts/agentcut-credentials.mjs";

interface ReceivedWrite {
  path: string;
  body: Record<string, unknown>;
}

const receivedWrites: ReceivedWrite[] = [];
const bootstrapToken = "mcp-bootstrap-token-that-is-long-enough-123456";
const accessToken = `agc_${"m".repeat(43)}`;
const daemon = createServer((request, response) => void routeDaemon(request, response));
let client: Client;
let transport: StdioClientTransport;
let stderr = "";
let daemonUrl = "";
let sessionCreations = 0;

beforeAll(async () => {
  await new Promise<void>((resolveListen, reject) => {
    daemon.once("error", reject);
    daemon.listen(0, "127.0.0.1", () => resolveListen());
  });
  const { port } = daemon.address() as AddressInfo;
  daemonUrl = `http://127.0.0.1:${port}`;
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../../scripts/agentcut-mcp.mjs", import.meta.url))],
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: {
      AGENTCUT_DAEMON_URL: daemonUrl,
      AGENTCUT_AGENT_BOOTSTRAP_TOKEN: bootstrapToken,
      CI: "true",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  client = new Client({ name: "agentcut-mcp-e2e", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    throw new Error(`MCP client failed to connect: ${error instanceof Error ? error.message : String(error)}; stderr=${stderr}`);
  }
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  if (daemon.listening) {
    await new Promise<void>((resolveClose, reject) => {
      daemon.close((error) => error ? reject(error) : resolveClose());
    });
  }
});

describe("AgentCut MCP stdio server", () => {
  it("connects through the official client without contaminating stdout", async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "agentcut_approval_apply",
      "agentcut_approval_get",
      "agentcut_candidate_approval_request",
      "agentcut_candidates_list",
      "agentcut_export_cancel",
      "agentcut_export_get",
      "agentcut_export_start",
      "agentcut_project_diff",
      "agentcut_project_get",
      "agentcut_project_status",
      "agentcut_rough_cut_generate",
      "agentcut_semantic_analyze",
      "agentcut_semantic_findings_propose",
      "agentcut_timeline_apply_transaction",
      "agentcut_transcript_get",
    ]);
    expect(stderr).not.toContain("MCP_BUILD_FAILED");
  });

  it("starts a second MCP host from a delegated session file without reading bootstrap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-mcp-handoff-"));
    const credentialPath = join(directory, "handoff.json");
    writeAgentHandoffCredentialFile(credentialPath, {
      daemonUrl,
      credential: {
        accessToken,
        session: {
          id: "session_mcp_delegated",
          projectId: "project_1",
          clientId: "codex-second-host",
          capabilities: ["project:read"],
          createdAt: "2026-08-10T00:00:00.000Z",
          expiresAt: "2026-08-10T01:00:00.000Z",
        },
      },
    });
    const before = sessionCreations;
    const delegatedTransport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../../../scripts/agentcut-mcp.mjs", import.meta.url))],
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: {
        AGENTCUT_AGENT_CREDENTIALS: credentialPath,
        CI: "true",
      },
      stderr: "pipe",
    });
    const delegatedClient = new Client({ name: "agentcut-mcp-handoff-e2e", version: "0.1.0" });
    try {
      await delegatedClient.connect(delegatedTransport);
      const result = await delegatedClient.callTool({ name: "agentcut_project_status", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        status: expect.objectContaining({ project: expect.objectContaining({ id: "project_1" }) }),
      });
      expect(sessionCreations).toBe(before);
    } finally {
      await delegatedClient.close().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps user approval resolution and manual deletion outside the Agent tool surface", async () => {
    const { tools } = await client.listTools();
    expect(tools.some((tool) => /accept|approve|confirm|delete|keep/i.test(tool.name))).toBe(false);
  });

  it("returns machine-readable project and candidate state", async () => {
    const status = await client.callTool({
      name: "agentcut_project_status",
      arguments: {},
    });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toEqual({
      status: expect.objectContaining({
        protocolVersion: "0.1.0",
        project: { id: "project_1", name: "Fixture", revision: 9 },
        roughCutStatus: "reviewing",
      }),
    });

    const candidates = await client.callTool({
      name: "agentcut_candidates_list",
      arguments: {},
    });
    expect(candidates.structuredContent).toEqual({
      candidates: [
        expect.objectContaining({
          candidateId: "candidate_high",
          risk: "high",
          text: "重复内容",
          sourceStartMicros: 1_000_000,
        }),
      ],
    });

    const diff = await client.callTool({
      name: "agentcut_project_diff",
      arguments: { fromRevision: 7, toRevision: 9 },
    });
    expect(diff.structuredContent).toEqual({
      diff: expect.objectContaining({
        projectId: "project_1",
        fromRevision: 7,
        toRevision: 9,
        headRevision: 9,
      }),
    });
  });

  it("passes caller-owned revision and idempotency key unchanged", async () => {
    const result = await client.callTool({
      name: "agentcut_rough_cut_generate",
      arguments: { baseRevision: 9, requestId: "mcp-rough-cut-001" },
    });
    expect(result.isError).not.toBe(true);
    expect(receivedWrites).toContainEqual({
      path: "/api/agent/rough-cut/generate",
      body: { baseRevision: 9, requestId: "mcp-rough-cut-001" },
    });
  });

  it("forwards an explicit export preset and rejects unknown presets locally", async () => {
    const vertical = await client.callTool({
      name: "agentcut_export_start",
      arguments: { baseRevision: 9, requestId: "mcp-export-vertical-001", preset: "vertical-9-16" },
    });
    expect(vertical.isError).not.toBe(true);
    expect(receivedWrites).toContainEqual({
      path: "/api/agent/exports",
      body: { baseRevision: 9, requestId: "mcp-export-vertical-001", preset: "vertical-9-16" },
    });

    const source = await client.callTool({
      name: "agentcut_export_start",
      arguments: { baseRevision: 9, requestId: "mcp-export-source-001" },
    });
    expect(source.isError).not.toBe(true);
    expect(receivedWrites).toContainEqual({
      path: "/api/agent/exports",
      body: { baseRevision: 9, requestId: "mcp-export-source-001" },
    });

    const before = receivedWrites.length;
    const invalid = await client.callTool({
      name: "agentcut_export_start",
      arguments: { baseRevision: 9, requestId: "mcp-export-bogus", preset: "square-1-1" },
    });
    expect(invalid.isError).toBe(true);
    expect(receivedWrites).toHaveLength(before);
  });

  it("reads paginated Transcript words and submits only high-risk semantic proposals", async () => {
    const transcript = await client.callTool({
      name: "agentcut_transcript_get",
      arguments: { offset: 20, limit: 2 },
    });
    expect(transcript.isError).not.toBe(true);
    expect(transcript.structuredContent).toEqual({
      transcript: expect.objectContaining({
        project: { id: "project_1", revision: 9 },
        transcript: expect.objectContaining({
          offset: 20,
          limit: 2,
          nextOffset: null,
          words: [expect.objectContaining({ wordId: "word_20", text: "不对" })],
        }),
      }),
    });

    const findings = [{
      category: "correction",
      removeStartWordId: "word_20",
      removeEndWordId: "word_20",
      keepStartWordId: "word_21",
      keepEndWordId: "word_22",
      confidence: 0.91,
      explanationZh: "说话者明确改口，保留后一段。",
    }];
    const proposed = await client.callTool({
      name: "agentcut_semantic_findings_propose",
      arguments: {
        baseRevision: 9,
        requestId: "mcp-semantic-propose-001",
        findings,
      },
    });
    expect(proposed.isError).not.toBe(true);
    expect(receivedWrites).toContainEqual({
      path: "/api/agent/semantic-findings",
      body: {
        baseRevision: 9,
        requestId: "mcp-semantic-propose-001",
        findings,
      },
    });

    const before = receivedWrites.length;
    const invalid = await client.callTool({
      name: "agentcut_semantic_findings_propose",
      arguments: {
        baseRevision: 9,
        requestId: "mcp-semantic-invalid",
        findings: [{ ...findings[0], confidence: 2 }],
      },
    });
    expect(invalid.isError).toBe(true);
    expect(receivedWrites).toHaveLength(before);
  });

  it("cancels an export with an auditable stable request id", async () => {
    const result = await client.callTool({
      name: "agentcut_export_cancel",
      arguments: { jobId: "job_1", requestId: "mcp-export-cancel-001" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      export: expect.objectContaining({
        jobId: "job_1",
        status: "running",
        cancelRequested: true,
      }),
    });
    expect(receivedWrites).toContainEqual({
      path: "/api/agent/exports/job_1/cancel",
      body: { requestId: "mcp-export-cancel-001" },
    });
  });

  it("requests and applies an exact approval without exposing a resolve tool", async () => {
    const requested = await client.callTool({
      name: "agentcut_candidate_approval_request",
      arguments: {
        candidateId: "candidate_high",
        baseRevision: 9,
        requestId: "mcp-approval-request-001",
      },
    });
    expect(requested.structuredContent).toEqual({
      approval: expect.objectContaining({
        approval: expect.objectContaining({ id: "approval_high", state: "pending" }),
      }),
    });
    const readable = await client.callTool({
      name: "agentcut_approval_get",
      arguments: { approvalId: "approval_high" },
    });
    expect(readable.structuredContent).toEqual({
      approval: {
        approval: expect.objectContaining({ state: "approved", approvalToken: "aga_fixture" }),
      },
    });
    const applied = await client.callTool({
      name: "agentcut_approval_apply",
      arguments: {
        approvalId: "approval_high",
        approvalToken: "aga_fixture",
        baseRevision: 9,
        requestId: "mcp-approval-apply-001",
      },
    });
    expect(applied.isError).not.toBe(true);
    expect(receivedWrites).toContainEqual({
      path: "/api/agent/approvals/approval_high/apply",
      body: {
        approvalToken: "aga_fixture",
        baseRevision: 9,
        requestId: "mcp-approval-apply-001",
      },
    });
    const { tools } = await client.listTools();
    expect(tools.some((tool) => /resolve/i.test(tool.name))).toBe(false);
  });

  it("rejects missing or normalized write identity before reaching the daemon", async () => {
    const before = receivedWrites.length;
    const missing = await client.callTool({
      name: "agentcut_rough_cut_generate",
      arguments: { baseRevision: 9 },
    });
    const padded = await client.callTool({
      name: "agentcut_semantic_analyze",
      arguments: { baseRevision: 9, requestId: " padded-id " },
    });
    expect(missing.isError).toBe(true);
    expect(padded.isError).toBe(true);
    expect(receivedWrites).toHaveLength(before);
  });

  it("preserves revision conflicts as structured tool errors", async () => {
    const result = await client.callTool({
      name: "agentcut_export_start",
      arguments: { baseRevision: 8, requestId: "mcp-stale-export" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        status: 409,
        code: "REVISION_CONFLICT",
        message: "Expected revision 8 but found 9",
        details: { expected: 8, actual: 9 },
      },
    });
  });
});

async function routeDaemon(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = request.url ?? "/";
  if (request.method === "POST" && path === "/api/agent/sessions") {
    sessionCreations += 1;
    if (request.headers.authorization !== `Bearer ${bootstrapToken}`) {
      sendJson(response, { error: { code: "AGENT_SESSION_INVALID", message: "invalid bootstrap" } }, 401);
      return;
    }
    const body = await readJsonBody(request);
    sendJson(response, {
      session: {
        id: "session_mcp",
        projectId: "project_1",
        clientId: body.clientId,
        capabilities: body.capabilities,
        createdAt: "2026-08-10T00:00:00.000Z",
        expiresAt: "2026-08-10T12:00:00.000Z",
      },
      accessToken,
      idempotentReplay: false,
    }, 201);
    return;
  }
  if (request.headers.authorization !== `Bearer ${accessToken}`) {
    sendJson(response, { error: { code: "AGENT_SESSION_INVALID", message: "invalid session" } }, 401);
    return;
  }
  if (request.method === "GET" && path === "/api/agent/status") {
    sendJson(response, reviewFixture());
    return;
  }
  if (request.method === "GET" && path === "/api/agent/candidates") {
    sendJson(response, auditFixture());
    return;
  }
  if (request.method === "GET" && path === "/api/agent/transcript?offset=20&limit=2") {
    sendJson(response, {
      protocolVersion: "0.1.0",
      project: { id: "project_1", revision: 9 },
      transcript: {
        id: "transcript_1",
        language: "zh-CN",
        sourceSha256: `sha256:${"a".repeat(64)}`,
        totalWords: 21,
        offset: 20,
        limit: 2,
        nextOffset: null,
        words: [{
          wordId: "word_20",
          index: 20,
          text: "不对",
          startMicros: 5_000_000,
          durationMicros: 300_000,
          confidence: 0.97,
        }],
      },
    });
    return;
  }
  if (request.method === "GET" && path === "/api/agent/project/diff?fromRevision=7&toRevision=9") {
    sendJson(response, {
      projectId: "project_1",
      fromRevision: 7,
      toRevision: 9,
      headRevision: 9,
      changes: [],
    });
    return;
  }
  if (request.method === "GET" && path === "/api/agent/approvals/approval_high") {
    sendJson(response, {
      approval: approvalFixture("approved", { approvalToken: "aga_fixture" }),
    });
    return;
  }
  if (request.method === "GET" && path === "/api/agent/exports/job_1") {
    sendJson(response, { jobId: "job_1", status: "running", progress: 0.5, sourceRevision: 9 });
    return;
  }
  if (request.method === "POST") {
    const body = await readJsonBody(request);
    receivedWrites.push({ path, body });
    if (path === "/api/agent/approvals") {
      sendJson(response, {
        approval: approvalFixture("pending"),
        idempotentReplay: false,
      }, 201);
      return;
    }
    if (path === "/api/agent/approvals/approval_high/apply") {
      sendJson(response, reviewFixture());
      return;
    }
    if (path === "/api/agent/exports" && body.baseRevision === 8) {
      sendJson(response, {
        error: {
          code: "REVISION_CONFLICT",
          message: "Expected revision 8 but found 9",
          details: { expected: 8, actual: 9 },
        },
      }, 409);
      return;
    }
    if (path === "/api/agent/exports") {
      sendJson(response, { jobId: "job_1", status: "pending", progress: 0, sourceRevision: 9 }, 202);
      return;
    }
    if (path === "/api/agent/exports/job_1/cancel") {
      sendJson(response, {
        jobId: "job_1",
        status: "running",
        progress: 0.5,
        sourceRevision: 9,
        cancelRequested: true,
        canCancel: true,
      }, 202);
      return;
    }
    if (path === "/api/agent/rough-cut/generate" || path === "/api/agent/analyze-semantic"
      || path === "/api/agent/semantic-findings") {
      sendJson(response, reviewFixture());
      return;
    }
  }
  sendJson(response, { error: { code: "NOT_FOUND", message: path } }, 404);
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function reviewFixture() {
  return {
    project: { id: "project_1", name: "Fixture", revision: 9 },
    roughCutStatus: "reviewing",
    preview: { revision: 9, durationSeconds: 60 },
    transcript: { id: "transcript_1", language: "zh" },
    media: { assetId: "asset_1", url: "/media/asset_1", originalFileName: "fixture.mp4" },
    review: {
      transcriptId: "transcript_1",
      projectRevision: 9,
      candidates: [{
        candidateId: "candidate_high",
        targetKind: "words",
        wordIds: ["word_1"],
        state: "candidate_remove",
        reasonCodes: ["repetition"],
        risk: "high",
        confidence: 0.8,
        explanationZh: "重复表达",
      }],
      summary: {
        normalTokens: 10,
        candidateTokens: 1,
        deletedTokens: 0,
        reviewedKeepTokens: 0,
        candidateGaps: 0,
        committedGaps: 0,
        reviewedKeepGaps: 0,
      },
    },
    jobs: [],
    exports: [],
    capabilities: { semanticReview: { available: true, provider: "local" } },
  };
}

function auditFixture() {
  return {
    audit: {
      project: { id: "project_1", name: "Fixture", revision: 9, sourceSha256: "sha256:source" },
      review: { completed: false, pendingCandidateIds: ["candidate_high"] },
      candidates: [{
        candidateId: "candidate_high",
        decision: "suggest_remove",
        targetKind: "words",
        wordIds: ["word_1"],
        state: "candidate_remove",
        reasonCodes: ["repetition"],
        risk: "high",
        confidence: 0.8,
        explanationZh: "重复表达",
        sourceStartMicros: 1_000_000,
        durationMicros: 500_000,
        text: "重复内容",
      }],
    },
  };
}

function approvalFixture(
  state: "pending" | "approved",
  extra: Record<string, unknown> = {},
) {
  return {
    id: "approval_high",
    kind: "content_high_risk_delete",
    targetId: "candidate_high",
    baseRevision: 9,
    payloadHash: `sha256:${"a".repeat(64)}`,
    state,
    createdAt: "2026-08-10T00:00:00.000Z",
    expiresAt: "2026-08-10T01:00:00.000Z",
    ...extra,
  };
}
