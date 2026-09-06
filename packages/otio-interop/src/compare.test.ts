import { describe, expect, it } from "vitest";
import { comparePlanToReadback } from "./compare.js";
import type { ExportPlan, NormalizedTimeline } from "./types.js";

function basePlan(): ExportPlan {
  return {
    name: "compare test",
    metadata: { projectId: "project_x" },
    tracks: [{
      name: "video",
      kind: "Video",
      metadata: { locked: false, enabled: true, order: 0 },
      items: [
        { type: "gap", duration: { value: 15, rate: 1 } },
        {
          type: "clip",
          name: "a.mp4",
          clipId: "clip_a",
          sourceRange: { start: { value: 100, rate: 30 }, duration: { value: 300, rate: 30 } },
          mediaReference: { targetUrl: "file:///media/a.mp4" },
          metadata: { clipId: "clip_a", enabled: true },
        },
      ],
    }],
    markers: [{
      name: "chapter",
      markedRange: { start: { value: 1440, rate: 30 }, duration: { value: 0, rate: 30 } },
    }],
  };
}

function baseReadback(): NormalizedTimeline {
  const plan = basePlan();
  return {
    name: plan.name,
    metadata: plan.metadata,
    tracks: plan.tracks.map((track) => ({
      name: track.name,
      kind: track.kind,
      metadata: track.metadata,
      items: track.items.map((item) => item.type === "gap"
        ? { type: "gap" as const, duration: item.duration }
        : {
          type: "clip" as const,
          name: item.name,
          sourceRange: item.sourceRange,
          mediaReference: { targetUrl: item.mediaReference.targetUrl },
          metadata: item.metadata,
        }),
    })),
    markers: plan.markers,
  };
}

describe("comparePlanToReadback", () => {
  it("reports an identical readback as equivalent", () => {
    const verification = comparePlanToReadback(basePlan(), baseReadback());
    expect(verification.status).toBe("equivalent");
    expect(verification.divergences).toEqual([]);
  });

  it("treats metadata key order as insignificant (OTIO map semantics)", () => {
    const readback = baseReadback();
    readback.tracks[0]!.metadata = { order: 0, enabled: true, locked: false };
    const clip = readback.tracks[0]!.items[1]!;
    if (clip.type === "clip") clip.metadata = { enabled: true, clipId: "clip_a" };
    expect(comparePlanToReadback(basePlan(), readback).status).toBe("equivalent");
  });

  it("accepts cross-value time representations within the seconds tolerance", () => {
    const readback = baseReadback();
    const gap = readback.tracks[0]!.items[0]!;
    if (gap.type === "gap") gap.duration = { value: 15.0000005, rate: 1 };
    expect(comparePlanToReadback(basePlan(), readback).status).toBe("equivalent");
  });

  it("accepts rate drift within the relative epsilon when values match", () => {
    const readback = baseReadback();
    const clip = readback.tracks[0]!.items[1]!;
    if (clip.type === "clip") {
      clip.sourceRange = {
        start: { value: 100, rate: 30 * (1 + 1e-10) },
        duration: { value: 300, rate: 30 },
      };
    }
    expect(comparePlanToReadback(basePlan(), readback).status).toBe("equivalent");
  });

  it("diverges on a rate change beyond epsilon with the same value", () => {
    const readback = baseReadback();
    const clip = readback.tracks[0]!.items[1]!;
    if (clip.type === "clip") {
      clip.sourceRange = {
        start: { value: 100, rate: 29.97 },
        duration: { value: 300, rate: 30 },
      };
    }
    const verification = comparePlanToReadback(basePlan(), readback);
    expect(verification.status).toBe("diverged");
    expect(verification.divergences.map((entry) => entry.path))
      .toContain("tracks[0].items[1].sourceRange.start");
  });

  it("diverges on gap duration drift beyond the seconds tolerance", () => {
    const readback = baseReadback();
    const gap = readback.tracks[0]!.items[0]!;
    if (gap.type === "gap") gap.duration = { value: 15.1, rate: 1 };
    const verification = comparePlanToReadback(basePlan(), readback);
    expect(verification.status).toBe("diverged");
    expect(verification.divergences[0]!.path).toBe("tracks[0].items[0].duration");
  });

  it("diverges on clip metadata, target URL, track name, item counts and markers", () => {
    const readback = baseReadback();
    readback.tracks[0]!.name = "renamed";
    const clip = readback.tracks[0]!.items[1]!;
    if (clip.type === "clip") {
      clip.mediaReference.targetUrl = "file:///media/other.mp4";
      clip.metadata = { clipId: "clip_a", enabled: false };
    }
    readback.markers[0]!.name = "moved";
    const verification = comparePlanToReadback(basePlan(), readback);
    expect(verification.status).toBe("diverged");
    expect(verification.divergences.map((entry) => entry.path)).toEqual([
      "tracks[0].name",
      "tracks[0].items[1].mediaReference.targetUrl",
      "tracks[0].items[1].metadata",
      "markers[0].name",
    ]);
  });

  it("diverges when the readback loses a track", () => {
    const readback = baseReadback();
    readback.tracks = [];
    const verification = comparePlanToReadback(basePlan(), readback);
    expect(verification.status).toBe("diverged");
    expect(verification.divergences.map((entry) => entry.path)).toContain("tracks.length");
  });
});
