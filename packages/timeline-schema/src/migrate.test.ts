import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MigrationError, migrateProjectDocument } from "./migrate.js";
import { validateProjectDocument } from "./validate.js";

const legacyUrl = new URL("../fixtures/legacy-project-0.0.json", import.meta.url);
const currentUrl = new URL("../fixtures/minimal-project.json", import.meta.url);

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8"));
}

describe("project schema migrations", () => {
  it("migrates the legacy fixture without mutating the source", () => {
    const legacy = readJson(legacyUrl);
    const before = structuredClone(legacy);
    const result = migrateProjectDocument(legacy);

    expect(legacy).toEqual(before);
    expect(result.status).toBe("migrated");
    if (result.status !== "migrated") throw new Error("Expected a migrated document");
    expect(result.document.schemaVersion).toBe("0.1.0");
    expect(result.document.artifacts).toEqual([]);
    expect(result.document.history).toEqual({ headRevision: 0, records: [] });
    expect(validateProjectDocument(result.document)).toEqual({ valid: true, errors: [] });
    expect(result.report.map((entry) => entry.category)).toEqual(
      expect.arrayContaining(["normalized", "defaulted", "preserved"]),
    );
  });

  it("is idempotent for a current document and supports dry-run", () => {
    const current = readJson(currentUrl);
    const result = migrateProjectDocument(current, { dryRun: true });
    expect(result.status).toBe("ready");
    expect(result.dryRun).toBe(true);
    if (result.status !== "ready") throw new Error("Expected a ready document");
    expect(result.document).toEqual(current);
    expect(result.document).not.toBe(current);
  });

  it("opens unknown major and newer versions in read-only mode", () => {
    for (const schemaVersion of ["1.0.0", "0.2.0"]) {
      const unknown = readJson(currentUrl) as Record<string, unknown>;
      unknown.schemaVersion = schemaVersion;
      const result = migrateProjectDocument(unknown);
      expect(result.status).toBe("read_only");
      if (result.status !== "read_only") throw new Error("Expected read-only protection");
      expect(result.reason).toContain("Schema");
      expect(result.report).toEqual(expect.arrayContaining([
        expect.objectContaining({ category: "manual_action_required" }),
      ]));
    }
  });

  it("reports invalid versions and failed migrations without altering input", () => {
    const invalidVersion = { schemaVersion: "banana" };
    expect(() => migrateProjectDocument(invalidVersion)).toThrowError(
      expect.objectContaining({ code: "INVALID_VERSION" }),
    );

    const invalidLegacy = readJson(legacyUrl) as Record<string, any>;
    invalidLegacy.sequences[0].tracks[0].clips[0].assetId = "asset_missing";
    const before = structuredClone(invalidLegacy);
    expect(() => migrateProjectDocument(invalidLegacy)).toThrowError(MigrationError);
    expect(invalidLegacy).toEqual(before);
  });
});
