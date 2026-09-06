import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentCutProjectDocument, Clip, Provenance, Track } from "@agentcut/timeline-schema";
import { buildTenMinuteProject } from "./fixture-10min.js";
import { buildExportPlan } from "./plan.js";
import type { LossEntry, PlanClip, PlanGap, PlanItem } from "./types.js";

function loadMinimalDocument(): AgentCutProjectDocument {
  const url = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as AgentCutProjectDocument;
}

const lossOf = (losses: LossEntry[], category: string) =>
  losses.find((entry) => entry.category === category);

const asClip = (item: PlanItem) => {
  if (item.type !== "clip") throw new Error(`expected clip, got ${item.type}`);
  return item;
};
const asGap = (item: PlanItem) => {
  if (item.type !== "gap") throw new Error(`expected gap, got ${item.type}`);
  return item;
};

const provenance: Provenance = {
  createdBy: { kind: "workflow", id: "plan_test" },
  createdAt: "2026-09-06T00:00:00.000Z",
  reason: "unit test",
};

function inlineMediaClip(id: string, startSeconds: number, durationSeconds: number): Clip {
  return {
    id,
    kind: "media",
    assetId: "asset_a",
    timelineRange: {
      start: { value: startSeconds * 30, rate: { numerator: 30, denominator: 1 } },
      duration: { value: durationSeconds * 30, rate: { numerator: 30, denominator: 1 } },
    },
    enabled: true,
    provenance,
  };
}

function inlineDocument(clips: Clip[], trackExtra: Partial<Track> = {}): AgentCutProjectDocument {
  return {
    schemaVersion: "0.1.0",
    project: {
      id: "project_plan_test",
      name: "plan test",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
      activeSequenceId: "sequence_main",
      revision: 0,
    },
    assets: [{
      id: "asset_a",
      kind: "video",
      uri: "media/a.mp4",
      contentHash: `sha256:${"a".repeat(64)}`,
      availability: "online",
      provenance,
    }],
    sequences: [{
      id: "sequence_main",
      name: "inline sequence",
      canvas: { width: 1920, height: 1080, background: "#000000" },
      frameRate: { numerator: 30, denominator: 1 },
      tracks: [{
        id: "track_v1",
        kind: "video",
        name: "video",
        order: 0,
        locked: false,
        enabled: true,
        clips,
        transitions: [],
        ...trackExtra,
      }],
      locks: [],
      markers: [],
    }],
    styleSpecs: [],
    artifacts: [],
    exportPresets: [],
    versions: [],
    history: { headRevision: 0, records: [] },
  };
}

describe("buildExportPlan — minimal fixture", () => {
  const { plan, losses } = buildExportPlan(loadMinimalDocument());

  it("maps the single media clip onto one video track with exact NTSC rate mapping", () => {
    expect(plan.name).toBe("主版本 9:16");
    expect(plan.tracks).toHaveLength(1);
    const track = plan.tracks[0]!;
    expect(track.kind).toBe("Video");
    expect(track.metadata).toEqual({ locked: false, enabled: true, order: 0 });
    expect(track.items).toHaveLength(1);
    const clip = asClip(track.items[0]!);
    expect(clip.name).toBe("talking-head.mp4");
    expect(clip.clipId).toBe("clip_take_1");
    expect(clip.sourceRange.start).toEqual({ value: 30, rate: 30000 / 1001 });
    expect(clip.sourceRange.duration).toEqual({ value: 300, rate: 30000 / 1001 });
    expect(clip.mediaReference.targetUrl).toBe("media/talking-head.mp4");
    expect(clip.metadata).toEqual({ clipId: "clip_take_1", enabled: true, streamIndex: 0 });
    expect(plan.markers).toEqual([]);
    expect(plan.metadata.projectId).toBe("project_demo_001");
    expect(plan.metadata.sequenceId).toBe("sequence_main");
  });

  it("accounts workspace artifacts and provenance as losses, nothing else", () => {
    expect(losses.map((entry) => entry.category)).toEqual([
      "artifact:deletionCandidateSet",
      "artifact:editProposal",
      "artifact:transcript",
      "provenance-and-history",
    ]);
    for (const entry of losses) {
      expect(entry.count).toBe(1);
      expect(entry.severity).toBe("dropped");
    }
  });

  it("resolves relative asset URIs against projectRoot as file URLs", () => {
    const { plan: rooted } = buildExportPlan(loadMinimalDocument(), { projectRoot: "/tmp/project root" });
    const clip = asClip(rooted.tracks[0]!.items[0]!);
    expect(clip.mediaReference.targetUrl).toBe("file:///tmp/project%20root/media/talking-head.mp4");
  });

  it("passes absolute asset URIs through untouched", () => {
    const document = loadMinimalDocument();
    document.assets[0]!.uri = "https://example.com/media/talking-head.mp4";
    const { plan: remote } = buildExportPlan(document, { projectRoot: "/tmp/ignored" });
    const clip = asClip(remote.tracks[0]!.items[0]!);
    expect(clip.mediaReference.targetUrl).toBe("https://example.com/media/talking-head.mp4");
  });
});

describe("buildExportPlan — 10 minute fixture", () => {
  const { plan, losses } = buildExportPlan(buildTenMinuteProject());

  it("keeps track order and encodes locked/enabled as track metadata", () => {
    expect(plan.tracks.map((track) => track.kind)).toEqual(["Video", "Audio"]);
    const [video, audio] = plan.tracks as [typeof plan.tracks[number], typeof plan.tracks[number]];
    expect(video.metadata).toEqual({ locked: false, enabled: true, order: 0 });
    expect(audio.metadata).toEqual({ locked: true, enabled: true, order: 1 });
    expect("muted" in audio.metadata).toBe(false);
  });

  it("inserts gaps for the hole and for the non-media clip, preserving 600s total", () => {
    const items = plan.tracks[0]!.items;
    expect(items.map((item) => item.type)).toEqual([
      "clip", "clip", "gap", "clip", "clip", "clip", "gap", "clip",
    ]);
    expect(asGap(items[2]!).duration).toEqual({ value: 15, rate: 1 });
    expect(asGap(items[6]!).duration).toEqual({ value: 600, rate: 30 });
    expect(asClip(items[7]!).clipId).toBe("clip_v_006");
    expect(asClip(items[7]!).sourceRange).toEqual({
      start: { value: 5700, rate: 30 },
      duration: { value: 6600, rate: 30 },
    });
    const totalSeconds = items.reduce((sum, item) => {
      const duration = item.type === "gap" ? item.duration : item.sourceRange.duration;
      return sum + duration.value / duration.rate;
    }, 0);
    expect(totalSeconds).toBeCloseTo(600, 6);
    const audioItems = plan.tracks[1]!.items;
    expect(audioItems.map((item) => item.type)).toEqual(["clip", "clip", "clip"]);
  });

  it("encodes disabled flags, stream indexes and clip metadata as agentcut metadata", () => {
    const videoItems = plan.tracks[0]!.items;
    expect(asClip(videoItems[3]!).metadata).toMatchObject({ clipId: "clip_v_003", enabled: false });
    expect(asClip(videoItems[1]!).metadata.irMetadata).toEqual({ "agentcut.note": "含口误待审" });
    const audioItems = plan.tracks[1]!.items;
    expect(asClip(audioItems[0]!).metadata).toEqual({ clipId: "clip_a_001", enabled: true, streamIndex: 1 });
    expect(asClip(audioItems[2]!).metadata).toEqual({ clipId: "clip_a_003", enabled: false, streamIndex: 1 });
  });

  it("maps shaped markers and accounts the freeform marker as a loss", () => {
    expect(plan.markers).toEqual([
      {
        name: "开场口误",
        markedRange: { start: { value: 1440, rate: 30 }, duration: { value: 48, rate: 24 } },
      },
      {
        name: "章节二",
        markedRange: { start: { value: 4500, rate: 30 }, duration: { value: 0, rate: 30 } },
      },
    ]);
    expect(lossOf(losses, "unmappable-marker")).toMatchObject({ count: 1, severity: "dropped" });
  });

  it("enumerates every unmapped semantic in the loss report", () => {
    const byCategory = new Map(losses.map((entry) => [entry.category, entry]));
    expect([...byCategory.keys()].sort()).toEqual([
      "clip-stream-index",
      "disabled-clip",
      "non-media-clip",
      "provenance-and-history",
      "sequence-locks",
      "track-flags-metadata",
      "unmappable-marker",
    ]);
    expect(byCategory.get("disabled-clip")).toMatchObject({ count: 2, severity: "metadata-encoded" });
    expect(byCategory.get("clip-stream-index")).toMatchObject({ count: 3, severity: "metadata-encoded" });
    expect(byCategory.get("non-media-clip")).toMatchObject({ count: 1, severity: "dropped" });
    expect(byCategory.get("sequence-locks")).toMatchObject({ count: 1, severity: "dropped" });
    expect(byCategory.get("track-flags-metadata")).toMatchObject({ count: 1, severity: "metadata-encoded" });
  });
});

describe("buildExportPlan — edge semantics", () => {
  it("skips overlapping clips with an explicit loss entry", () => {
    const { plan, losses } = buildExportPlan(inlineDocument([
      inlineMediaClip("clip_first", 0, 10),
      inlineMediaClip("clip_overlap", 5, 10),
    ]));
    expect(plan.tracks[0]!.items).toHaveLength(1);
    expect(asClip(plan.tracks[0]!.items[0]!).clipId).toBe("clip_first");
    expect(lossOf(losses, "overlapping-clip")).toMatchObject({ count: 1, severity: "dropped" });
  });

  it("derives a zero-based source range when the IR clip omits one", () => {
    const clip = inlineMediaClip("clip_no_source", 0, 10);
    delete clip.sourceRange;
    const { plan } = buildExportPlan(inlineDocument([clip]));
    expect(asClip(plan.tracks[0]!.items[0]!).sourceRange).toEqual({
      start: { value: 0, rate: 1 },
      duration: { value: 300, rate: 30 },
    });
  });

  it("accounts render properties (transform/audio/effects/…) as dropped losses", () => {
    const clip = { ...inlineMediaClip("clip_fx", 0, 10), transform: { scale: 1.2 } };
    const { losses } = buildExportPlan(inlineDocument([clip]));
    expect(lossOf(losses, "clip-render-properties")).toMatchObject({ count: 1, severity: "dropped" });
    expect(lossOf(losses, "clip-render-properties")!.detail).toContain("transform");
  });

  it("encodes muted tracks as metadata and records the loss", () => {
    const { plan, losses } = buildExportPlan(
      inlineDocument([inlineMediaClip("clip_a", 0, 10)], { muted: true }),
    );
    expect(plan.tracks[0]!.metadata.muted).toBe(true);
    expect(lossOf(losses, "track-flags-metadata")).toMatchObject({ count: 1, severity: "metadata-encoded" });
  });

  it("rejects an unknown sequence id", () => {
    expect(() => buildExportPlan(inlineDocument([]), { sequenceId: "sequence_nope" }))
      .toThrow(/sequence_nope/);
  });
});
