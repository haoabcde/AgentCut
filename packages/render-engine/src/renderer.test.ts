import { describe, expect, it } from "vitest";
import { videoFitFilter } from "./renderer.js";
import type { RenderPlan } from "./types.js";

function planWith(width: number, height: number, fitMode: RenderPlan["fitMode"]): RenderPlan {
  return {
    planHash: "sha256:test",
    projectId: "project_test",
    sourceRevision: 0,
    sequenceId: "sequence_main",
    transcriptArtifactId: "transcript_fixture",
    width,
    height,
    frameRate: { numerator: 30, denominator: 1 },
    fitMode,
    timelineDuration: { value: 0, rate: { numerator: 1_000_000, denominator: 1 } },
    expectedOutputMicros: 0,
    inputPaths: [],
    segments: [],
    cues: [],
    removedWordIds: [],
    partialWordIds: [],
    warnings: [],
  };
}

describe("videoFitFilter", () => {
  it("letterboxes the whole frame with contain fit", () => {
    expect(videoFitFilter(planWith(1920, 1080, "contain"))).toBe(
      "scale=1920:1080:force_original_aspect_ratio=decrease,"
        + "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black",
    );
  });

  it("fills and center-crops with cover fit", () => {
    expect(videoFitFilter(planWith(1080, 1920, "cover"))).toBe(
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
    );
  });
});
