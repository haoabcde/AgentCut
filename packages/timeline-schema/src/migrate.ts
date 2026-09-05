import { assertProjectDocument } from "./validate.js";
import type { AgentCutProjectDocument } from "./types.js";

export const CURRENT_SCHEMA_VERSION = "0.1.0" as const;

export type MigrationCategory =
  | "preserved"
  | "normalized"
  | "defaulted"
  | "dropped"
  | "manual_action_required";

export interface MigrationReportEntry {
  category: MigrationCategory;
  path: string;
  message: string;
}

interface MigrationBase {
  sourceVersion: string;
  targetVersion: typeof CURRENT_SCHEMA_VERSION;
  dryRun: boolean;
  report: MigrationReportEntry[];
}

export type MigrationResult =
  | (MigrationBase & {
      status: "ready" | "migrated";
      document: AgentCutProjectDocument;
    })
  | (MigrationBase & {
      status: "read_only";
      reason: string;
    });

export class MigrationError extends Error {
  constructor(
    readonly code: "INVALID_VERSION" | "MIGRATION_FAILED",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

export function migrateProjectDocument(
  input: unknown,
  options: { dryRun?: boolean } = {},
): MigrationResult {
  const dryRun = options.dryRun ?? false;
  const source = asRecord(input, "/");
  const sourceVersion = source.schemaVersion;
  if (typeof sourceVersion !== "string" || !parseSemver(sourceVersion)) {
    throw new MigrationError("INVALID_VERSION", "Project schemaVersion must be a valid semver string");
  }

  if (sourceVersion === CURRENT_SCHEMA_VERSION) {
    const document = structuredClone(input);
    assertProjectDocument(document);
    return {
      status: "ready",
      sourceVersion,
      targetVersion: CURRENT_SCHEMA_VERSION,
      dryRun,
      document,
      report: [{ category: "preserved", path: "/", message: "Project already uses schema 0.1.0" }],
    };
  }

  if (sourceVersion === "0.0.0") {
    return migrateLegacyZero(source, dryRun);
  }

  const parsed = parseSemver(sourceVersion)!;
  const reason = parsed.major > 0
    ? `Schema major ${parsed.major} is not supported by this runtime`
    : `Schema ${sourceVersion} is newer than or unrelated to the supported migration path`;
  return {
    status: "read_only",
    sourceVersion,
    targetVersion: CURRENT_SCHEMA_VERSION,
    dryRun,
    reason,
    report: [{
      category: "manual_action_required",
      path: "/schemaVersion",
      message: `${reason}; project must not be overwritten`,
    }],
  };
}

function migrateLegacyZero(source: Record<string, unknown>, dryRun: boolean): MigrationResult {
  const migrated = structuredClone(source);
  const report: MigrationReportEntry[] = [{
    category: "normalized",
    path: "/schemaVersion",
    message: "Updated schemaVersion from 0.0.0 to 0.1.0",
  }];
  migrated.schemaVersion = CURRENT_SCHEMA_VERSION;

  defaultArray(migrated, "styleSpecs", report);
  defaultArray(migrated, "artifacts", report);
  defaultArray(migrated, "exportPresets", report);
  defaultArray(migrated, "versions", report);

  if (migrated.history === undefined) {
    const project = asRecord(migrated.project, "/project");
    const revision = project.revision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
      throw new MigrationError(
        "MIGRATION_FAILED",
        "Legacy project revision must be a non-negative safe integer",
      );
    }
    migrated.history = { headRevision: revision, records: [] };
    report.push({
      category: "defaulted",
      path: "/history",
      message: "Created empty history at the legacy project revision",
    });
  }

  try {
    assertProjectDocument(migrated);
  } catch (error) {
    throw new MigrationError(
      "MIGRATION_FAILED",
      "Migrated project does not satisfy schema 0.1.0",
      { cause: error instanceof Error ? error.message : String(error), report },
    );
  }
  report.push({
    category: "preserved",
    path: "/project,/assets,/sequences",
    message: "Core project, asset and timeline data were preserved",
  });
  return {
    status: "migrated",
    sourceVersion: "0.0.0",
    targetVersion: CURRENT_SCHEMA_VERSION,
    dryRun,
    document: migrated,
    report,
  };
}

function defaultArray(
  document: Record<string, unknown>,
  key: string,
  report: MigrationReportEntry[],
): void {
  if (document[key] !== undefined) return;
  document[key] = [];
  report.push({
    category: "defaulted",
    path: `/${key}`,
    message: `Created empty ${key} collection`,
  });
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationError("MIGRATION_FAILED", `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseSemver(version: string): { major: number; minor: number; patch: number } | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}
