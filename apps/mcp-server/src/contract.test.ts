import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createAgentCutMcpServer, type AgentCutMcpApi } from "./server.js";

describe("AgentCut MCP in-memory contract", () => {
  it("discovers the 15-tool surface and preserves transcript/proposal/timeline inputs", async () => {
    const transcript = {
      protocolVersion: "0.1.0" as const,
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
    };
    const status = statusFixture();
    const projectSummary = {
      protocolVersion: "0.1.0" as const,
      project: {
        id: "project_1",
        name: "Fixture",
        revision: 9,
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
        activeSequenceId: "sequence_main",
      },
      facts: { sequenceCount: 1, clipCount: 1, artifactCount: 3, transcriptArtifacts: 1 },
      capabilities: { extensions: ["talking-head-review"] },
    };
    const timelineResult = {
      protocolVersion: "0.1.0" as const,
      revision: 10,
      idempotentReplay: false,
      record: {
        transactionId: "tx_contract_001",
        baseRevision: 9,
        committedRevision: 10,
        committedAt: "2026-08-10T00:00:00.000Z",
        beforeHash: `sha256:${"c".repeat(64)}`,
        afterHash: `sha256:${"d".repeat(64)}`,
        inverseOperationCount: 1,
      },
    };
    const timelinePage = {
      protocolVersion: "0.1.0" as const,
      project: { id: "project_1", revision: 9 },
      timeline: {
        sequenceId: "sequence_main",
        name: "主时间线",
        tracks: [{ trackId: "track_v1", kind: "video", name: "主画面", order: 0, locked: false, enabled: true }],
        totalClips: 1,
        offset: 0,
        limit: 200,
        nextOffset: null,
        clips: [{
          clipId: "clip_1",
          trackId: "track_v1",
          kind: "media",
          assetId: "asset_1",
          startMicros: 0,
          durationMicros: 10_010_000,
          enabled: true,
        }],
      },
    };
    const api: AgentCutMcpApi = {
      status: vi.fn(async () => status),
      project: vi.fn(async () => projectSummary),
      timeline: vi.fn(async () => timelinePage),
      candidates: vi.fn(async () => []),
      transcript: vi.fn(async () => transcript),
      applyTimelineTransaction: vi.fn(async () => timelineResult),
      generateRoughCut: vi.fn(async () => status),
      analyzeSemantic: vi.fn(async () => status),
      proposeSemanticFindings: vi.fn(async () => status),
      startExport: vi.fn(async () => exportFixture()),
      cancelExport: vi.fn(async () => exportFixture()),
      exportStatus: vi.fn(async () => exportFixture()),
      projectDiff: vi.fn(async () => ({
        projectId: "project_1",
        fromRevision: 9,
        toRevision: 9,
        headRevision: 9,
        changes: [],
      })),
      requestCandidateApproval: vi.fn(async () => ({ approval: approvalFixture() })),
      approvalStatus: vi.fn(async () => ({ approval: approvalFixture() })),
      applyApproval: vi.fn(async () => status),
    };
    const server = createAgentCutMcpServer({ client: api });
    const client = new Client({ name: "agentcut-memory-contract", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
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
        "agentcut_timeline_get",
        "agentcut_transcript_get",
      ]);

      const project = await client.callTool({ name: "agentcut_project_get", arguments: {} });
      expect(project.isError).not.toBe(true);
      expect(project.structuredContent).toEqual({ project: projectSummary });

      const timeline = await client.callTool({
        name: "agentcut_timeline_get",
        arguments: { sequenceId: "sequence_main", limit: 50 },
      });
      expect(timeline.isError).not.toBe(true);
      expect(timeline.structuredContent).toEqual({ timeline: timelinePage });
      expect(api.timeline).toHaveBeenCalledWith({ sequenceId: "sequence_main", limit: 50 });

      const applied = await client.callTool({
        name: "agentcut_timeline_apply_transaction",
        arguments: {
          transactionId: "tx_contract_001",
          idempotencyKey: "contract:timeline:001",
          projectId: "project_1",
          sequenceId: "sequence_main",
          baseRevision: 9,
          reason: "Contract test transaction",
          operations: [{ type: "clip.update", clipId: "clip_1", patch: { enabled: false } }],
        },
      });
      expect(applied.isError).not.toBe(true);
      expect(applied.structuredContent).toEqual({ timeline: timelineResult });
      expect(api.applyTimelineTransaction).toHaveBeenCalledWith(expect.objectContaining({
        transactionId: "tx_contract_001",
        idempotencyKey: "contract:timeline:001",
        baseRevision: 9,
      }));

      const read = await client.callTool({
        name: "agentcut_transcript_get",
        arguments: { offset: 20, limit: 2 },
      });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toEqual({ transcript });
      expect(api.transcript).toHaveBeenCalledWith({ offset: 20, limit: 2 });

      const findings = [{
        category: "correction" as const,
        removeStartWordId: "word_20",
        removeEndWordId: "word_20",
        keepStartWordId: "word_21",
        keepEndWordId: "word_22",
        confidence: 0.91,
        explanationZh: "说话者明确改口，保留后一段。",
      }];
      const proposed = await client.callTool({
        name: "agentcut_semantic_findings_propose",
        arguments: { baseRevision: 9, requestId: "memory-propose-001", findings },
      });
      expect(proposed.isError).not.toBe(true);
      expect(api.proposeSemanticFindings).toHaveBeenCalledWith({
        baseRevision: 9,
        requestId: "memory-propose-001",
        findings,
      });

      const invalid = await client.callTool({
        name: "agentcut_semantic_findings_propose",
        arguments: {
          baseRevision: 9,
          requestId: "memory-propose-invalid",
          findings: [{ ...findings[0], confidence: 2 }],
        },
      });
      expect(invalid.isError).toBe(true);
      expect(api.proposeSemanticFindings).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function statusFixture() {
  return {
    protocolVersion: "0.1.0" as const,
    project: { id: "project_1", name: "Fixture", revision: 9 },
    roughCutStatus: "reviewing" as const,
    transcript: { id: "transcript_1", language: "zh-CN" },
    media: { assetId: "asset_1", originalFileName: "fixture.mp4" },
    preview: { revision: 9, durationSeconds: 60 },
    candidates: {
      total: 0,
      pending: 0,
      committedDeleted: 0,
      reviewedKeep: 0,
      byRisk: { low: 0, medium: 0, high: 0 },
    },
    jobs: [],
    exports: [],
    approvals: [],
    capabilities: { semanticReview: { available: false } },
  };
}

function exportFixture() {
  return {
    jobId: "job_1",
    status: "pending" as const,
    progress: 0,
    sourceRevision: 9,
    cancelRequested: false,
    canCancel: true,
  };
}

function approvalFixture() {
  return {
    id: "approval_1",
    kind: "content_high_risk_delete" as const,
    targetId: "candidate_1",
    baseRevision: 9,
    payloadHash: `sha256:${"b".repeat(64)}`,
    state: "pending" as const,
    createdAt: "2026-08-10T00:00:00.000Z",
    expiresAt: "2026-08-10T01:00:00.000Z",
  };
}
