import { readFileSync } from "node:fs";
import { assertProjectDocument, type AgentCutProjectDocument } from "@agentcut/timeline-schema";
import { describe, expect, it } from "vitest";
import { buildSpeechGapProjection } from "./speech-gaps.js";

function fixture(): AgentCutProjectDocument {
  const url = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(url, "utf8"));
  assertProjectDocument(value);
  return structuredClone(value);
}

describe("speech-gap projection", () => {
  it("projects retained trailing video without Transcript words", () => {
    const gaps = buildSpeechGapProjection(fixture(), "transcript_main_001");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toEqual(expect.objectContaining({
      gapId: expect.stringMatching(/^speech_gap_[a-f0-9]{24}$/),
      clipId: "clip_take_1",
      previousWordId: "word_004",
      sourceRange: {
        start: { value: 3_400_000, rate: { numerator: 1_000_000, denominator: 1 } },
        duration: { value: 7_611_000, rate: { numerator: 1_000_000, denominator: 1 } },
      },
      timelineRange: {
        start: { value: 2_399_000, rate: { numerator: 1_000_000, denominator: 1 } },
        duration: { value: 7_611_000, rate: { numerator: 1_000_000, denominator: 1 } },
      },
    }));
  });

  it("suppresses microscopic inter-word alignment gaps", () => {
    const gaps = buildSpeechGapProjection(fixture(), "transcript_main_001", {
      minimumDurationMicros: 50_000,
    });
    expect(gaps.some((gap) => gap.previousWordId === "word_001"
      && gap.nextWordId === "word_002")).toBe(true);
    expect(buildSpeechGapProjection(fixture(), "transcript_main_001")
      .some((gap) => gap.previousWordId === "word_001" && gap.nextWordId === "word_002"))
      .toBe(false);
  });
});
