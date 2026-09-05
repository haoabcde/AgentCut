import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AlphaAuditDraft } from "./audit.js";
import {
  alphaEvidenceBundleFileSha256,
  createAlphaEvidenceBundle,
  serializeAlphaEvidenceBundle,
} from "./bundle.js";
import { AlphaEvidenceStore } from "./evidence.js";
import { AlphaGateInputError, evaluateAlphaGate } from "./gate.js";
import { materializeAlphaGateManifest } from "./manifest-evidence.js";
import { alphaAuthorizationEvidenceSha256 } from "./authorization.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Alpha Gate bundle materialization", () => {
  it("rejects cohort cloning that re-registers one canonical project under many cohort IDs", async () => {
    const fixture = evidenceFixture();
    const base = manifestFor(fixture.fileSha256, fixture.revision).projects[0]!;
    // 20 个 cohort 条目共享同一 bundle（同一真实项目换皮复制）。外层
    // evaluateAlphaGate 的 DUPLICATE_SOURCE 校验在 binding 之前就按 manifest 的
    // 共享 sourceSha256 拦截——这是克隆的第一道防线，断言它真实命中。
    const projects = Array.from({ length: 20 }, (_, index) => ({
      ...base,
      projectId: `clone-${index + 1}`,
      evidenceBundle: { ...base.evidenceBundle!, path: "bundle.json" },
    }));
    await expect(materializeAlphaGateManifest(
      { schemaVersion: "1.0", projects },
      { baseDirectory: fixture.directory },
    )).rejects.toThrowError(expect.objectContaining({ code: "DUPLICATE_SOURCE" }));
  });

  it("rejects a bundle whose source hash does not match the manifest entry", async () => {
    // binding 校验同时锁住 sourceSha256：换 source 不换 bundle（或反之）即失配。
    const fixture = evidenceFixture();
    const base = manifestFor(fixture.fileSha256, fixture.revision).projects[0]!;
    const project = { ...base, sourceSha256: `sha256:${"b".repeat(64)}` };
    writeFileSync(
      join(fixture.directory, "authorization.md"),
      `<!-- agentcut-alpha-authorization: project_alpha_001 sha256:${"b".repeat(64)} -->\n`,
      "utf8",
    );
    project.authorization.sha256 = alphaAuthorizationEvidenceSha256(
      `<!-- agentcut-alpha-authorization: project_alpha_001 sha256:${"b".repeat(64)} -->\n`,
    );
    await expect(materializeAlphaGateManifest(
      { schemaVersion: "1.0", projects: [project] },
      { baseDirectory: fixture.directory },
    )).rejects.toThrowError(expect.objectContaining({ code: "BUNDLE_BINDING_MISMATCH" }));
  });

  it("derives review, candidate and boundary counts from the verified bundle", async () => {
    const fixture = evidenceFixture();
    const manifest = manifestFor(fixture.fileSha256, fixture.revision);
    const materialized = await materializeAlphaGateManifest(manifest, { baseDirectory: fixture.directory });
    const project = materialized.projects[0]!;

    expect(project.reviewCompleted).toBe(true);
    expect(project.candidates).toEqual({
      definiteRemovePredicted: 1,
      definiteRemoveTruePositive: 1,
      highRiskAutoDeleted: 0,
      annotationEvidence: "bundle.json",
    });
    expect(project.boundaries).toEqual({
      evaluated: 1,
      usable: 1,
      annotationEvidence: "bundle.json",
    });
    expect(project.correctness).toEqual({
      undo: { evaluated: 1, passed: 1 },
      restart: { evaluated: 1, passed: 1 },
      idempotency: { evaluated: 1, passed: 1 },
      revisionConflict: { evaluated: 1, passed: 1 },
      evidence: "bundle.json",
    });
    expect(project.timing).toEqual({
      manualBaselineSeconds: 120,
      agentCutActiveSeconds: 30,
      operatorIdHash: "sha256:44bbfadc719174790d5ae76b635c642a758e3615b846b56591bf2b922a31a441",
      evidenceSha256: `sha256:${"c".repeat(64)}`,
      evidence: "bundle.json",
    });
    expect(evaluateAlphaGate(materialized).metrics.definiteRemovePrecision)
      .toEqual(expect.objectContaining({ numerator: 1, denominator: 1, value: 1 }));
  });

  it("rejects file tampering before using any bundle counts", async () => {
    const fixture = evidenceFixture();
    writeFileSync(fixture.path, readFileSync(fixture.path, "utf8").replace('"usable": true', '"usable": false'));

    await expect(materializeAlphaGateManifest(
      manifestFor(fixture.fileSha256, fixture.revision),
      { baseDirectory: fixture.directory },
    )).rejects.toThrowError(expect.objectContaining<Partial<AlphaGateInputError>>({
      code: "BUNDLE_FILE_HASH_MISMATCH",
    }));
  });

  it("rejects a bundle bound to another project revision", async () => {
    const fixture = evidenceFixture();

    await expect(materializeAlphaGateManifest(
      manifestFor(fixture.fileSha256, fixture.revision + 1),
      { baseDirectory: fixture.directory },
    )).rejects.toThrowError(expect.objectContaining<Partial<AlphaGateInputError>>({
      code: "BUNDLE_BINDING_MISMATCH",
    }));
  });

  it("rejects confirmed authorization whose referenced file is missing or empty", async () => {
    const missing = evidenceFixture();
    rmSync(join(missing.directory, "authorization.md"));
    await expect(materializeAlphaGateManifest(
      manifestFor(missing.fileSha256, missing.revision),
      { baseDirectory: missing.directory },
    )).rejects.toThrowError(expect.objectContaining<Partial<AlphaGateInputError>>({
      code: "AUTHORIZATION_EVIDENCE_INVALID",
    }));

    const empty = evidenceFixture();
    writeFileSync(join(empty.directory, "authorization.md"), "", "utf8");
    await expect(materializeAlphaGateManifest(
      manifestFor(empty.fileSha256, empty.revision),
      { baseDirectory: empty.directory },
    )).rejects.toThrowError(expect.objectContaining<Partial<AlphaGateInputError>>({
      code: "AUTHORIZATION_EVIDENCE_INVALID",
    }));

    const unbound = evidenceFixture();
    writeFileSync(
      join(unbound.directory, "authorization.md"),
      `<!-- agentcut-alpha-authorization: another-project sha256:${"a".repeat(64)} -->\n`,
      "utf8",
    );
    await expect(materializeAlphaGateManifest(
      manifestFor(unbound.fileSha256, unbound.revision),
      { baseDirectory: unbound.directory },
    )).rejects.toThrowError(expect.objectContaining<Partial<AlphaGateInputError>>({
      code: "AUTHORIZATION_EVIDENCE_INVALID",
    }));

    const wrongSource = evidenceFixture();
    writeFileSync(
      join(wrongSource.directory, "authorization.md"),
      `<!-- agentcut-alpha-authorization: project_alpha_001 sha256:${"b".repeat(64)} -->\n`,
      "utf8",
    );
    await expect(materializeAlphaGateManifest(
      manifestFor(wrongSource.fileSha256, wrongSource.revision),
      { baseDirectory: wrongSource.directory },
    )).rejects.toThrowError(expect.objectContaining<Partial<AlphaGateInputError>>({
      code: "AUTHORIZATION_EVIDENCE_INVALID",
    }));
  });

  it("rejects authorization prose changed after collection even when the cohort marker remains", async () => {
    const fixture = evidenceFixture();
    writeFileSync(
      join(fixture.directory, "authorization.md"),
      `Replaced authorization scope.\n<!-- agentcut-alpha-authorization: project_alpha_001 sha256:${"a".repeat(64)} -->\n`,
      "utf8",
    );

    await expect(materializeAlphaGateManifest(
      manifestFor(fixture.fileSha256, fixture.revision),
      { baseDirectory: fixture.directory },
    )).rejects.toThrowError(expect.objectContaining<Partial<AlphaGateInputError>>({
      code: "AUTHORIZATION_EVIDENCE_INVALID",
    }));
  });
});

function evidenceFixture(): {
  directory: string;
  path: string;
  fileSha256: string;
  revision: number;
} {
  const directory = mkdtempSync(join(tmpdir(), "agentcut-alpha-bundle-manifest-"));
  temporaryDirectories.push(directory);
  const draft = auditDraft();
  let now = "2026-07-31T14:00:00.000Z";
  const store = AlphaEvidenceStore.open(":memory:", { clock: () => now });
  store.setTimingBaseline(draft, {
    requestId: "timing-baseline-r7",
    manualBaselineSeconds: 120,
    method: "stopwatch",
      operatorId: "operator-01",
      evidenceSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  });
  store.startTiming(draft, { requestId: "timing-start-r7", sessionId: "timing-session-r7" });
  now = "2026-07-31T14:00:30.000Z";
  store.finishTiming(draft, { requestId: "timing-finish-r7" });
  store.labelCandidate(draft, {
    requestId: "candidate-001",
    candidateId: "candidate_001",
    label: "true_positive",
  });
  store.labelBoundary(draft, {
    requestId: "boundary-001",
    boundaryId: "boundary_001",
    usable: true,
    issueCodes: [],
  });
  const passed = (code: string) => ({ passed: true, code, details: { verified: true } });
  const evidence = store.recordCorrectnessRun(draft, {
    runId: "correctness-r7",
    projectId: draft.project.id,
    projectRevision: draft.project.revision,
    sourceSha256: draft.project.sourceSha256,
    sourceStateHash: `sha256:${"c".repeat(64)}`,
    checks: {
      undo: passed("DOMAIN_STATE_RESTORED"),
      restart: passed("STATE_REOPEN_MATCH"),
      idempotency: passed("IDEMPOTENT_REPLAY"),
      revisionConflict: passed("REVISION_CONFLICT_REJECTED"),
    },
  });
  const serialized = serializeAlphaEvidenceBundle(createAlphaEvidenceBundle(evidence));
  const path = join(directory, "bundle.json");
  writeFileSync(path, serialized, "utf8");
  writeFileSync(
    join(directory, "authorization.md"),
    `Authorized for local Alpha testing.\n<!-- agentcut-alpha-authorization: project_alpha_001 sha256:${"a".repeat(64)} -->\n`,
    "utf8",
  );
  store.close();
  return {
    directory,
    path,
    fileSha256: alphaEvidenceBundleFileSha256(serialized),
    revision: draft.project.revision,
  };
}

function manifestFor(fileSha256: string, projectRevision: number) {
  return {
    schemaVersion: "1.0" as const,
    projects: [{
      projectId: "project_alpha_001",
      sourceSha256: `sha256:${"a".repeat(64)}`,
      evidenceBundle: {
        path: "bundle.json",
        sha256: fileSha256,
        canonicalProjectId: "project_alpha_001",
        projectRevision,
      },
      authorization: {
        confirmed: true,
        basis: "user_supplied_for_testing",
        evidence: "authorization.md",
        sha256: alphaAuthorizationEvidenceSha256(
          `Authorized for local Alpha testing.\n<!-- agentcut-alpha-authorization: project_alpha_001 sha256:${"a".repeat(64)} -->\n`,
        ),
      },
      reviewCompleted: false,
      export: { succeeded: false },
      candidates: { definiteRemovePredicted: 999, highRiskAutoDeleted: 999 },
      boundaries: { evaluated: 999 },
      correctness: {
        undo: { evaluated: 0, passed: 0 },
        restart: { evaluated: 0, passed: 0 },
        idempotency: { evaluated: 0, passed: 0 },
        revisionConflict: { evaluated: 0, passed: 0 },
      },
      timing: {
        manualBaselineSeconds: 999,
        agentCutActiveSeconds: 999,
        operatorIdHash: `sha256:${"e".repeat(64)}`,
        evidenceSha256: `sha256:${"f".repeat(64)}`,
        evidence: "unverified-manual-entry.json",
      },
    }],
  };
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
      alphaTrial: {
        mode: "formal",
        enrolledAt: "2026-07-31T14:00:00.000Z",
      },
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
      text: "敏感文稿",
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
