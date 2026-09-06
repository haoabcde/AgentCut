import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createReferenceHost, REFERENCE_PROTOCOL_VERSION } from "@agentcut/reference-host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * P1 gate: the packaged MCP server drives the reference host over its real wire
 * protocol (stdio -> HTTP). Only protocol-core tools are exercised; product
 * tools must fail with a structured host error instead of pretending to work.
 */
const bootstrapToken = "ref-bootstrap-mcp-e2e-token-that-is-long-enough";

let host: ReturnType<typeof createReferenceHost>;
let hostUrl: string;
let directory: string;
let client: Client;
let transport: StdioClientTransport;
let stderr = "";

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "agentcut-mcp-reference-e2e-"));
  const databasePath = join(directory, "agentcut.sqlite");
  const fixtureUrl = new URL(
    "../../../packages/timeline-schema/fixtures/minimal-project.json",
    import.meta.url,
  );
  const { ProjectStore } = await import("@agentcut/project-store");
  ProjectStore.create(databasePath, JSON.parse(readFileSync(fixtureUrl, "utf8")) as never);
  host = createReferenceHost({ databasePath, agentBootstrapToken: bootstrapToken });
  await new Promise<void>((resolveListen, rejectListen) => {
    host.once("error", rejectListen);
    host.listen(0, "127.0.0.1", () => resolveListen());
  });
  const { port } = host.address() as AddressInfo;
  hostUrl = `http://127.0.0.1:${port}`;

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../../scripts/agentcut-mcp.mjs", import.meta.url))],
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: {
      AGENTCUT_DAEMON_URL: hostUrl,
      AGENTCUT_AGENT_BOOTSTRAP_TOKEN: bootstrapToken,
      CI: "true",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  client = new Client({ name: "agentcut-mcp-reference-e2e", version: "0.1.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  host?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("AgentCut MCP server against the reference host", () => {
  it("reads the core protocol project summary and transcript through real transport", async () => {
    const project = await client.callTool({ name: "agentcut_project_get", arguments: {} });
    expect(project.isError).not.toBe(true);
    expect(project.structuredContent).toEqual({
      project: expect.objectContaining({
        protocolVersion: REFERENCE_PROTOCOL_VERSION,
        project: expect.objectContaining({ id: "project_demo_001", revision: 0 }),
        facts: expect.objectContaining({ clipCount: 1, transcriptArtifacts: 1 }),
        capabilities: {
          extensions: [],
          writePolicy: {
            timelineTransactions: { baseCapability: "timeline:write:low_risk_only" },
          },
        },
      }),
    });

    const transcript = await client.callTool({
      name: "agentcut_transcript_get",
      arguments: { limit: 2 },
    });
    expect(transcript.isError).not.toBe(true);
    expect(transcript.structuredContent).toEqual({
      transcript: expect.objectContaining({
        protocolVersion: REFERENCE_PROTOCOL_VERSION,
        transcript: expect.objectContaining({
          totalWords: 4,
          limit: 2,
          nextOffset: 2,
          words: expect.arrayContaining([expect.objectContaining({ wordId: "word_001", text: "大家好" })]),
        }),
      }),
    });
  });

  it("applies a revision-bound transaction, replays it, and reads the diff", async () => {
    const applied = await client.callTool({
      name: "agentcut_timeline_apply_transaction",
      arguments: {
        transactionId: "tx_mcp_refhost_001",
        idempotencyKey: "mcp-refhost:disable-clip:001",
        projectId: "project_demo_001",
        sequenceId: "sequence_main",
        baseRevision: 0,
        reason: "Disable first take while re-planning",
        operations: [{ type: "clip.update", clipId: "clip_take_1", patch: { enabled: false } }],
      },
    });
    expect(applied.isError).not.toBe(true);
    expect(applied.structuredContent).toEqual({
      timeline: expect.objectContaining({
        revision: 1,
        idempotentReplay: false,
        record: expect.objectContaining({ committedRevision: 1 }),
      }),
    });

    const replay = await client.callTool({
      name: "agentcut_timeline_apply_transaction",
      arguments: {
        transactionId: "tx_mcp_refhost_001",
        idempotencyKey: "mcp-refhost:disable-clip:001",
        projectId: "project_demo_001",
        sequenceId: "sequence_main",
        baseRevision: 0,
        reason: "Disable first take while re-planning",
        operations: [{ type: "clip.update", clipId: "clip_take_1", patch: { enabled: false } }],
      },
    });
    expect(replay.isError).not.toBe(true);
    expect(replay.structuredContent).toEqual({
      timeline: expect.objectContaining({ revision: 1, idempotentReplay: true }),
    });

    const diff = await client.callTool({
      name: "agentcut_project_diff",
      arguments: { fromRevision: 0 },
    });
    expect(diff.isError).not.toBe(true);
    expect(diff.structuredContent).toEqual({
      diff: expect.objectContaining({
        projectId: "project_demo_001",
        fromRevision: 0,
        headRevision: 1,
        changes: [expect.objectContaining({
          transactionId: "tx_mcp_refhost_001",
          operationTypes: ["clip.update"],
        })],
      }),
    });
  });

  it("keeps stale writes rejected and product-only tools honestly unavailable", async () => {
    const stale = await client.callTool({
      name: "agentcut_timeline_apply_transaction",
      arguments: {
        transactionId: "tx_mcp_refhost_stale",
        idempotencyKey: "mcp-refhost:stale:001",
        projectId: "project_demo_001",
        sequenceId: "sequence_main",
        baseRevision: 0,
        reason: "Stale base revision",
        operations: [{ type: "clip.update", clipId: "clip_take_2", patch: { enabled: false } }],
      },
    });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toEqual(expect.objectContaining({
      error: expect.objectContaining({ status: 409, code: "REVISION_CONFLICT" }),
    }));

    const productOnly = await client.callTool({
      name: "agentcut_project_status",
      arguments: {},
    });
    expect(productOnly.isError).toBe(true);
    expect(productOnly.structuredContent).toEqual(expect.objectContaining({
      error: expect.objectContaining({ status: 404 }),
    }));
    expect(stderr).not.toContain("MCP_BUILD_FAILED");
  });
});
