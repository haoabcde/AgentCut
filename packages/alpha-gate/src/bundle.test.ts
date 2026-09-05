import { describe, expect, it } from "vitest";
import type { AlphaAuditDraft } from "./audit.js";
import {
  AlphaEvidenceBundleError,
  createAlphaEvidenceBundle,
  parseAlphaEvidenceBundle,
  serializeAlphaEvidenceBundle,
} from "./bundle.js";
import { AlphaEvidenceStore } from "./evidence.js";

describe("Alpha evidence bundle", () => {
  it("serializes the same bound evidence deterministically without copying transcript text", () => {
    const draft = auditDraft();
    const store = AlphaEvidenceStore.open(":memory:", { clock: () => "2026-07-31T13:00:00.000Z" });
    store.labelCandidate(draft, {
      requestId: "candidate-label-001",
      candidateId: "candidate_001",
      label: "true_positive",
      note: "人工试听确认",
    });
    const evidence = store.labelBoundary(draft, {
      requestId: "boundary-label-001",
      boundaryId: "boundary_001",
      usable: true,
      issueCodes: [],
    });

    const first = serializeAlphaEvidenceBundle(createAlphaEvidenceBundle(evidence));
    const second = serializeAlphaEvidenceBundle(createAlphaEvidenceBundle(store.apply(draft)));

    expect(second).toBe(first);
    expect(first).not.toContain("这段文字不能复制进证据包");
    expect(first).not.toContain("人工试听确认");
    expect(first).toMatch(/"noteSha256": "sha256:[a-f0-9]{64}"/);
    expect(parseAlphaEvidenceBundle(first)).toEqual(createAlphaEvidenceBundle(evidence));
    expect(parseAlphaEvidenceBundle(first).integrity.payloadSha256)
      .toMatch(/^sha256:[a-f0-9]{64}$/);
    store.close();
  });

  it("rejects a payload changed after export", () => {
    const store = AlphaEvidenceStore.open(":memory:");
    const serialized = serializeAlphaEvidenceBundle(createAlphaEvidenceBundle(store.apply(auditDraft())));
    const tampered = serialized.replace('"candidateLabeled": 0', '"candidateLabeled": 1');

    expect(() => parseAlphaEvidenceBundle(tampered)).toThrowError(
      expect.objectContaining<Partial<AlphaEvidenceBundleError>>({ code: "BUNDLE_INTEGRITY_MISMATCH" }),
    );
    store.close();
  });

  it("rejects final labels without a passing export for the accepted revision", () => {
    const draft = auditDraft();
    const store = AlphaEvidenceStore.open(":memory:");
    store.labelCandidate(draft, {
      requestId: "candidate-label-export-gate",
      candidateId: "candidate_001",
      label: "true_positive",
    });
    const bundle = createAlphaEvidenceBundle(store.apply(draft));
    bundle.export = null;
    const { integrity: _integrity, ...payload } = bundle;
    bundle.integrity.payloadSha256 = canonicalSha256(payload);

    expect(() => serializeAlphaEvidenceBundle(bundle)).toThrowError(
      expect.objectContaining<Partial<AlphaEvidenceBundleError>>({ code: "INVALID_BUNDLE" }),
    );
    store.close();
  });

  it("materializes completed timing from the append-only event log", () => {
    const draft = formalAuditDraft();
    let now = "2026-07-31T19:00:00.000Z";
    const store = AlphaEvidenceStore.open(":memory:", { clock: () => now });
    store.setTimingBaseline(draft, {
      requestId: "timing-baseline-bundle",
      manualBaselineSeconds: 100,
      method: "editor_log",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    store.startTiming(draft, { requestId: "timing-start-bundle", sessionId: "bundle-session" });
    now = "2026-07-31T19:00:20.000Z";
    const evidence = store.finishTiming(draft, { requestId: "timing-finish-bundle" });

    const bundle = parseAlphaEvidenceBundle(serializeAlphaEvidenceBundle(createAlphaEvidenceBundle(evidence)));
    expect(bundle.project.alphaTrial).toEqual({
      mode: "formal",
      enrolledAt: "2026-07-01T00:00:00.000Z",
    });
    expect(bundle.timing).toEqual({
      manualBaselineSeconds: 100,
      method: "editor_log",
      operatorIdHash: "sha256:44bbfadc719174790d5ae76b635c642a758e3615b846b56591bf2b922a31a441",
      evidenceSha256: `sha256:${"c".repeat(64)}`,
      agentCutActiveSeconds: 20,
      complete: true,
    });
    expect(bundle.events.filter((event) => event.targetType === "timing")).toHaveLength(3);

    if (!bundle.timing) throw new Error("Timing fixture is missing");
    bundle.timing.agentCutActiveSeconds = 19;
    const { integrity: _integrity, ...payload } = bundle;
    bundle.integrity.payloadSha256 = canonicalSha256(payload);
    expect(() => serializeAlphaEvidenceBundle(bundle)).toThrowError(
      expect.objectContaining<Partial<AlphaEvidenceBundleError>>({ code: "INVALID_BUNDLE" }),
    );
    store.close();
  });

  it("preserves and validates a completed active-time run that spans project revisions", () => {
    const draft = formalAuditDraft();
    let now = "2026-07-31T19:30:00.000Z";
    const store = AlphaEvidenceStore.open(":memory:", { clock: () => now });
    store.setTimingBaseline(draft, {
      requestId: "timing-baseline-bundle-cross-revision",
      manualBaselineSeconds: 100,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    store.startTiming(draft, {
      requestId: "timing-start-bundle-cross-revision",
      sessionId: "bundle-cross-revision",
    });
    now = "2026-07-31T19:30:15.000Z";
    store.finishTiming(draft, {
      requestId: "timing-finish-bundle-before-edit",
    });

    const finalDraft = structuredClone(draft);
    finalDraft.project.revision += 1;
    finalDraft.derived.firstHumanDecisionRevision = finalDraft.project.revision;
    store.startTiming(finalDraft, {
      requestId: "timing-start-bundle-after-edit",
      sessionId: "bundle-cross-revision-resumed",
    });
    now = "2026-07-31T19:30:25.000Z";
    store.heartbeatTiming(finalDraft, {
      requestId: "timing-heartbeat-bundle-after-edit",
      sessionId: "bundle-cross-revision-resumed",
    });
    now = "2026-07-31T19:30:35.000Z";
    const evidence = store.finishTiming(finalDraft, {
      requestId: "timing-finish-bundle-cross-revision",
    });

    const bundle = parseAlphaEvidenceBundle(serializeAlphaEvidenceBundle(createAlphaEvidenceBundle(evidence)));
    expect(bundle.project.revision).toBe(finalDraft.project.revision);
    expect(bundle.derived.firstHumanDecisionRevision).toBe(finalDraft.project.revision);
    expect(bundle.timing?.agentCutActiveSeconds).toBe(35);
    expect(bundle.events.filter((event) => event.targetType === "timing").map((event) =>
      event.projectRevision,
    )).toEqual([
      draft.project.revision,
      draft.project.revision,
      draft.project.revision,
      finalDraft.project.revision,
      finalDraft.project.revision,
      finalDraft.project.revision,
    ]);
    store.close();
  });

  it("rejects timing whose baseline or first start is not earlier than the first human decision", () => {
    const draft = formalAuditDraft();
    let now = "2026-07-31T20:00:00.000Z";
    const store = AlphaEvidenceStore.open(":memory:", { clock: () => now });
    store.setTimingBaseline(draft, {
      requestId: "timing-baseline-origin",
      manualBaselineSeconds: 100,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    store.startTiming(draft, { requestId: "timing-start-origin", sessionId: "origin-session" });
    now = "2026-07-31T20:00:10.000Z";
    const evidence = store.finishTiming(draft, { requestId: "timing-finish-origin" });
    const bundle = createAlphaEvidenceBundle(evidence);
    bundle.derived.firstHumanDecisionRevision = draft.project.revision;
    const { integrity: _integrity, ...payload } = bundle;
    bundle.integrity.payloadSha256 = canonicalSha256(payload);

    expect(() => serializeAlphaEvidenceBundle(bundle)).toThrowError(
      expect.objectContaining<Partial<AlphaEvidenceBundleError>>({ code: "INVALID_BUNDLE" }),
    );
    store.close();
  });

  it("rejects final labels recorded before active-time evidence was finished", () => {
    const draft = formalAuditDraft();
    let now = "2026-08-13T00:00:00.000Z";
    const store = AlphaEvidenceStore.open(":memory:", { clock: () => now });
    store.beginTiming(draft, {
      requestId: "timing-label-order-begin",
      manualBaselineSeconds: 120,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sessionId: "timing-label-order-session",
    });
    now = "2026-08-13T00:00:10.000Z";
    store.finishTiming(draft, { requestId: "timing-label-order-finish" });
    const evidence = store.labelCandidate(draft, {
      requestId: "timing-label-order-candidate",
      candidateId: "candidate_001",
      label: "true_positive",
    });
    const bundle = createAlphaEvidenceBundle(evidence);
    const finish = bundle.events.find((event) => event.timingEvent?.kind === "finish");
    const candidate = bundle.events.find((event) => event.targetType === "candidate");
    if (!finish || !candidate) throw new Error("Label-order fixture is incomplete");
    [finish.sequence, candidate.sequence] = [candidate.sequence, finish.sequence];
    bundle.events.sort((left, right) => left.sequence - right.sequence);
    const { integrity: _integrity, ...payload } = bundle;
    bundle.integrity.payloadSha256 = canonicalSha256(payload);

    expect(() => serializeAlphaEvidenceBundle(bundle)).toThrowError(
      expect.objectContaining<Partial<AlphaEvidenceBundleError>>({ code: "INVALID_BUNDLE" }),
    );
    store.close();
  });

  it("rejects timing evidence from a project that was not prospectively enrolled", () => {
    const draft = formalAuditDraft();
    let now = "2026-08-13T00:00:00.000Z";
    const store = AlphaEvidenceStore.open(":memory:", { clock: () => now });
    store.beginTiming(draft, {
      requestId: "nonformal-timing-begin",
      manualBaselineSeconds: 120,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sessionId: "nonformal-session",
    });
    now = "2026-08-13T00:00:10.000Z";
    const evidence = store.finishTiming(draft, { requestId: "nonformal-timing-finish" });
    const bundle = createAlphaEvidenceBundle(evidence);
    bundle.project.alphaTrial = null;
    const { integrity: _integrity, ...payload } = bundle;
    bundle.integrity.payloadSha256 = canonicalSha256(payload);

    expect(() => serializeAlphaEvidenceBundle(bundle)).toThrowError(
      expect.objectContaining<Partial<AlphaEvidenceBundleError>>({ code: "INVALID_BUNDLE" }),
    );
    store.close();
  });

  it("rejects an invalid formal enrollment timestamp even after the payload is rehashed", () => {
    const store = AlphaEvidenceStore.open(":memory:");
    const bundle = createAlphaEvidenceBundle(store.apply(formalAuditDraft()));
    if (!bundle.project.alphaTrial) throw new Error("Formal enrollment fixture is missing");
    bundle.project.alphaTrial.enrolledAt = "not-a-timestamp";
    const { integrity: _integrity, ...payload } = bundle;
    bundle.integrity.payloadSha256 = canonicalSha256(payload);

    expect(() => serializeAlphaEvidenceBundle(bundle)).toThrowError(
      expect.objectContaining<Partial<AlphaEvidenceBundleError>>({ code: "INVALID_BUNDLE" }),
    );
    store.close();
  });

  it("rejects formal enrollment recorded after the first timing baseline", () => {
    const draft = formalAuditDraft();
    let now = "2026-07-31T21:00:00.000Z";
    const store = AlphaEvidenceStore.open(":memory:", { clock: () => now });
    store.beginTiming(draft, {
      requestId: "post-hoc-enrollment-begin",
      manualBaselineSeconds: 120,
      method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sessionId: "post-hoc-enrollment-session",
    });
    now = "2026-07-31T21:00:10.000Z";
    const bundle = createAlphaEvidenceBundle(store.finishTiming(draft, {
      requestId: "post-hoc-enrollment-finish",
    }));
    if (!bundle.project.alphaTrial) throw new Error("Formal enrollment fixture is missing");
    bundle.project.alphaTrial.enrolledAt = "2026-07-31T21:00:01.000Z";
    const { integrity: _integrity, ...payload } = bundle;
    bundle.integrity.payloadSha256 = canonicalSha256(payload);

    expect(() => serializeAlphaEvidenceBundle(bundle)).toThrowError(
      expect.objectContaining<Partial<AlphaEvidenceBundleError>>({ code: "INVALID_BUNDLE" }),
    );
    store.close();
  });

  it("rejects timing with its operator and baseline-evidence commitments stripped and rehashed", () => {
    const draft = formalAuditDraft();
    let now = "2026-07-31T22:00:00.000Z";
    const store = AlphaEvidenceStore.open(":memory:", { clock: () => now });
    store.beginTiming(draft, {
      requestId: "timing-proof-begin",
      manualBaselineSeconds: 120,
      method: "screen_recording",
      operatorId: "operator-01",
      evidenceSha256: `sha256:${"c".repeat(64)}`,
      sessionId: "timing-proof-session",
    });
    now = "2026-07-31T22:00:10.000Z";
    const bundle = createAlphaEvidenceBundle(store.finishTiming(draft, {
      requestId: "timing-proof-finish",
    }));
    if (!bundle.timing) throw new Error("Timing fixture is missing");
    delete (bundle.timing as Partial<typeof bundle.timing>).operatorIdHash;
    delete (bundle.timing as Partial<typeof bundle.timing>).evidenceSha256;
    const baseline = bundle.events.find((event) => event.timingEvent?.kind === "baseline");
    if (!baseline?.timingEvent || baseline.timingEvent.kind !== "baseline") {
      throw new Error("Timing baseline fixture is missing");
    }
    delete (baseline.timingEvent as Partial<typeof baseline.timingEvent>).operatorIdHash;
    delete (baseline.timingEvent as Partial<typeof baseline.timingEvent>).evidenceSha256;
    const { integrity: _integrity, ...payload } = bundle;
    bundle.integrity.payloadSha256 = canonicalSha256(payload);

    expect(() => serializeAlphaEvidenceBundle(bundle)).toThrowError(
      expect.objectContaining<Partial<AlphaEvidenceBundleError>>({ code: "INVALID_BUNDLE" }),
    );
    store.close();
  });
});

function canonicalSha256(value: unknown): string {
  const canonicalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonicalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]));
    }
    return candidate;
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
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
      sourceSha256: `sha256:${"a".repeat(64)}`,
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
      text: "这段文字不能复制进证据包",
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
    enrolledAt: "2026-07-01T00:00:00.000Z",
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
import { createHash } from "node:crypto";
