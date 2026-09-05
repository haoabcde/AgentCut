import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  alphaEvidenceBundleFileSha256,
  parseAlphaEvidenceBundle,
  type AlphaEvidenceBundle,
} from "./bundle.js";
import {
  AlphaGateInputError,
  evaluateAlphaGate,
  type AlphaGateManifest,
  type AlphaGateProjectEvidence,
} from "./gate.js";
import { assertAlphaAuthorizationEvidence } from "./authorization.js";

export interface MaterializeAlphaGateManifestOptions {
  baseDirectory: string;
}

export async function materializeAlphaGateManifest(
  input: unknown,
  options: MaterializeAlphaGateManifestOptions,
): Promise<AlphaGateManifest> {
  evaluateAlphaGate(input);
  const manifest = structuredClone(input) as AlphaGateManifest;
  manifest.projects = await Promise.all(manifest.projects.map(async (project) => {
    await validateAuthorizationEvidence(project, options.baseDirectory);
    if (!project.evidenceBundle) return project;
    const descriptor = project.evidenceBundle;
    validateDescriptor(project.projectId, descriptor);
    const bundlePath = resolveInside(options.baseDirectory, descriptor.path);
    const serialized = await readFile(bundlePath, "utf8");
    const actualFileSha256 = alphaEvidenceBundleFileSha256(serialized);
    if (actualFileSha256 !== descriptor.sha256) {
      throw new AlphaGateInputError(
        "BUNDLE_FILE_HASH_MISMATCH",
        `Project ${project.projectId} evidence bundle file hash mismatch: expected ${descriptor.sha256}, got ${actualFileSha256}`,
      );
    }
    const bundle = parseAlphaEvidenceBundle(serialized);
    assertBinding(project, descriptor.canonicalProjectId, descriptor.projectRevision, bundle);
    return materializeProject(project, bundle);
  }));
  return manifest;
}

async function validateAuthorizationEvidence(
  project: AlphaGateProjectEvidence,
  baseDirectory: string,
): Promise<void> {
  if (!project.authorization.confirmed) return;
  const reference = project.authorization.evidence;
  if (isAbsolute(reference)) {
    throw new AlphaGateInputError(
      "AUTHORIZATION_EVIDENCE_INVALID",
      `Project ${project.projectId} authorization evidence must be relative to the manifest directory`,
    );
  }
  try {
    const actualSha256 = await assertAlphaAuthorizationEvidence({
      cohortId: project.projectId,
      sourceSha256: project.sourceSha256,
      path: resolve(baseDirectory, reference),
      reference,
    });
    if (actualSha256 !== project.authorization.sha256.toLowerCase()) {
      throw new Error(
        `Project ${project.projectId} authorization evidence hash mismatch: expected ${project.authorization.sha256}, got ${actualSha256}`,
      );
    }
  } catch (error) {
    throw new AlphaGateInputError(
      "AUTHORIZATION_EVIDENCE_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function materializeProject(
  project: AlphaGateProjectEvidence,
  bundle: AlphaEvidenceBundle,
): AlphaGateProjectEvidence {
  const { timing: _unverifiedTiming, ...verifiedProject } = project;
  const definiteRemove = bundle.candidates.filter((candidate) => candidate.decision === "definite_remove");
  const candidateLabelsComplete = definiteRemove.every((candidate) => candidate.label !== null);
  const boundaryLabelsComplete = bundle.boundaries.every((boundary) => boundary.usable !== null);
  const reviewCompleted = bundle.review.projectCompleted && bundle.progress.complete;
  const correctnessRun = [...bundle.events].reverse().find((event) =>
    event.targetType === "correctness" && event.correctnessResult !== undefined,
  );
  const correctnessFor = (kind: "undo" | "restart" | "idempotency" | "revisionConflict") => ({
    evaluated: correctnessRun ? 1 : 0,
    passed: correctnessRun?.correctnessResult?.checks[kind].passed ? 1 : 0,
  });
  const correctness: AlphaGateProjectEvidence["correctness"] = {
    undo: correctnessFor("undo"),
    restart: correctnessFor("restart"),
    idempotency: correctnessFor("idempotency"),
    revisionConflict: correctnessFor("revisionConflict"),
  };
  return {
    ...verifiedProject,
    reviewCompleted,
    export: bundle.export?.qualityPassed ? {
      succeeded: true,
      artifactSha256: bundle.export.outputSha256,
      qualityReport: project.evidenceBundle!.path,
    } : { succeeded: false },
    candidates: {
      definiteRemovePredicted: definiteRemove.length,
      ...(candidateLabelsComplete ? {
        definiteRemoveTruePositive: definiteRemove.filter((candidate) => candidate.label === "true_positive").length,
        annotationEvidence: project.evidenceBundle!.path,
      } : {}),
      highRiskAutoDeleted: bundle.derived.highRiskAutoDeletedCandidateIds.length,
    },
    boundaries: {
      evaluated: bundle.boundaries.length,
      ...(boundaryLabelsComplete ? {
        usable: bundle.boundaries.filter((boundary) => boundary.usable === true).length,
        annotationEvidence: project.evidenceBundle!.path,
      } : {}),
    },
    correctness: {
      ...correctness,
      ...(correctnessRun ? { evidence: project.evidenceBundle!.path } : {}),
    },
    ...(bundle.timing?.complete ? {
      timing: {
        manualBaselineSeconds: bundle.timing.manualBaselineSeconds,
        agentCutActiveSeconds: bundle.timing.agentCutActiveSeconds,
        operatorIdHash: bundle.timing.operatorIdHash,
        evidenceSha256: bundle.timing.evidenceSha256,
        evidence: project.evidenceBundle!.path,
      },
    } : {}),
  };
}

function validateDescriptor(
  projectId: string,
  descriptor: NonNullable<AlphaGateProjectEvidence["evidenceBundle"]>,
): void {
  if (!requiredText(descriptor.path) || isAbsolute(descriptor.path)) {
    throw new AlphaGateInputError("INVALID_BUNDLE_REFERENCE", `Project ${projectId} requires a relative bundle path`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(descriptor.sha256)) {
    throw new AlphaGateInputError("INVALID_BUNDLE_REFERENCE", `Project ${projectId} has an invalid bundle file hash`);
  }
  if (!requiredText(descriptor.canonicalProjectId)) {
    throw new AlphaGateInputError("INVALID_BUNDLE_REFERENCE", `Project ${projectId} requires a canonical project ID`);
  }
  if (!Number.isSafeInteger(descriptor.projectRevision) || descriptor.projectRevision < 0) {
    throw new AlphaGateInputError("INVALID_BUNDLE_REFERENCE", `Project ${projectId} has an invalid bundle revision`);
  }
}

function resolveInside(baseDirectory: string, path: string): string {
  const base = resolve(baseDirectory);
  const target = resolve(base, path);
  const pathFromBase = relative(base, target);
  if (pathFromBase === ".." || pathFromBase.startsWith(`..${sep}`) || isAbsolute(pathFromBase)) {
    throw new AlphaGateInputError("INVALID_BUNDLE_REFERENCE", `Evidence bundle escapes manifest directory: ${path}`);
  }
  return target;
}

function assertBinding(
  project: AlphaGateProjectEvidence,
  canonicalProjectId: string,
  expectedRevision: number,
  bundle: AlphaEvidenceBundle,
): void {
  if (bundle.project.id !== canonicalProjectId
    || bundle.project.sourceSha256 !== project.sourceSha256
    || bundle.project.revision !== expectedRevision) {
    throw new AlphaGateInputError(
      "BUNDLE_BINDING_MISMATCH",
      `Project ${project.projectId} bundle binding does not match manifest project/revision/source hash`,
    );
  }
}

function requiredText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
