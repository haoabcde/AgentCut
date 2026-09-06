import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentCutProjectDocument } from "@agentcut/timeline-schema";
import { comparePlanToReadback } from "./compare.js";
import { exportTimeline } from "./export.js";
import { buildTenMinuteProject } from "./fixture-10min.js";
import { buildExportPlan } from "./plan.js";
import { otioAvailability, readOtioFile } from "./python.js";

const otio = otioAvailability();
const itWithOtio = otio.available ? it : it.skip;

function loadMinimalDocument(): AgentCutProjectDocument {
  const url = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as AgentCutProjectDocument;
}

const FIXED_CLOCK = () => "2026-09-06T00:00:00.000Z";

describe("OTIO round-trip via the official library", () => {
  let workDir: string;
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "agentcut-otio-roundtrip-"));
  });
  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("reports opentimelineio availability so a skip stays legible", () => {
    // 可用性探针本身无条件运行：skip 时测试报告里仍能看到原因。
    console.info(otio.available
      ? `opentimelineio ${otio.version} available`
      : "opentimelineio NOT available — round-trip tests skipped (python3 -m pip install --user opentimelineio)");
    expect(typeof otio.available).toBe("boolean");
  });

  itWithOtio("exports the minimal fixture and verifies read-back equivalence", { timeout: 60_000 }, () => {
    const outPath = join(workDir, "minimal.otio");
    const result = exportTimeline(loadMinimalDocument(), { outPath, clock: FIXED_CLOCK });
    expect(result.lossReport.verification.status).toBe("equivalent");
    expect(result.lossReport.losses.map((entry) => entry.category)).toEqual([
      "artifact:deletionCandidateSet",
      "artifact:editProposal",
      "artifact:transcript",
      "provenance-and-history",
    ]);
    expect(result.lossReport.project).toEqual({ id: "project_demo_001", revision: 0, sequenceId: "sequence_main" });
    expect(result.lossReport.otioVersion).toBe(otio.version);
    expect(result.lossReportMarkdown).toContain("round-trip (via official parser): **equivalent**");
    const raw = JSON.parse(readFileSync(outPath, "utf8")) as { OTIO_SCHEMA?: string };
    expect(raw.OTIO_SCHEMA).toBe("Timeline.1");
  });

  itWithOtio("round-trips the 10 minute fixture with zero divergence beyond the loss report", { timeout: 60_000 }, () => {
    const outPath = join(workDir, "ten-minute.otio");
    const result = exportTimeline(buildTenMinuteProject(), { outPath, clock: FIXED_CLOCK });
    expect(result.lossReport.verification.status).toBe("equivalent");
    const byCategory = new Map(result.lossReport.losses.map((entry) => [entry.category, entry]));
    expect([...byCategory.keys()].sort()).toEqual([
      "clip-stream-index",
      "disabled-clip",
      "non-media-clip",
      "provenance-and-history",
      "sequence-locks",
      "track-flags-metadata",
      "unmappable-marker",
    ]);
    expect(byCategory.get("disabled-clip")!.count).toBe(2);
    expect(byCategory.get("clip-stream-index")!.count).toBe(3);
    expect(result.lossReportMarkdown).toContain("| non-media-clip | dropped | 1 |");
  });

  itWithOtio("surfaces tampering as a round-trip divergence, not a silent pass", { timeout: 60_000 }, () => {
    const document = loadMinimalDocument();
    const outPath = join(workDir, "tampered.otio");
    exportTimeline(document, { outPath, clock: FIXED_CLOCK });
    const raw = readFileSync(outPath, "utf8").replace("media/talking-head.mp4", "media/swapped.mp4");
    expect(raw).not.toBe(readFileSync(outPath, "utf8"));
    writeFileSync(outPath, raw);
    const { plan } = buildExportPlan(document);
    const verification = comparePlanToReadback(plan, readOtioFile(outPath));
    expect(verification.status).toBe("diverged");
    expect(verification.divergences.map((entry) => entry.path))
      .toContain("tracks[0].items[0].mediaReference.targetUrl");
  });
});
