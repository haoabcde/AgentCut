import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AlphaAuditDraft } from "./audit.js";
import type { AlphaCorrectnessRun } from "./correctness.js";
import { AlphaEvidenceError, AlphaEvidenceStore } from "./evidence.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AlphaEvidenceStore", () => {
  it("rejects timing for a project without prospective formal enrollment", () => {
    const draft = auditDraft();
    draft.project.alphaTrial = null;
    const store = AlphaEvidenceStore.open(":memory:");

    expect(() => store.beginTiming(draft, {
      requestId: "timing-nonformal",
      manualBaselineSeconds: 180,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sessionId: "timing-nonformal-session",
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({
      code: "ALPHA_TRIAL_ENROLLMENT_REQUIRED",
    }));
    expect(store.apply(draft).events).toEqual([]);
    store.close();
  });

  it("rejects an unbound baseline proof without writing a partial timing event", () => {
    const draft = formalAuditDraft();
    const store = AlphaEvidenceStore.open(":memory:");

    expect(() => store.beginTiming(draft, {
      requestId: "timing-proof-missing-operator",
      manualBaselineSeconds: 180,
      method: "screen_recording",
      operatorId: "",
      evidenceSha256: `sha256:${"c".repeat(64)}`,
      sessionId: "timing-proof-session",
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({ code: "INVALID_LABEL" }));
    expect(() => store.beginTiming(draft, {
      requestId: "timing-proof-reuses-source",
      manualBaselineSeconds: 180,
      method: "screen_recording",
      operatorId: "operator-01",
      evidenceSha256: draft.project.sourceSha256,
      sessionId: "timing-proof-session",
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({ code: "INVALID_LABEL" }));
    expect(store.apply(draft).events).toEqual([]);
    store.close();
  });

  it("atomically records the manual baseline and first active timing session", () => {
    const { path } = evidencePath();
    const draft = formalAuditDraft();
    const store = AlphaEvidenceStore.open(path, { clock: () => "2026-07-31T15:55:00.000Z" });

    const started = store.beginTiming(draft, {
      requestId: "timing-begin-001",
      manualBaselineSeconds: 180,
      method: "screen_recording",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sessionId: "timing-session-001",
    });
    expect(started.timing).toEqual({
      baseline: {
        manualBaselineSeconds: 180,
        method: "screen_recording",
        operatorIdHash: "sha256:44bbfadc719174790d5ae76b635c642a758e3615b846b56591bf2b922a31a441",
        evidenceSha256: `sha256:${"c".repeat(64)}`,
      },
      agentCutActiveSeconds: 0,
      state: "running",
      activeSessionId: "timing-session-001",
      lastActivityAt: "2026-07-31T15:55:00.000Z",
      complete: false,
    });
    expect(started.events.filter((event) => event.targetType === "timing").map((event) => ({
      requestId: event.requestId,
      kind: event.timingEvent?.kind,
      createdAt: event.createdAt,
    }))).toEqual([
      {
        requestId: "timing-begin-001:baseline",
        kind: "baseline",
        createdAt: "2026-07-31T15:55:00.000Z",
      },
      {
        requestId: "timing-begin-001:start",
        kind: "start",
        createdAt: "2026-07-31T15:55:00.000Z",
      },
    ]);
    expect(JSON.stringify(started.events)).not.toContain("operator-01");
    expect(store.beginTiming(draft, {
      requestId: "timing-begin-001",
      manualBaselineSeconds: 180,
      method: "screen_recording",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sessionId: "timing-session-001",
    }).events).toHaveLength(2);
    expect(() => store.beginTiming(draft, {
      requestId: "timing-begin-001",
      manualBaselineSeconds: 181,
      method: "screen_recording",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sessionId: "timing-session-001",
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({
      code: "IDEMPOTENCY_CONFLICT",
    }));
    store.close();
  });

  it("leaves no partial baseline when atomic timing begin is no longer eligible", () => {
    const draft = formalAuditDraft();
    draft.derived.firstHumanDecisionRevision = draft.project.revision;
    const store = AlphaEvidenceStore.open(":memory:", {
      clock: () => "2026-07-31T15:56:00.000Z",
    });

    expect(() => store.beginTiming(draft, {
      requestId: "timing-begin-too-late",
      manualBaselineSeconds: 180,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sessionId: "timing-session-too-late",
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({
      code: "INVALID_TIMING_ORIGIN",
    }));
    expect(store.apply(draft)).toEqual(expect.objectContaining({
      events: [],
      timing: expect.objectContaining({ baseline: null, state: "not_started" }),
    }));
    store.close();
  });

  it("persists a paired baseline and server-clocked active editing time across sessions", () => {
    const { path } = evidencePath();
    const draft = formalAuditDraft();
    let now = "2026-07-31T16:00:00.000Z";
    const store = AlphaEvidenceStore.open(path, { clock: () => now });

    store.setTimingBaseline(draft, {
      requestId: "timing-baseline-001",
      manualBaselineSeconds: 120,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    store.startTiming(draft, { requestId: "timing-start-001", sessionId: "session-001" });
    now = "2026-07-31T16:00:15.000Z";
    store.heartbeatTiming(draft, { requestId: "timing-heartbeat-001", sessionId: "session-001" });
    now = "2026-07-31T16:00:25.000Z";
    store.pauseTiming(draft, {
      requestId: "timing-pause-001",
      sessionId: "session-001",
      reason: "user",
    });
    store.close();

    now = "2026-07-31T16:05:00.000Z";
    const reopened = AlphaEvidenceStore.open(path, { clock: () => now });
    expect(reopened.apply(draft).timing).toEqual({
      baseline: {
        manualBaselineSeconds: 120,
        method: "stopwatch",
        operatorIdHash: "sha256:44bbfadc719174790d5ae76b635c642a758e3615b846b56591bf2b922a31a441",
        evidenceSha256: `sha256:${"c".repeat(64)}`,
      },
      agentCutActiveSeconds: 25,
      state: "paused",
      activeSessionId: null,
      lastActivityAt: "2026-07-31T16:00:25.000Z",
      complete: false,
    });

    reopened.startTiming(draft, { requestId: "timing-start-002", sessionId: "session-002" });
    now = "2026-07-31T16:05:10.000Z";
    const finished = reopened.finishTiming(draft, { requestId: "timing-finish-001" });
    expect(finished.timing).toEqual({
      baseline: {
        manualBaselineSeconds: 120,
        method: "stopwatch",
        operatorIdHash: "sha256:44bbfadc719174790d5ae76b635c642a758e3615b846b56591bf2b922a31a441",
        evidenceSha256: `sha256:${"c".repeat(64)}`,
      },
      agentCutActiveSeconds: 35,
      state: "finished",
      activeSessionId: null,
      lastActivityAt: "2026-07-31T16:05:10.000Z",
      complete: true,
    });
    expect(finished.events.filter((event) => event.targetType === "timing")).toHaveLength(6);
    reopened.close();
  });

  it("keeps one active-time run across Timeline revisions", () => {
    const draft = formalAuditDraft();
    let now = "2026-07-31T16:30:00.000Z";
    const store = AlphaEvidenceStore.open(":memory:", { clock: () => now });
    store.setTimingBaseline(draft, {
      requestId: "timing-baseline-cross-revision",
      manualBaselineSeconds: 120,
      method: "editor_log",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    store.startTiming(draft, {
      requestId: "timing-start-cross-revision",
      sessionId: "session-cross-revision",
    });
    now = "2026-07-31T16:30:15.000Z";
    store.heartbeatTiming(draft, {
      requestId: "timing-heartbeat-before-edit",
      sessionId: "session-cross-revision",
    });

    const nextRevision = structuredClone(draft);
    nextRevision.project.revision += 1;
    const afterEdit = store.apply(nextRevision);
    expect(afterEdit.audit.candidates[0]?.humanLabel).toBeNull();
    expect(afterEdit.timing).toEqual(expect.objectContaining({
      agentCutActiveSeconds: 15,
      state: "running",
      activeSessionId: "session-cross-revision",
    }));

    now = "2026-07-31T16:30:25.000Z";
    store.heartbeatTiming(nextRevision, {
      requestId: "timing-heartbeat-after-edit",
      sessionId: "session-cross-revision",
    });
    now = "2026-07-31T16:30:35.000Z";
    store.pauseTiming(nextRevision, {
      requestId: "timing-pause-after-edit",
      sessionId: "session-cross-revision",
      reason: "user",
    });
    const finished = store.finishTiming(nextRevision, {
      requestId: "timing-finish-after-edit",
    });
    expect(finished.timing).toEqual(expect.objectContaining({
      agentCutActiveSeconds: 35,
      state: "finished",
      complete: true,
    }));
    expect(finished.events.filter((event) => event.targetType === "timing").map((event) =>
      event.projectRevision,
    )).toEqual([draft.project.revision, draft.project.revision, draft.project.revision,
      nextRevision.project.revision, nextRevision.project.revision, nextRevision.project.revision]);
    expect(finished.events.some((event) => event.targetType === "candidate")).toBe(false);
    store.close();
  });

  it("reopens a finished timing run when the accepted Timeline revision changes", () => {
    const draft = formalAuditDraft();
    let now = "2026-07-31T16:45:00.000Z";
    const store = AlphaEvidenceStore.open(":memory:", { clock: () => now });
    store.setTimingBaseline(draft, {
      requestId: "timing-baseline-reopen",
      manualBaselineSeconds: 90,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    store.startTiming(draft, { requestId: "timing-start-reopen-1", sessionId: "reopen-1" });
    now = "2026-07-31T16:45:20.000Z";
    store.finishTiming(draft, { requestId: "timing-finish-reopen-1" });

    const edited = structuredClone(draft);
    edited.project.revision += 1;
    expect(store.apply(edited).timing).toEqual(expect.objectContaining({
      agentCutActiveSeconds: 20,
      state: "paused",
      complete: false,
    }));

    store.startTiming(edited, { requestId: "timing-start-reopen-2", sessionId: "reopen-2" });
    now = "2026-07-31T16:45:30.000Z";
    const finished = store.finishTiming(edited, { requestId: "timing-finish-reopen-2" });
    expect(finished.timing).toEqual(expect.objectContaining({
      agentCutActiveSeconds: 30,
      state: "finished",
      complete: true,
    }));
    store.close();
  });

  it("rejects replacing the baseline after a human content decision", () => {
    const draft = formalAuditDraft();
    let now = "2026-07-31T16:55:00.000Z";
    const store = AlphaEvidenceStore.open(":memory:", { clock: () => now });
    store.setTimingBaseline(draft, {
      requestId: "timing-baseline-old-run",
      manualBaselineSeconds: 90,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    store.startTiming(draft, { requestId: "timing-start-old-run", sessionId: "old-run" });
    now = "2026-07-31T16:55:20.000Z";
    store.finishTiming(draft, { requestId: "timing-finish-old-run" });

    const edited = structuredClone(draft);
    edited.project.revision += 1;
    edited.derived.firstHumanDecisionRevision = edited.project.revision;
    expect(() => store.setTimingBaseline(edited, {
      requestId: "timing-baseline-new-run",
      manualBaselineSeconds: 150,
      method: "editor_log",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({
      code: "INVALID_TIMING_ORIGIN",
    }));
    store.close();
  });

  it("rejects a first timing start after a human decision but permits a previously started run to resume", () => {
    const beforeDecision = formalAuditDraft();
    beforeDecision.project.revision = 5;
    let now = "2026-07-31T17:05:00.000Z";
    const store = AlphaEvidenceStore.open(":memory:", { clock: () => now });
    store.setTimingBaseline(beforeDecision, {
      requestId: "timing-baseline-before-decision",
      manualBaselineSeconds: 120,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });

    const afterDecision = structuredClone(beforeDecision);
    afterDecision.project.revision = 6;
    afterDecision.derived.firstHumanDecisionRevision = 6;
    expect(() => store.startTiming(afterDecision, {
      requestId: "timing-start-too-late",
      sessionId: "too-late",
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({
      code: "INVALID_TIMING_ORIGIN",
    }));
    store.close();

    const resumedStore = AlphaEvidenceStore.open(":memory:", { clock: () => now });
    resumedStore.setTimingBaseline(beforeDecision, {
      requestId: "timing-baseline-valid-run",
      manualBaselineSeconds: 120,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    resumedStore.startTiming(beforeDecision, {
      requestId: "timing-start-valid-run",
      sessionId: "valid-before-decision",
    });
    now = "2026-07-31T17:05:10.000Z";
    resumedStore.pauseTiming(afterDecision, {
      requestId: "timing-pause-after-decision",
      sessionId: "valid-before-decision",
      reason: "user",
    });
    resumedStore.startTiming(afterDecision, {
      requestId: "timing-resume-after-decision",
      sessionId: "valid-after-decision",
    });
    now = "2026-07-31T17:05:20.000Z";
    const finished = resumedStore.finishTiming(afterDecision, {
      requestId: "timing-finish-valid-run",
    });
    expect(finished.timing).toEqual(expect.objectContaining({
      agentCutActiveSeconds: 20,
      state: "finished",
      complete: true,
    }));
    resumedStore.close();
  });

  it("auto-pauses a stale timing session without counting background or daemon downtime", () => {
    const draft = formalAuditDraft();
    let now = "2026-07-31T17:00:00.000Z";
    const store = AlphaEvidenceStore.open(":memory:", { clock: () => now });
    store.setTimingBaseline(draft, {
      requestId: "timing-baseline-stale",
      manualBaselineSeconds: 90,
      method: "screen_recording",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    store.startTiming(draft, { requestId: "timing-start-stale", sessionId: "session-stale" });
    now = "2026-07-31T17:00:15.000Z";
    store.heartbeatTiming(draft, { requestId: "timing-heartbeat-stale", sessionId: "session-stale" });
    now = "2026-07-31T17:02:00.000Z";

    expect(store.apply(draft).timing).toEqual(expect.objectContaining({
      agentCutActiveSeconds: 15,
      state: "paused",
      activeSessionId: null,
      complete: false,
    }));
    expect(() => store.heartbeatTiming(draft, {
      requestId: "timing-heartbeat-too-late",
      sessionId: "session-stale",
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({
      code: "INVALID_TIMING_STATE",
    }));
    store.close();
  });

  it("requires a real baseline and counted active time before timing can finish", () => {
    const draft = formalAuditDraft();
    const store = AlphaEvidenceStore.open(":memory:", { clock: () => "2026-07-31T18:00:00.000Z" });

    expect(() => store.finishTiming(draft, { requestId: "timing-finish-empty" }))
      .toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({ code: "INVALID_TIMING_STATE" }));
    expect(() => store.setTimingBaseline(draft, {
      requestId: "timing-baseline-invalid",
      manualBaselineSeconds: 0,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({ code: "INVALID_LABEL" }));
    store.setTimingBaseline(draft, {
      requestId: "timing-baseline-before-running",
      manualBaselineSeconds: 90,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    store.startTiming(draft, { requestId: "timing-start-before-baseline-change", sessionId: "active" });
    expect(() => store.setTimingBaseline(draft, {
      requestId: "timing-baseline-while-running",
      manualBaselineSeconds: 100,
      method: "editor_log",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({ code: "INVALID_TIMING_STATE" }));
    store.close();
  });

  it("persists candidate and boundary labels without changing the audit binding", () => {
    const { path } = evidencePath();
    const draft = auditDraft();
    const store = AlphaEvidenceStore.open(path, { clock: () => "2026-07-31T12:00:00.000Z" });
    store.labelCandidate(draft, {
      requestId: "candidate-label-001",
      candidateId: "candidate_001",
      label: "true_positive",
      note: "试听确认是可删除停顿",
    });
    store.labelBoundary(draft, {
      requestId: "boundary-label-001",
      boundaryId: "boundary_001",
      usable: false,
      issueCodes: ["clipped_syllable"],
      note: "右侧起音略短",
    });
    store.close();

    const reopened = AlphaEvidenceStore.open(path);
    const evidence = reopened.apply(draft);
    expect(evidence.audit.project).toEqual(draft.project);
    expect(evidence.audit.candidates[0]).toEqual(expect.objectContaining({
      humanLabel: "true_positive",
      humanNote: "试听确认是可删除停顿",
    }));
    expect(evidence.audit.boundaries[0]).toEqual(expect.objectContaining({
      humanUsable: false,
      humanIssueCodes: ["clipped_syllable"],
      humanNote: "右侧起音略短",
    }));
    expect(evidence.progress).toEqual({
      candidateLabeled: 1,
      candidateTotal: 1,
      boundaryLabeled: 1,
      boundaryTotal: 1,
      complete: true,
    });
    expect(evidence.events).toHaveLength(2);
    reopened.close();
  });

  it("replays the same request idempotently and rejects request reuse with another payload", () => {
    const { path } = evidencePath();
    const draft = auditDraft();
    const store = AlphaEvidenceStore.open(path);
    const input = {
      requestId: "candidate-label-idempotent",
      candidateId: "candidate_001",
      label: "false_positive" as const,
      note: "这是有意义的停顿",
    };

    const first = store.labelCandidate(draft, input);
    const replay = store.labelCandidate(draft, input);
    expect(replay).toEqual(first);
    expect(store.apply(draft).events).toHaveLength(1);
    expect(() => store.labelCandidate(draft, { ...input, label: "true_positive" }))
      .toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({
        code: "IDEMPOTENCY_CONFLICT",
      }));
    store.close();
  });

  it("does not carry labels across a project revision or source hash", () => {
    const { path } = evidencePath();
    const draft = auditDraft();
    const store = AlphaEvidenceStore.open(path);
    store.labelCandidate(draft, {
      requestId: "candidate-label-bound",
      candidateId: "candidate_001",
      label: "true_positive",
    });

    const nextRevision = structuredClone(draft);
    nextRevision.project.revision += 1;
    expect(store.apply(nextRevision).audit.candidates[0]?.humanLabel).toBeNull();
    const anotherSource = structuredClone(draft);
    anotherSource.project.sourceSha256 = "sha256:another";
    expect(store.apply(anotherSource).audit.candidates[0]?.humanLabel).toBeNull();
    store.close();
  });

  it("validates target identity and unusable boundary evidence", () => {
    const { path } = evidencePath();
    const draft = auditDraft();
    const store = AlphaEvidenceStore.open(path);
    expect(() => store.labelCandidate(draft, {
      requestId: "candidate-label-missing",
      candidateId: "candidate_missing",
      label: "true_positive",
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({ code: "TARGET_NOT_FOUND" }));
    expect(() => store.labelBoundary(draft, {
      requestId: "boundary-label-invalid",
      boundaryId: "boundary_001",
      usable: false,
      issueCodes: [],
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({ code: "INVALID_LABEL" }));

    const pendingReview = structuredClone(draft);
    pendingReview.review = { completed: false, pendingCandidateIds: ["candidate_001"] };
    expect(() => store.labelCandidate(pendingReview, {
      requestId: "candidate-label-before-review-complete",
      candidateId: "candidate_001",
      label: "true_positive",
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({ code: "INVALID_LABEL" }));
    expect(() => store.labelBoundary(pendingReview, {
      requestId: "boundary-label-before-review-complete",
      boundaryId: "boundary_001",
      usable: true,
      issueCodes: [],
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({ code: "INVALID_LABEL" }));
    store.close();
  });

  it("rejects final quality labels until the accepted revision has a passing export", () => {
    const withoutExport = auditDraft();
    withoutExport.export = null;
    const store = AlphaEvidenceStore.open(":memory:");

    expect(() => store.labelCandidate(withoutExport, {
      requestId: "candidate-label-before-export",
      candidateId: "candidate_001",
      label: "true_positive",
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({ code: "INVALID_LABEL" }));

    const staleExport = auditDraft();
    staleExport.export!.sourceRevision -= 1;
    expect(() => store.labelBoundary(staleExport, {
      requestId: "boundary-label-after-stale-export",
      boundaryId: "boundary_001",
      usable: true,
      issueCodes: [],
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({ code: "INVALID_LABEL" }));
    store.close();
  });

  it("requires formal Alpha timing to be finished before recording final quality labels", () => {
    const draft = auditDraft();
    draft.project.alphaTrial = {
      mode: "formal",
      enrolledAt: "2026-08-13T00:00:00.000Z",
    };
    let now = "2026-08-13T00:00:00.000Z";
    const store = AlphaEvidenceStore.open(":memory:", { clock: () => now });
    store.beginTiming(draft, {
      requestId: "formal-label-timing-begin",
      manualBaselineSeconds: 120,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sessionId: "formal-label-session",
    });

    expect(() => store.labelCandidate(draft, {
      requestId: "formal-label-while-running",
      candidateId: "candidate_001",
      label: "true_positive",
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({
      code: "INVALID_TIMING_STATE",
    }));

    now = "2026-08-13T00:00:10.000Z";
    store.pauseTiming(draft, {
      requestId: "formal-label-timing-pause",
      sessionId: "formal-label-session",
      reason: "user",
    });
    expect(() => store.labelBoundary(draft, {
      requestId: "formal-label-while-paused",
      boundaryId: "boundary_001",
      usable: true,
      issueCodes: [],
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({
      code: "INVALID_TIMING_STATE",
    }));

    store.finishTiming(draft, { requestId: "formal-label-timing-finish" });
    expect(store.labelCandidate(draft, {
      requestId: "formal-label-after-finish",
      candidateId: "candidate_001",
      label: "true_positive",
    }).audit.candidates[0]?.humanLabel).toBe("true_positive");
    expect(store.labelBoundary(draft, {
      requestId: "formal-boundary-after-finish",
      boundaryId: "boundary_001",
      usable: true,
      issueCodes: [],
    }).audit.boundaries[0]?.humanUsable).toBe(true);
    store.close();
  });

  it("records a bound machine correctness run idempotently without changing label progress", () => {
    const { path } = evidencePath();
    const draft = auditDraft();
    const store = AlphaEvidenceStore.open(path, { clock: () => "2026-07-31T15:00:00.000Z" });
    const run = correctnessRun(draft);

    const first = store.recordCorrectnessRun(draft, run);
    const replay = store.recordCorrectnessRun(draft, run);

    expect(replay).toEqual(first);
    expect(replay.progress).toEqual({
      candidateLabeled: 0,
      candidateTotal: 1,
      boundaryLabeled: 0,
      boundaryTotal: 1,
      complete: false,
    });
    expect(replay.events).toContainEqual(expect.objectContaining({
      targetType: "correctness",
      targetId: "correctness-r7",
      correctnessResult: {
        sourceStateHash: `sha256:${"b".repeat(64)}`,
        checks: run.checks,
      },
    }));
    expect(() => store.recordCorrectnessRun(draft, {
      ...run,
      checks: { ...run.checks, undo: { ...run.checks.undo, passed: false } },
    })).toThrowError(expect.objectContaining<Partial<AlphaEvidenceError>>({
      code: "IDEMPOTENCY_CONFLICT",
    }));
    store.close();
  });
});

function evidencePath(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "agentcut-alpha-evidence-"));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, "alpha-evidence.sqlite") };
}

function auditDraft(): AlphaAuditDraft {
  return {
    schemaVersion: "1.0",
    project: {
      id: "project_alpha_001",
      name: "Alpha 真实项目",
      revision: 7,
      sequenceId: "sequence_main",
      transcriptId: "transcript_001",
      sourceAssetId: "asset_001",
      sourceSha256: "sha256:source-001",
    },
    review: { completed: true, pendingCandidateIds: [] },
    candidates: [{
      candidateId: "candidate_001",
      decision: "definite_remove",
      risk: "low",
      reasonCodes: ["silence"],
      confidence: 0.99,
      explanationZh: "低风险停顿",
      targetKind: "gap",
      wordIds: [],
      sourceStartMicros: 1_000_000,
      durationMicros: 800_000,
      text: "前文[停顿]后文",
      state: "committed_deleted",
      humanLabel: null,
      humanNote: null,
    }],
    boundaries: [{
      boundaryId: "boundary_001",
      assetId: "asset_001",
      timelineMicros: 1_000_000,
      leftSourceEndMicros: 1_000_000,
      rightSourceStartMicros: 1_800_000,
      removedDurationMicros: 800_000,
      candidateIds: ["candidate_001"],
      humanUsable: null,
      humanIssueCodes: [],
      humanNote: null,
    }],
    derived: {
      definiteRemovePredicted: 1,
      definiteRemoveCommitted: 1,
      highRiskAutoDeletedCandidateIds: [],
      firstHumanDecisionRevision: null,
    },
    export: passingExport(6),
  };
}

function formalAuditDraft(): AlphaAuditDraft {
  const draft = auditDraft();
  draft.project.alphaTrial = {
    mode: "formal",
    enrolledAt: "2026-07-31T00:00:00.000Z",
  };
  return draft;
}

function passingExport(sourceRevision: number): NonNullable<AlphaAuditDraft["export"]> {
  return {
    reportId: "render_passed_001",
    sourceRevision,
    outputAssetId: "asset_output_001",
    outputSha256: `sha256:${"d".repeat(64)}`,
    videoCodec: "h264",
    audioCodec: "aac",
    quality: {
      timelineDuration: { value: 10_000_000, rate: { numerator: 1_000_000, denominator: 1 } },
      outputDuration: { value: 10_000_000, rate: { numerator: 1_000_000, denominator: 1 } },
      durationDeltaMillis: 0,
      width: 1920,
      height: 1080,
      hasAudio: true,
      subtitleCueCount: 1,
      passed: true,
    },
  };
}

function correctnessRun(draft: AlphaAuditDraft): AlphaCorrectnessRun {
  const passed = (code: string) => ({ passed: true, code, details: { verified: true } });
  return {
    runId: "correctness-r7",
    projectId: draft.project.id,
    projectRevision: draft.project.revision,
    sourceSha256: draft.project.sourceSha256,
    sourceStateHash: `sha256:${"b".repeat(64)}`,
    checks: {
      undo: passed("DOMAIN_STATE_RESTORED"),
      restart: passed("STATE_REOPEN_MATCH"),
      idempotency: passed("IDEMPOTENT_REPLAY"),
      revisionConflict: passed("REVISION_CONFLICT_REJECTED"),
    },
  };
}
