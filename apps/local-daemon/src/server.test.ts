import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { compileEditProposalBundle } from "@agentcut/edit-commands";
import { createPreviewProxyBinding } from "@agentcut/host-extensions";
import { ProjectStore } from "@agentcut/project-store";
import { RenderError, type PersistedRenderJobOptions } from "@agentcut/render-engine";
import {
  type AgentCutProjectDocument,
  type Asset,
  type CaptionDocumentArtifact,
  type RenderReportArtifact,
} from "@agentcut/timeline-schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureUiCredentialFile,
  readUiCredentialFile,
} from "../../../scripts/agentcut-credentials.mjs";
import {
  createAgentCutServer,
  handleAgentCutRequest,
  recoverExportJobs,
  statusForCode,
} from "./server.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("AgentCut local daemon", () => {
  it("reports deterministic document validation failures as authoritative 422 responses", () => {
    expect(statusForCode("INVALID_DOCUMENT")).toBe(422);
    expect(statusForCode("RENDER_CAPABILITY_MISSING")).toBe(422);
    expect(statusForCode("INTERNAL_ERROR")).toBe(500);
  });

  it("rejects paired Alpha timing for projects that were not prospectively enrolled", async () => {
    const fixture = createFixtureProject("agentcut-nonformal-alpha-timing-");
    const initial = await request(fixture.options, "GET", "/api/alpha-audit");
    const binding = (initial.body as {
      audit: { project: { revision: number; sourceSha256: string; alphaTrial?: unknown } };
    }).audit.project;
    expect(binding.alphaTrial ?? null).toBeNull();

    await expect(request(fixture.options, "POST", "/api/alpha-audit/timing/begin", {
      requestId: "nonformal-alpha-begin",
      baseRevision: binding.revision,
      sourceSha256: binding.sourceSha256,
      manualBaselineSeconds: 100,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sessionId: "nonformal-alpha-session",
    })).rejects.toMatchObject({ code: "ALPHA_TRIAL_ENROLLMENT_REQUIRED" });
  });

  it("locks formal Alpha sample edits outside an active timer while preserving exact replay", async () => {
    const fixture = createFixtureProject("agentcut-formal-alpha-trial-", (document) => {
      document.extensions = {
        ...document.extensions,
        "agentcut.alphaTrial": {
          schemaVersion: "1.0",
          mode: "formal",
          enrolledAt: "2026-08-10T00:00:00.000Z",
        },
      };
    });
    const initial = await request(fixture.options, "GET", "/api/alpha-audit");
    const initialAudit = initial.body as {
      audit: { project: {
        revision: number;
        sourceSha256: string;
        alphaTrial: { mode: string; enrolledAt: string } | null;
      } };
    };
    expect(initialAudit.audit.project.alphaTrial).toEqual({
      mode: "formal",
      enrolledAt: "2026-08-10T00:00:00.000Z",
    });

    const agentBootstrapToken = "formal-alpha-semantic-bootstrap-token-long-enough";
    const agentOptions = { ...fixture.options, agentBootstrapToken };
    const agentSession = await request(agentOptions, "POST", "/api/agent/sessions", {
      requestId: "formal-semantic-session",
      clientId: "codex-formal-semantic",
      capabilities: ["analysis:propose"],
      ttlSeconds: 3_600,
    }, { authorization: `Bearer ${agentBootstrapToken}` });
    const agentAccessToken = (agentSession.body as { accessToken: string }).accessToken;
    await expect(request(
      agentOptions,
      "POST",
      "/api/agent/semantic-findings",
      {
        requestId: "formal-semantic-before-timer",
        baseRevision: 0,
        findings: [{
          category: "correction",
          removeStartWordId: "word_001",
          removeEndWordId: "word_001",
          keepStartWordId: "word_003",
          keepEndWordId: "word_004",
          confidence: 0.9,
          explanationZh: "正式样本门禁测试，不应在计时前进入证据判断。",
        }],
      },
      {
        authorization: `Bearer ${agentAccessToken}`,
        "x-agentcut-request-id": "formal-semantic-before-timer",
      },
    )).rejects.toMatchObject({ code: "ALPHA_TRIAL_TIMING_REQUIRED" });

    await expect(request(
      fixture.options,
      "POST",
      "/api/candidates/candidate_filler_001/accept",
      { requestId: "formal-edit", baseRevision: initialAudit.audit.project.revision },
    )).rejects.toMatchObject({ code: "ALPHA_TRIAL_TIMING_REQUIRED" });

    await expect(request(fixture.options, "POST", "/api/alpha-audit/timing/begin", {
      requestId: "formal-begin-without-proof",
      baseRevision: initialAudit.audit.project.revision,
      sourceSha256: initialAudit.audit.project.sourceSha256,
      manualBaselineSeconds: 100,
      method: "stopwatch",
      sessionId: "formal-session-without-proof",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await request(fixture.options, "POST", "/api/alpha-audit/timing/begin", {
      requestId: "formal-begin",
      baseRevision: initialAudit.audit.project.revision,
      sourceSha256: initialAudit.audit.project.sourceSha256,
      manualBaselineSeconds: 100,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sessionId: "formal-session",
    });
    const edited = await request(
      fixture.options,
      "POST",
      "/api/candidates/candidate_filler_001/accept",
      { requestId: "formal-edit", baseRevision: initialAudit.audit.project.revision },
    );
    const editedRevision = (edited.body as { project: { revision: number } }).project.revision;
    expect(editedRevision).toBe(initialAudit.audit.project.revision + 1);

    await request(fixture.options, "POST", "/api/alpha-audit/timing/pause", {
      requestId: "formal-pause",
      baseRevision: editedRevision,
      sourceSha256: initialAudit.audit.project.sourceSha256,
      sessionId: "formal-session",
      reason: "user",
    });
    await expect(request(fixture.options, "POST", "/api/alpha-audit/timing/finish", {
      requestId: "formal-finish-too-early",
      baseRevision: editedRevision,
      sourceSha256: initialAudit.audit.project.sourceSha256,
    })).rejects.toMatchObject({ code: "ALPHA_TRIAL_NOT_READY_TO_FINISH" });
    const replay = await request(
      fixture.options,
      "POST",
      "/api/candidates/candidate_filler_001/accept",
      { requestId: "formal-edit", baseRevision: initialAudit.audit.project.revision },
    );
    expect((replay.body as { project: { revision: number } }).project.revision).toBe(editedRevision);
    await expect(request(
      fixture.options,
      "POST",
      "/api/candidates/candidate_silence_001/keep",
      { requestId: "formal-edit-after-pause", baseRevision: editedRevision },
    )).rejects.toMatchObject({ code: "ALPHA_TRIAL_TIMING_REQUIRED" });
    expect((await request(fixture.options, "GET", "/api/health")).body)
      .toEqual(expect.objectContaining({ revision: editedRevision }));
  });

  it("rejects formal final labels until timing is finished after the accepted export", async () => {
    const fixture = createFixtureProject("agentcut-formal-label-order-", (document) => {
      document.extensions = {
        ...document.extensions,
        "agentcut.alphaTrial": {
          schemaVersion: "1.0",
          mode: "formal",
          enrolledAt: "2026-08-13T00:00:00.000Z",
        },
      };
    });
    let now = "2026-08-13T00:00:00.000Z";
    const options = { ...fixture.options, alphaEvidenceClock: () => now };
    const initial = await request(options, "GET", "/api/alpha-audit");
    const binding = (initial.body as {
      audit: { project: { revision: number; sourceSha256: string } };
    }).audit.project;

    await request(options, "POST", "/api/alpha-audit/timing/begin", {
      requestId: "formal-label-order-begin",
      baseRevision: binding.revision,
      sourceSha256: binding.sourceSha256,
      manualBaselineSeconds: 120,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sessionId: "formal-label-order-session",
    });
    const deleted = await request(
      options,
      "POST",
      "/api/candidates/candidate_filler_001/accept",
      { requestId: "formal-label-order-delete", baseRevision: binding.revision },
    );
    const deletedRevision = (deleted.body as { project: { revision: number } }).project.revision;
    const kept = await request(options, "POST", "/api/candidates/keep-remaining", {
      requestId: "formal-label-order-keep",
      baseRevision: deletedRevision,
    });
    const acceptedRevision = (kept.body as { project: { revision: number } }).project.revision;
    commitPassingExport(fixture.databasePath);
    const finalRevision = acceptedRevision + 1;
    now = "2026-08-13T00:00:10.000Z";
    await request(options, "POST", "/api/alpha-audit/timing/pause", {
      requestId: "formal-label-order-pause",
      baseRevision: finalRevision,
      sourceSha256: binding.sourceSha256,
      sessionId: "formal-label-order-session",
      reason: "user",
    });

    await expect(request(
      options,
      "POST",
      "/api/alpha-audit/candidates/candidate_filler_001",
      {
        requestId: "formal-label-order-too-early",
        baseRevision: finalRevision,
        sourceSha256: binding.sourceSha256,
        label: "true_positive",
      },
    )).rejects.toMatchObject({ code: "INVALID_TIMING_STATE" });

    await request(options, "POST", "/api/alpha-audit/timing/finish", {
      requestId: "formal-label-order-finish",
      baseRevision: finalRevision,
      sourceSha256: binding.sourceSha256,
    });
    const labeled = await request(
      options,
      "POST",
      "/api/alpha-audit/candidates/candidate_filler_001",
      {
        requestId: "formal-label-order-after-finish",
        baseRevision: finalRevision,
        sourceSha256: binding.sourceSha256,
        label: "true_positive",
      },
    );
    expect(labeled.body).toEqual(expect.objectContaining({
      timing: expect.objectContaining({ state: "finished", complete: true }),
      progress: expect.objectContaining({ candidateLabeled: 1 }),
    }));
  });

  it("keeps active-time evidence across a real Timeline edit without timing writes changing revision", async () => {
    const fixture = createFixtureProject("agentcut-alpha-timing-", (document) => {
      document.extensions = {
        ...document.extensions,
        "agentcut.alphaTrial": {
          schemaVersion: "1.0",
          mode: "formal",
          enrolledAt: "2026-07-31T20:00:00.000Z",
        },
      };
    });
    let now = "2026-07-31T20:00:00.000Z";
    const options = { ...fixture.options, alphaEvidenceClock: () => now };
    const initial = await request(options, "GET", "/api/alpha-audit");
    const binding = (initial.body as {
      audit: { project: { revision: number; sourceSha256: string } };
    }).audit.project;
    const bound = { baseRevision: binding.revision, sourceSha256: binding.sourceSha256 };

    const begun = await request(options, "POST", "/api/alpha-audit/timing/begin", {
      ...bound,
      requestId: "api-timing-begin",
      manualBaselineSeconds: 100,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sessionId: "api-session",
    });
    expect(begun.body).toEqual(expect.objectContaining({
      timing: expect.objectContaining({
        baseline: {
          manualBaselineSeconds: 100,
          method: "stopwatch",
          operatorIdHash: "sha256:44bbfadc719174790d5ae76b635c642a758e3615b846b56591bf2b922a31a441",
          evidenceSha256: `sha256:${"c".repeat(64)}`,
        },
        state: "running",
        activeSessionId: "api-session",
      }),
      events: expect.arrayContaining([
        expect.objectContaining({ requestId: "api-timing-begin:baseline" }),
        expect.objectContaining({ requestId: "api-timing-begin:start" }),
      ]),
    }));
    const replay = await request(options, "POST", "/api/alpha-audit/timing/begin", {
      ...bound,
      requestId: "api-timing-begin",
      manualBaselineSeconds: 100,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sessionId: "api-session",
    });
    expect((replay.body as { events: unknown[] }).events).toHaveLength(2);
    now = "2026-07-31T20:00:15.000Z";
    await request(options, "POST", "/api/alpha-audit/timing/heartbeat", {
      ...bound,
      requestId: "api-timing-heartbeat",
      sessionId: "api-session",
    });
    const edited = await request(options, "POST", "/api/candidates/candidate_filler_001/accept", {
      requestId: "api-timing-edit",
      baseRevision: binding.revision,
    });
    const editedRevision = (edited.body as { project: { revision: number } }).project.revision;
    expect(editedRevision).toBe(binding.revision + 1);
    const afterEdit = await request(options, "GET", "/api/alpha-audit");
    expect(afterEdit.body).toEqual(expect.objectContaining({
      timing: expect.objectContaining({
        agentCutActiveSeconds: 15,
        state: "running",
        activeSessionId: "api-session",
      }),
    }));
    const rebound = { baseRevision: editedRevision, sourceSha256: binding.sourceSha256 };
    now = "2026-07-31T20:00:25.000Z";
    await request(options, "POST", "/api/alpha-audit/timing/heartbeat", {
      ...rebound,
      requestId: "api-timing-heartbeat-after-edit",
      sessionId: "api-session",
    });
    now = "2026-07-31T20:00:35.000Z";
    const paused = await request(options, "POST", "/api/alpha-audit/timing/pause", {
      ...rebound,
      requestId: "api-timing-pause",
      sessionId: "api-session",
      reason: "page_hidden",
    });

    expect(paused.body).toEqual(expect.objectContaining({
      timing: {
        baseline: {
          manualBaselineSeconds: 100,
          method: "stopwatch",
          operatorIdHash: "sha256:44bbfadc719174790d5ae76b635c642a758e3615b846b56591bf2b922a31a441",
          evidenceSha256: `sha256:${"c".repeat(64)}`,
        },
        agentCutActiveSeconds: 35,
        state: "paused",
        activeSessionId: null,
        lastActivityAt: now,
        complete: false,
      },
    }));
    const refreshed = await request(options, "GET", "/api/alpha-audit");
    expect(refreshed.body).toEqual(expect.objectContaining({
      timing: expect.objectContaining({ agentCutActiveSeconds: 35, state: "paused", complete: false }),
    }));
    const health = await request(options, "GET", "/api/health");
    expect(health.body).toEqual(expect.objectContaining({ revision: editedRevision }));
  });

  it("persists revision-bound Alpha labels without changing Timeline revision", async () => {
    const fixture = createCommittedFixtureProject("agentcut-alpha-evidence-");
    const initial = await request(fixture.options, "GET", "/api/alpha-audit");
    expect(initial.status).toBe(200);
    const initialBody = initial.body as {
      audit: {
        project: { revision: number; sourceSha256: string };
        candidates: Array<{ candidateId: string; humanLabel: string | null }>;
        boundaries: Array<{ boundaryId: string; humanUsable: boolean | null }>;
      };
      progress: { candidateLabeled: number; boundaryLabeled: number };
    };
    expect(initialBody.audit.project.revision).toBe(1);
    expect(initialBody.progress).toEqual(expect.objectContaining({
      candidateLabeled: 0,
      boundaryLabeled: 0,
    }));
    const candidateId = initialBody.audit.candidates.find((candidate) =>
      candidate.candidateId === "candidate_filler_001",
    )?.candidateId;
    const boundaryId = initialBody.audit.boundaries[0]?.boundaryId;
    expect(candidateId).toBe("candidate_filler_001");
    expect(boundaryId).toBeTruthy();

    await expect(request(
      fixture.options,
      "POST",
      `/api/alpha-audit/candidates/${candidateId}`,
      {
        requestId: "alpha-candidate-before-review-complete",
        baseRevision: 1,
        sourceSha256: initialBody.audit.project.sourceSha256,
        label: "true_positive",
      },
    )).rejects.toMatchObject({ code: "INVALID_LABEL" });
    const kept = await request(fixture.options, "POST", "/api/candidates/keep-remaining", {
      requestId: "alpha-finish-content-review",
      baseRevision: 1,
    });
    expect(kept.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 2 }),
      roughCutStatus: "rough_cut_ready",
    }));
    await expect(request(fixture.options, "POST", "/api/alpha-audit/timing/baseline", {
      requestId: "alpha-retroactive-timing-baseline",
      baseRevision: 2,
      sourceSha256: initialBody.audit.project.sourceSha256,
      manualBaselineSeconds: 100,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    })).rejects.toMatchObject({ code: "ALPHA_TRIAL_ENROLLMENT_REQUIRED" });
    await expect(request(
      fixture.options,
      "POST",
      `/api/alpha-audit/candidates/${candidateId}`,
      {
        requestId: "alpha-candidate-before-export",
        baseRevision: 2,
        sourceSha256: initialBody.audit.project.sourceSha256,
        label: "true_positive",
      },
    )).rejects.toMatchObject({ code: "INVALID_LABEL" });
    commitPassingExport(fixture.databasePath);

    const candidate = await request(
      fixture.options,
      "POST",
      `/api/alpha-audit/candidates/${candidateId}`,
      {
        requestId: "alpha-candidate-001",
        baseRevision: 3,
        sourceSha256: initialBody.audit.project.sourceSha256,
        label: "true_positive",
        note: "试听确认",
      },
    );
    expect(candidate.body).toEqual(expect.objectContaining({
      audit: expect.objectContaining({
        project: expect.objectContaining({ revision: 3 }),
        candidates: expect.arrayContaining([expect.objectContaining({
          candidateId,
          humanLabel: "true_positive",
          humanNote: "试听确认",
        })]),
      }),
    }));

    const boundary = await request(
      fixture.options,
      "POST",
      `/api/alpha-audit/boundaries/${boundaryId}`,
      {
        requestId: "alpha-boundary-001",
        baseRevision: 3,
        sourceSha256: initialBody.audit.project.sourceSha256,
        usable: false,
        issueCodes: ["clipped_syllable"],
      },
    );
    expect(boundary.body).toEqual(expect.objectContaining({
      audit: expect.objectContaining({
        boundaries: expect.arrayContaining([expect.objectContaining({
          boundaryId,
          humanUsable: false,
          humanIssueCodes: ["clipped_syllable"],
        })]),
      }),
    }));

    const refreshed = await request(fixture.options, "GET", "/api/alpha-audit");
    expect(refreshed.body).toEqual(expect.objectContaining({
      progress: expect.objectContaining({ candidateLabeled: 1, boundaryLabeled: 1 }),
      events: expect.arrayContaining([
        expect.objectContaining({ requestId: "alpha-candidate-001" }),
        expect.objectContaining({ requestId: "alpha-boundary-001" }),
      ]),
    }));
    const health = await request(fixture.options, "GET", "/api/health");
    expect(health.body).toEqual(expect.objectContaining({ revision: 3 }));

    await expect(request(
      fixture.options,
      "POST",
      `/api/alpha-audit/candidates/${candidateId}`,
      {
        requestId: "alpha-candidate-stale",
        baseRevision: 1,
        sourceSha256: initialBody.audit.project.sourceSha256,
        label: "true_positive",
      },
    )).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(request(
      fixture.options,
      "POST",
      `/api/alpha-audit/candidates/${candidateId}`,
      {
        requestId: "alpha-candidate-wrong-source",
        baseRevision: 3,
        sourceSha256: "sha256:wrong-source",
        label: "true_positive",
      },
    )).rejects.toMatchObject({ code: "AUDIT_BINDING_CONFLICT" });
  });

  it("recovers pending exports and diagnoses interrupted running jobs on restart", async () => {
    const fixture = createFixtureProject("agentcut-export-recovery-");
    const store = ProjectStore.open(fixture.databasePath);
    store.createJob({
      id: "job_export_pending",
      type: "export.render",
      payload: { sourceRevision: 0, sequenceId: "sequence_main", transcriptArtifactId: "transcript_main_001" },
    });
    store.createJob({
      id: "job_export_interrupted",
      type: "export.render",
      payload: { sourceRevision: 0, sequenceId: "sequence_main", transcriptArtifactId: "transcript_main_001" },
    });
    store.startJob("job_export_interrupted");
    store.createJob({
      id: "job_export_recoverable",
      type: "export.render",
      payload: { sourceRevision: 0, sequenceId: "sequence_main", transcriptArtifactId: "transcript_main_001" },
    });
    store.startJob("job_export_recoverable");
    store.createJob({
      id: "job_export_source_drift",
      type: "export.render",
      payload: { sourceRevision: 0, sequenceId: "sequence_main", transcriptArtifactId: "transcript_main_001" },
    });
    store.startJob("job_export_source_drift");
    store.createJob({
      id: "job_export_cancelled_on_restart",
      type: "export.render",
      payload: { sourceRevision: 0, sequenceId: "sequence_main", transcriptArtifactId: "transcript_main_001" },
    });
    store.startJob("job_export_cancelled_on_restart");
    store.requestJobCancellation("job_export_cancelled_on_restart", {
      requestId: "cancel_on_restart_001",
      requestedBy: "local_user",
    });
    store.close();
    let recoveredPending: string | undefined;

    recoverExportJobs({
      ...fixture.options,
      renderJobRunner: async ({ jobId }) => {
        recoveredPending = jobId;
        return undefined;
      },
      renderRecoveryRunner: async ({ store: recoveryStore, jobId }) => {
        if (jobId === "job_export_source_drift") {
          throw new RenderError(
            "SOURCE_INTEGRITY_FAILED",
            "Managed source bytes drifted",
            { assetId: "asset_main" },
          );
        }
        if (jobId !== "job_export_recoverable") return null;
        recoveryStore.succeedJob(jobId, []);
        return { recovered: true };
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const reopened = ProjectStore.open(fixture.databasePath);
    expect(recoveredPending).toBe("job_export_pending");
    expect(reopened.getJob("job_export_interrupted")).toEqual(expect.objectContaining({
      status: "outcome_unknown",
      error: expect.objectContaining({ code: "EXPORT_INTERRUPTED" }),
    }));
    expect(reopened.getJob("job_export_recoverable").status).toBe("succeeded");
    expect(reopened.getJob("job_export_source_drift")).toEqual(expect.objectContaining({
      status: "failed",
      retryable: false,
      error: expect.objectContaining({
        code: "SOURCE_INTEGRITY_FAILED",
        details: { assetId: "asset_main" },
      }),
    }));
    expect(reopened.getJob("job_export_cancelled_on_restart")).toEqual(expect.objectContaining({
      status: "cancelled",
      cancelRequested: true,
    }));
    reopened.close();
    const unknownStatus = await request(
      fixture.options,
      "GET",
      "/api/exports/job_export_interrupted",
    );
    expect(unknownStatus.body).toEqual(expect.objectContaining({
      status: "outcome_unknown",
      canCancel: false,
      cancelRequested: false,
      error: expect.objectContaining({ code: "EXPORT_INTERRUPTED" }),
    }));
  });

  it("creates a revision-bound export job only after rough-cut review is complete", async () => {
    const fixture = createFixtureProject("agentcut-export-job-");
    const kept = await request(fixture.options, "POST", "/api/candidates/keep-remaining", {
      requestId: "finish_review_001",
      baseRevision: 0,
    });
    expect((kept.body as { roughCutStatus: string }).roughCutStatus).toBe("rough_cut_ready");
    let scheduledJobId: string | undefined;
    let scheduledOutputPolicy: PersistedRenderJobOptions["existingOutputPolicy"];
    const options = {
      ...fixture.options,
      renderCapabilityInspector: () => ({
        ready: true,
        ffmpegVersion: "ffmpeg test",
        ffprobeVersion: "ffprobe test",
        availableBytes: 2_000_000_000,
        missing: [],
      }),
      renderJobRunner: async (input: PersistedRenderJobOptions) => {
        const { jobId } = input;
        scheduledJobId = jobId;
        scheduledOutputPolicy = input.existingOutputPolicy;
        return undefined;
      },
    };

    const created = await request(options, "POST", "/api/exports", {
      requestId: "export_001",
      baseRevision: 1,
    });
    expect(created.status).toBe(202);
    expect(created.body).toEqual(expect.objectContaining({
      jobId: "job_export_export_001",
      status: "pending",
      sourceRevision: 1,
      progress: 0,
    }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(scheduledJobId).toBe("job_export_export_001");
    expect(scheduledOutputPolicy).toBe("recover_or_preserve");

    const status = await request(options, "GET", "/api/exports/job_export_export_001");
    expect(status.body).toEqual(expect.objectContaining({
      jobId: "job_export_export_001",
      status: "pending",
    }));

    const refreshedReview = await request(options, "GET", "/api/review");
    expect(refreshedReview.body).toEqual(expect.objectContaining({
      exports: [expect.objectContaining({
        jobId: "job_export_export_001",
        status: "pending",
        sourceRevision: 1,
      })],
    }));
  });

  it("threads the vertical preset into the render job and rejects preset replay conflicts", async () => {
    const fixture = createFixtureProject("agentcut-export-preset-");
    await request(fixture.options, "POST", "/api/candidates/keep-remaining", {
      requestId: "finish_review_preset",
      baseRevision: 0,
    });
    let scheduledOutput: PersistedRenderJobOptions["output"];
    const options = {
      ...fixture.options,
      renderCapabilityInspector: () => ({
        ready: true,
        ffmpegVersion: "ffmpeg test",
        ffprobeVersion: "ffprobe test",
        availableBytes: 2_000_000_000,
        missing: [],
      }),
      renderJobRunner: async (input: PersistedRenderJobOptions) => {
        scheduledOutput = input.output;
        return undefined;
      },
    };

    const created = await request(options, "POST", "/api/exports", {
      requestId: "export_vertical_001",
      baseRevision: 1,
      preset: "vertical-9-16",
    });
    expect(created.status).toBe(202);
    expect(created.body).toEqual(expect.objectContaining({
      jobId: "job_export_export_vertical_001",
      preset: "vertical-9-16",
    }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(scheduledOutput).toEqual({ width: 1080, height: 1920, fitMode: "cover" });

    // 同一 requestId + 同一 preset 幂等重放；换 preset 必须拒绝而不是悄悄改导出规格。
    const replay = await request(options, "POST", "/api/exports", {
      requestId: "export_vertical_001",
      baseRevision: 1,
      preset: "vertical-9-16",
    });
    expect(replay.status).toBe(202);
    await expect(request(options, "POST", "/api/exports", {
      requestId: "export_vertical_001",
      baseRevision: 1,
      preset: "source",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    await expect(request(fixture.options, "POST", "/api/exports", {
      requestId: "export_bogus_preset",
      baseRevision: 1,
      preset: "square-1-1",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    // 未带 preset 的导出按 source 画布调度，与旧 job 语义保持一致。
    let legacyOutput: PersistedRenderJobOptions["output"];
    const legacyOptions = {
      ...options,
      renderJobRunner: async (input: PersistedRenderJobOptions) => {
        legacyOutput = input.output;
        return undefined;
      },
    };
    const legacy = await request(legacyOptions, "POST", "/api/exports", {
      requestId: "export_legacy_default",
      baseRevision: 1,
    });
    expect(legacy.status).toBe(202);
    expect(legacy.body).toEqual(expect.objectContaining({ preset: "source" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(legacyOutput).toEqual({ width: 1080, height: 1920, fitMode: "contain" });
  });

  it("cancels a running export through AbortSignal with idempotent audit and no Timeline edit", async () => {
    const fixture = createFixtureProject("agentcut-export-cancel-");
    const agentBootstrapToken = "agentcut-export-cancel-bootstrap-token-long-enough";
    await request(fixture.options, "POST", "/api/candidates/keep-remaining", {
      requestId: "finish_review_for_cancel",
      baseRevision: 0,
    });
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let notifyFinished!: () => void;
    const finished = new Promise<void>((resolve) => { notifyFinished = resolve; });
    const options = {
      ...fixture.options,
      agentBootstrapToken,
      renderCapabilityInspector: () => ({
        ready: true,
        ffmpegVersion: "ffmpeg test",
        ffprobeVersion: "ffprobe test",
        availableBytes: 2_000_000_000,
        missing: [],
      }),
      renderJobRunner: async (input: PersistedRenderJobOptions) => {
        input.store.startJob(input.jobId);
        notifyStarted();
        if (!input.signal?.aborted) {
          await new Promise<void>((resolve) => {
            input.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        const job = input.store.getJob(input.jobId);
        if (job.status === "running" && job.cancelRequested) {
          input.store.markJobCancelled(input.jobId);
        }
        notifyFinished();
        return undefined;
      },
    };

    const sessionCreation = await request(options, "POST", "/api/agent/sessions", {
      requestId: "export-cancel-session-001",
      clientId: "codex-export-cancel-test",
      capabilities: ["export:write", "project:read"],
      ttlSeconds: 3_600,
    }, { authorization: `Bearer ${agentBootstrapToken}` });
    const session = (sessionCreation.body as {
      session: { id: string };
      accessToken: string;
    });

    await request(options, "POST", "/api/exports", {
      requestId: "export_cancel_target",
      baseRevision: 1,
    });
    await started;
    await expect(request(
      options,
      "POST",
      "/api/agent/exports/job_export_export_cancel_target/cancel",
      { requestId: "cancel-export-body-mismatch" },
      {
        authorization: `Bearer ${session.accessToken}`,
        "x-agentcut-request-id": "cancel-export-header-mismatch",
      },
    )).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const cancelled = await request(
      options,
      "POST",
      "/api/agent/exports/job_export_export_cancel_target/cancel",
      { requestId: "cancel-export-001" },
      {
        authorization: `Bearer ${session.accessToken}`,
        "x-agentcut-request-id": "cancel-export-001",
      },
    );
    expect(cancelled.status).toBe(202);
    expect(cancelled.body).toEqual(expect.objectContaining({
      status: "running",
      cancelRequested: true,
      canCancel: true,
    }));
    await finished;
    const terminal = await request(
      options,
      "GET",
      "/api/exports/job_export_export_cancel_target",
    );
    expect(terminal.body).toEqual(expect.objectContaining({
      status: "cancelled",
      cancelRequested: true,
      canCancel: false,
    }));
    const replay = await request(
      options,
      "POST",
      "/api/agent/exports/job_export_export_cancel_target/cancel",
      { requestId: "cancel-export-001" },
      {
        authorization: `Bearer ${session.accessToken}`,
        "x-agentcut-request-id": "cancel-export-001",
      },
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(expect.objectContaining({ status: "cancelled" }));

    const store = ProjectStore.open(fixture.databasePath);
    try {
      expect(store.listJobCancellationRequests("job_export_export_cancel_target")).toEqual([
        expect.objectContaining({
          requestId: "cancel-export-001",
          requestedBy: `agent:${session.session.id}`,
          observedStatus: "running",
          changed: true,
        }),
      ]);
      expect(store.listAgentAccessEvents(session.session.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          capability: "export:write",
          path: "/api/agent/exports/job_export_export_cancel_target/cancel",
          requestId: "cancel-export-001",
          allowed: true,
        }),
      ]));
      expect(store.snapshot().project.revision).toBe(1);
      expect(store.snapshot().artifacts.some((artifact) => artifact.kind === "renderReport"))
        .toBe(false);
    } finally {
      store.close();
    }

    const terminalStore = ProjectStore.open(fixture.databasePath);
    terminalStore.createJob({
      id: "job_export_already_succeeded",
      type: "export.render",
      payload: {
        sourceRevision: 1,
        sequenceId: "sequence_main",
        transcriptArtifactId: "transcript_fixture",
      },
    });
    terminalStore.startJob("job_export_already_succeeded");
    terminalStore.succeedJob("job_export_already_succeeded", []);
    terminalStore.close();
    const completedRace = await request(
      options,
      "POST",
      "/api/exports/job_export_already_succeeded/cancel",
      { requestId: "cancel-completed-export-001" },
    );
    expect(completedRace.status).toBe(200);
    expect(completedRace.body).toEqual(expect.objectContaining({
      status: "succeeded",
      cancelRequested: false,
      canCancel: false,
    }));
    const auditedTerminal = ProjectStore.open(fixture.databasePath);
    expect(auditedTerminal.listJobCancellationRequests("job_export_already_succeeded"))
      .toEqual([expect.objectContaining({
        requestId: "cancel-completed-export-001",
        observedStatus: "succeeded",
        changed: false,
      })]);
    expect(auditedTerminal.snapshot().project.revision).toBe(1);
    auditedTerminal.close();
  });

  it("blocks export with a precise FFmpeg capability diagnosis", async () => {
    const fixture = createFixtureProject("agentcut-export-doctor-");
    await request(fixture.options, "POST", "/api/candidates/keep-remaining", {
      requestId: "finish_review_002",
      baseRevision: 0,
    });

    await expect(request({
      ...fixture.options,
      renderCapabilityInspector: () => ({
        ready: false,
        ffmpegVersion: "ffmpeg test",
        ffprobeVersion: "ffprobe test",
        availableBytes: 2_000_000_000,
        missing: ["ass_filter" as const],
      }),
    }, "POST", "/api/exports", {
      requestId: "export_no_ass",
      baseRevision: 1,
    })).rejects.toMatchObject({
      code: "RENDER_CAPABILITY_MISSING",
      details: { missing: ["ass_filter"] },
    });
  });

  it("reports rough-cut readiness and a timeline preview plan", async () => {
    const fixture = createFixtureProject("agentcut-preview-status-");
    const reviewed = await request(fixture.options, "GET", "/api/review");

    expect(reviewed.body).toEqual(expect.objectContaining({
      roughCutStatus: "reviewing",
      preview: expect.objectContaining({
        revision: 0,
        durationSeconds: 10.01,
        segments: [expect.objectContaining({
          clipId: "clip_take_1",
          assetId: "asset_camera_a",
          timelineStartSeconds: 0,
          sourceStartSeconds: 1.001,
          durationSeconds: 10.01,
        })],
      }),
    }));
  });

  it("previews a manual Transcript selection without committing the deletion", async () => {
    const fixture = createFixtureProject("agentcut-selection-preview-");
    const previewed = await request(fixture.options, "POST", "/api/selections/preview", {
      requestId: "selection-preview-001",
      baseRevision: 0,
      wordIds: ["word_003", "word_004"],
    });

    expect(previewed.body).toEqual(expect.objectContaining({
      wordIds: ["word_003", "word_004"],
      baseRevision: 0,
      preview: expect.objectContaining({
        revision: 0,
        durationSeconds: expect.any(Number),
        segments: expect.any(Array),
      }),
    }));
    expect((previewed.body as { preview: { durationSeconds: number } }).preview.durationSeconds)
      .toBeLessThan(10.01);
    const store = ProjectStore.open(fixture.databasePath);
    expect(store.snapshot().project.revision).toBe(0);
    expect(store.listRecords()).toHaveLength(0);
    store.close();

    await expect(request(fixture.options, "POST", "/api/selections/preview", {
      requestId: "selection-preview-stale",
      baseRevision: 1,
      wordIds: ["word_003", "word_004"],
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(request(fixture.options, "POST", "/api/selections/preview", {
      requestId: "selection-preview-noncontiguous",
      baseRevision: 0,
      wordIds: ["word_001", "word_003"],
    })).rejects.toMatchObject({ code: "INVALID_SELECTION" });
  });

  it("previews a pending candidate deletion without changing project state", async () => {
    const fixture = createFixtureProject("agentcut-candidate-preview-");
    const previewed = await request(
      fixture.options,
      "GET",
      "/api/candidates/candidate_silence_001/preview?baseRevision=0",
    );

    expect(previewed.body).toEqual(expect.objectContaining({
      candidateId: "candidate_silence_001",
      baseRevision: 0,
      preview: expect.objectContaining({
        revision: 0,
        durationSeconds: 9.9099,
        segments: [
          expect.objectContaining({ sourceStartSeconds: 1.001, durationSeconds: 0.6006 }),
          expect.objectContaining({ sourceStartSeconds: 1.7017, durationSeconds: 9.3093 }),
        ],
      }),
    }));
    expect((await request(fixture.options, "GET", "/api/health")).body).toEqual(
      expect.objectContaining({ revision: 0 }),
    );
    const store = ProjectStore.open(fixture.databasePath);
    expect(store.listRecords()).toHaveLength(0);
    store.close();

    await expect(request(
      fixture.options,
      "GET",
      "/api/candidates/candidate_silence_001/preview?baseRevision=1",
    )).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await request(fixture.options, "POST", "/api/candidates/candidate_silence_001/keep", {
      requestId: "keep-before-preview",
      baseRevision: 0,
    });
    await expect(request(
      fixture.options,
      "GET",
      "/api/candidates/candidate_silence_001/preview?baseRevision=1",
    )).rejects.toMatchObject({ code: "CANDIDATE_UNAVAILABLE" });
  });

  it("issues audited capability sessions, guards Agent routes, and returns revision diffs", async () => {
    const fixture = createFixtureProject("agentcut-agent-session-", (document) => {
      document.artifacts = document.artifacts.filter((artifact) =>
        artifact.kind !== "deletionCandidateSet" && artifact.kind !== "editProposal",
      );
    });
    const bootstrapToken = "agentcut-test-bootstrap-token-that-is-long-enough";
    const options = {
      ...fixture.options,
      agentBootstrapToken: bootstrapToken,
      agentAccessClock: () => "2026-08-10T01:00:00.000Z",
      silenceDetector: () => [],
    };
    const created = await request(options, "POST", "/api/agent/sessions", {
      requestId: "agent-session-create-001",
      clientId: "codex-mcp",
      capabilities: ["project:read", "timeline:write:low_risk_only"],
      ttlSeconds: 3_600,
    }, { authorization: `Bearer ${bootstrapToken}` });
    expect(created.status).toBe(201);
    const createdBody = created.body as {
      accessToken: string;
      session: { id: string; capabilities: string[]; expiresAt: string };
      idempotentReplay: boolean;
    };
    expect(createdBody).toEqual(expect.objectContaining({
      accessToken: expect.stringMatching(/^agc_/),
      idempotentReplay: false,
      session: expect.objectContaining({
        capabilities: ["project:read", "timeline:write:low_risk_only"],
        expiresAt: "2026-08-10T02:00:00.000Z",
      }),
    }));
    const replay = await request(options, "POST", "/api/agent/sessions", {
      requestId: "agent-session-create-001",
      clientId: "codex-mcp",
      capabilities: ["project:read", "timeline:write:low_risk_only"],
      ttlSeconds: 3_600,
    }, { authorization: `Bearer ${bootstrapToken}` });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(expect.objectContaining({
      accessToken: createdBody.accessToken,
      idempotentReplay: true,
    }));

    const headers = { authorization: `Bearer ${createdBody.accessToken}` };
    const status = await request(options, "GET", "/api/agent/status", undefined, headers);
    expect(status.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 0 }),
      capabilities: expect.objectContaining({
        agentSession: expect.objectContaining({ id: createdBody.session.id, clientId: "codex-mcp" }),
      }),
    }));
    await expect(request(
      options,
      "POST",
      "/api/agent/analyze-semantic",
      { requestId: "semantic-denied-001", baseRevision: 0 },
      { ...headers, "x-agentcut-request-id": "semantic-denied-001" },
    )).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    await expect(request(
      options,
      "GET",
      "/api/agent/status",
      undefined,
      { ...headers, "x-agentcut-request-id": "x".repeat(129) },
    )).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const roughCut = await request(
      options,
      "POST",
      "/api/agent/rough-cut/generate",
      { requestId: "agent-rough-cut-001", baseRevision: 0 },
      { ...headers, "x-agentcut-request-id": "agent-rough-cut-001" },
    );
    expect(roughCut.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
    }));
    const diff = await request(
      options,
      "GET",
      "/api/agent/project/diff?fromRevision=0",
      undefined,
      headers,
    );
    expect(diff.body).toEqual({
      projectId: "project_demo_001",
      fromRevision: 0,
      toRevision: 1,
      headRevision: 1,
      changes: [expect.objectContaining({
        transactionId: "tx_rough_cut_generate_agent-rough-cut-001",
        baseRevision: 0,
        committedRevision: 1,
        actor: { kind: "workflow", id: "rough_cut_v1" },
        operationTypes: ["artifact.put", "artifact.put", "range.deleteRipple"],
        objectIds: expect.arrayContaining(["track_v1"]),
      })],
    });
    await expect(request(
      options,
      "GET",
      "/api/agent/project/diff?fromRevision=2",
      undefined,
      headers,
    )).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(request(
      options,
      "POST",
      "/api/agent/candidates/candidate_filler_001/accept",
      { requestId: "agent-high-risk-bypass", baseRevision: 1, confirmHighRisk: true },
      headers,
    )).resolves.toEqual(expect.objectContaining({ status: 404 }));

    const sessionReview = await request(options, "GET", "/api/review");
    expect(sessionReview.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
      agentSessions: [expect.objectContaining({
        id: createdBody.session.id,
        clientId: "codex-mcp",
        access: expect.objectContaining({ total: 5, allowed: 4, denied: 1 }),
      })],
    }));
    expect(JSON.stringify(sessionReview.body)).not.toContain(createdBody.accessToken);
    expect(JSON.stringify(sessionReview.body)).not.toContain("tokenHash");

    const revoked = await request(
      options,
      "POST",
      `/api/agent-sessions/${createdBody.session.id}/revoke`,
      { requestId: "agent-session-revoke-001" },
    );
    expect(revoked.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
      agentSessions: [expect.objectContaining({
        id: createdBody.session.id,
        revokedAt: "2026-08-10T01:00:00.000Z",
      })],
    }));
    const revokeReplay = await request(
      options,
      "POST",
      `/api/agent-sessions/${createdBody.session.id}/revoke`,
      { requestId: "agent-session-revoke-001" },
    );
    expect(revokeReplay.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
    }));
    await expect(request(
      options,
      "GET",
      "/api/agent/status",
      undefined,
      headers,
    )).rejects.toMatchObject({
      code: "AGENT_SESSION_INVALID",
      details: expect.objectContaining({ reason: "revoked" }),
    });
    await expect(request(
      options,
      "POST",
      "/api/agent-sessions/session_missing/revoke",
      { requestId: "agent-session-revoke-missing" },
    )).rejects.toMatchObject({ code: "AGENT_SESSION_TARGET_NOT_FOUND" });

    const store = ProjectStore.open(fixture.databasePath);
    try {
      expect(store.snapshot().project.revision).toBe(1);
      expect(store.listAgentSessionRevocations()).toEqual([
        expect.objectContaining({
          sessionId: createdBody.session.id,
          requestId: "agent-session-revoke-001",
          revokedBy: "local_user",
          changed: true,
        }),
      ]);
      expect(store.listAgentAccessEvents()).toEqual(expect.arrayContaining([
        expect.objectContaining({ allowed: true, path: "/api/agent/status" }),
        expect.objectContaining({
          allowed: false,
          reason: "capability_denied",
          requestId: "semantic-denied-001",
        }),
        expect.objectContaining({
          allowed: true,
          capability: "timeline:write:low_risk_only",
          requestId: "agent-rough-cut-001",
        }),
        expect.objectContaining({
          allowed: false,
          reason: "revoked",
          sessionId: createdBody.session.id,
        }),
      ]));
    } finally {
      store.close();
    }
  });

  it("serves the protocol core: project summary and arbitrary validated timeline transactions", async () => {
    const fixture = createFixtureProject("agentcut-agent-core-", (document) => {
      document.artifacts = document.artifacts.filter((artifact) =>
        artifact.kind !== "deletionCandidateSet" && artifact.kind !== "editProposal",
      );
    });
    const bootstrapToken = "agentcut-core-bootstrap-token-that-is-long-enough";
    const options = {
      ...fixture.options,
      agentBootstrapToken: bootstrapToken,
      agentAccessClock: () => "2026-08-10T01:00:00.000Z",
    };
    const created = await request(options, "POST", "/api/agent/sessions", {
      requestId: "agent-core-session-001",
      clientId: "codex-core",
      capabilities: ["project:read", "timeline:write:low_risk_only"],
      ttlSeconds: 3_600,
    }, { authorization: `Bearer ${bootstrapToken}` });
    const headers = {
      authorization: `Bearer ${(created.body as { accessToken: string }).accessToken!}`,
    };

    const project = await request(options, "GET", "/api/agent/project", undefined, headers);
    expect(project.status).toBe(200);
    expect(project.body).toEqual({
      protocolVersion: "0.1.0",
      project: expect.objectContaining({
        id: "project_demo_001",
        revision: 0,
        activeSequenceId: "sequence_main",
      }),
      facts: expect.objectContaining({ clipCount: 1, transcriptArtifacts: 1 }),
      capabilities: {
        extensions: ["talking-head-review"],
        writePolicy: expect.objectContaining({
          timelineTransactions: expect.objectContaining({
            baseCapability: "timeline:write:low_risk_only",
            approvalCapability: "timeline:write:approved",
            approvalExtension: "talking-head-review",
          }),
        }),
      },
      session: expect.objectContaining({ clientId: "codex-core" }),
    });

    // §6.4：时间线结构读取——Agent 借此发现可编辑对象，无需宿主私有知识。
    const timeline = await request(options, "GET", "/api/agent/timeline", undefined, headers);
    expect(timeline.status).toBe(200);
    expect(timeline.body).toEqual(expect.objectContaining({
      protocolVersion: "0.1.0",
      timeline: expect.objectContaining({
        sequenceId: "sequence_main",
        totalClips: 1,
        nextOffset: null,
        tracks: [expect.objectContaining({ trackId: "track_v1", kind: "video", locked: false })],
        clips: [expect.objectContaining({
          clipId: "clip_take_1",
          trackId: "track_v1",
          kind: "media",
          assetId: "asset_camera_a",
          startMicros: 0,
          durationMicros: 10_010_000,
          enabled: true,
        })],
      }),
    }));
    const windowMiss = await request(
      options, "GET", "/api/agent/timeline?fromMicros=20000000", undefined, headers,
    );
    expect(windowMiss.body).toEqual(expect.objectContaining({
      timeline: expect.objectContaining({ totalClips: 0, clips: [] }),
    }));
    await expect(request(
      options, "GET", "/api/agent/timeline?sequenceId=sequence_nope", undefined, headers,
    )).rejects.toMatchObject({ code: "OBJECT_NOT_FOUND" });

    const transaction = {
      protocolVersion: "0.1.0",
      transactionId: "tx_core_disable_clip",
      idempotencyKey: "core:disable-clip:001",
      projectId: "project_demo_001",
      sequenceId: "sequence_main",
      baseRevision: 0,
      reason: "Disable first take while re-planning",
      preconditions: [],
      operations: [{ type: "clip.update", clipId: "clip_take_1", patch: { enabled: false } }],
      actor: { kind: "user", id: "spoofed-identity" },
    };
    const applied = await request(
      options,
      "POST",
      "/api/agent/timeline/transactions",
      transaction,
      { ...headers, "x-agentcut-request-id": "core:disable-clip:001" },
    );
    expect(applied.status).toBe(201);
    expect(applied.body).toEqual({
      protocolVersion: "0.1.0",
      revision: 1,
      idempotentReplay: false,
      record: expect.objectContaining({
        transactionId: "tx_core_disable_clip",
        baseRevision: 0,
        committedRevision: 1,
      }),
    });

    const replay = await request(
      options,
      "POST",
      "/api/agent/timeline/transactions",
      transaction,
      headers,
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(expect.objectContaining({ revision: 1, idempotentReplay: true }));

    await expect(request(
      options,
      "POST",
      "/api/agent/timeline/transactions",
      { ...transaction, transactionId: "tx_core_stale", idempotencyKey: "core:stale:001" },
      headers,
    )).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    const diff = await request(
      options,
      "GET",
      "/api/agent/project/diff?fromRevision=0",
      undefined,
      headers,
    );
    expect(diff.body).toEqual(expect.objectContaining({
      headRevision: 1,
      changes: [expect.objectContaining({
        transactionId: "tx_core_disable_clip",
        actor: { kind: "agent", id: "codex-core" },
        operationTypes: ["clip.update"],
        objectIds: ["clip_take_1"],
      })],
    }));

    await expect(request(
      options,
      "POST",
      "/api/agent/timeline/transactions",
      {
        ...transaction,
        transactionId: "tx_core_missing_clip",
        idempotencyKey: "core:missing-clip:001",
        baseRevision: 1,
        operations: [{ type: "clip.update", clipId: "clip_missing", patch: { enabled: false } }],
      },
      headers,
    )).rejects.toMatchObject({ code: "OBJECT_NOT_FOUND" });

    // 提交后的时间线读取反映新状态（rev 1，clip 已禁用）。
    const after = await request(options, "GET", "/api/agent/timeline", undefined, headers);
    expect(after.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
      timeline: expect.objectContaining({
        clips: [expect.objectContaining({ clipId: "clip_take_1", enabled: false })],
      }),
    }));

    const store = ProjectStore.open(fixture.databasePath);
    try {
      expect(store.snapshot().project.revision).toBe(1);
      expect(store.snapshot().sequences[0]!.tracks.flatMap((track) => track.clips))
        .toEqual([expect.objectContaining({ id: "clip_take_1", enabled: false })]);
    } finally {
      store.close();
    }
  });

  it("lets a scoped Agent page through the Transcript and persist only validated high-risk suggestions", async () => {
    const fixture = createFixtureProject("agentcut-agent-semantic-proposal-", (document) => {
      document.artifacts = document.artifacts.filter((artifact) =>
        artifact.kind !== "deletionCandidateSet" && artifact.kind !== "editProposal",
      );
      const transcript = document.artifacts.find((artifact) => artifact.kind === "transcript");
      if (!transcript || transcript.kind !== "transcript") throw new Error("Fixture transcript missing");
      transcript.words = [
        "我们", "采用", "第一种", "方案", "，", "不对", "，", "采用", "第二种", "方案", "。",
      ].map((text, index) => ({
        id: `semantic_word_${index}`,
        text,
        confidence: 0.98,
        sourceRange: {
          start: { value: 1_001 + index * 300, rate: { numerator: 1_000, denominator: 1 } },
          duration: { value: 240, rate: { numerator: 1_000, denominator: 1 } },
        },
      }));
    });
    const bootstrapToken = "agentcut-semantic-proposal-bootstrap-token-long-enough";
    const options = { ...fixture.options, agentBootstrapToken: bootstrapToken };
    const created = await request(options, "POST", "/api/agent/sessions", {
      requestId: "semantic-proposal-session-001",
      clientId: "codex-semantic-reviewer",
      capabilities: ["transcript:read", "analysis:propose"],
      ttlSeconds: 3_600,
    }, { authorization: `Bearer ${bootstrapToken}` });
    const accessToken = (created.body as { accessToken: string }).accessToken;
    const headers = { authorization: `Bearer ${accessToken}` };

    const transcriptPage = await request(
      options,
      "GET",
      "/api/agent/transcript?offset=2&limit=3",
      undefined,
      headers,
    );
    expect(transcriptPage.body).toEqual({
      protocolVersion: "0.1.0",
      project: { id: "project_demo_001", revision: 0 },
      transcript: expect.objectContaining({
        id: "transcript_main_001",
        language: "zh-CN",
        sourceSha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        totalWords: 11,
        offset: 2,
        limit: 3,
        nextOffset: 5,
        words: [
          expect.objectContaining({ wordId: "semantic_word_2", index: 2, text: "第一种" }),
          expect.objectContaining({ wordId: "semantic_word_3", index: 3, text: "方案" }),
          expect.objectContaining({ wordId: "semantic_word_4", index: 4, text: "，" }),
        ],
      }),
    });
    expect(JSON.stringify(transcriptPage.body)).not.toContain(fixture.options.projectRoot);

    const finding = {
      category: "correction",
      removeStartWordId: "semantic_word_0",
      removeEndWordId: "semantic_word_6",
      keepStartWordId: "semantic_word_7",
      keepEndWordId: "semantic_word_10",
      confidence: 0.91,
      explanationZh: "说话者用“不对”明确推翻第一种方案，随后给出第二种方案。",
    };
    const proposed = await request(
      options,
      "POST",
      "/api/agent/semantic-findings",
      { requestId: "semantic-propose-001", baseRevision: 0, findings: [finding] },
      { ...headers, "x-agentcut-request-id": "semantic-propose-001" },
    );
    expect(proposed.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
      review: expect.objectContaining({
        candidates: [expect.objectContaining({
          state: "candidate_remove",
          risk: "high",
          reasonCodes: ["correction"],
          evidence: [expect.objectContaining({
            role: "retained_comparison",
            wordIds: [
              "semantic_word_7", "semantic_word_8", "semantic_word_9", "semantic_word_10",
            ],
            text: "采用第二种方案。",
          })],
          wordIds: [
            "semantic_word_0", "semantic_word_1", "semantic_word_2", "semantic_word_3",
            "semantic_word_4", "semantic_word_5", "semantic_word_6",
          ],
        })],
      }),
    }));

    const replay = await request(
      options,
      "POST",
      "/api/agent/semantic-findings",
      { requestId: "semantic-propose-001", baseRevision: 0, findings: [finding] },
      { ...headers, "x-agentcut-request-id": "semantic-propose-001" },
    );
    expect((replay.body as { project: { revision: number } }).project.revision).toBe(1);
    await expect(request(
      options,
      "POST",
      "/api/agent/semantic-findings",
      {
        requestId: "semantic-propose-001",
        baseRevision: 0,
        findings: [{ ...finding, confidence: 0.92 }],
      },
      { ...headers, "x-agentcut-request-id": "semantic-propose-001" },
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(request(
      options,
      "POST",
      "/api/agent/semantic-findings",
      { requestId: "semantic-propose-stale", baseRevision: 0, findings: [finding] },
      { ...headers, "x-agentcut-request-id": "semantic-propose-stale" },
    )).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(request(
      options,
      "POST",
      "/api/agent/semantic-findings",
      {
        requestId: "semantic-propose-invalid",
        baseRevision: 1,
        findings: [{ ...finding, confidence: 2 }],
      },
      { ...headers, "x-agentcut-request-id": "semantic-propose-invalid" },
    )).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(request(
      options,
      "POST",
      "/api/agent/semantic-findings",
      {
        requestId: "semantic-propose-no-evidence",
        baseRevision: 1,
        findings: [{
          ...finding,
          removeStartWordId: "invented_word_1",
          removeEndWordId: "invented_word_2",
        }],
      },
      { ...headers, "x-agentcut-request-id": "semantic-propose-no-evidence" },
    )).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      details: { report: expect.objectContaining({ acceptedCandidates: 0 }) },
    });

    const readOnly = await request(options, "POST", "/api/agent/sessions", {
      requestId: "semantic-read-only-session-001",
      clientId: "codex-read-only",
      capabilities: ["transcript:read"],
      ttlSeconds: 3_600,
    }, { authorization: `Bearer ${bootstrapToken}` });
    const readOnlyToken = (readOnly.body as { accessToken: string }).accessToken;
    await expect(request(
      options,
      "POST",
      "/api/agent/semantic-findings",
      { requestId: "semantic-propose-denied", baseRevision: 1, findings: [] },
      {
        authorization: `Bearer ${readOnlyToken}`,
        "x-agentcut-request-id": "semantic-propose-denied",
      },
    )).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });

    const store = ProjectStore.open(fixture.databasePath);
    try {
      expect(store.snapshot().project.revision).toBe(1);
      const candidateSets = store.snapshot().artifacts.filter((artifact) =>
        artifact.kind === "deletionCandidateSet",
      );
      expect(candidateSets).toHaveLength(1);
      expect(candidateSets[0]).toEqual(expect.objectContaining({
        candidates: [expect.objectContaining({ risk: "high", decision: "suggest_remove" })],
      }));
      expect(store.listRecords()).toEqual([
        expect.objectContaining({
          transactionId: "tx_agent_semantic_semantic-propose-001",
          request: expect.objectContaining({
            actor: { kind: "agent", id: "codex-semantic-reviewer" },
            operations: [expect.objectContaining({ type: "artifact.put" })],
          }),
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it("requires a paired HttpOnly UI session for user writes without blocking authorized Agent routes", async () => {
    const fixture = createFixtureProject("agentcut-ui-session-");
    const agentBootstrapToken = "agentcut-ui-agent-bootstrap-token-long-enough";
    const uiBootstrapToken = "agentcut-ui-browser-bootstrap-token-long-enough";
    let now = "2026-08-10T01:00:00.000Z";
    const options = {
      ...fixture.options,
      agentBootstrapToken,
      uiBootstrapToken,
      agentAccessClock: () => now,
      uiSessionClock: () => now,
      uiSessionNonce: () => "ui_session_nonce_001",
      silenceDetector: () => [],
    };

    const anonymous = await request(options, "GET", "/api/ui/session");
    expect(anonymous.body).toEqual({ authenticated: false, reason: "missing" });
    await expect(request(options, "GET", "/api/review"))
      .rejects.toMatchObject({ code: "UI_SESSION_REQUIRED" });
    await expect(request(options, "GET", "/api/alpha-audit"))
      .rejects.toMatchObject({ code: "UI_SESSION_REQUIRED" });
    await expect(request(options, "GET", "/media/asset_camera_a"))
      .rejects.toMatchObject({ code: "UI_SESSION_REQUIRED" });
    await expect(request(options, "GET", "/artifacts/captions_private"))
      .rejects.toMatchObject({ code: "UI_SESSION_REQUIRED" });
    expect((await request(options, "GET", "/api/health")).status).toBe(200);
    await expect(request(
      options,
      "POST",
      "/api/candidates/candidate_silence_001/keep",
      { requestId: "ui-write-without-session", baseRevision: 0 },
    )).rejects.toMatchObject({ code: "UI_SESSION_REQUIRED" });
    await expect(request(
      options,
      "POST",
      "/api/ui/session",
      undefined,
      { authorization: "Bearer wrong-ui-bootstrap-token-that-is-long" },
    )).rejects.toMatchObject({ code: "UI_BOOTSTRAP_DENIED" });

    const agentCreation = await request(options, "POST", "/api/agent/sessions", {
      requestId: "ui-auth-agent-session",
      clientId: "codex-ui-auth-test",
      capabilities: ["project:read", "timeline:write:low_risk_only"],
      ttlSeconds: 3_600,
    }, { authorization: `Bearer ${agentBootstrapToken}` });
    const agentToken = (agentCreation.body as { accessToken: string }).accessToken;
    const agentRead = await request(options, "GET", "/api/agent/status", undefined, {
      authorization: `Bearer ${agentToken}`,
    });
    expect(agentRead.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 0 }),
    }));
    const agentWrite = await request(options, "POST", "/api/agent/rough-cut/generate", {
      requestId: "ui-auth-agent-write",
      baseRevision: 0,
    }, {
      authorization: `Bearer ${agentToken}`,
      "x-agentcut-request-id": "ui-auth-agent-write",
    });
    expect(agentWrite.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
    }));

    const paired = await request(options, "POST", "/api/ui/session", undefined, {
      authorization: `Bearer ${uiBootstrapToken}`,
    });
    expect(paired.status).toBe(201);
    expect(paired.body).toEqual({
      authenticated: true,
      expiresAt: "2026-08-17T01:00:00.000Z",
      generation: 0,
    });
    expect(JSON.stringify(paired.body)).not.toContain(uiBootstrapToken);
    const setCookie = paired.headers["set-cookie"];
    expect(setCookie).toContain("agentcut_ui_session=uis_");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie!.split(";")[0]!;
    const authenticated = await request(options, "GET", "/api/ui/session", undefined, { cookie });
    expect(authenticated.body).toEqual(paired.body);
    const privateReview = await request(options, "GET", "/api/review", undefined, { cookie });
    expect(privateReview.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
    }));
    await expect(request(options, "POST", "/api/ui/bootstrap/rotate", {
      requestId: "static-ui-bootstrap-cannot-rotate",
    }, { cookie })).rejects.toMatchObject({ code: "UI_CREDENTIAL_ROTATION_UNAVAILABLE" });

    const userWrite = await request(
      options,
      "POST",
      "/api/candidates/candidate_silence_001/keep",
      { requestId: "ui-write-with-session", baseRevision: 1 },
      { cookie },
    );
    expect(userWrite.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 2 }),
    }));
    await expect(request(
      options,
      "POST",
      "/api/candidates/candidate_filler_001/keep",
      { requestId: "ui-write-tampered-cookie", baseRevision: 2 },
      { cookie: `${cookie}tampered` },
    )).rejects.toMatchObject({ code: "UI_SESSION_REQUIRED" });

    now = "2026-08-17T01:00:00.001Z";
    expect((await request(options, "GET", "/api/ui/session", undefined, { cookie })).body)
      .toEqual({ authenticated: false, reason: "expired" });
    await expect(request(options, "GET", "/api/review", undefined, { cookie }))
      .rejects.toMatchObject({ code: "UI_SESSION_EXPIRED" });
    await expect(request(
      options,
      "POST",
      "/api/candidates/candidate_filler_001/keep",
      { requestId: "ui-write-expired-cookie", baseRevision: 2 },
      { cookie },
    )).rejects.toMatchObject({ code: "UI_SESSION_EXPIRED" });
    const store = ProjectStore.open(fixture.databasePath);
    try {
      expect(store.listUiAccessEvents()).toEqual([
        expect.objectContaining({ allowed: false, method: "GET", path: "/api/review", reason: "missing" }),
        expect.objectContaining({ allowed: false, method: "GET", path: "/api/alpha-audit", reason: "missing" }),
        expect.objectContaining({ allowed: false, method: "GET", path: "/media/asset_camera_a", reason: "missing" }),
        expect.objectContaining({ allowed: false, method: "GET", path: "/artifacts/captions_private", reason: "missing" }),
        expect.objectContaining({ allowed: false, reason: "missing" }),
        expect.objectContaining({ allowed: true, reason: "paired", path: "/api/ui/session" }),
        expect.objectContaining({
          allowed: true,
          reason: "allowed",
          path: "/api/ui/bootstrap/rotate",
        }),
        expect.objectContaining({ allowed: true, reason: "allowed" }),
        expect.objectContaining({ allowed: false, reason: "invalid" }),
        expect.objectContaining({ allowed: false, method: "GET", path: "/api/review", reason: "expired" }),
        expect.objectContaining({ allowed: false, reason: "expired" }),
      ]);
      expect(store.snapshot().project.revision).toBe(2);
    } finally {
      store.close();
    }
  });

  it("keeps static shell and health public while paired media byte ranges stay playable", async () => {
    const fixture = createFixtureProject("agentcut-private-media-");
    const credential = ensureUiCredentialFile(fixture.options.projectRoot);
    const mediaDirectory = join(fixture.options.projectRoot, "media");
    mkdirSync(mediaDirectory, { recursive: true });
    writeFileSync(join(mediaDirectory, "talking-head.mp4"), "0123456789");
    const studioRoot = join(fixture.options.projectRoot, "studio");
    mkdirSync(studioRoot, { recursive: true });
    writeFileSync(join(studioRoot, "index.html"), "<!doctype html><title>Private AgentCut</title>");
    const server = createAgentCutServer({
      ...fixture.options,
      studioRoot,
      uiCredentialPath: credential.credentialPath,
      uiSessionNonce: () => "private_media_nonce_001",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server address missing");
      const origin = `http://127.0.0.1:${address.port}`;

      expect((await fetch(`${origin}/`)).status).toBe(200);
      expect((await fetch(`${origin}/api/health`)).status).toBe(200);
      expect((await fetch(`${origin}/api/review`)).status).toBe(401);
      expect((await fetch(`${origin}/media/asset_camera_a`)).status).toBe(401);

      const paired = await fetch(`${origin}/api/ui/session`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.bootstrapToken}` },
      });
      expect(paired.status).toBe(201);
      const cookie = paired.headers.get("set-cookie")?.split(";")[0];
      if (!cookie) throw new Error("Paired Studio response did not set a cookie");

      expect((await fetch(`${origin}/api/review`, { headers: { Cookie: cookie } })).status).toBe(200);
      const range = await fetch(`${origin}/media/asset_camera_a`, {
        headers: { Cookie: cookie, Range: "bytes=2-5" },
      });
      expect(range.status).toBe(206);
      expect(range.headers.get("accept-ranges")).toBe("bytes");
      expect(range.headers.get("content-range")).toBe("bytes 2-5/10");
      expect(await range.text()).toBe("2345");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
    }
  });

  it("rotates a file-backed UI bootstrap, invalidates old cookies, and replays safely", async () => {
    const fixture = createFixtureProject("agentcut-ui-rotation-");
    const credential = ensureUiCredentialFile(fixture.options.projectRoot);
    let now = "2026-08-10T03:30:00.000Z";
    const options = {
      ...fixture.options,
      uiCredentialPath: credential.credentialPath,
      uiSessionClock: () => now,
      uiSessionNonce: () => "ui_rotation_nonce_001",
      uiRotationTokenFactory: () => "rotated-ui-bootstrap-token-0000000000000001",
    };
    const paired = await request(options, "POST", "/api/ui/session", undefined, {
      authorization: `Bearer ${credential.bootstrapToken}`,
    });
    const oldCookie = paired.headers["set-cookie"]!.split(";")[0]!;

    const rotated = await request(options, "POST", "/api/ui/bootstrap/rotate", {
      requestId: "ui-bootstrap-rotate-001",
    }, { cookie: oldCookie });
    expect(rotated.status).toBe(201);
    expect(rotated.body).toEqual({
      authenticated: true,
      expiresAt: "2026-08-17T03:30:00.000Z",
      generation: 1,
      rotatedAt: "2026-08-10T03:30:00.000Z",
      idempotentReplay: false,
    });
    expect(JSON.stringify(rotated.body)).not.toContain("rotated-ui-bootstrap");
    const newCookie = rotated.headers["set-cookie"]!.split(";")[0]!;
    expect(newCookie).not.toBe(oldCookie);
    expect((await request(options, "GET", "/api/ui/session", undefined, { cookie: oldCookie })).body)
      .toEqual({ authenticated: false, reason: "invalid" });
    expect((await request(options, "GET", "/api/ui/session", undefined, { cookie: newCookie })).body)
      .toEqual({
        authenticated: true,
        expiresAt: "2026-08-17T03:30:00.000Z",
        generation: 1,
      });

    const replay = await request(options, "POST", "/api/ui/bootstrap/rotate", {
      requestId: "ui-bootstrap-rotate-001",
    }, { cookie: newCookie });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(expect.objectContaining({
      generation: 1,
      idempotentReplay: true,
    }));
    const store = ProjectStore.open(fixture.databasePath);
    try {
      expect(store.listUiCredentialRotations()).toEqual([
        expect.objectContaining({
          requestId: "ui-bootstrap-rotate-001",
          generation: 1,
          rotatedBy: "local_user",
        }),
      ]);
      expect(store.snapshot().project.revision).toBe(0);
    } finally {
      store.close();
    }
  });

  it("recovers rotation audit after credential publish succeeds but the request crashes", async () => {
    const fixture = createFixtureProject("agentcut-ui-rotation-recovery-");
    const credential = ensureUiCredentialFile(fixture.options.projectRoot);
    let failAfterPublish = true;
    const options = {
      ...fixture.options,
      uiCredentialPath: credential.credentialPath,
      uiSessionClock: () => "2026-08-10T03:40:00.000Z",
      uiSessionNonce: () => "ui_rotation_nonce_002",
      uiRotationTokenFactory: () => "rotated-ui-bootstrap-token-recovery-000001",
      uiRotationAfterCredentialPublishHook: () => {
        if (!failAfterPublish) return;
        failAfterPublish = false;
        throw new Error("injected crash after UI credential publish");
      },
    };
    const paired = await request(options, "POST", "/api/ui/session", undefined, {
      authorization: `Bearer ${credential.bootstrapToken}`,
    });
    const oldCookie = paired.headers["set-cookie"]!.split(";")[0]!;
    await expect(request(options, "POST", "/api/ui/bootstrap/rotate", {
      requestId: "ui-bootstrap-recover-001",
    }, { cookie: oldCookie })).rejects.toThrow("injected crash after UI credential publish");

    const published = readUiCredentialFile(credential.credentialPath, fixture.options.projectRoot);
    expect(published.generation).toBe(1);
    expect(published.lastRotation?.requestId).toBe("ui-bootstrap-recover-001");
    const beforeRestart = ProjectStore.open(fixture.databasePath);
    expect(beforeRestart.listUiCredentialRotations()).toHaveLength(0);
    beforeRestart.close();

    const recoveredServer = createAgentCutServer({
      ...fixture.options,
      uiCredentialPath: credential.credentialPath,
      uiSessionClock: options.uiSessionClock,
      uiSessionNonce: options.uiSessionNonce,
      uiRotationTokenFactory: options.uiRotationTokenFactory,
    });
    recoveredServer.close();
    const afterRestart = ProjectStore.open(fixture.databasePath);
    try {
      expect(afterRestart.listUiCredentialRotations()).toEqual([
        expect.objectContaining({
          requestId: "ui-bootstrap-recover-001",
          generation: 1,
        }),
      ]);
      expect(afterRestart.snapshot().project.revision).toBe(0);
    } finally {
      afterRestart.close();
    }
    expect((await request(options, "GET", "/api/ui/session", undefined, { cookie: oldCookie })).body)
      .toEqual({ authenticated: false, reason: "invalid" });
  });

  it("binds high-risk approval to revision and payload before one-time Agent application", async () => {
    const fixture = createFixtureProject("agentcut-approval-flow-", (document) => {
      const candidateSet = document.artifacts.find((artifact) =>
        artifact.kind === "deletionCandidateSet",
      );
      if (!candidateSet || candidateSet.kind !== "deletionCandidateSet") {
        throw new Error("Approval fixture candidate set is missing");
      }
      candidateSet.candidates[0]!.risk = "high";
    });
    const bootstrapToken = "agentcut-approval-bootstrap-token-that-is-long-enough";
    let now = "2026-08-10T01:00:00.000Z";
    let crashAfterCommit = true;
    const options = {
      ...fixture.options,
      agentBootstrapToken: bootstrapToken,
      agentAccessClock: () => now,
      approvalAfterCommitHook: () => {
        if (!crashAfterCommit) return;
        crashAfterCommit = false;
        throw new Error("simulated crash after approval Timeline commit");
      },
    };
    const createdSession = await request(options, "POST", "/api/agent/sessions", {
      requestId: "approval-session-create",
      clientId: "codex-mcp",
      capabilities: ["project:read", "approval:request"],
      ttlSeconds: 3_600,
    }, { authorization: `Bearer ${bootstrapToken}` });
    const accessToken = (createdSession.body as { accessToken: string }).accessToken;
    const headers = { authorization: `Bearer ${accessToken}` };
    const requested = await request(options, "POST", "/api/agent/approvals", {
      requestId: "approval-request-high-001",
      baseRevision: 0,
      candidateId: "candidate_filler_001",
    }, { ...headers, "x-agentcut-request-id": "approval-request-high-001" });
    expect(requested.status).toBe(201);
    const approval = (requested.body as {
      approval: { id: string; payloadHash: string; state: string; approvalToken?: string };
    }).approval;
    expect(approval).toEqual(expect.objectContaining({
      state: "pending",
      payloadHash: expect.stringMatching(/^sha256:/),
    }));
    expect(approval.approvalToken).toBeUndefined();

    const uiReview = await request(options, "GET", "/api/review");
    expect(uiReview.body).toEqual(expect.objectContaining({
      approvals: [expect.objectContaining({ id: approval.id, state: "pending" })],
    }));
    expect(JSON.stringify(uiReview.body)).not.toContain("approvalToken");

    now = "2026-08-10T01:01:00.000Z";
    const resolved = await request(options, "POST", `/api/approvals/${approval.id}/resolve`, {
      requestId: "approval-resolve-high-001",
      baseRevision: 0,
      decision: "approve",
    });
    expect(resolved.body).toEqual(expect.objectContaining({
      approvals: [expect.objectContaining({ id: approval.id, state: "approved" })],
    }));
    expect(JSON.stringify(resolved.body)).not.toContain("approvalToken");

    const applyingSession = await request(options, "POST", "/api/agent/sessions", {
      requestId: "approval-session-applying",
      clientId: "codex-applier",
      capabilities: ["project:read", "timeline:write:approved"],
      ttlSeconds: 3_600,
    }, { authorization: `Bearer ${bootstrapToken}` });
    const applyingToken = (applyingSession.body as { accessToken: string }).accessToken;
    const applyingHeaders = { authorization: `Bearer ${applyingToken}` };
    const readable = await request(
      options,
      "GET",
      `/api/agent/approvals/${approval.id}`,
      undefined,
      applyingHeaders,
    );
    const approved = (readable.body as {
      approval: { state: string; approvalToken: string };
    }).approval;
    expect(approved).toEqual(expect.objectContaining({
      state: "approved",
      approvalToken: expect.stringMatching(/^aga_/),
    }));
    await expect(request(
      options,
      "POST",
      `/api/agent/approvals/${approval.id}/apply`,
      { requestId: "approval-apply-wrong", baseRevision: 0, approvalToken: "wrong-token" },
      { ...applyingHeaders, "x-agentcut-request-id": "approval-apply-wrong" },
    )).rejects.toMatchObject({ code: "APPROVAL_TOKEN_INVALID" });

    now = "2026-08-10T01:02:00.000Z";
    await expect(request(
      options,
      "POST",
      `/api/agent/approvals/${approval.id}/apply`,
      {
        requestId: "approval-apply-high-001",
        baseRevision: 0,
        approvalToken: approved.approvalToken,
      },
      { ...applyingHeaders, "x-agentcut-request-id": "approval-apply-high-001" },
    )).rejects.toThrow("simulated crash after approval Timeline commit");
    const interrupted = ProjectStore.open(fixture.databasePath);
    try {
      expect(interrupted.snapshot().project.revision).toBe(1);
      expect(interrupted.getApproval(approval.id)).toEqual(expect.objectContaining({ state: "approved" }));
      expect(interrupted.getRecord(`tx_review_accept_approval_${approval.id}`)).toBeDefined();
    } finally {
      interrupted.close();
    }

    const resumedSession = await request(options, "POST", "/api/agent/sessions", {
      requestId: "approval-session-resumed",
      clientId: "codex-resumer",
      capabilities: ["project:read", "timeline:write:approved"],
      ttlSeconds: 3_600,
    }, { authorization: `Bearer ${bootstrapToken}` });
    const resumedToken = (resumedSession.body as { accessToken: string }).accessToken;
    const resumedHeaders = { authorization: `Bearer ${resumedToken}` };
    const replay = await request(
      options,
      "POST",
      `/api/agent/approvals/${approval.id}/apply`,
      {
        requestId: "approval-apply-high-retry",
        baseRevision: 0,
        approvalToken: approved.approvalToken,
      },
      { ...resumedHeaders, "x-agentcut-request-id": "approval-apply-high-retry" },
    );
    expect(replay.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
      approvals: [expect.objectContaining({
        id: approval.id,
        state: "consumed",
        transactionId: `tx_review_accept_approval_${approval.id}`,
      })],
    }));

    const store = ProjectStore.open(fixture.databasePath);
    try {
      const record = store.getRecord(`tx_review_accept_approval_${approval.id}`);
      expect(record?.request.actor).toEqual({ kind: "user", id: "local_user" });
      expect(record?.request.reason).toContain("via codex-applier");
      expect(store.getApproval(approval.id)).toEqual(expect.objectContaining({
        state: "consumed",
        consumedBySessionId: (resumedSession.body as { session: { id: string } }).session.id,
      }));
    } finally {
      store.close();
    }
  });

  it("fails closed for denied, expired, and revision-stale approval requests", async () => {
    const setup = async (name: string) => {
      const fixture = createFixtureProject(`agentcut-approval-${name}-`, (document) => {
        const candidateSet = document.artifacts.find((artifact) =>
          artifact.kind === "deletionCandidateSet",
        );
        if (!candidateSet || candidateSet.kind !== "deletionCandidateSet") {
          throw new Error("Approval fixture candidate set is missing");
        }
        candidateSet.candidates[0]!.risk = "high";
      });
      let now = "2026-08-10T03:00:00.000Z";
      const bootstrapToken = `approval-${name}-bootstrap-token-that-is-long-enough`;
      const options = {
        ...fixture.options,
        agentBootstrapToken: bootstrapToken,
        agentAccessClock: () => now,
      };
      const session = await request(options, "POST", "/api/agent/sessions", {
        requestId: `session-${name}`,
        clientId: `codex-${name}`,
        capabilities: ["project:read", "approval:request", "timeline:write:approved"],
        ttlSeconds: 86_400,
      }, { authorization: `Bearer ${bootstrapToken}` });
      const accessToken = (session.body as { accessToken: string }).accessToken;
      const headers = { authorization: `Bearer ${accessToken}` };
      const requested = await request(options, "POST", "/api/agent/approvals", {
        requestId: `approval-request-${name}`,
        baseRevision: 0,
        candidateId: "candidate_filler_001",
      }, { ...headers, "x-agentcut-request-id": `approval-request-${name}` });
      const approvalId = (requested.body as { approval: { id: string } }).approval.id;
      return {
        fixture,
        options,
        headers,
        approvalId,
        setNow(value: string) { now = value; },
      };
    };

    const denied = await setup("denied");
    await request(denied.options, "POST", `/api/approvals/${denied.approvalId}/resolve`, {
      requestId: "resolve-denied",
      baseRevision: 0,
      decision: "deny",
    });
    const deniedStatus = await request(
      denied.options,
      "GET",
      `/api/agent/approvals/${denied.approvalId}`,
      undefined,
      denied.headers,
    );
    expect(deniedStatus.body).toEqual({
      approval: expect.objectContaining({ state: "denied" }),
    });
    expect(JSON.stringify(deniedStatus.body)).not.toContain("approvalToken");

    const expired = await setup("expired");
    expired.setNow("2026-08-10T04:00:01.000Z");
    const expiredStatus = await request(
      expired.options,
      "GET",
      `/api/agent/approvals/${expired.approvalId}`,
      undefined,
      expired.headers,
    );
    expect(expiredStatus.body).toEqual({
      approval: expect.objectContaining({ state: "expired" }),
    });
    await expect(request(
      expired.options,
      "POST",
      `/api/approvals/${expired.approvalId}/resolve`,
      { requestId: "resolve-expired", baseRevision: 0, decision: "approve" },
    )).rejects.toMatchObject({ code: "APPROVAL_STATE_INVALID" });

    const stale = await setup("stale");
    await request(stale.options, "POST", "/api/candidates/candidate_silence_001/keep", {
      requestId: "advance-before-approval",
      baseRevision: 0,
    });
    const staleStatus = await request(
      stale.options,
      "GET",
      `/api/agent/approvals/${stale.approvalId}`,
      undefined,
      stale.headers,
    );
    expect(staleStatus.body).toEqual({
      approval: expect.objectContaining({ state: "stale", baseRevision: 0 }),
    });
    await expect(request(
      stale.options,
      "POST",
      `/api/approvals/${stale.approvalId}/resolve`,
      { requestId: "resolve-stale", baseRevision: 1, decision: "approve" },
    )).rejects.toMatchObject({ code: "APPROVAL_STALE" });
  });

  it("generates a rough cut and applies only definite low-risk candidates", async () => {
    const fixture = createFixtureProject("agentcut-generate-rough-cut-", (document) => {
      document.artifacts = document.artifacts.filter((artifact) =>
        artifact.kind !== "deletionCandidateSet" && artifact.kind !== "editProposal",
      );
    });
    const generated = await request({
      ...fixture.options,
      silenceDetector: () => [],
    }, "POST", "/api/rough-cut/generate", {
      requestId: "rough_cut_001",
      baseRevision: 0,
    });

    expect(generated.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
      roughCutStatus: "rough_cut_ready",
      review: expect.objectContaining({
        summary: expect.objectContaining({ deletedTokens: 1 }),
      }),
    }));
    const store = ProjectStore.open(fixture.databasePath);
    try {
      const record = store.getRecord("tx_rough_cut_generate_rough_cut_001");
      expect(record?.request.operations.map((operation) => operation.type)).toEqual([
        "artifact.put",
        "artifact.put",
        "range.deleteRipple",
      ]);
      expect(store.snapshot().artifacts
        .filter((artifact) => artifact.kind === "deletionCandidateSet")
        .flatMap((artifact) => artifact.candidates)
        .filter((candidate) => candidate.risk === "high"))
        .toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("deletes a contiguous manual Transcript selection through a revision-bound transaction", async () => {
    const fixture = createFixtureProject("agentcut-manual-delete-");
    const deleted = await request(fixture.options, "POST", "/api/selections/delete", {
      requestId: "manual_001",
      baseRevision: 0,
      wordIds: ["word_003", "word_004"],
    });

    expect(deleted.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
      review: expect.objectContaining({
        summary: expect.objectContaining({ deletedTokens: 2 }),
      }),
    }));
  });

  it("previews and deletes retained video without Transcript speech", async () => {
    const fixture = createFixtureProject("agentcut-manual-speech-gap-");
    const initial = await request(fixture.options, "GET", "/api/review");
    const speechGaps = (initial.body as {
      review: { speechGaps: Array<{ gapId: string; previousWordId?: string }> };
    }).review.speechGaps;
    expect(speechGaps).toHaveLength(1);
    expect(speechGaps[0]).toEqual(expect.objectContaining({ previousWordId: "word_004" }));

    const previewed = await request(fixture.options, "POST", "/api/speech-gaps/preview", {
      gapId: speechGaps[0]!.gapId,
      baseRevision: 0,
    });
    expect(previewed.body).toEqual(expect.objectContaining({
      gapId: speechGaps[0]!.gapId,
      baseRevision: 0,
      preview: expect.objectContaining({ revision: 0 }),
    }));
    const unchanged = ProjectStore.open(fixture.databasePath);
    expect(unchanged.snapshot().project.revision).toBe(0);
    unchanged.close();

    const deleted = await request(fixture.options, "POST", "/api/speech-gaps/delete", {
      requestId: "manual_gap_001",
      gapId: speechGaps[0]!.gapId,
      baseRevision: 0,
    });
    expect(deleted.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
      review: expect.objectContaining({
        speechGaps: [],
        summary: expect.objectContaining({ committedGaps: 1 }),
      }),
    }));
    const committed = ProjectStore.open(fixture.databasePath);
    expect(committed.getRecord("tx_manual_gap_delete_manual_gap_001")?.inverseOperations.length)
      .toBeGreaterThan(0);
    committed.close();
  });

  it("keeps every pending candidate in one transaction and marks the rough cut ready", async () => {
    const fixture = createFixtureProject("agentcut-keep-remaining-");
    const kept = await request(fixture.options, "POST", "/api/candidates/keep-remaining", {
      requestId: "keep_remaining_001",
      baseRevision: 0,
    });

    expect(kept.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
      roughCutStatus: "rough_cut_ready",
      review: expect.objectContaining({
        summary: expect.objectContaining({
          reviewedKeepTokens: 1,
          reviewedKeepGaps: 1,
          candidateTokens: 0,
          candidateGaps: 0,
        }),
      }),
    }));
  });

  it("serves the built Studio and API from one process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-static-studio-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agentcut.sqlite");
    const fixtureUrl = new URL(
      "../../../packages/timeline-schema/fixtures/minimal-project.json",
      import.meta.url,
    );
    ProjectStore.create(
      databasePath,
      JSON.parse(readFileSync(fixtureUrl, "utf8")) as AgentCutProjectDocument,
    ).close();
    const studioRoot = join(directory, "studio");
    mkdirSync(join(studioRoot, "assets"), { recursive: true });
    writeFileSync(join(studioRoot, "index.html"), "<!doctype html><title>AgentCut Studio</title>");
    writeFileSync(join(studioRoot, "assets", "app.js"), "console.log('agentcut')");
    const server = createAgentCutServer({ databasePath, projectRoot: directory, studioRoot });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server address missing");
      const origin = `http://127.0.0.1:${address.port}`;
      const page = await fetch(`${origin}/review`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("AgentCut Studio");
      const script = await fetch(`${origin}/assets/app.js`);
      expect(script.headers.get("content-type")).toContain("text/javascript");
      expect(await script.text()).toContain("agentcut");
      await expect(fetch(`${origin}/api/health`).then((response) => response.json()))
        .resolves.toEqual(expect.objectContaining({ ok: true, protocolVersion: "0.1.0", revision: 0 }));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
    }
  });

  it("serves a bound browser proxy while keeping Transcript and PreviewPlan on the source asset", async () => {
    const fixture = createFixtureProject("agentcut-review-proxy-", (document) => {
      const source = document.assets[0]!;
      document.assets.push({
        id: "asset_preview_camera_a",
        kind: "generated",
        uri: "proxies/camera-a-browser.mp4",
        contentHash: `sha256:${"b".repeat(64)}`,
        availability: "online",
        provenance: {
          createdBy: { kind: "workflow", id: "preview_proxy_v1" },
          createdAt: "2026-08-13T00:00:00.000Z",
          reason: "Browser-compatible local preview",
        },
        metadata: {
          "agentcut.previewProxy": createPreviewProxyBinding(source),
        },
      });
    });

    const review = await request(fixture.options, "GET", "/api/review");
    expect(review.body).toEqual(expect.objectContaining({
      media: {
        assetId: "asset_camera_a",
        url: "/media/asset_preview_camera_a",
        originalFileName: "media/talking-head.mp4",
        playback: {
          assetId: "asset_preview_camera_a",
          kind: "proxy",
          profile: "browser-h264-aac-1280-v1",
        },
      },
      transcript: expect.objectContaining({ id: "transcript_main_001" }),
      preview: expect.objectContaining({
        segments: expect.arrayContaining([
          expect.objectContaining({ assetId: "asset_camera_a" }),
        ]),
      }),
    }));
  });

  it("serves review state and restores a committed deletion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-daemon-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agentcut.sqlite");
    const fixtureUrl = new URL(
      "../../../packages/timeline-schema/fixtures/minimal-project.json",
      import.meta.url,
    );
    const document = JSON.parse(readFileSync(fixtureUrl, "utf8")) as AgentCutProjectDocument;
    const candidateSet = document.artifacts.find(
      (artifact) => artifact.kind === "deletionCandidateSet",
    );
    const proposal = document.artifacts.find((artifact) => artifact.kind === "editProposal");
    if (!candidateSet || candidateSet.kind !== "deletionCandidateSet"
      || !proposal || proposal.kind !== "editProposal") {
      throw new Error("Fixture analysis artifacts are missing");
    }
    document.artifacts = document.artifacts.filter((artifact) =>
      artifact.kind !== "deletionCandidateSet" && artifact.kind !== "editProposal",
    );
    const store = ProjectStore.create(databasePath, document);
    store.commit(compileEditProposalBundle(document, candidateSet, proposal, {
      transactionId: "tx_daemon_delete",
      idempotencyKey: "daemon-delete",
      actor: { kind: "agent", id: "candidate_engine" },
    }));
    store.close();

    const options = { databasePath, projectRoot: directory };
    const initial = await request(options, "GET", "/api/review");
    expect(initial.status).toBe(200);
    const initialBody = initial.body as {
        project: { revision: number };
        review: { summary: { deletedTokens: number } };
        readiness: {
          candidatesPending: number;
          undo: { transactionId: string; labelZh: string } | null;
        };
    };
    expect(initialBody.project.revision).toBe(1);
    expect(initialBody.review.summary.deletedTokens).toBe(1);
    expect(initialBody.readiness.candidatesPending).toBeGreaterThan(0);
    expect(initialBody.readiness.undo?.transactionId).toBe("tx_daemon_delete");

    const restorePayload = {
      transactionId: "tx_daemon_delete",
      requestId: "test_restore_001",
      baseRevision: 1,
    };
    const restored = await request(options, "POST", "/api/restore", restorePayload);
    expect(restored.status).toBe(200);
    const restoredBody = restored.body as {
      project: { revision: number };
      review: { summary: { deletedTokens: number; candidateTokens: number } };
      readiness: { undo: { transactionId: string } | null };
    };
    expect(restoredBody.project.revision).toBe(2);
    expect(restoredBody.review.summary).toEqual(expect.objectContaining({
      deletedTokens: 0,
      candidateTokens: 0,
    }));
    expect(restoredBody.readiness.undo).toBeNull();

    const replay = await request(options, "POST", "/api/restore", restorePayload);
    expect(replay.status).toBe(200);
    expect((replay.body as { project: { revision: number } }).project.revision).toBe(2);
  });

  it("persists keep, reconsider, and accept decisions with revision checks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-review-actions-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agentcut.sqlite");
    const fixtureUrl = new URL(
      "../../../packages/timeline-schema/fixtures/minimal-project.json",
      import.meta.url,
    );
    const document = JSON.parse(readFileSync(fixtureUrl, "utf8")) as AgentCutProjectDocument;
    ProjectStore.create(databasePath, document).close();
    const options = { databasePath, projectRoot: directory };

    const kept = await request(
      options,
      "POST",
      "/api/candidates/candidate_silence_001/keep",
      { requestId: "keep_001", baseRevision: 0 },
    );
    expect(kept.status).toBe(200);
    expect(kept.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
      review: expect.objectContaining({
        summary: expect.objectContaining({ reviewedKeepGaps: 1, candidateGaps: 0 }),
      }),
    }));
    const keptGap = (kept.body as {
      review: { gaps: Array<{ candidateId: string; lockId?: string }> };
    }).review.gaps.find((gap) => gap.candidateId === "candidate_silence_001");
    expect(keptGap?.lockId).toMatch(/^lock_candidate_keep_/);

    await expect(request(
      options,
      "POST",
      "/api/candidates/candidate_silence_001/accept",
      { requestId: "stale_accept", baseRevision: 0 },
    )).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    const reconsidered = await request(
      options,
      "POST",
      `/api/locks/${keptGap!.lockId}/remove`,
      { requestId: "unlock_001", baseRevision: 1 },
    );
    expect(reconsidered.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 2 }),
      review: expect.objectContaining({
        summary: expect.objectContaining({ reviewedKeepGaps: 0, candidateGaps: 1 }),
      }),
    }));

    const accepted = await request(
      options,
      "POST",
      "/api/candidates/candidate_silence_001/accept",
      { requestId: "accept_001", baseRevision: 2 },
    );
    expect(accepted.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 3 }),
      review: expect.objectContaining({
        summary: expect.objectContaining({ committedGaps: 1, candidateGaps: 0 }),
      }),
    }));
  });

  it("requires an explicit request flag before committing a high-risk candidate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-high-risk-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agentcut.sqlite");
    const fixtureUrl = new URL(
      "../../../packages/timeline-schema/fixtures/minimal-project.json",
      import.meta.url,
    );
    const document = JSON.parse(readFileSync(fixtureUrl, "utf8")) as AgentCutProjectDocument;
    const candidateSet = document.artifacts.find((artifact) =>
      artifact.kind === "deletionCandidateSet",
    );
    if (!candidateSet || candidateSet.kind !== "deletionCandidateSet") {
      throw new Error("Fixture candidate set is missing");
    }
    const candidate = candidateSet.candidates.find((item) =>
      item.id === "candidate_silence_001",
    );
    if (!candidate) throw new Error("Fixture silence candidate is missing");
    candidate.risk = "high";
    ProjectStore.create(databasePath, document).close();
    const options = { databasePath, projectRoot: directory };

    await expect(request(
      options,
      "POST",
      "/api/candidates/candidate_silence_001/accept",
      { requestId: "high_risk_missing_confirmation", baseRevision: 0 },
    )).rejects.toMatchObject({ code: "HIGH_RISK_CONFIRMATION_REQUIRED" });
    const unchanged = await request(options, "GET", "/api/review");
    expect(unchanged.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 0 }),
    }));

    const accepted = await request(
      options,
      "POST",
      "/api/candidates/candidate_silence_001/accept",
      {
        requestId: "high_risk_explicit_confirmation",
        baseRevision: 0,
        confirmHighRisk: true,
      },
    );
    expect(accepted.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
      review: expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({
            candidateId: "candidate_silence_001",
            state: "committed_deleted",
            risk: "high",
          }),
        ]),
      }),
    }));
  });

  it("forces overlapping candidates through one higher-risk reversible decision", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-overlap-review-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agentcut.sqlite");
    const fixtureUrl = new URL(
      "../../../packages/timeline-schema/fixtures/minimal-project.json",
      import.meta.url,
    );
    const document = JSON.parse(readFileSync(fixtureUrl, "utf8")) as AgentCutProjectDocument;
    const candidateSet = document.artifacts.find((artifact) =>
      artifact.kind === "deletionCandidateSet",
    );
    if (!candidateSet || candidateSet.kind !== "deletionCandidateSet") {
      throw new Error("Fixture candidate set is missing");
    }
    const anchor = candidateSet.candidates.find((candidate) =>
      candidate.id === "candidate_filler_001",
    )!;
    const overlap = candidateSet.candidates.find((candidate) =>
      candidate.id === "candidate_silence_001",
    )!;
    anchor.risk = "high";
    if (overlap.target.kind !== "gap") throw new Error("Fixture gap candidate missing");
    overlap.target.nextWordId = "word_003";
    overlap.target.sourceRange.duration.value = 350;
    ProjectStore.create(databasePath, document).close();
    const options = { databasePath, projectRoot: directory };

    const initial = await request(options, "GET", "/api/review");
    expect(initial.body).toEqual(expect.objectContaining({
      review: expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({
            candidateId: anchor.id,
            overlapDecisionAnchorId: anchor.id,
            overlapCandidateIds: [overlap.id],
          }),
          expect.objectContaining({
            candidateId: overlap.id,
            overlapDecisionAnchorId: anchor.id,
          }),
        ]),
      }),
    }));
    await expect(request(
      options,
      "POST",
      `/api/candidates/${overlap.id}/keep`,
      { requestId: "overlap_wrong_order", baseRevision: 0 },
    )).rejects.toMatchObject({ code: "CANDIDATE_OVERLAP_ANCHOR_REQUIRED" });

    const accepted = await request(
      options,
      "POST",
      `/api/candidates/${anchor.id}/accept`,
      { requestId: "overlap_anchor_accept", baseRevision: 0, confirmHighRisk: true },
    );
    expect(accepted.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
      roughCutStatus: "rough_cut_ready",
      review: expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({ candidateId: anchor.id, state: "committed_deleted" }),
          expect.objectContaining({
            candidateId: overlap.id,
            state: "reviewed_keep",
            overlapResolvedByCandidateId: anchor.id,
          }),
        ]),
      }),
    }));

    const restored = await request(options, "POST", "/api/restore", {
      transactionId: "tx_review_accept_overlap_anchor_accept",
      requestId: "overlap_anchor_restore",
      baseRevision: 1,
    });
    expect(restored.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 2 }),
      roughCutStatus: "reviewing",
      review: expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({ candidateId: anchor.id, state: "candidate_remove" }),
          expect.objectContaining({ candidateId: overlap.id, state: "candidate_keep" }),
        ]),
      }),
    }));
  });

  it("accepts a batch of low/medium candidates as one reversible transaction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-batch-accept-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agentcut.sqlite");
    const fixtureUrl = new URL(
      "../../../packages/timeline-schema/fixtures/minimal-project.json",
      import.meta.url,
    );
    const document = JSON.parse(readFileSync(fixtureUrl, "utf8")) as AgentCutProjectDocument;
    const candidateSet = document.artifacts.find((artifact) =>
      artifact.kind === "deletionCandidateSet",
    );
    if (!candidateSet || candidateSet.kind !== "deletionCandidateSet") {
      throw new Error("Fixture candidate set is missing");
    }
    candidateSet.candidates.push({
      id: "candidate_repeat_extra",
      target: {
        kind: "words",
        wordIds: ["word_003", "word_004"],
        sourceRange: {
          start: { value: 2000, rate: { numerator: 1000, denominator: 1 } },
          duration: { value: 1400, rate: { numerator: 1000, denominator: 1 } },
        },
      },
      reasonCodes: ["repetition"],
      decision: "definite_remove",
      risk: "low",
      confidence: 0.9,
      explanationZh: "测试用重复候选。",
    });
    ProjectStore.create(databasePath, document).close();
    const options = { databasePath, projectRoot: directory };

    const accepted = await request(options, "POST", "/api/candidates/batch-accept", {
      requestId: "batch_accept_001",
      baseRevision: 0,
      candidateIds: ["candidate_filler_001", "candidate_silence_001", "candidate_repeat_extra"],
    });
    expect(accepted.status).toBe(200);
    const committed = (accepted.body as {
      review: { candidates: Array<{ candidateId: string; state: string; transactionId?: string }> };
    }).review.candidates.filter((candidate) =>
      ["candidate_filler_001", "candidate_silence_001", "candidate_repeat_extra"]
        .includes(candidate.candidateId),
    );
    expect(committed).toHaveLength(3);
    expect(committed.every((candidate) => candidate.state === "committed_deleted")).toBe(true);
    expect(new Set(committed.map((candidate) => candidate.transactionId)))
      .toEqual(new Set(["tx_review_accept_batch_batch_accept_001"]));
    expect(accepted.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
      roughCutStatus: "rough_cut_ready",
    }));

    const replayed = await request(options, "POST", "/api/candidates/batch-accept", {
      requestId: "batch_accept_001",
      baseRevision: 1,
      candidateIds: ["candidate_filler_001", "candidate_silence_001", "candidate_repeat_extra"],
    });
    expect(replayed.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
    }));

    const restored = await request(options, "POST", "/api/restore", {
      transactionId: "tx_review_accept_batch_batch_accept_001",
      requestId: "batch_accept_restore",
      baseRevision: 1,
    });
    expect(restored.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 2 }),
      roughCutStatus: "reviewing",
      review: expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({ candidateId: "candidate_filler_001", state: "candidate_remove" }),
          expect.objectContaining({ candidateId: "candidate_silence_001", state: "candidate_keep" }),
          expect.objectContaining({ candidateId: "candidate_repeat_extra", state: "candidate_remove" }),
        ]),
      }),
    }));
  });

  it("rejects batch acceptance that includes high-risk candidates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-batch-high-risk-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agentcut.sqlite");
    const fixtureUrl = new URL(
      "../../../packages/timeline-schema/fixtures/minimal-project.json",
      import.meta.url,
    );
    const document = JSON.parse(readFileSync(fixtureUrl, "utf8")) as AgentCutProjectDocument;
    const candidateSet = document.artifacts.find((artifact) =>
      artifact.kind === "deletionCandidateSet",
    );
    if (!candidateSet || candidateSet.kind !== "deletionCandidateSet") {
      throw new Error("Fixture candidate set is missing");
    }
    candidateSet.candidates.find((candidate) =>
      candidate.id === "candidate_silence_001",
    )!.risk = "high";
    ProjectStore.create(databasePath, document).close();
    const options = { databasePath, projectRoot: directory };

    await expect(request(options, "POST", "/api/candidates/batch-accept", {
      requestId: "batch_high_risk",
      baseRevision: 0,
      candidateIds: ["candidate_filler_001", "candidate_silence_001"],
    })).rejects.toMatchObject({ code: "HIGH_RISK_CONFIRMATION_REQUIRED" });
    const unchanged = await request(options, "GET", "/api/review");
    expect(unchanged.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 0 }),
    }));
  });

  it("resolves overlap members when a batch accepts their non-high-risk anchor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-batch-overlap-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agentcut.sqlite");
    const fixtureUrl = new URL(
      "../../../packages/timeline-schema/fixtures/minimal-project.json",
      import.meta.url,
    );
    const document = JSON.parse(readFileSync(fixtureUrl, "utf8")) as AgentCutProjectDocument;
    const candidateSet = document.artifacts.find((artifact) =>
      artifact.kind === "deletionCandidateSet",
    );
    if (!candidateSet || candidateSet.kind !== "deletionCandidateSet") {
      throw new Error("Fixture candidate set is missing");
    }
    const anchor = candidateSet.candidates.find((candidate) =>
      candidate.id === "candidate_filler_001",
    )!;
    const overlap = candidateSet.candidates.find((candidate) =>
      candidate.id === "candidate_silence_001",
    )!;
    anchor.risk = "medium";
    if (overlap.target.kind !== "gap") throw new Error("Fixture gap candidate missing");
    overlap.target.nextWordId = "word_003";
    overlap.target.sourceRange.duration.value = 350;
    ProjectStore.create(databasePath, document).close();
    const options = { databasePath, projectRoot: directory };

    await expect(request(options, "POST", "/api/candidates/batch-accept", {
      requestId: "batch_overlap_member",
      baseRevision: 0,
      candidateIds: [overlap.id],
    })).rejects.toMatchObject({ code: "CANDIDATE_OVERLAP_ANCHOR_REQUIRED" });

    const accepted = await request(options, "POST", "/api/candidates/batch-accept", {
      requestId: "batch_overlap_anchor",
      baseRevision: 0,
      candidateIds: [anchor.id],
    });
    expect(accepted.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
      review: expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({ candidateId: anchor.id, state: "committed_deleted" }),
          expect.objectContaining({
            candidateId: overlap.id,
            state: "reviewed_keep",
            overlapResolvedByCandidateId: anchor.id,
          }),
        ]),
      }),
    }));

    const restored = await request(options, "POST", "/api/restore", {
      transactionId: "tx_review_accept_batch_batch_overlap_anchor",
      requestId: "batch_overlap_restore",
      baseRevision: 1,
    });
    expect(restored.body).toEqual(expect.objectContaining({
      review: expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({ candidateId: anchor.id, state: "candidate_remove" }),
          expect.objectContaining({ candidateId: overlap.id, state: "candidate_keep" }),
        ]),
      }),
    }));
  });

  it("rejects malformed and stale batch acceptance requests", async () => {
    const fixture = createFixtureProject("agentcut-batch-invalid-");
    await expect(request(fixture.options, "POST", "/api/candidates/batch-accept", {
      requestId: "batch_duplicate",
      baseRevision: 0,
      candidateIds: ["candidate_filler_001", "candidate_filler_001"],
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(request(fixture.options, "POST", "/api/candidates/batch-accept", {
      requestId: "batch_empty",
      baseRevision: 0,
      candidateIds: [],
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(request(fixture.options, "POST", "/api/candidates/batch-accept", {
      requestId: "batch_unknown_candidate",
      baseRevision: 0,
      candidateIds: ["candidate_does_not_exist"],
    })).rejects.toMatchObject({ code: "CANDIDATE_UNAVAILABLE" });

    await request(fixture.options, "POST", "/api/candidates/candidate_filler_001/accept", {
      requestId: "batch_stale_accept_first",
      baseRevision: 0,
    });
    await expect(request(fixture.options, "POST", "/api/candidates/batch-accept", {
      requestId: "batch_stale",
      baseRevision: 0,
      candidateIds: ["candidate_silence_001"],
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("runs local semantic review as a revision-bound persistent job", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-semantic-review-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agentcut.sqlite");
    const fixtureUrl = new URL(
      "../../../packages/timeline-schema/fixtures/minimal-project.json",
      import.meta.url,
    );
    const document = JSON.parse(readFileSync(fixtureUrl, "utf8")) as AgentCutProjectDocument;
    const transcript = document.artifacts.find((artifact) => artifact.kind === "transcript");
    if (!transcript || transcript.kind !== "transcript") throw new Error("Fixture Transcript missing");
    transcript.words[0]!.text = "第一种方案，不对";
    transcript.words[2]!.text = "第二种方案";
    ProjectStore.create(databasePath, document).close();
    const options = {
      databasePath,
      projectRoot: directory,
      semanticReviewProvider: {
        id: "test-local-semantic-model",
        async analyze() {
          return [{
            category: "correction" as const,
            removeStartWordId: "word_001",
            removeEndWordId: "word_001",
            keepStartWordId: "word_003",
            keepEndWordId: "word_003",
            confidence: 0.9,
            explanationZh: "说话者明确说不对，随后改为第二种方案。",
          }];
        },
      },
    };
    const analyzed = await request(options, "POST", "/api/analyze-semantic", {
      requestId: "semantic_001",
      baseRevision: 0,
    });
    expect(analyzed.body).toEqual(expect.objectContaining({
      project: expect.objectContaining({ revision: 1 }),
      capabilities: { semanticReview: expect.objectContaining({ available: true }) },
      review: expect.objectContaining({
        candidates: expect.arrayContaining([expect.objectContaining({
          reasonCodes: ["correction"],
          evidence: [expect.objectContaining({
            role: "retained_comparison",
            wordIds: ["word_003"],
            text: "第二种方案",
          })],
          risk: "high",
          state: "candidate_remove",
        })]),
      }),
    }));
    const store = ProjectStore.open(databasePath);
    try {
      expect(store.getJob("job_semantic_review_semantic_001")).toEqual(
        expect.objectContaining({ status: "succeeded", progress: 1 }),
      );
      expect(store.listJobEvents("job_semantic_review_semantic_001").map((event) => event.type))
        .toEqual(["created", "started", "progress", "progress", "succeeded"]);
    } finally {
      store.close();
    }
  });
});

function commitPassingExport(databasePath: string): void {
  const store = ProjectStore.open(databasePath);
  try {
    const document = store.snapshot();
    const sourceRevision = document.project.revision;
    const sequenceId = document.project.activeSequenceId!;
    const transcript = document.artifacts.find((artifact) => artifact.kind === "transcript");
    if (!transcript || transcript.kind !== "transcript") throw new Error("Transcript fixture is missing");
    const actor = { kind: "workflow" as const, id: "render_engine" };
    const createdAt = "2026-08-10T00:00:00.000Z";
    const duration = { value: 3_003_000, rate: { numerator: 1_000_000, denominator: 1 } };
    const caption: CaptionDocumentArtifact = {
      id: "captions_alpha_fixture",
      kind: "captionDocument",
      transcriptArtifactId: transcript.id,
      sequenceId,
      projectRevision: sourceRevision,
      language: "zh",
      format: "srt",
      uri: "renders/alpha-fixture.srt",
      contentHash: `sha256:${"e".repeat(64)}`,
      cues: [],
      provenance: {
        createdBy: actor,
        createdAt,
        reason: "Alpha API export gate fixture",
        sourceArtifactIds: [transcript.id],
      },
    };
    const output: Asset = {
      id: "asset_alpha_fixture_output",
      kind: "generated",
      uri: "renders/alpha-fixture.mp4",
      contentHash: `sha256:${"d".repeat(64)}`,
      availability: "online",
      provenance: {
        createdBy: actor,
        createdAt,
        reason: "Alpha API export gate fixture",
        sourceArtifactIds: [caption.id],
      },
    };
    const report: RenderReportArtifact = {
      id: "render_alpha_fixture",
      kind: "renderReport",
      sequenceId,
      projectRevision: sourceRevision,
      outputAssetId: output.id,
      captionArtifactId: caption.id,
      renderer: "ffmpeg",
      rendererVersion: "fixture",
      planHash: `sha256:${"f".repeat(64)}`,
      duration,
      fileSizeBytes: 1_000,
      videoCodec: "h264",
      audioCodec: "aac",
      quality: {
        timelineDuration: duration,
        outputDuration: duration,
        durationDeltaMillis: 0,
        width: 1280,
        height: 720,
        hasAudio: true,
        subtitleCueCount: 0,
        passed: true,
      },
      warnings: [],
      provenance: {
        createdBy: actor,
        createdAt,
        reason: "Alpha API export gate fixture",
        sourceArtifactIds: [transcript.id, caption.id],
      },
    };
    store.commit({
      protocolVersion: "0.1.0",
      transactionId: "tx_alpha_fixture_export",
      idempotencyKey: "alpha-fixture-export",
      projectId: document.project.id,
      sequenceId,
      baseRevision: sourceRevision,
      actor,
      reason: "Register passing Alpha export fixture",
      preconditions: [{ type: "object_exists", objectId: transcript.id }],
      operations: [
        { type: "asset.put", asset: output },
        { type: "artifact.put", artifact: caption },
        { type: "artifact.put", artifact: report },
      ],
    });
  } finally {
    store.close();
  }
}

function createFixtureProject(
  prefix: string,
  mutate?: (document: AgentCutProjectDocument) => void,
): {
  databasePath: string;
  options: Parameters<typeof handleAgentCutRequest>[2];
} {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "agentcut.sqlite");
  const fixtureUrl = new URL(
    "../../../packages/timeline-schema/fixtures/minimal-project.json",
    import.meta.url,
  );
  const document = JSON.parse(readFileSync(fixtureUrl, "utf8")) as AgentCutProjectDocument;
  mutate?.(document);
  ProjectStore.create(databasePath, document).close();
  return { databasePath, options: { databasePath, projectRoot: directory } };
}

function createCommittedFixtureProject(prefix: string): {
  databasePath: string;
  options: Parameters<typeof handleAgentCutRequest>[2];
} {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "agentcut.sqlite");
  const fixtureUrl = new URL(
    "../../../packages/timeline-schema/fixtures/minimal-project.json",
    import.meta.url,
  );
  const document = JSON.parse(readFileSync(fixtureUrl, "utf8")) as AgentCutProjectDocument;
  const candidateSet = document.artifacts.find((artifact) => artifact.kind === "deletionCandidateSet");
  const proposal = document.artifacts.find((artifact) => artifact.kind === "editProposal");
  if (!candidateSet || candidateSet.kind !== "deletionCandidateSet"
    || !proposal || proposal.kind !== "editProposal") {
    throw new Error("Fixture analysis artifacts are missing");
  }
  document.artifacts = document.artifacts.filter((artifact) =>
    artifact.kind !== "deletionCandidateSet" && artifact.kind !== "editProposal",
  );
  const store = ProjectStore.create(databasePath, document);
  store.commit(compileEditProposalBundle(document, candidateSet, proposal, {
    transactionId: "tx_alpha_fixture_delete",
    idempotencyKey: "alpha-fixture-delete",
    actor: { kind: "user", id: "alpha_reviewer" },
  }));
  store.close();
  return { databasePath, options: { databasePath, projectRoot: directory } };
}

async function request(
  options: Parameters<typeof handleAgentCutRequest>[2],
  method: string,
  url: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const source = body ? [Buffer.from(JSON.stringify(body))] : [];
  const incoming = Readable.from(source) as IncomingMessage;
  incoming.method = method;
  incoming.url = url;
  incoming.headers = {
    ...(body ? { "content-type": "application/json" } : {}),
    ...headers,
  };
  let status = 0;
  const responseHeaders: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const response = {
    writeHead(nextStatus: number, nextHeaders?: Record<string, string | number | readonly string[]>) {
      status = nextStatus;
      for (const [name, value] of Object.entries(nextHeaders ?? {})) {
        responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
      }
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return this;
    },
  } as unknown as ServerResponse;
  await handleAgentCutRequest(incoming, response, options);
  const raw = Buffer.concat(chunks).toString("utf8");
  return {
    status,
    body: raw ? JSON.parse(raw) as unknown : undefined,
    headers: responseHeaders,
  };
}
