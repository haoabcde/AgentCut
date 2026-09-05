import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeSemanticReview,
  batchAcceptCandidates,
  beginAlphaTiming,
  cancelExport,
  createExport,
  deleteTranscriptSelection,
  durationLabel,
  fetchAlphaAudit,
  fetchCandidatePreview,
  fetchReview,
  fetchUiSession,
  generateRoughCut,
  keepRemainingCandidates,
  labelAlphaBoundary,
  labelAlphaCandidate,
  finishAlphaTiming,
  heartbeatAlphaTiming,
  pauseAlphaTiming,
  previewTranscriptSelection,
  pairUiSession,
  setAlphaTimingBaseline,
  startAlphaTiming,
  fetchExport,
  reviewCandidate,
  resolveApproval,
  rotateUiBootstrap,
  revokeAgentSession,
  ReviewApiError,
  seconds,
} from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Studio time formatting", () => {
  it("converts rational time without assuming milliseconds", () => {
    expect(seconds({
      value: 30,
      rate: { numerator: 30_000, denominator: 1_001 },
    })).toBeCloseTo(1.001);
  });

  it("formats short and long review ranges for Chinese readers", () => {
    expect(durationLabel({
      start: { value: 0, rate: { numerator: 1_000, denominator: 1 } },
      duration: { value: 720, rate: { numerator: 1_000, denominator: 1 } },
    })).toBe("720 毫秒");
    expect(durationLabel({
      start: { value: 0, rate: { numerator: 1_000, denominator: 1 } },
      duration: { value: 1_574, rate: { numerator: 1_000, denominator: 1 } },
    })).toBe("1.57 秒");
  });

  it("posts a revision-bound candidate decision with a caller-owned request ID", async () => {
    const responseBody = {
      project: { id: "project", name: "Project", revision: 4 },
      transcript: { id: "transcript", language: "zh" },
      media: { assetId: "asset", url: "/media/asset", originalFileName: "source.mov" },
      review: {
        transcriptId: "transcript",
        projectRevision: 4,
        candidates: [],
        tokens: [],
        gaps: [],
        summary: {
          normalTokens: 0,
          candidateTokens: 0,
          deletedTokens: 0,
          reviewedKeepTokens: 0,
          candidateGaps: 0,
          committedGaps: 1,
          reviewedKeepGaps: 0,
        },
      },
      jobs: [],
    };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify(responseBody),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => { throw new Error("must not generate request ID"); } });

    await expect(reviewCandidate({
      requestId: "request_001",
      candidateId: "candidate 001",
      action: "accept",
      baseRevision: 3,
      confirmHighRisk: true,
    })).resolves.toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/candidates/candidate%20001/accept",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          baseRevision: 3,
          confirmHighRisk: true,
          requestId: "request_001",
        }),
      }),
    );
  });

  it("surfaces invalid edit documents as a clear authoritative failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "INVALID_DOCUMENT",
        message: "Transaction produced an invalid project document",
        details: { path: "/sequences/0/tracks/0/clips/5/id" },
      },
    }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(reviewCandidate({
      requestId: "request_invalid_document",
      candidateId: "candidate_001",
      action: "accept",
      baseRevision: 10,
    })).rejects.toMatchObject({
      status: 422,
      code: "INVALID_DOCUMENT",
      message: expect.stringContaining("本次没有写入"),
      details: { path: "/sequences/0/tracks/0/clips/5/id" },
    });
  });

  it("preserves a render capability diagnosis instead of reporting daemon disconnection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "RENDER_CAPABILITY_MISSING",
        message: "当前 FFmpeg 环境不能可靠导出：ass_filter",
        details: { missing: ["ass_filter"] },
      },
    }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(createExport({
      requestId: "request_missing_ass",
      baseRevision: 14,
      preset: "source",
    })).rejects.toMatchObject({
      status: 422,
      code: "RENDER_CAPABILITY_MISSING",
      message: "当前 FFmpeg 环境不能可靠导出：ass_filter",
      details: { missing: ["ass_filter"] },
    });
  });

  it("posts a batch candidate acceptance with a caller-owned request ID", async () => {
    const responseBody = {
      project: { id: "project", name: "Project", revision: 4 },
      transcript: { id: "transcript", language: "zh" },
      media: { assetId: "asset", url: "/media/asset", originalFileName: "source.mov" },
      review: {
        transcriptId: "transcript",
        projectRevision: 4,
        candidates: [],
        tokens: [],
        gaps: [],
        summary: {
          normalTokens: 0,
          candidateTokens: 0,
          deletedTokens: 0,
          reviewedKeepTokens: 0,
          candidateGaps: 0,
          committedGaps: 0,
          reviewedKeepGaps: 0,
        },
      },
      jobs: [],
    };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify(responseBody),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => { throw new Error("must not generate request ID"); } });

    await expect(batchAcceptCandidates({
      requestId: "batch_request_001",
      candidateIds: ["candidate_filler_001", "candidate_silence_001"],
      baseRevision: 3,
    })).resolves.toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/candidates/batch-accept",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          candidateIds: ["candidate_filler_001", "candidate_silence_001"],
          baseRevision: 3,
          requestId: "batch_request_001",
        }),
      }),
    );
  });

  it("fetches a revision-bound read-only candidate preview", async () => {    const body = {
      candidateId: "candidate 001",
      baseRevision: 3,
      preview: { revision: 3, durationSeconds: 8.4, segments: [] },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCandidatePreview("candidate 001", 3)).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/candidates/candidate%20001/preview?baseRevision=3",
    );
  });

  it("posts a revision-bound read-only Transcript selection preview", async () => {
    const body = {
      wordIds: ["word_002", "word_003"],
      baseRevision: 5,
      preview: { revision: 5, durationSeconds: 7.2, segments: [] },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "selection-preview-request" });

    await expect(previewTranscriptSelection({
      wordIds: ["word_002", "word_003"],
      baseRevision: 5,
    })).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/selections/preview", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        wordIds: ["word_002", "word_003"],
        baseRevision: 5,
        requestId: "selection-preview-request",
      }),
    }));
  });

  it("checks and pairs a browser UI session without putting bootstrap credentials in JSON", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: false, reason: "missing" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authenticated: true,
        expiresAt: "2026-08-17T01:00:00.000Z",
      }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUiSession()).resolves.toEqual({ authenticated: false, reason: "missing" });
    await expect(pairUiSession("ui-bootstrap-secret-001")).resolves.toEqual(expect.objectContaining({
      authenticated: true,
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/ui/session", {
      credentials: "same-origin",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/ui/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { Authorization: "Bearer ui-bootstrap-secret-001" },
    });
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty("body");
  });

  it("rotates UI bootstrap with a caller-stable request id and same-origin cookie", async () => {
    const body = {
      authenticated: true,
      expiresAt: "2026-08-17T03:30:00.000Z",
      generation: 2,
      rotatedAt: "2026-08-10T03:30:00.000Z",
      idempotentReplay: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(rotateUiBootstrap("ui-rotation-stable-001")).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/ui/bootstrap/rotate", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "ui-rotation-stable-001" }),
    });
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain("bootstrapToken");
  });

  it("cancels one export with a caller-stable request id", async () => {
    const body = {
      jobId: "job/export 1",
      status: "running",
      progress: 0.5,
      sourceRevision: 9,
      cancelRequested: true,
      canCancel: true,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cancelExport("job/export 1", "cancel-export-stable-001")).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/exports/job%2Fexport%201/cancel", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "cancel-export-stable-001" }),
    });
  });

  it("resolves a revision-bound approval through the user-only route", async () => {
    const responseBody = { project: { id: "project", name: "Project", revision: 7 } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "approval_resolution_001" });

    await expect(resolveApproval({
      requestId: "approval_resolution_001",
      approvalId: "approval high/1",
      baseRevision: 7,
      decision: "approve",
    })).resolves.toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/approvals/approval%20high%2F1/resolve",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          baseRevision: 7,
          decision: "approve",
          requestId: "approval_resolution_001",
        }),
      }),
    );
  });

  it("revokes an Agent session through the local user route without sending a token", async () => {
    const responseBody = { project: { id: "project", name: "Project", revision: 7 } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "session_revoke_001" });

    await expect(revokeAgentSession({
      requestId: "session_revoke_001",
      sessionId: "session cli/1",
    })).resolves.toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent-sessions/session%20cli%2F1/revoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ requestId: "session_revoke_001" }),
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("accessToken");
  });

  it("starts semantic review against an exact project revision", async () => {
    const responseBody = { project: { id: "project", name: "Project", revision: 5 } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "semantic_request_001" });

    await expect(analyzeSemanticReview({
      requestId: "semantic_request_001",
      baseRevision: 4,
    })).resolves.toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/analyze-semantic",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ baseRevision: 4, requestId: "semantic_request_001" }),
      }),
    );
  });

  it("posts revision-bound rough-cut workflow actions", async () => {
    const responseBody = { project: { id: "project", name: "Project", revision: 8 } };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify(responseBody),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    ));
    vi.stubGlobal("fetch", fetchMock);
    let requestNumber = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `rough_request_${++requestNumber}` });

    await generateRoughCut({ requestId: "rough_request_1", baseRevision: 5 });
    await deleteTranscriptSelection({
      requestId: "rough_request_2",
      baseRevision: 6,
      wordIds: ["word_003", "word_004"],
    });
    await keepRemainingCandidates({ requestId: "rough_request_3", baseRevision: 7 });

    expect(fetchMock.mock.calls.map(([path, init]) => [path, JSON.parse(init.body)])).toEqual([
      ["/api/rough-cut/generate", { baseRevision: 5, requestId: "rough_request_1" }],
      ["/api/selections/delete", {
        baseRevision: 6,
        wordIds: ["word_003", "word_004"],
        requestId: "rough_request_2",
      }],
      ["/api/candidates/keep-remaining", {
        baseRevision: 7,
        requestId: "rough_request_3",
      }],
    ]);
  });

  it("creates and polls a revision-bound export job", async () => {
    const body = {
      jobId: "job_export_001",
      status: "pending",
      progress: 0,
      sourceRevision: 8,
    };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify(body),
      { status: 202, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "export_001" });

    await expect(createExport({ requestId: "export_001", baseRevision: 8 })).resolves.toEqual(body);
    await expect(fetchExport("job_export_001")).resolves.toEqual(body);
    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/exports",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ baseRevision: 8, requestId: "export_001" }),
      }),
    ]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/exports/job_export_001");
  });

  it("loads and writes revision-bound Alpha evidence", async () => {
    const body = { audit: { project: { revision: 9 } }, progress: {}, events: [] };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    let request = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `alpha_request_${++request}` });

    await fetchAlphaAudit("/api/alpha-audit");
    await labelAlphaCandidate({
      requestId: "alpha_request_1",
      candidateId: "candidate 001",
      baseRevision: 9,
      sourceSha256: "sha256:source",
      label: "true_positive",
    });
    await labelAlphaBoundary({
      requestId: "alpha_request_2",
      boundaryId: "boundary 001",
      baseRevision: 9,
      sourceSha256: "sha256:source",
      usable: false,
      issueCodes: ["clipped_syllable"],
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/alpha-audit");
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/alpha-audit/candidates/candidate%20001",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          baseRevision: 9,
          sourceSha256: "sha256:source",
          label: "true_positive",
          requestId: "alpha_request_1",
        }),
      }),
    ]);
    expect(fetchMock.mock.calls[2]).toEqual([
      "/api/alpha-audit/boundaries/boundary%20001",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          baseRevision: 9,
          sourceSha256: "sha256:source",
          usable: false,
          issueCodes: ["clipped_syllable"],
          requestId: "alpha_request_2",
        }),
      }),
    ]);
  });

  it("posts server-clocked Alpha timing transitions with the audit binding", async () => {
    const body = { audit: { project: { revision: 9 } }, progress: {}, timing: {}, events: [] };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    let request = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `timing_request_${++request}` });
    const binding = { baseRevision: 9, sourceSha256: "sha256:source" };

    await beginAlphaTiming({
      ...binding,
      requestId: "timing_begin_stable_001",
      manualBaselineSeconds: 180,
      method: "screen_recording",
      operatorId: "partner-01",
      evidenceSha256: `sha256:${"c".repeat(64)}`,
      sessionId: "session-begin-001",
    });
    await setAlphaTimingBaseline({
      requestId: "timing_request_1",
      ...binding,
      manualBaselineSeconds: 180,
      method: "stopwatch",
      operatorId: "partner-01",
      evidenceSha256: `sha256:${"c".repeat(64)}`,
    });
    await startAlphaTiming({ requestId: "timing_request_2", ...binding, sessionId: "session-001" });
    await heartbeatAlphaTiming({ requestId: "timing_request_3", ...binding, sessionId: "session-001" });
    await pauseAlphaTiming({ requestId: "timing_request_4", ...binding, sessionId: "session-001", reason: "idle" });
    await finishAlphaTiming({ requestId: "timing_request_5", ...binding });

    expect(fetchMock.mock.calls.map(([path, init]) => [path, JSON.parse(init.body)])).toEqual([
      ["/api/alpha-audit/timing/begin", {
        ...binding,
        manualBaselineSeconds: 180,
        method: "screen_recording",
        operatorId: "partner-01",
        evidenceSha256: `sha256:${"c".repeat(64)}`,
        sessionId: "session-begin-001",
        requestId: "timing_begin_stable_001",
      }],
      ["/api/alpha-audit/timing/baseline", {
        ...binding,
        manualBaselineSeconds: 180,
        method: "stopwatch",
        operatorId: "partner-01",
        evidenceSha256: `sha256:${"c".repeat(64)}`,
        requestId: "timing_request_1",
      }],
      ["/api/alpha-audit/timing/start", {
        ...binding,
        sessionId: "session-001",
        requestId: "timing_request_2",
      }],
      ["/api/alpha-audit/timing/heartbeat", {
        ...binding,
        sessionId: "session-001",
        requestId: "timing_request_3",
      }],
      ["/api/alpha-audit/timing/pause", {
        ...binding,
        sessionId: "session-001",
        reason: "idle",
        requestId: "timing_request_4",
      }],
      ["/api/alpha-audit/timing/finish", {
        ...binding,
        requestId: "timing_request_5",
      }],
    ]);
  });

  it("preserves structured revision conflict details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "REVISION_CONFLICT",
        message: "Project advanced",
        details: { expected: 6, received: 5 },
      },
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    })));
    vi.stubGlobal("crypto", { randomUUID: () => "request_002" });

    await expect(reviewCandidate({
      requestId: "request_002",
      candidateId: "candidate_002",
      action: "keep",
      baseRevision: 5,
    })).rejects.toEqual(expect.objectContaining<Partial<ReviewApiError>>({
      status: 409,
      code: "REVISION_CONFLICT",
      details: { expected: 6, received: 5 },
    }));
  });

  it("turns a development proxy 502 into an actionable daemon message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Bad Gateway", {
      status: 502,
    })));

    await expect(fetchReview("/api/review")).rejects.toEqual(
      expect.objectContaining<Partial<ReviewApiError>>({
        status: 502,
        code: "DAEMON_UNAVAILABLE",
        message: expect.stringContaining("pnpm studio"),
      }),
    );
  });
});
