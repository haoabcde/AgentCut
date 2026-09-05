import { describe, expect, it } from "vitest";
import { AlphaGateInputError, evaluateAlphaGate } from "./gate.js";

function qualifyingProject(projectId: string) {
  return {
    projectId,
    sourceSha256: `sha256:${createHash("sha256").update(projectId).digest("hex")}`,
    authorization: {
      confirmed: true,
      basis: "user_supplied_for_testing",
      evidence: `records/${projectId}/authorization.md`,
      sha256: `sha256:${"c".repeat(64)}`,
    },
    reviewCompleted: true,
    export: {
      succeeded: true,
      artifactSha256: `sha256:${"b".repeat(64)}`,
      qualityReport: `records/${projectId}/render-report.json`,
    },
    candidates: {
      definiteRemovePredicted: 50,
      definiteRemoveTruePositive: 49,
      highRiskAutoDeleted: 0,
      annotationEvidence: `records/${projectId}/candidate-labels.json`,
    },
    boundaries: {
      evaluated: 20,
      usable: 19,
      annotationEvidence: `records/${projectId}/boundary-listening.json`,
    },
    correctness: {
      undo: { evaluated: 1, passed: 1 },
      restart: { evaluated: 1, passed: 1 },
      idempotency: { evaluated: 1, passed: 1 },
      revisionConflict: { evaluated: 1, passed: 1 },
      evidence: `records/${projectId}/correctness.json`,
    },
    timing: {
      manualBaselineSeconds: 1_000,
      agentCutActiveSeconds: 700,
      operatorIdHash: `sha256:${createHash("sha256").update(`operator:${projectId}`).digest("hex")}`,
      evidenceSha256: `sha256:${"d".repeat(64)}`,
      evidence: `records/${projectId}/timing.json`,
    },
  };
}

describe("Alpha Gate evaluator", () => {
  it("passes only when twenty auditable projects meet every locked threshold", () => {
    // 20 个项目循环覆盖 8 类，验证凑满后多样性门槛不误伤合法 cohort。
    const classes = [
      "mandarin", "accent", "code-switch", "proper-noun-number",
      "fast-speech", "background-music", "vfr", "screen-recording",
    ] as const;
    const report = evaluateAlphaGate({
      schemaVersion: "1.0",
      projects: Array.from({ length: 20 }, (_, index) => ({
        ...qualifyingProject(`project-${index + 1}`),
        coverageClasses: [classes[index % classes.length]],
      })),
    });

    expect(report.status).toBe("passed");
    expect(report.metrics).toEqual(expect.objectContaining({
      authorizedProjects: { value: 20, required: 20, status: "passed" },
      reviewedAndExportedProjects: { value: 20, required: 20, status: "passed" },
      highRiskAutoDeleted: { value: 0, maximum: 0, status: "passed" },
      definiteRemovePrecision: {
        numerator: 980,
        denominator: 1_000,
        value: 0.98,
        minimum: 0.98,
        status: "passed",
      },
      boundaryUsability: {
        numerator: 380,
        denominator: 400,
        value: 0.95,
        minimum: 0.95,
        status: "passed",
      },
      medianTimeReduction: {
        pairedProjects: 20,
        value: 0.3,
        minimum: 0.3,
        status: "passed",
      },
      operatorCoverage: {
        distinctOperators: 20,
        required: 5,
        status: "passed",
      },
    }));
    expect(report.issues).toEqual([]);
  });

  it("fails a 20-project cohort that does not cover all eight required classes", () => {
    // 20 个项目全部达标，但只覆盖 mandarin 一类——多样性门槛应判 failed。
    const report = evaluateAlphaGate({
      schemaVersion: "1.0",
      projects: Array.from({ length: 20 }, (_, index) => ({
        ...qualifyingProject(`project-${index + 1}`),
        coverageClasses: ["mandarin" as const],
      })),
    });
    expect(report.status).toBe("failed");
    const coverageIssue = report.issues.find((issue) => issue.code === "SAMPLE_COVERAGE_INCOMPLETE");
    expect(coverageIssue).toBeDefined();
    expect(coverageIssue?.status).toBe("failed");
    expect(coverageIssue?.message).toContain("accent");
  });

  it("fails twenty paired projects collected under fewer than five operators", () => {
    const classes = [
      "mandarin", "accent", "code-switch", "proper-noun-number",
      "fast-speech", "background-music", "vfr", "screen-recording",
    ] as const;
    const projects = Array.from({ length: 20 }, (_, index) => ({
      ...qualifyingProject(`project-${index + 1}`),
      coverageClasses: [classes[index % classes.length]],
    }));
    for (const project of projects) project.timing.operatorIdHash = `sha256:${"c".repeat(64)}`;

    const report = evaluateAlphaGate({ schemaVersion: "1.0", projects });

    expect(report.status).toBe("failed");
    expect(report.metrics.operatorCoverage).toEqual({
      distinctOperators: 1,
      required: 5,
      status: "failed",
    });
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "OPERATOR_COVERAGE_INCOMPLETE",
      status: "failed",
    }));
  });

  it("treats unrecorded coverage classes as missing once twenty projects exist", () => {
    // 20 个达标项目但无一记录 coverageClasses——凑满后按缺失计，不得静默通过。
    const report = evaluateAlphaGate({
      schemaVersion: "1.0",
      projects: Array.from({ length: 20 }, (_, index) => qualifyingProject(`project-${index + 1}`)),
    });
    expect(report.status).toBe("failed");
    expect(report.issues.map((issue) => issue.code)).toContain("SAMPLE_COVERAGE_INCOMPLETE");
  });

  it("rejects a manifest with a coverage class outside the allowed set", () => {
    const project = { ...qualifyingProject("project-one"), coverageClasses: ["holographic-8k"] };
    expect(() => evaluateAlphaGate({ schemaVersion: "1.0", projects: [project] }))
      .toThrowError(expect.objectContaining({ code: "INVALID_COVERAGE_CLASS" }));
  });

  it("rejects malformed authorization metadata before counting a project", () => {
    const missingEvidence = {
      ...qualifyingProject("project-one"),
      authorization: { confirmed: true, basis: "user_supplied_for_testing", evidence: "" },
    };
    expect(() => evaluateAlphaGate({ schemaVersion: "1.0", projects: [missingEvidence] }))
      .toThrowError(expect.objectContaining<Partial<AlphaGateInputError>>({
        code: "INVALID_AUTHORIZATION",
      }));

    const invalidConfirmation = {
      ...qualifyingProject("project-two"),
      authorization: {
        confirmed: "yes",
        basis: "user_supplied_for_testing",
        evidence: "authorization.md",
      },
    };
    expect(() => evaluateAlphaGate({ schemaVersion: "1.0", projects: [invalidConfirmation] }))
      .toThrowError(expect.objectContaining<Partial<AlphaGateInputError>>({
        code: "INVALID_AUTHORIZATION",
      }));

    const missingHash = {
      ...qualifyingProject("project-three"),
      authorization: {
        confirmed: true,
        basis: "user_supplied_for_testing",
        evidence: "authorization.md",
      },
    };
    expect(() => evaluateAlphaGate({ schemaVersion: "1.0", projects: [missingHash] }))
      .toThrowError(expect.objectContaining<Partial<AlphaGateInputError>>({
        code: "INVALID_AUTHORIZATION",
      }));
  });

  it("does not let a strong cohort dilute one project below the per-project floor", () => {
    // 19 个项目完美（precision 100%、边界 100%），1 个项目 precision 50%、边界 50%。
    // 跨项目聚合 precision=99.5%、边界=97.5% 都过线，但单项目跌破底线应判 failed。
    const classes = [
      "mandarin", "accent", "code-switch", "proper-noun-number",
      "fast-speech", "background-music", "vfr", "screen-recording",
    ] as const;
    const projects = Array.from({ length: 20 }, (_, index) => ({
      ...qualifyingProject(`project-${index + 1}`),
      coverageClasses: [classes[index % classes.length]],
    }));
    // 先把 20 个项目全部拉满，再只压低第 20 个；否则 qualifyingProject 自带的 49/50、19/20
    // 会让跨项目聚合跌破 0.98/0.95，测试就无法证明「单项目底线」而非「聚合阈值」导致 failed。
    for (const project of projects) {
      project.candidates.definiteRemoveTruePositive = project.candidates.definiteRemovePredicted;
      project.boundaries.usable = project.boundaries.evaluated;
    }
    const bad = projects[19]!;
    bad.candidates.definiteRemovePredicted = 10;
    bad.candidates.definiteRemoveTruePositive = 5; // 50% precision
    bad.boundaries.evaluated = 20;
    bad.boundaries.usable = 10; // 50% usability

    const report = evaluateAlphaGate({ schemaVersion: "1.0", projects });

    expect(report.status).toBe("failed");
    expect(report.metrics.definiteRemovePrecision.value).toBeCloseTo(0.994791, 3);
    expect(report.metrics.boundaryUsability.value).toBeCloseTo(0.975, 3);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DEFINITE_REMOVE_PROJECT_BELOW_FLOOR", projectIds: ["project-20"] }),
      expect.objectContaining({ code: "BOUNDARY_PROJECT_BELOW_FLOOR", projectIds: ["project-20"] }),
    ]));
  });

  it("reports missing denominators and sample coverage as insufficient evidence", () => {
    const project = qualifyingProject("project-one");
    project.candidates.definiteRemovePredicted = 0;
    project.candidates.definiteRemoveTruePositive = 0;
    project.boundaries.evaluated = 0;
    project.boundaries.usable = 0;
    project.timing = undefined as never;

    const report = evaluateAlphaGate({ schemaVersion: "1.0", projects: [project] });

    expect(report.status).toBe("insufficient_evidence");
    expect(report.metrics.authorizedProjects).toEqual({ value: 1, required: 20, status: "insufficient_evidence" });
    expect(report.metrics.definiteRemovePrecision.status).toBe("insufficient_evidence");
    expect(report.metrics.boundaryUsability.status).toBe("insufficient_evidence");
    expect(report.metrics.medianTimeReduction.status).toBe("insufficient_evidence");
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "AUTHORIZED_PROJECTS_MISSING",
      "DEFINITE_REMOVE_LABELS_MISSING",
      "BOUNDARY_LABELS_MISSING",
      "TIMING_PAIRS_MISSING",
    ]));
  });

  it("fails immediately when any high-risk content was automatically deleted", () => {
    const projects = Array.from({ length: 20 }, (_, index) => qualifyingProject(`project-${index + 1}`));
    projects[7]!.candidates.highRiskAutoDeleted = 1;

    const report = evaluateAlphaGate({ schemaVersion: "1.0", projects });

    expect(report.status).toBe("failed");
    expect(report.metrics.highRiskAutoDeleted).toEqual({ value: 1, maximum: 0, status: "failed" });
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "HIGH_RISK_AUTO_DELETE",
      projectIds: ["project-8"],
    }));
  });

  it("requires every correctness mechanism to pass once per authorized project", () => {
    const projects = Array.from({ length: 20 }, (_, index) => qualifyingProject(`project-${index + 1}`));
    projects[0]!.correctness.restart.passed = 0;

    const report = evaluateAlphaGate({ schemaVersion: "1.0", projects });

    expect(report.status).toBe("failed");
    expect(report.metrics.correctness.restart).toEqual({
      passed: 19,
      evaluated: 20,
      coveredProjects: 19,
      requiredEvaluations: 20,
      status: "failed",
    });
  });

  it("does not let one project substitute repeated checks for nineteen uncovered projects", () => {
    // 补全覆盖类别，隔离本测试对 correctness 证据不足的关注点（不被覆盖检查干扰）。
    const classes = [
      "mandarin", "accent", "code-switch", "proper-noun-number",
      "fast-speech", "background-music", "vfr", "screen-recording",
    ] as const;
    const projects = Array.from({ length: 20 }, (_, index) => ({
      ...qualifyingProject(`project-${index + 1}`),
      coverageClasses: [classes[index % classes.length]],
    }));
    for (const project of projects) project.correctness.undo = { evaluated: 0, passed: 0 };
    projects[0]!.correctness.undo = { evaluated: 20, passed: 20 };

    const report = evaluateAlphaGate({ schemaVersion: "1.0", projects });

    expect(report.status).toBe("insufficient_evidence");
    expect(report.metrics.correctness.undo).toEqual({
      passed: 20,
      evaluated: 20,
      coveredProjects: 1,
      requiredEvaluations: 20,
      status: "insufficient_evidence",
    });
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "CORRECTNESS_EVIDENCE_MISSING",
      projectIds: projects.slice(1).map((project) => project.projectId),
    }));
  });

  it("rejects duplicate projects and impossible human-label counts", () => {
    const duplicate = qualifyingProject("duplicate");
    expect(() => evaluateAlphaGate({ schemaVersion: "1.0", projects: [duplicate, duplicate] }))
      .toThrowError(new AlphaGateInputError("DUPLICATE_PROJECT", "Duplicate projectId: duplicate"));

    const impossible = qualifyingProject("impossible");
    impossible.boundaries.usable = impossible.boundaries.evaluated + 1;
    expect(() => evaluateAlphaGate({ schemaVersion: "1.0", projects: [impossible] }))
      .toThrowError(new AlphaGateInputError(
        "INVALID_COUNT",
        "Project impossible has usable boundaries greater than evaluated boundaries",
      ));
  });

  it("rejects the same source media registered under multiple cohort project IDs", () => {
    const first = qualifyingProject("cohort-project-001");
    const duplicateSource = qualifyingProject("cohort-project-002");
    first.sourceSha256 = `sha256:${"a".repeat(64)}`;
    duplicateSource.sourceSha256 = first.sourceSha256;

    expect(() => evaluateAlphaGate({ schemaVersion: "1.0", projects: [first, duplicateSource] }))
      .toThrowError(new AlphaGateInputError(
        "DUPLICATE_SOURCE",
        "Source media sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa is registered by both cohort-project-001 and cohort-project-002",
      ));
  });
});
import { createHash } from "node:crypto";
