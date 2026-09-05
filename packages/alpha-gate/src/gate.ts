export class AlphaGateInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AlphaGateInputError";
  }
}

export type AlphaGateMetricStatus = "passed" | "failed" | "insufficient_evidence";
export type AlphaGateStatus = AlphaGateMetricStatus;

export interface AlphaGateCountEvidence {
  evaluated: number;
  passed: number;
}

export interface AlphaGateProjectEvidence {
  projectId: string;
  sourceSha256: string;
  /** 该项目覆盖的素材类别（REQUIRED_COVERAGE_CLASSES 子集）；未记录时缺省，凑满 20 个后按缺失计。 */
  coverageClasses?: CoverageClass[];
  auditDraft?: string;
  evidenceBundle?: {
    path: string;
    sha256: string;
    canonicalProjectId: string;
    projectRevision: number;
  };
  authorization: {
    confirmed: boolean;
    basis: string;
    evidence: string;
    sha256: string;
  };
  reviewCompleted: boolean;
  export: {
    succeeded: boolean;
    artifactSha256?: string;
    qualityReport?: string;
  };
  candidates: {
    definiteRemovePredicted: number;
    definiteRemoveTruePositive?: number;
    highRiskAutoDeleted: number;
    annotationEvidence?: string;
  };
  boundaries: {
    evaluated: number;
    usable?: number;
    annotationEvidence?: string;
  };
  correctness: {
    undo: AlphaGateCountEvidence;
    restart: AlphaGateCountEvidence;
    idempotency: AlphaGateCountEvidence;
    revisionConflict: AlphaGateCountEvidence;
    evidence?: string;
  };
  timing?: {
    manualBaselineSeconds: number;
    agentCutActiveSeconds: number;
    operatorIdHash: string;
    evidenceSha256: string;
    evidence: string;
  };
}

export interface AlphaGateManifest {
  schemaVersion: "1.0";
  projects: AlphaGateProjectEvidence[];
}

export interface AlphaGateIssue {
  code: string;
  status: Exclude<AlphaGateMetricStatus, "passed">;
  message: string;
  projectIds?: string[];
}

export interface AlphaGateReport {
  status: AlphaGateStatus;
  metrics: {
    authorizedProjects: { value: number; required: number; status: AlphaGateMetricStatus };
    reviewedAndExportedProjects: { value: number; required: number; status: AlphaGateMetricStatus };
    highRiskAutoDeleted: { value: number; maximum: number; status: AlphaGateMetricStatus };
    definiteRemovePrecision: RatioMetric;
    boundaryUsability: RatioMetric;
    correctness: Record<CorrectnessKind, CorrectnessMetric>;
    medianTimeReduction: {
      pairedProjects: number;
      value?: number;
      minimum: number;
      status: AlphaGateMetricStatus;
    };
    operatorCoverage: {
      distinctOperators: number;
      required: number;
      status: AlphaGateMetricStatus;
    };
  };
  issues: AlphaGateIssue[];
}

interface RatioMetric {
  numerator: number;
  denominator: number;
  value?: number;
  minimum: number;
  status: AlphaGateMetricStatus;
}

interface CorrectnessMetric {
  passed: number;
  evaluated: number;
  coveredProjects: number;
  requiredEvaluations: number;
  status: AlphaGateMetricStatus;
}

const REQUIRED_PROJECTS = 20;
const MINIMUM_DEFINITE_REMOVE_PRECISION = 0.98;
const MINIMUM_BOUNDARY_USABILITY = 0.95;
/**
 * 单项目底线：防止一个候选很多的项目掩盖另一个项目的错删。
 * Gate 原意是「每个真实项目都要可信」，跨项目聚合（sum/sum）允许烂项目被稀释，
 * 故在聚合阈值之上叠加每项目最低线（略低于聚合线，容忍小分母项目的正常波动）。
 */
const MINIMUM_PER_PROJECT_DEFINITE_REMOVE_PRECISION = 0.9;
const MINIMUM_PER_PROJECT_BOUNDARY_USABILITY = 0.8;

/**
 * Gate 要求的 8 类真实口播覆盖（docs/13「数据与试用」）。
 * 仅在凑满 REQUIRED_PROJECTS 个项目后才作为 Gate 门槛强制；manifest 未记录类别时按缺失计。
 */
export const REQUIRED_COVERAGE_CLASSES = [
  "mandarin",
  "accent",
  "code-switch",
  "proper-noun-number",
  "fast-speech",
  "background-music",
  "vfr",
  "screen-recording",
] as const;
export type CoverageClass = typeof REQUIRED_COVERAGE_CLASSES[number];
const MINIMUM_MEDIAN_TIME_REDUCTION = 0.3;
const MINIMUM_DISTINCT_OPERATORS = 5;
const CORRECTNESS_KINDS = ["undo", "restart", "idempotency", "revisionConflict"] as const;
type CorrectnessKind = typeof CORRECTNESS_KINDS[number];

export function evaluateAlphaGate(input: unknown): AlphaGateReport {
  const manifest = parseManifest(input);
  validateProjects(manifest.projects);
  const projects = manifest.projects.filter((project) => project.authorization.confirmed);
  const issues: AlphaGateIssue[] = [];

  const authorizedStatus = projects.length >= REQUIRED_PROJECTS ? "passed" : "insufficient_evidence";
  if (authorizedStatus !== "passed") {
    issues.push(issue(
      "AUTHORIZED_PROJECTS_MISSING",
      authorizedStatus,
      `Alpha Gate requires ${REQUIRED_PROJECTS} authorized projects; found ${projects.length}`,
    ));
  } else {
    // 凑满 20 个项目后，强制 8 类素材全覆盖；避免 20 条同质素材冒充达标。
    const covered = new Set(projects.flatMap((project) => project.coverageClasses ?? []));
    const missingCoverage = REQUIRED_COVERAGE_CLASSES.filter((klass) => !covered.has(klass));
    if (missingCoverage.length > 0) {
      issues.push(issue(
        "SAMPLE_COVERAGE_INCOMPLETE",
        "failed",
        `Alpha Gate requires all ${REQUIRED_COVERAGE_CLASSES.length} coverage classes across ${REQUIRED_PROJECTS} projects; missing: ${missingCoverage.join(", ")}`,
      ));
    }
  }

  const completeProjects = projects.filter((project) =>
    project.reviewCompleted && project.export.succeeded && hasText(project.export.artifactSha256)
      && hasText(project.export.qualityReport),
  );
  const completionStatus = completeProjects.length === projects.length && projects.length >= REQUIRED_PROJECTS
    ? "passed"
    : projects.length >= REQUIRED_PROJECTS ? "failed" : "insufficient_evidence";
  if (completionStatus !== "passed") {
    issues.push(issue(
      "REVIEW_EXPORT_INCOMPLETE",
      completionStatus,
      `Alpha Gate requires ${REQUIRED_PROJECTS}/${REQUIRED_PROJECTS} reviewed and exported projects; found ${completeProjects.length}`,
      projects.filter((project) => !completeProjects.includes(project)).map((project) => project.projectId),
    ));
  }

  const highRiskProjects = projects.filter((project) => project.candidates.highRiskAutoDeleted > 0);
  const highRiskAutoDeleted = sum(projects.map((project) => project.candidates.highRiskAutoDeleted));
  const highRiskStatus = highRiskAutoDeleted === 0 ? "passed" : "failed";
  if (highRiskStatus === "failed") {
    issues.push(issue(
      "HIGH_RISK_AUTO_DELETE",
      highRiskStatus,
      `${highRiskAutoDeleted} high-risk candidates were automatically deleted`,
      highRiskProjects.map((project) => project.projectId),
    ));
  }

  const labeledCandidateProjects = projects.filter((project) =>
    project.candidates.definiteRemoveTruePositive !== undefined
      && hasText(project.candidates.annotationEvidence),
  );
  const definiteRemoveDenominator = sum(labeledCandidateProjects.map((project) =>
    project.candidates.definiteRemovePredicted,
  ));
  const definiteRemoveNumerator = sum(labeledCandidateProjects.map((project) =>
    project.candidates.definiteRemoveTruePositive!,
  ));
  const definiteRemovePrecision = ratio(definiteRemoveNumerator, definiteRemoveDenominator);
  // 每项目底线：任何已标注项目跌破底线即 failed，不被聚合稀释。
  const lowPrecisionProjects = labeledCandidateProjects.filter((project) => {
    const perProject = ratio(project.candidates.definiteRemoveTruePositive!, project.candidates.definiteRemovePredicted);
    return perProject !== undefined && perProject < MINIMUM_PER_PROJECT_DEFINITE_REMOVE_PRECISION;
  });
  const definiteRemoveStatus = lowPrecisionProjects.length > 0
    ? "failed"
    : thresholdStatus(
      definiteRemovePrecision,
      MINIMUM_DEFINITE_REMOVE_PRECISION,
      labeledCandidateProjects.length >= REQUIRED_PROJECTS,
    );
  if (definiteRemoveStatus !== "passed") {
    issues.push(issue(
      lowPrecisionProjects.length > 0
        ? "DEFINITE_REMOVE_PROJECT_BELOW_FLOOR"
        : definiteRemovePrecision === undefined ? "DEFINITE_REMOVE_LABELS_MISSING" : "DEFINITE_REMOVE_PRECISION_LOW",
      definiteRemoveStatus,
      lowPrecisionProjects.length > 0
        ? `${lowPrecisionProjects.length} project(s) fall below the per-project definite_remove precision floor of ${MINIMUM_PER_PROJECT_DEFINITE_REMOVE_PRECISION}`
        : definiteRemovePrecision === undefined
          ? "No auditable definite_remove labels are available"
          : `definite_remove precision is ${formatPercent(definiteRemovePrecision)}`,
      lowPrecisionProjects.map((project) => project.projectId),
    ));
  }

  const labeledBoundaryProjects = projects.filter((project) =>
    project.boundaries.usable !== undefined && hasText(project.boundaries.annotationEvidence),
  );
  const boundaryDenominator = sum(labeledBoundaryProjects.map((project) => project.boundaries.evaluated));
  const boundaryNumerator = sum(labeledBoundaryProjects.map((project) => project.boundaries.usable!));
  const boundaryUsability = ratio(boundaryNumerator, boundaryDenominator);
  // 每项目底线：同 precision，防止单个项目的边界被聚合稀释。
  const lowBoundaryProjects = labeledBoundaryProjects.filter((project) => {
    const perProject = ratio(project.boundaries.usable!, project.boundaries.evaluated);
    return perProject !== undefined && perProject < MINIMUM_PER_PROJECT_BOUNDARY_USABILITY;
  });
  const boundaryStatus = lowBoundaryProjects.length > 0
    ? "failed"
    : thresholdStatus(
      boundaryUsability,
      MINIMUM_BOUNDARY_USABILITY,
      labeledBoundaryProjects.length >= REQUIRED_PROJECTS,
    );
  if (boundaryStatus !== "passed") {
    issues.push(issue(
      lowBoundaryProjects.length > 0
        ? "BOUNDARY_PROJECT_BELOW_FLOOR"
        : boundaryUsability === undefined ? "BOUNDARY_LABELS_MISSING" : "BOUNDARY_USABILITY_LOW",
      boundaryStatus,
      lowBoundaryProjects.length > 0
        ? `${lowBoundaryProjects.length} project(s) fall below the per-project boundary usability floor of ${MINIMUM_PER_PROJECT_BOUNDARY_USABILITY}`
        : boundaryUsability === undefined
          ? "No auditable cut-boundary listening labels are available"
          : `cut-boundary usability is ${formatPercent(boundaryUsability)}`,
      lowBoundaryProjects.map((project) => project.projectId),
    ));
  }

  const correctness = Object.fromEntries(CORRECTNESS_KINDS.map((kind) => {
    const evaluated = sum(projects.map((project) => project.correctness[kind].evaluated));
    const passed = sum(projects.map((project) => project.correctness[kind].passed));
    const failedProjects = projects.filter((project) => {
      const evidence = project.correctness[kind];
      return evidence.evaluated > 0 && evidence.passed < evidence.evaluated;
    });
    const coveredProjects = projects.filter((project) => {
      const evidence = project.correctness[kind];
      return evidence.evaluated > 0 && evidence.passed === evidence.evaluated;
    });
    const status: AlphaGateMetricStatus = failedProjects.length > 0
      ? "failed"
      : projects.length >= REQUIRED_PROJECTS && coveredProjects.length === projects.length
        ? "passed"
        : "insufficient_evidence";
    if (status !== "passed") {
      issues.push(issue(
        status === "failed" ? "CORRECTNESS_FAILURE" : "CORRECTNESS_EVIDENCE_MISSING",
        status,
        `${kind} correctness is ${passed}/${evaluated} across ${coveredProjects.length}/${projects.length} authorized projects; `
          + `${REQUIRED_PROJECTS} project-level passing evaluations are required`,
        projects.filter((project) => {
          const evidence = project.correctness[kind];
          return evidence.passed < evidence.evaluated || evidence.evaluated === 0;
        }).map((project) => project.projectId),
      ));
    }
    return [kind, {
      passed,
      evaluated,
      coveredProjects: coveredProjects.length,
      requiredEvaluations: REQUIRED_PROJECTS,
      status,
    }];
  })) as Record<CorrectnessKind, CorrectnessMetric>;

  const timingProjects = projects.filter((project) => project.timing !== undefined && hasText(project.timing.evidence));
  const reductions = timingProjects.map((project) => {
    const timing = project.timing!;
    return (timing.manualBaselineSeconds - timing.agentCutActiveSeconds) / timing.manualBaselineSeconds;
  }).sort((left, right) => left - right);
  const medianReduction = median(reductions);
  const timingStatus = thresholdStatus(
    medianReduction,
    MINIMUM_MEDIAN_TIME_REDUCTION,
    timingProjects.length >= REQUIRED_PROJECTS,
  );
  if (timingStatus !== "passed") {
    issues.push(issue(
      medianReduction === undefined ? "TIMING_PAIRS_MISSING" : "TIME_REDUCTION_LOW",
      timingStatus,
      medianReduction === undefined
        ? "No paired manual and AgentCut active-time measurements are available"
        : `Median active-time reduction is ${formatPercent(medianReduction)}`,
    ));
  }
  const distinctOperators = new Set(timingProjects.map((project) => project.timing!.operatorIdHash)).size;
  const operatorCoverageStatus: AlphaGateMetricStatus = timingProjects.length < REQUIRED_PROJECTS
    ? "insufficient_evidence"
    : distinctOperators >= MINIMUM_DISTINCT_OPERATORS ? "passed" : "failed";
  if (operatorCoverageStatus !== "passed") {
    issues.push(issue(
      "OPERATOR_COVERAGE_INCOMPLETE",
      operatorCoverageStatus,
      `Alpha Gate requires ${MINIMUM_DISTINCT_OPERATORS} distinct paired-timing operators; found ${distinctOperators}`,
    ));
  }

  return {
    status: overallStatus(issues),
    metrics: {
      authorizedProjects: { value: projects.length, required: REQUIRED_PROJECTS, status: authorizedStatus },
      reviewedAndExportedProjects: {
        value: completeProjects.length,
        required: REQUIRED_PROJECTS,
        status: completionStatus,
      },
      highRiskAutoDeleted: { value: highRiskAutoDeleted, maximum: 0, status: highRiskStatus },
      definiteRemovePrecision: {
        numerator: definiteRemoveNumerator,
        denominator: definiteRemoveDenominator,
        ...(definiteRemovePrecision === undefined ? {} : { value: definiteRemovePrecision }),
        minimum: MINIMUM_DEFINITE_REMOVE_PRECISION,
        status: definiteRemoveStatus,
      },
      boundaryUsability: {
        numerator: boundaryNumerator,
        denominator: boundaryDenominator,
        ...(boundaryUsability === undefined ? {} : { value: boundaryUsability }),
        minimum: MINIMUM_BOUNDARY_USABILITY,
        status: boundaryStatus,
      },
      correctness,
      medianTimeReduction: {
        pairedProjects: timingProjects.length,
        ...(medianReduction === undefined ? {} : { value: medianReduction }),
        minimum: MINIMUM_MEDIAN_TIME_REDUCTION,
        status: timingStatus,
      },
      operatorCoverage: {
        distinctOperators,
        required: MINIMUM_DISTINCT_OPERATORS,
        status: operatorCoverageStatus,
      },
    },
    issues,
  };
}

function parseManifest(input: unknown): AlphaGateManifest {
  if (!isRecord(input) || input.schemaVersion !== "1.0" || !Array.isArray(input.projects)) {
    throw new AlphaGateInputError("INVALID_MANIFEST", "Expected schemaVersion 1.0 and a projects array");
  }
  return input as unknown as AlphaGateManifest;
}

function validateProjects(projects: AlphaGateProjectEvidence[]): void {
  const seen = new Set<string>();
  const sourceOwners = new Map<string, string>();
  const allowedCoverage = new Set<string>(REQUIRED_COVERAGE_CLASSES);
  for (const project of projects) {
    if (!isRecord(project) || !hasText(project.projectId)) {
      throw new AlphaGateInputError("INVALID_PROJECT", "Every project requires a non-empty projectId");
    }
    if (seen.has(project.projectId)) {
      throw new AlphaGateInputError("DUPLICATE_PROJECT", `Duplicate projectId: ${project.projectId}`);
    }
    seen.add(project.projectId);
    if (!isRecord(project.authorization)
      || typeof project.authorization.confirmed !== "boolean"
      || !hasText(project.authorization.basis)
      || !hasText(project.authorization.evidence)
      || !/^sha256:[a-f0-9]{64}$/i.test(String(project.authorization.sha256))) {
      throw new AlphaGateInputError(
        "INVALID_AUTHORIZATION",
        `Project ${project.projectId} requires confirmed, basis, evidence and evidence SHA-256 authorization metadata`,
      );
    }
    if (project.coverageClasses !== undefined) {
      if (!Array.isArray(project.coverageClasses)
        || project.coverageClasses.some((klass) => typeof klass !== "string" || !allowedCoverage.has(klass))) {
        throw new AlphaGateInputError(
          "INVALID_COVERAGE_CLASS",
          `Project ${project.projectId} has coverageClasses outside the allowed set (${REQUIRED_COVERAGE_CLASSES.join(", ")})`,
        );
      }
    }
    if (!/^sha256:[a-f0-9]{64}$/i.test(project.sourceSha256)) {
      throw new AlphaGateInputError("INVALID_HASH", `Project ${project.projectId} has an invalid sourceSha256`);
    }
    const normalizedSourceSha256 = project.sourceSha256.toLowerCase();
    const existingSourceOwner = sourceOwners.get(normalizedSourceSha256);
    if (existingSourceOwner) {
      throw new AlphaGateInputError(
        "DUPLICATE_SOURCE",
        `Source media ${normalizedSourceSha256} is registered by both ${existingSourceOwner} and ${project.projectId}`,
      );
    }
    sourceOwners.set(normalizedSourceSha256, project.projectId);
    validateCount(project.candidates.definiteRemovePredicted, project.projectId, "definiteRemovePredicted");
    validateOptionalCount(project.candidates.definiteRemoveTruePositive, project.projectId, "definiteRemoveTruePositive");
    validateCount(project.candidates.highRiskAutoDeleted, project.projectId, "highRiskAutoDeleted");
    if (
      project.candidates.definiteRemoveTruePositive !== undefined
      && project.candidates.definiteRemoveTruePositive > project.candidates.definiteRemovePredicted
    ) {
      throw new AlphaGateInputError(
        "INVALID_COUNT",
        `Project ${project.projectId} has true-positive definite removals greater than predicted removals`,
      );
    }
    validateCount(project.boundaries.evaluated, project.projectId, "boundaries.evaluated");
    validateOptionalCount(project.boundaries.usable, project.projectId, "boundaries.usable");
    if (project.boundaries.usable !== undefined && project.boundaries.usable > project.boundaries.evaluated) {
      throw new AlphaGateInputError(
        "INVALID_COUNT",
        `Project ${project.projectId} has usable boundaries greater than evaluated boundaries`,
      );
    }
    for (const kind of CORRECTNESS_KINDS) {
      const evidence = project.correctness[kind];
      validateCount(evidence.evaluated, project.projectId, `${kind}.evaluated`);
      validateCount(evidence.passed, project.projectId, `${kind}.passed`);
      if (evidence.passed > evidence.evaluated) {
        throw new AlphaGateInputError(
          "INVALID_COUNT",
          `Project ${project.projectId} has ${kind} passes greater than evaluations`,
        );
      }
    }
    if (project.timing) {
      if (!Number.isFinite(project.timing.manualBaselineSeconds) || project.timing.manualBaselineSeconds <= 0) {
        throw new AlphaGateInputError(
          "INVALID_TIMING",
          `Project ${project.projectId} requires positive manualBaselineSeconds`,
        );
      }
      if (!Number.isFinite(project.timing.agentCutActiveSeconds) || project.timing.agentCutActiveSeconds < 0) {
        throw new AlphaGateInputError(
          "INVALID_TIMING",
          `Project ${project.projectId} requires non-negative agentCutActiveSeconds`,
        );
      }
      if (!/^sha256:[a-f0-9]{64}$/i.test(project.timing.operatorIdHash)
        || !/^sha256:[a-f0-9]{64}$/i.test(project.timing.evidenceSha256)) {
        throw new AlphaGateInputError(
          "INVALID_TIMING",
          `Project ${project.projectId} requires operator and baseline-evidence SHA-256 commitments`,
        );
      }
    }
  }
}

function validateOptionalCount(value: number | undefined, projectId: string, field: string): void {
  if (value !== undefined) validateCount(value, projectId, field);
}

function validateCount(value: number, projectId: string, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AlphaGateInputError("INVALID_COUNT", `Project ${projectId} has invalid ${field}`);
  }
}

function thresholdStatus(
  value: number | undefined,
  minimum: number,
  enoughEvidence: boolean,
): AlphaGateMetricStatus {
  if (value !== undefined && value < minimum) return "failed";
  if (value === undefined || !enoughEvidence) return "insufficient_evidence";
  return "passed";
}

function overallStatus(issues: AlphaGateIssue[]): AlphaGateStatus {
  if (issues.some((candidate) => candidate.status === "failed")) return "failed";
  if (issues.some((candidate) => candidate.status === "insufficient_evidence")) {
    return "insufficient_evidence";
  }
  return "passed";
}

function issue(
  code: string,
  status: Exclude<AlphaGateMetricStatus, "passed">,
  message: string,
  projectIds?: string[],
): AlphaGateIssue {
  return {
    code,
    status,
    message,
    ...(projectIds && projectIds.length > 0 ? { projectIds } : {}),
  };
}

function ratio(numerator: number, denominator: number): number | undefined {
  return denominator === 0 ? undefined : numerator / denominator;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[middle]!
    : (values[middle - 1]! + values[middle]!) / 2;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
