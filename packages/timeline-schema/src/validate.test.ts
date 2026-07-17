import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateProjectDocument } from "./validate.js";

const fixtureUrl = new URL("../fixtures/minimal-project.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as unknown;

describe("timeline project schema", () => {
  it("accepts the executable V0.1 golden fixture", () => {
    expect(validateProjectDocument(fixture)).toEqual({ valid: true, errors: [] });
  });

  it("rejects fractional time values", () => {
    const invalid = structuredClone(fixture) as Record<string, any>;
    invalid.sequences[0].tracks[0].clips[0].timelineRange.start.value = 0.5;
    const result = validateProjectDocument(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.keyword === "type")).toBe(true);
  });

  it("rejects dangling references and revision drift", () => {
    const invalid = structuredClone(fixture) as Record<string, any>;
    invalid.sequences[0].tracks[0].clips[0].assetId = "missing_asset";
    invalid.history.headRevision = 4;
    const result = validateProjectDocument(invalid);
    expect(result.errors.map((error) => error.keyword)).toEqual(
      expect.arrayContaining(["reference", "revision"]),
    );
  });

  it("rejects semantic locks pointing at missing objects", () => {
    const invalid = structuredClone(fixture) as Record<string, any>;
    invalid.sequences[0].locks.push({
      id: "lock_missing_clip",
      owner: "local_user",
      mode: "owner_only",
      scope: { kind: "clip", clipId: "missing_clip" },
      createdAt: "2026-07-17T08:00:00Z",
    });
    const result = validateProjectDocument(invalid);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "reference", instancePath: expect.stringContaining("clipId") }),
    ]));
  });
});
