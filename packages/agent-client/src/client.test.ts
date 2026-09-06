import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentCutClient, AgentCutClientError } from "./client.js";
import { parseAgentCliArgs, runAgentCli, AgentCliUsageError } from "./cli.js";
import {
  loadAgentCredential,
  readAgentHandoffCredentialFile,
  writeAgentHandoffCredentialFile,
} from "../../../scripts/agentcut-credentials.mjs";
import type { ReviewResponse } from "./types.js";

describe("AgentCut typed daemon client", () => {
  it("creates one capability session before using protected Agent routes", async () => {
    const credential = sessionFixture();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...credential, idempotentReplay: false }, 201))
      .mockResolvedValueOnce(jsonResponse(reviewFixture()));
    const client = new AgentCutClient({
      baseUrl: "http://127.0.0.1:4320",
      fetcher,
      bootstrapToken: "bootstrap-token-that-is-at-least-thirty-two-bytes",
      clientId: "codex-test",
      sessionRequestId: "session-request-001",
    });

    await expect(client.status()).resolves.toEqual(expect.objectContaining({
      capabilities: expect.objectContaining({
        agentSession: expect.objectContaining({ id: "session_test", clientId: "codex-test" }),
      }),
    }));
    expect(fetcher.mock.calls[0]).toEqual([
      new URL("http://127.0.0.1:4320/api/agent/sessions"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer bootstrap-token-that-is-at-least-thirty-two-bytes",
        }),
        body: JSON.stringify({
          requestId: "session-request-001",
          clientId: "codex-test",
          capabilities: [
            "project:read",
            "transcript:read",
            "analysis:local",
            "analysis:propose",
            "timeline:write:low_risk_only",
            "approval:request",
            "timeline:write:approved",
            "export:write",
          ],
          ttlSeconds: 43_200,
        }),
      }),
    ]);
    expect(fetcher.mock.calls[1]?.[0]).toEqual(new URL("http://127.0.0.1:4320/api/agent/status"));
  });

  it("summarizes project state without returning the full token transcript", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(reviewFixture()));
    const client = new AgentCutClient({
      baseUrl: "http://127.0.0.1:4320",
      fetcher,
      session: sessionFixture(),
    });

    await expect(client.status()).resolves.toEqual(expect.objectContaining({
      protocolVersion: "0.1.0",
      project: { id: "project_1", name: "Fixture", revision: 9 },
      roughCutStatus: "reviewing",
      candidates: {
        total: 3,
        pending: 1,
        committedDeleted: 1,
        reviewedKeep: 1,
        byRisk: { low: 1, medium: 1, high: 1 },
      },
      jobs: [],
    }));
    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:4320/api/agent/status"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-AgentCut-Client": "agentcut-agent/0.1.0",
          Authorization: "Bearer test-access-token",
        }),
      }),
    );
  });

  it("reads a bounded transcript page without exposing source paths", async () => {
    const page = transcriptPageFixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(page));
    const client = new AgentCutClient({ fetcher, session: sessionFixture() });

    await expect(client.transcript({ offset: 200, limit: 100 })).resolves.toEqual(page);
    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:4317/api/agent/transcript?offset=200&limit=100"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(JSON.stringify(page)).not.toContain("/Users/");
  });

  it("submits revision-bound semantic findings with the caller request id", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(reviewFixture()));
    const client = new AgentCutClient({ fetcher, session: sessionFixture() });
    const findings = [semanticFindingFixture()];

    await client.proposeSemanticFindings({
      baseRevision: 9,
      requestId: "semantic-propose-001",
      findings,
    });

    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:4317/api/agent/semantic-findings"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          baseRevision: 9,
          requestId: "semantic-propose-001",
          findings,
        }),
        headers: expect.objectContaining({
          "X-AgentCut-Request-Id": "semantic-propose-001",
        }),
      }),
    );
    await expect(client.proposeSemanticFindings({
      baseRevision: 9,
      requestId: "semantic-propose-empty",
      findings: [],
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sends caller-owned revision and request id unchanged for idempotent writes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(reviewFixture()));
    const client = new AgentCutClient({
      baseUrl: "http://127.0.0.1:4320",
      fetcher,
      session: sessionFixture(),
    });

    await client.generateRoughCut({ baseRevision: 9, requestId: "codex-rough-cut-001" });

    const request = fetcher.mock.calls[0]?.[1];
    expect(request?.method).toBe("POST");
    expect(request?.body).toBe(JSON.stringify({
      baseRevision: 9,
      requestId: "codex-rough-cut-001",
    }));
    expect(request?.headers).toEqual(expect.objectContaining({
      Authorization: "Bearer test-access-token",
      "X-AgentCut-Request-Id": "codex-rough-cut-001",
    }));
  });

  it("returns the stable audit candidate projection with text and source timing", async () => {
    const candidate = {
      candidateId: "candidate_1",
      decision: "suggest_remove" as const,
      targetKind: "words" as const,
      wordIds: ["word_1"],
      state: "candidate_remove" as const,
      reasonCodes: ["repetition"],
      risk: "high" as const,
      confidence: 0.8,
      explanationZh: "重复表达",
      sourceStartMicros: 1_000_000,
      durationMicros: 500_000,
      text: "重复内容",
      evidenceStatus: "structured" as const,
      evidence: [{
        role: "retained_comparison" as const,
        wordIds: ["word_2"],
        sourceStartMicros: 2_000_000,
        durationMicros: 600_000,
        text: "保留内容",
      }],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      audit: {
        project: { id: "project_1", name: "Fixture", revision: 9, sourceSha256: "sha256:source" },
        review: { completed: false, pendingCandidateIds: [candidate.candidateId] },
        candidates: [{ ...candidate, humanLabel: null, humanNote: null }],
      },
    }));
    const client = new AgentCutClient({
      baseUrl: "http://127.0.0.1:4320",
      fetcher,
      session: sessionFixture(),
    });

    await expect(client.candidates()).resolves.toEqual([candidate]);
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL("http://127.0.0.1:4320/api/agent/candidates"));
  });

  it("preserves structured daemon conflicts for an Agent to re-read and retry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: {
        code: "REVISION_CONFLICT",
        message: "Expected revision 8 but found 9",
        details: { expected: 8, actual: 9 },
      },
    }, 409));
    const client = new AgentCutClient({ fetcher, session: sessionFixture() });

    await expect(client.startExport({ baseRevision: 8, requestId: "export-stale" }))
      .rejects.toEqual(expect.objectContaining<Partial<AgentCutClientError>>({
        code: "REVISION_CONFLICT",
        details: { expected: 8, actual: 9 },
      }));
  });

  it("encodes export job ids as one path segment", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      jobId: "job/export 1",
      status: "running",
      progress: 0.5,
      sourceRevision: 9,
    }));
    const client = new AgentCutClient({
      baseUrl: "http://127.0.0.1:4320",
      fetcher,
      session: sessionFixture(),
    });

    await client.exportStatus("job/export 1");

    expect(fetcher.mock.calls[0]?.[0]).toEqual(
      new URL("http://127.0.0.1:4320/api/agent/exports/job%2Fexport%201"),
    );
  });

  it("sends the export preset only when the caller chooses one", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({
      jobId: "job_export_vertical",
      status: "running",
      progress: 0,
      sourceRevision: 9,
      preset: "vertical-9-16",
      cancelRequested: false,
      canCancel: true,
    }));
    const client = new AgentCutClient({ fetcher, session: sessionFixture() });

    await client.startExport({
      baseRevision: 9,
      requestId: "export-vertical-001",
      preset: "vertical-9-16",
    });

    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL("http://127.0.0.1:4317/api/agent/exports"));
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({
      baseRevision: 9,
      requestId: "export-vertical-001",
      preset: "vertical-9-16",
    }));

    await client.startExport({ baseRevision: 9, requestId: "export-source-002" });
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({
      baseRevision: 9,
      requestId: "export-source-002",
    }));

    await expect(client.startExport({
      baseRevision: 9,
      requestId: "export-bogus",
      preset: "square-1-1" as never,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("cancels an export with a caller-owned idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      jobId: "job/export 1",
      status: "running",
      progress: 0.5,
      sourceRevision: 9,
      cancelRequested: true,
      canCancel: true,
    }, 202));
    const client = new AgentCutClient({ fetcher, session: sessionFixture() });

    await client.cancelExport({ jobId: "job/export 1", requestId: "cancel-export-001" });

    expect(fetcher.mock.calls[0]?.[0]).toEqual(
      new URL("http://127.0.0.1:4317/api/agent/exports/job%2Fexport%201/cancel"),
    );
    expect(fetcher.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ requestId: "cancel-export-001" }),
      headers: expect.objectContaining({ "X-AgentCut-Request-Id": "cancel-export-001" }),
    }));
  });

  it("reads a bounded project diff for conflict recovery", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      projectId: "project_1",
      fromRevision: 7,
      toRevision: 9,
      headRevision: 9,
      changes: [],
    }));
    const client = new AgentCutClient({
      baseUrl: "http://127.0.0.1:4320",
      fetcher,
      session: sessionFixture(),
    });

    await expect(client.projectDiff({ fromRevision: 7, toRevision: 9 })).resolves.toEqual(
      expect.objectContaining({ fromRevision: 7, toRevision: 9, headRevision: 9 }),
    );
    expect(fetcher.mock.calls[0]?.[0]).toEqual(
      new URL("http://127.0.0.1:4320/api/agent/project/diff?fromRevision=7&toRevision=9"),
    );
  });

  it("reads the core protocol project summary available on any compatible host", async () => {
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
      facts: { sequenceCount: 1, clipCount: 1, artifactCount: 0, transcriptArtifacts: 0 },
      capabilities: { extensions: [] },
      session: {
        id: "session_test",
        clientId: "codex-test",
        capabilities: ["project:read" as const],
        expiresAt: "2026-08-10T12:00:00.000Z",
      },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(projectSummary));
    const client = new AgentCutClient({
      baseUrl: "http://127.0.0.1:4318",
      fetcher,
      session: sessionFixture(),
    });

    await expect(client.project()).resolves.toEqual(projectSummary);
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL("http://127.0.0.1:4318/api/agent/project"));
  });

  it("applies a core timeline transaction with protocol defaults and rejects empty operations", async () => {
    const transactionResult = {
      protocolVersion: "0.1.0" as const,
      revision: 10,
      idempotentReplay: false,
      record: {
        transactionId: "tx_001",
        baseRevision: 9,
        committedRevision: 10,
        committedAt: "2026-08-10T00:00:00.000Z",
        beforeHash: `sha256:${"b".repeat(64)}`,
        afterHash: `sha256:${"c".repeat(64)}`,
        inverseOperationCount: 1,
      },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(transactionResult, 201));
    const client = new AgentCutClient({
      baseUrl: "http://127.0.0.1:4318",
      fetcher,
      session: sessionFixture(),
    });
    const operations = [{ type: "clip.update", clipId: "clip_1", patch: { enabled: false } }];

    await expect(client.applyTimelineTransaction({
      transactionId: "tx_001",
      idempotencyKey: "client-test:tx:001",
      projectId: "project_1",
      sequenceId: "sequence_main",
      baseRevision: 9,
      reason: "Disable one clip",
      operations,
    })).resolves.toEqual(transactionResult);
    expect(fetcher.mock.calls[0]?.[0]).toEqual(
      new URL("http://127.0.0.1:4318/api/agent/timeline/transactions"),
    );
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({
      protocolVersion: "0.1.0",
      preconditions: [],
      transactionId: "tx_001",
      idempotencyKey: "client-test:tx:001",
      projectId: "project_1",
      sequenceId: "sequence_main",
      baseRevision: 9,
      reason: "Disable one clip",
      operations,
    }));
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({
      "X-AgentCut-Request-Id": "client-test:tx:001",
    }));

    await expect(client.applyTimelineTransaction({
      transactionId: "tx_empty",
      idempotencyKey: "client-test:tx:empty",
      projectId: "project_1",
      sequenceId: "sequence_main",
      baseRevision: 9,
      reason: "Empty transaction",
      operations: [],
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requests, reads, and applies only an exact approved payload", async () => {
    const pending = {
      approval: {
        id: "approval_high",
        kind: "content_high_risk_delete" as const,
        targetId: "candidate_high",
        baseRevision: 9,
        payloadHash: `sha256:${"a".repeat(64)}`,
        state: "pending" as const,
        createdAt: "2026-08-10T00:00:00.000Z",
        expiresAt: "2026-08-10T01:00:00.000Z",
      },
      idempotentReplay: false,
    };
    const approved = {
      approval: { ...pending.approval, state: "approved" as const, approvalToken: "aga_token" },
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(pending, 201))
      .mockResolvedValueOnce(jsonResponse(approved))
      .mockResolvedValueOnce(jsonResponse(reviewFixture()));
    const client = new AgentCutClient({ fetcher, session: sessionFixture() });

    await expect(client.requestCandidateApproval({
      candidateId: "candidate_high",
      baseRevision: 9,
      requestId: "approval-request-001",
    })).resolves.toEqual(pending);
    await expect(client.approvalStatus("approval/high 1")).resolves.toEqual(approved);
    await expect(client.applyApproval({
      approvalId: "approval/high 1",
      approvalToken: "aga_token",
      baseRevision: 9,
      requestId: "approval-apply-001",
    })).resolves.toEqual(expect.objectContaining({ project: expect.objectContaining({ revision: 9 }) }));

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:4317/api/agent/approvals",
      "http://127.0.0.1:4317/api/agent/approvals/approval%2Fhigh%201",
      "http://127.0.0.1:4317/api/agent/approvals/approval%2Fhigh%201/apply",
    ]);
    expect(fetcher.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({
        approvalToken: "aga_token",
        baseRevision: 9,
        requestId: "approval-apply-001",
      }),
      headers: expect.objectContaining({ "X-AgentCut-Request-Id": "approval-apply-001" }),
    }));
  });
});

describe("agentcut-agent JSON CLI", () => {
  it("parses read and revision-bound write commands with an overridable daemon URL", () => {
    expect(parseAgentCliArgs(["--", "status"], { AGENTCUT_DAEMON_URL: "http://127.0.0.1:4320" }))
      .toEqual({ command: "status", url: "http://127.0.0.1:4320" });
    expect(parseAgentCliArgs([
      "rough-cut", "generate",
      "--base-revision", "9",
      "--request-id", "rough-cut-001",
      "--url", "http://localhost:4320",
    ])).toEqual({
      command: "rough-cut-generate",
      url: "http://localhost:4320",
      baseRevision: 9,
      requestId: "rough-cut-001",
    });
    expect(parseAgentCliArgs([
      "project", "diff",
      "--from-revision", "7",
      "--to-revision", "9",
    ])).toEqual({
      command: "project-diff",
      url: "http://127.0.0.1:4317",
      fromRevision: 7,
      toRevision: 9,
    });
    expect(parseAgentCliArgs([
      "approval", "apply", "approval_1",
      "--approval-token", "aga_token",
      "--base-revision", "9",
      "--request-id", "approval-apply-001",
    ])).toEqual({
      command: "approval-apply",
      url: "http://127.0.0.1:4317",
      approvalId: "approval_1",
      approvalToken: "aga_token",
      baseRevision: 9,
      requestId: "approval-apply-001",
    });
    expect(parseAgentCliArgs([
      "export", "cancel", "job_export_001", "--request-id", "cancel-export-001",
    ])).toEqual({
      command: "export-cancel",
      url: "http://127.0.0.1:4317",
      jobId: "job_export_001",
      requestId: "cancel-export-001",
    });
    expect(parseAgentCliArgs([
      "export", "start",
      "--base-revision", "9",
      "--request-id", "export-001",
      "--preset", "vertical-9-16",
    ])).toEqual({
      command: "export-start",
      url: "http://127.0.0.1:4317",
      baseRevision: 9,
      requestId: "export-001",
      preset: "vertical-9-16",
    });
    expect(parseAgentCliArgs([
      "export", "start",
      "--base-revision", "9",
      "--request-id", "export-002",
    ])).toEqual({
      command: "export-start",
      url: "http://127.0.0.1:4317",
      baseRevision: 9,
      requestId: "export-002",
    });
    expect(() => parseAgentCliArgs([
      "export", "start",
      "--base-revision", "9",
      "--request-id", "export-003",
      "--preset", "square-1-1",
    ])).toThrowError(AgentCliUsageError);
    expect(parseAgentCliArgs([
      "transcript", "get", "--offset", "100", "--limit", "50",
    ])).toEqual({
      command: "transcript-get",
      url: "http://127.0.0.1:4317",
      offset: 100,
      limit: 50,
    });
    expect(parseAgentCliArgs([
      "semantic", "propose",
      "--findings-file", "/tmp/findings.json",
      "--base-revision", "9",
      "--request-id", "semantic-propose-001",
    ])).toEqual({
      command: "semantic-propose",
      url: "http://127.0.0.1:4317",
      findingsPath: "/tmp/findings.json",
      baseRevision: 9,
      requestId: "semantic-propose-001",
    });
    expect(parseAgentCliArgs([
      "handoff", "create",
      "--client-id", "codex-followup",
      "--capability", "approval:request",
      "--capability", "project:read",
      "--ttl-seconds", "1800",
      "--request-id", "handoff-create-001",
      "--out", "/tmp/agentcut-followup.json",
      "--url", "http://127.0.0.1:4320",
    ])).toEqual({
      command: "handoff-create",
      url: "http://127.0.0.1:4320",
      clientId: "codex-followup",
      capabilities: ["approval:request", "project:read"],
      ttlSeconds: 1800,
      requestId: "handoff-create-001",
      outputPath: "/tmp/agentcut-followup.json",
    });
  });

  it("creates a private least-privilege handoff without printing its access token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-handoff-cli-"));
    const outputPath = join(directory, "followup.json");
    const delegatedCredential = {
      accessToken: `agc_${"a".repeat(43)}`,
      session: {
        id: "session_followup",
        projectId: "project_1",
        clientId: "codex-followup",
        capabilities: ["project:read" as const, "approval:request" as const],
        createdAt: "2026-08-10T00:00:00.000Z",
        expiresAt: "2026-08-10T00:30:00.000Z",
      },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ ...delegatedCredential, idempotentReplay: false }, 201),
    );
    const stdout: string[] = [];
    try {
      await expect(runAgentCli([
        "handoff", "create",
        "--client-id", "codex-followup",
        "--capability", "project:read",
        "--capability", "approval:request",
        "--ttl-seconds", "1800",
        "--request-id", "handoff-create-001",
        "--out", outputPath,
        "--url", "http://127.0.0.1:4320",
      ], {
        environment: { AGENTCUT_AGENT_BOOTSTRAP_TOKEN: "bootstrap-token-that-is-at-least-thirty-two-bytes" },
        fetcher,
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
      })).resolves.toBe(0);
      expect(fetcher.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
        body: JSON.stringify({
          requestId: "handoff-create-001",
          clientId: "codex-followup",
          capabilities: ["approval:request", "project:read"],
          ttlSeconds: 1800,
        }),
      }));
      expect(stdout).toHaveLength(1);
      expect(stdout[0]).not.toContain(delegatedCredential.accessToken);
      expect(JSON.parse(stdout[0]!)).toEqual({
        handoff: expect.objectContaining({
          credentialPath: outputPath,
          sessionId: "session_followup",
          capabilities: ["project:read", "approval:request"],
          idempotentReplay: false,
          accessTokenFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      });
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(loadAgentCredential({ AGENTCUT_AGENT_CREDENTIALS: outputPath })).toEqual({
        kind: "session",
        daemonUrl: "http://127.0.0.1:4320",
        credential: delegatedCredential,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires explicit idempotency and revision for every write command", async () => {
    const stderr: string[] = [];
    const exitCode = await runAgentCli(["export", "start", "--base-revision", "9"], {
      stderr: (line) => stderr.push(line),
      stdout: () => undefined,
    });
    expect(exitCode).toBe(2);
    expect(JSON.parse(stderr[0]!)).toEqual({
      error: expect.objectContaining({ code: "INVALID_ARGUMENTS" }),
    });
  });

  it("loads semantic findings from a JSON file and submits one JSON result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-semantic-cli-"));
    const findingsPath = join(directory, "findings.json");
    const findings = [semanticFindingFixture()];
    writeFileSync(findingsPath, JSON.stringify({ findings }));
    const stdout: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(reviewFixture()));
    try {
      await expect(runAgentCli([
        "semantic", "propose",
        "--findings-file", findingsPath,
        "--base-revision", "9",
        "--request-id", "semantic-propose-cli-001",
      ], {
        fetcher,
        session: sessionFixture(),
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
      })).resolves.toBe(0);
      expect(fetcher.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
        body: JSON.stringify({
          baseRevision: 9,
          requestId: "semantic-propose-cli-001",
          findings,
        }),
      }));
      expect(stdout).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes exactly one JSON document to stdout and maps revision conflict to exit code 3", async () => {
    const stdout: string[] = [];
    const success = await runAgentCli(["status"], {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(reviewFixture())),
      session: sessionFixture(),
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });
    expect(success).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toEqual(expect.objectContaining({ protocolVersion: "0.1.0" }));

    const stderr: string[] = [];
    const conflict = await runAgentCli([
      "export", "start", "--base-revision", "8", "--request-id", "stale-export",
    ], {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        error: { code: "REVISION_CONFLICT", message: "stale" },
      }, 409)),
      session: sessionFixture(),
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
    });
    expect(conflict).toBe(3);
    expect(JSON.parse(stderr[0]!)).toEqual({
      error: { code: "REVISION_CONFLICT", message: "stale" },
    });
  });

  it("maps missing local render capability to the stable capability exit code", async () => {
    const stderr: string[] = [];
    const exitCode = await runAgentCli([
      "export", "start", "--base-revision", "9", "--request-id", "export-no-libass",
    ], {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        error: { code: "RENDER_CAPABILITY_MISSING", message: "libass unavailable" },
      }, 409)),
      session: sessionFixture(),
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
    });
    expect(exitCode).toBe(5);
    expect(JSON.parse(stderr[0]!)).toEqual({
      error: { code: "RENDER_CAPABILITY_MISSING", message: "libass unavailable" },
    });
  });

  it("maps unavailable local semantics and terminal failed export jobs without false success", async () => {
    const semanticErrors: string[] = [];
    const unavailable = await runAgentCli([
      "semantic", "analyze", "--base-revision", "9", "--request-id", "semantic-offline",
    ], {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        error: { code: "SEMANTIC_REVIEW_UNAVAILABLE", message: "LM Studio unavailable" },
      }, 503)),
      session: sessionFixture(),
      stdout: () => undefined,
      stderr: (line) => semanticErrors.push(line),
    });
    expect(unavailable).toBe(5);

    const exportErrors: string[] = [];
    const failed = await runAgentCli(["export", "get", "job_failed"], {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        jobId: "job_failed",
        status: "failed",
        progress: 0.8,
        sourceRevision: 9,
        error: { code: "SOURCE_INTEGRITY_FAILED", message: "source drifted" },
      })),
      session: sessionFixture(),
      stdout: () => undefined,
      stderr: (line) => exportErrors.push(line),
    });
    expect(failed).toBe(6);
    expect(JSON.parse(exportErrors[0]!)).toEqual({
      error: { code: "SOURCE_INTEGRITY_FAILED", message: "source drifted" },
    });
  });

  it("fails closed when Agent credentials are unavailable", async () => {
    const stderr: string[] = [];
    const exitCode = await runAgentCli(["status"], {
      environment: {},
      fetcher: vi.fn<typeof fetch>(),
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(5);
    expect(JSON.parse(stderr[0]!)).toEqual({
      error: expect.objectContaining({ code: "AGENT_CREDENTIALS_MISSING" }),
    });
  });
});

describe("Agent handoff credential file", () => {
  it("publishes atomically, replays exactly, rejects overwrite, remote daemon, and broad permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-handoff-file-"));
    const outputPath = join(directory, "handoff.json");
    const credential = {
      accessToken: `agc_${"b".repeat(43)}`,
      session: {
        id: "session_handoff_file",
        projectId: "project_1",
        clientId: "codex-next-task",
        capabilities: ["project:read" as const],
        createdAt: "2026-08-10T00:00:00.000Z",
        expiresAt: "2026-08-10T01:00:00.000Z",
      },
    };
    try {
      const created = writeAgentHandoffCredentialFile(outputPath, {
        daemonUrl: "http://localhost:4320",
        credential,
      });
      expect(created.idempotentReplay).toBe(false);
      expect(readAgentHandoffCredentialFile(outputPath)).toEqual(created.credential);
      expect(writeAgentHandoffCredentialFile(outputPath, {
        daemonUrl: "http://localhost:4320",
        credential,
      }).idempotentReplay).toBe(true);
      expect(() => writeAgentHandoffCredentialFile(outputPath, {
        daemonUrl: "http://localhost:4320",
        credential: {
          ...credential,
          accessToken: `agc_${"c".repeat(43)}`,
        },
      })).toThrowError(expect.objectContaining({ code: "AGENT_HANDOFF_EXISTS" }));
      expect(() => writeAgentHandoffCredentialFile(join(directory, "remote.json"), {
        daemonUrl: "https://example.com",
        credential,
      })).toThrowError(expect.objectContaining({ code: "AGENT_HANDOFF_INVALID" }));
      chmodSync(outputPath, 0o644);
      expect(() => readAgentHandoffCredentialFile(outputPath)).toThrowError(
        expect.objectContaining({ code: "AGENT_HANDOFF_PERMISSIONS" }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function reviewFixture(): ReviewResponse {
  return {
    project: { id: "project_1", name: "Fixture", revision: 9 },
    roughCutStatus: "reviewing",
    preview: { revision: 9, durationSeconds: 60 },
    transcript: { id: "transcript_1", language: "zh" },
    media: { assetId: "asset_1", url: "/media/asset_1", originalFileName: "fixture.mp4" },
    review: {
      transcriptId: "transcript_1",
      projectRevision: 9,
      candidates: [
        candidate("candidate_low", "candidate_remove", "low"),
        candidate("candidate_medium", "committed_deleted", "medium"),
        candidate("candidate_high", "reviewed_keep", "high"),
      ],
      summary: {
        normalTokens: 10,
        candidateTokens: 1,
        deletedTokens: 1,
        reviewedKeepTokens: 1,
        candidateGaps: 0,
        committedGaps: 0,
        reviewedKeepGaps: 0,
      },
    },
    jobs: [],
    exports: [],
    capabilities: { semanticReview: { available: false } },
  };
}

function candidate(
  candidateId: string,
  state: "candidate_remove" | "committed_deleted" | "reviewed_keep",
  risk: "low" | "medium" | "high",
) {
  return {
    candidateId,
    targetKind: "words" as const,
    wordIds: [`word_${candidateId}`],
    state,
    reasonCodes: ["repetition"],
    risk,
    confidence: 0.9,
    explanationZh: "fixture",
  };
}

function sessionFixture() {
  return {
    accessToken: "test-access-token",
    session: {
      id: "session_test",
      projectId: "project_1",
      clientId: "codex-test",
      capabilities: [
        "project:read" as const,
        "transcript:read" as const,
        "analysis:local" as const,
        "analysis:propose" as const,
        "timeline:write:low_risk_only" as const,
        "approval:request" as const,
        "timeline:write:approved" as const,
        "export:write" as const,
      ],
      createdAt: "2026-08-10T00:00:00.000Z",
      expiresAt: "2026-08-10T12:00:00.000Z",
    },
  };
}

function transcriptPageFixture() {
  return {
    protocolVersion: "0.1.0" as const,
    project: { id: "project_1", revision: 9 },
    transcript: {
      id: "transcript_1",
      language: "zh-CN",
      sourceSha256: "a".repeat(64),
      totalWords: 301,
      offset: 200,
      limit: 100,
      nextOffset: 300,
      words: [{
        wordId: "word_200",
        index: 200,
        text: "继续",
        startMicros: 12_300_000,
        durationMicros: 420_000,
        confidence: 0.97,
      }],
    },
  };
}

function semanticFindingFixture() {
  return {
    category: "repetition" as const,
    removeStartWordId: "word_1",
    removeEndWordId: "word_2",
    keepStartWordId: "word_3",
    keepEndWordId: "word_4",
    confidence: 0.91,
    explanationZh: "前一句与后一句重复，建议人工试听后删除前一句。",
  };
}
