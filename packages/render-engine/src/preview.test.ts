import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assertProjectDocument, type AgentCutProjectDocument } from "@agentcut/timeline-schema";
import type { RenderPlan } from "./types.js";
import { createPreviewPlan, evaluateTimelineSegments } from "./preview.js";

describe("preview plan", () => {
  it("projects render segments into stable timeline/source seconds", () => {
    const renderPlan = {
      planHash: "sha256:preview",
      sourceRevision: 7,
      timelineDuration: {
        value: 8_000_000,
        rate: { numerator: 1_000_000, denominator: 1 },
      },
      segments: [
        {
          clipId: "clip_a",
          assetId: "asset_a",
          timelineStartMicros: 0,
          sourceStartMicros: 0,
          durationMicros: 3_000_000,
        },
        {
          clipId: "clip_b",
          assetId: "asset_a",
          timelineStartMicros: 3_000_000,
          sourceStartMicros: 5_000_000,
          durationMicros: 5_000_000,
        },
      ],
    } as RenderPlan;

    expect(createPreviewPlan(renderPlan)).toEqual({
      revision: 7,
      planHash: "sha256:preview",
      durationSeconds: 8,
      segments: [
        {
          clipId: "clip_a",
          assetId: "asset_a",
          timelineStartSeconds: 0,
          sourceStartSeconds: 0,
          durationSeconds: 3,
        },
        {
          clipId: "clip_b",
          assetId: "asset_a",
          timelineStartSeconds: 3,
          sourceStartSeconds: 5,
          durationSeconds: 5,
        },
      ],
    });
  });

  it("evaluates the canonical timeline without reading source bytes", () => {
    const fixtureUrl = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
    const value: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));
    assertProjectDocument(value);
    const document = value as AgentCutProjectDocument;

    expect(evaluateTimelineSegments(
      document,
      document.project.activeSequenceId!,
      "transcript_main_001",
    )).toEqual({
      durationMicros: 10_010_000,
      segments: [{
        clipId: "clip_take_1",
        assetId: "asset_camera_a",
        timelineStartMicros: 0,
        sourceStartMicros: 1_001_000,
        durationMicros: 10_010_000,
      }],
    });
  });
});
