import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ProjectStore } from "@agentcut/project-store";
import { TALKING_HEAD_EXTENSION_VALIDATORS } from "@agentcut/host-extensions";
import { createAlphaAuditDraft, type AlphaAuditDraft } from "./audit.js";
import {
  alphaEvidenceBundleFileSha256,
  createAlphaEvidenceBundle,
  serializeAlphaEvidenceBundle,
  type AlphaEvidenceBundle,
} from "./bundle.js";
import { verifyAlphaProjectCorrectness } from "./correctness.js";
import { AlphaEvidenceStore } from "./evidence.js";
import type { AlphaGateManifest, AlphaGateProjectEvidence, CoverageClass } from "./gate.js";
import { REQUIRED_COVERAGE_CLASSES } from "./gate.js";
import { materializeAlphaGateManifest } from "./manifest-evidence.js";
import { assertAlphaAuthorizationEvidence } from "./authorization.js";

export interface AlphaCollectCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export async function runAlphaCollectCli(arguments_: string[], io: AlphaCollectCliIo): Promise<number> {
  try {
    const parsed = parseArguments(arguments_);
    const projectRoot = resolve(parsed.projectRoot);
    const manifestPath = resolve(parsed.manifestPath);
    const manifestDirectory = dirname(manifestPath);
    const authorizationPath = resolve(manifestDirectory, parsed.authorizationEvidence);
    const before = readAudit(join(projectRoot, "agentcut.sqlite"));
    const authorizationSha256 = await assertAlphaAuthorizationEvidence({
      cohortId: parsed.cohortId,
      sourceSha256: before.project.sourceSha256,
      path: authorizationPath,
      reference: parsed.authorizationEvidence,
    });

    const initialManifestBytes = await readFile(manifestPath, "utf8");
    const manifestValue = parseManifest(initialManifestBytes);
    await materializeAlphaGateManifest(manifestValue, { baseDirectory: manifestDirectory });
    assertRegistrationCompatible(manifestValue, before, parsed, manifestDirectory, authorizationPath);

    const correctnessRun = await verifyAlphaProjectCorrectness({
      databasePath: join(projectRoot, "agentcut.sqlite"),
      requestId: `alpha-collect:${parsed.cohortId}:r${before.project.revision}:correctness-v1`,
      projectId: before.project.id,
      projectRevision: before.project.revision,
      sourceSha256: before.project.sourceSha256,
    });
    const after = readAudit(join(projectRoot, "agentcut.sqlite"));
    assertSameAuditBinding(before, after);
    const evidenceStore = AlphaEvidenceStore.open(join(projectRoot, "alpha-evidence.sqlite"));
    let bundle: AlphaEvidenceBundle;
    try {
      const evidence = evidenceStore.recordCorrectnessRun(after, correctnessRun);
      bundle = createAlphaEvidenceBundle(evidence);
    } finally {
      evidenceStore.close();
    }

    const serializedBundle = serializeAlphaEvidenceBundle(bundle);
    const bundleFileSha256 = alphaEvidenceBundleFileSha256(serializedBundle);
    const bundleFileName = `${parsed.cohortId}-r${bundle.project.revision}-${bundleFileSha256.slice(7, 19)}.evidence.json`;
    const bundlePath = join(manifestDirectory, "bundles", bundleFileName);
    await publishAlphaContentAddressedFile(bundlePath, serializedBundle);

    const descriptor = {
      path: portablePath(relative(manifestDirectory, bundlePath)),
      sha256: bundleFileSha256,
      canonicalProjectId: bundle.project.id,
      projectRevision: bundle.project.revision,
    };
    const nextManifest = upsertProject(manifestValue, parsed, bundle, descriptor, authorizationSha256);
    await materializeAlphaGateManifest(nextManifest, { baseDirectory: manifestDirectory });
    const nextManifestBytes = `${JSON.stringify(nextManifest, null, 2)}\n`;
    if (nextManifestBytes !== initialManifestBytes) {
      await commitAlphaManifestIfUnchanged(manifestPath, initialManifestBytes, nextManifestBytes);
    }

    io.stdout(
      `Registered ${parsed.cohortId} revision ${bundle.project.revision} in ${manifestPath} `
      + `with ${descriptor.path} (${bundleFileSha256})\n`,
    );
    return 0;
  } catch (error) {
    io.stderr(`Alpha collect input error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

export async function commitAlphaManifestIfUnchanged(
  manifestPath: string,
  initialBytes: string,
  nextBytes: string,
): Promise<void> {
  const temporaryPath = join(dirname(manifestPath), `.${randomUUID()}.alpha-collect-manifest.tmp`);
  await writeFile(temporaryPath, nextBytes, { encoding: "utf8", flag: "wx" });
  try {
    const currentBytes = await readFile(manifestPath, "utf8");
    if (currentBytes !== initialBytes) {
      throw new Error("Alpha Gate manifest changed during collection; bundle was preserved and registration was not overwritten");
    }
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

interface ParsedArguments {
  projectRoot: string;
  manifestPath: string;
  cohortId: string;
  authorizationBasis: string;
  authorizationEvidence: string;
  coverageClasses?: CoverageClass[];
}

function parseArguments(arguments_: string[]): ParsedArguments {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const supported = new Set([
    "--manifest",
    "--cohort-id",
    "--authorization-basis",
    "--authorization-evidence",
    "--coverage-classes",
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--") continue;
    if (argument.startsWith("--")) {
      if (!supported.has(argument)) throw new Error(`Unknown alpha:collect option: ${argument}`);
      const value = arguments_[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (values.has(argument)) throw new Error(`${argument} may only be provided once`);
      values.set(argument, value);
    } else {
      positionals.push(argument);
    }
  }
  if (positionals.length !== 1) throw new Error("alpha:collect requires exactly one project directory");
  const cohortId = requiredOption(values, "--cohort-id");
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(cohortId)) {
    throw new Error("--cohort-id must use 1-100 lowercase letters, numbers, dots, underscores or hyphens");
  }
  const authorizationEvidence = requiredOption(values, "--authorization-evidence");
  if (isAbsolute(authorizationEvidence)) {
    throw new Error("--authorization-evidence must be relative to the manifest directory");
  }
  const coverageRaw = values.get("--coverage-classes");
  const coverageClasses = coverageRaw === undefined
    ? undefined
    : parseCoverageClasses(coverageRaw);
  return {
    projectRoot: positionals[0]!,
    manifestPath: values.get("--manifest") ?? "benchmarks/alpha-gate/manifest.json",
    cohortId,
    authorizationBasis: requiredOption(values, "--authorization-basis"),
    authorizationEvidence: portablePath(authorizationEvidence),
    ...(coverageClasses ? { coverageClasses } : {}),
  };
}

function parseCoverageClasses(raw: string): CoverageClass[] {
  const allowed = new Set<string>(REQUIRED_COVERAGE_CLASSES);
  const classes = raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  if (classes.length === 0) throw new Error("--coverage-classes must list at least one class");
  const unknown = classes.filter((item) => !allowed.has(item));
  if (unknown.length > 0) {
    throw new Error(`--coverage-classes has unknown classes: ${unknown.join(", ")} (allowed: ${REQUIRED_COVERAGE_CLASSES.join(", ")})`);
  }
  return [...new Set(classes)].sort() as CoverageClass[];
}

function requiredOption(values: Map<string, string>, option: string): string {
  const value = values.get(option)?.trim();
  if (!value) throw new Error(`alpha:collect requires ${option} <value>`);
  return value;
}

function parseManifest(source: string): AlphaGateManifest {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Alpha Gate manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value as { schemaVersion?: unknown }).schemaVersion !== "1.0"
    || !Array.isArray((value as { projects?: unknown }).projects)) {
    throw new Error("Alpha Gate manifest must use schemaVersion 1.0 and contain projects");
  }
  return value as AlphaGateManifest;
}

function readAudit(databasePath: string): AlphaAuditDraft {
  const store = ProjectStore.open(databasePath,
    { extensionValidators: TALKING_HEAD_EXTENSION_VALIDATORS });
  try {
    return createAlphaAuditDraft(store.snapshot(), store.listRecords());
  } finally {
    store.close();
  }
}

function assertRegistrationCompatible(
  manifest: AlphaGateManifest,
  draft: AlphaAuditDraft,
  parsed: ParsedArguments,
  manifestDirectory: string,
  authorizationPath: string,
): void {
  const duplicateSource = manifest.projects.find((project) =>
    project.sourceSha256.toLowerCase() === draft.project.sourceSha256.toLowerCase()
      && project.projectId !== parsed.cohortId,
  );
  if (duplicateSource) {
    throw new Error(
      `Source ${draft.project.sourceSha256} is already registered as ${duplicateSource.projectId}; one source cannot count twice`,
    );
  }
  const existing = manifest.projects.find((project) => project.projectId === parsed.cohortId);
  if (!existing) return;
  if (existing.sourceSha256.toLowerCase() !== draft.project.sourceSha256.toLowerCase()) {
    throw new Error(`Cohort ID ${parsed.cohortId} is already bound to another source hash`);
  }
  const existingAuthorizationPaths = [
    resolve(manifestDirectory, existing.authorization.evidence),
    resolve(existing.authorization.evidence),
  ];
  if (!existing.authorization.confirmed
    || existing.authorization.basis !== parsed.authorizationBasis
    || !existingAuthorizationPaths.includes(authorizationPath)) {
    throw new Error(`Cohort ID ${parsed.cohortId} has different authorization evidence; refusing silent replacement`);
  }
  if (existing.evidenceBundle
    && existing.evidenceBundle.canonicalProjectId !== draft.project.id) {
    throw new Error(`Cohort ID ${parsed.cohortId} is already bound to another canonical project`);
  }
}

function assertSameAuditBinding(before: AlphaAuditDraft, after: AlphaAuditDraft): void {
  if (after.project.id !== before.project.id
    || after.project.revision !== before.project.revision
    || after.project.sourceSha256 !== before.project.sourceSha256) {
    throw new Error("Project changed while Alpha collection was running; evidence was not registered");
  }
}

export async function publishAlphaContentAddressedFile(
  outputPath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = join(dirname(outputPath), `.${randomUUID()}.alpha-collect-bundle.tmp`);
  await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
  try {
    try {
      await link(temporaryPath, outputPath);
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      const existing = await readFile(outputPath, "utf8");
      if (existing !== content) {
        throw new Error(`Content-addressed Alpha bundle collision at ${outputPath}`);
      }
    }
  } catch (error) {
    await unlink(temporaryPath);
    throw error;
  }
  await unlink(temporaryPath);
}

function upsertProject(
  manifest: AlphaGateManifest,
  parsed: ParsedArguments,
  bundle: AlphaEvidenceBundle,
  descriptor: NonNullable<AlphaGateProjectEvidence["evidenceBundle"]>,
  authorizationSha256: string,
): AlphaGateManifest {
  const existingIndex = manifest.projects.findIndex((project) => project.projectId === parsed.cohortId);
  const existing = existingIndex >= 0 ? manifest.projects[existingIndex] : undefined;
  const nextProject: AlphaGateProjectEvidence = existing ? {
    ...existing,
    evidenceBundle: descriptor,
    authorization: {
      ...existing.authorization,
      sha256: authorizationSha256,
    },
    ...(parsed.coverageClasses ? { coverageClasses: parsed.coverageClasses } : {}),
  } : {
    projectId: parsed.cohortId,
    sourceSha256: bundle.project.sourceSha256,
    evidenceBundle: descriptor,
    ...(parsed.coverageClasses ? { coverageClasses: parsed.coverageClasses } : {}),
    authorization: {
      confirmed: true,
      basis: parsed.authorizationBasis,
      evidence: parsed.authorizationEvidence,
      sha256: authorizationSha256,
    },
    reviewCompleted: false,
    export: { succeeded: false },
    candidates: {
      definiteRemovePredicted: bundle.candidates.filter((candidate) => candidate.decision === "definite_remove").length,
      highRiskAutoDeleted: bundle.derived.highRiskAutoDeletedCandidateIds.length,
    },
    boundaries: { evaluated: bundle.boundaries.length },
    correctness: {
      undo: { evaluated: 0, passed: 0 },
      restart: { evaluated: 0, passed: 0 },
      idempotency: { evaluated: 0, passed: 0 },
      revisionConflict: { evaluated: 0, passed: 0 },
    },
  };
  const projects = [...manifest.projects];
  if (existingIndex >= 0) projects[existingIndex] = nextProject;
  else projects.push(nextProject);
  return { schemaVersion: "1.0", projects };
}

function portablePath(value: string): string {
  return value.split(sep).join("/");
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
