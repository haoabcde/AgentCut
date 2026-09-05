import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertProjectDocument, type AgentCutProjectDocument } from "@agentcut/timeline-schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatAss,
  formatSrt,
  generateCaptionCues,
  mapTranscriptToTimeline,
} from "./captions.js";
import { buildRenderPlan } from "./plan.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("cut-aware caption mapping", () => {
  it("omits removed words, reports cut words, and shifts later words to edited time", () => {
    const document = renderFixture();
    const mapping = mapTranscriptToTimeline(document, "transcript_fixture", "sequence_main");
    expect(mapping.words.map((item) => ({
      id: item.word.id,
      clipId: item.clipId,
      start: item.timelineRange.start.value,
    }))).toEqual([
      { id: "word_a", clipId: "clip_left", start: 200_000 },
      { id: "word_b", clipId: "clip_left", start: 1_200_000 },
      { id: "word_d", clipId: "clip_right", start: 2_200_000 },
      { id: "word_e", clipId: "clip_right", start: 3_200_000 },
    ]);
    expect(mapping.removedWordIds).toEqual(["word_partial", "word_removed"]);
    expect(mapping.partialWordIds).toEqual(["word_partial"]);

    const cues = generateCaptionCues(mapping.words, { maximumCharacters: 16 });
    expect(cues.map((cue) => ({ text: cue.text, start: cue.timelineRange.start.value })))
      .toEqual([{ text: "甲乙", start: 200_000 }, { text: "丁戊。", start: 2_200_000 }]);
    expect(formatSrt(cues)).toContain("00:00:02,200 --> 00:00:03,500\n丁戊。");
    expect(formatAss(cues, 320, 180)).toContain("Dialogue: 0,0:00:02.20,0:00:03.50");
  });

  it("builds a deterministic single-source render plan with explicit stream ordinals", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-render-plan-"));
    temporaryDirectories.push(directory);
    mkdirSync(join(directory, "media"));
    writeFileSync(join(directory, "media", "source.mp4"), "fixture bytes");
    const document = renderFixture();
    const asset = document.assets[0]!;
    asset.uri = "media/source.mp4";
    asset.metadata = {
      mediaProbe: {
        streams: [
          { index: 0, type: "video" },
          { index: 1, type: "audio" },
        ],
      },
    };
    const plan = buildRenderPlan({
      document,
      projectRoot: directory,
      sequenceId: "sequence_main",
      transcriptArtifactId: "transcript_fixture",
    });
    expect(plan).toEqual(expect.objectContaining({
      sourceRevision: 0,
      width: 320,
      height: 180,
      timelineDuration: micros(4_000_000),
      removedWordIds: ["word_partial", "word_removed"],
      partialWordIds: ["word_partial"],
    }));
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[1]).toEqual(expect.objectContaining({
      inputIndex: 0,
      videoStreamOrdinal: 0,
      audioStreamOrdinal: 0,
      sourceStartMicros: 3_000_000,
      timelineStartMicros: 2_000_000,
    }));
    expect(plan.planHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects cover fit that matches the sequence canvas aspect", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-render-plan-fit-"));
    temporaryDirectories.push(directory);
    mkdirSync(join(directory, "media"));
    writeFileSync(join(directory, "media", "source.mp4"), "fixture bytes");
    const document = renderFixture();
    document.assets[0]!.metadata = {
      mediaProbe: {
        streams: [
          { index: 0, type: "video" },
          { index: 1, type: "audio" },
        ],
      },
    };
    expect(() => buildRenderPlan({
      document,
      projectRoot: directory,
      sequenceId: "sequence_main",
      transcriptArtifactId: "transcript_fixture",
      outputWidth: 320,
      outputHeight: 180,
      fitMode: "cover",
    })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_FIT_MODE" }));
    expect(() => buildRenderPlan({
      document,
      projectRoot: directory,
      sequenceId: "sequence_main",
      transcriptArtifactId: "transcript_fixture",
      outputWidth: 0,
      outputHeight: 1920,
      fitMode: "cover",
    })).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    const vertical = buildRenderPlan({
      document,
      projectRoot: directory,
      sequenceId: "sequence_main",
      transcriptArtifactId: "transcript_fixture",
      outputWidth: 1080,
      outputHeight: 1920,
      fitMode: "cover",
    });
    expect(vertical.width).toBe(1080);
    expect(vertical.height).toBe(1920);
    expect(vertical.fitMode).toBe("cover");
    expect(vertical.warnings.some((warning) => warning.includes("center-crop"))).toBe(true);
  });
});

function renderFixture(): AgentCutProjectDocument {
  const fixtureUrl = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  assertProjectDocument(value);
  const document = structuredClone(value);
  document.project.revision = 0;
  document.history.headRevision = 0;
  document.history.records = [];
  document.project.activeSequenceId = "sequence_main";
  document.assets = [{
    id: "asset_source",
    kind: "video",
    uri: "media/source.mp4",
    contentHash: `sha256:${"a".repeat(64)}`,
    availability: "online",
    provenance: {
      createdBy: { kind: "user", id: "local_user" },
      createdAt: "2026-07-18T10:00:00Z",
      reason: "Render fixture",
    },
  }];
  document.artifacts = [{
    id: "transcript_fixture",
    kind: "transcript",
    assetId: "asset_source",
    language: "zh",
    audioStreamIndex: 1,
    words: [
      word("word_a", "甲", 200_000, 300_000),
      word("word_b", "乙", 1_200_000, 300_000),
      word("word_partial", "跨", 1_800_000, 400_000),
      word("word_removed", "删", 2_300_000, 300_000),
      word("word_d", "丁", 3_200_000, 300_000),
      word("word_e", "戊。", 4_200_000, 300_000),
    ],
    provenance: {
      createdBy: { kind: "workflow", id: "asr" },
      createdAt: "2026-07-18T10:00:00Z",
      reason: "Render fixture transcript",
    },
  }];
  const sequence = document.sequences[0]!;
  sequence.canvas = { width: 320, height: 180, background: "#000000" };
  sequence.frameRate = { numerator: 30, denominator: 1 };
  sequence.tracks = [{
    id: "track_v1",
    kind: "video",
    name: "Main",
    order: 0,
    locked: false,
    enabled: true,
    clips: [
      clip("clip_left", 0, 0, 2_000_000),
      clip("clip_right", 2_000_000, 3_000_000, 2_000_000),
    ],
    transitions: [],
  }];
  sequence.locks = [];
  sequence.markers = [];
  return document;
}

function clip(id: string, timelineStart: number, sourceStart: number, duration: number) {
  return {
    id,
    kind: "media" as const,
    assetId: "asset_source",
    streamIndex: 0,
    timelineRange: { start: micros(timelineStart), duration: micros(duration) },
    sourceRange: { start: micros(sourceStart), duration: micros(duration) },
    enabled: true,
    provenance: {
      createdBy: { kind: "workflow" as const, id: "test" },
      createdAt: "2026-07-18T10:00:00Z",
      reason: "Render fixture clip",
    },
  };
}

function word(id: string, text: string, start: number, duration: number) {
  return { id, text, confidence: 0.99, sourceRange: { start: micros(start), duration: micros(duration) } };
}

function micros(value: number) {
  return { value, rate: { numerator: 1_000_000, denominator: 1 } };
}
