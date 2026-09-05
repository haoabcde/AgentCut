import { describe, expect, it } from "vitest";
import { normalizeAsrResult } from "./normalize.js";

const asset = {
  id: "asset_asr_test",
  kind: "video" as const,
  uri: "media/test.mov",
  contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  availability: "online" as const,
  provenance: {
    createdBy: { kind: "user" as const, id: "local_user" },
    createdAt: "2026-07-18T05:00:00Z",
    reason: "test",
  },
};

describe("ASR normalization", () => {
  it("creates stable word IDs, provider provenance, and monotonic microsecond ranges", () => {
    const rawResult = {
      language: "zh",
      segments: [{ words: [
        { word: " 大家好", start: 0.1, end: 0.5, probability: 0.98 },
        { word: "，", start: 0.49, end: 0.55, probability: 1.2 },
        { word: " 今天", start: 0.6, end: 1.0, probability: 0.9 },
      ] }],
    };
    const options = {
      asset,
      audioStreamIndex: 1,
      rawResult,
      rawResultUri: "artifacts/asr/raw.json",
      provider: "mlx-whisper",
      model: "mlx-community/whisper-large-v3-turbo",
      providerVersion: "0.4.3",
      actor: { kind: "workflow" as const, id: "asr_job" },
      createdAt: "2026-07-18T05:01:00Z",
      streamDuration: { value: 10, rate: { numerator: 1, denominator: 1 } },
    };
    const first = normalizeAsrResult(options);
    const second = normalizeAsrResult(options);
    expect(second.transcript.words.map((word) => word.id)).toEqual(
      first.transcript.words.map((word) => word.id),
    );
    expect(first.transcript.providerArtifactId).toBe(first.providerArtifact.id);
    expect(first.transcript.provenance.sourceArtifactIds).toEqual([first.providerArtifact.id]);
    expect(first.transcript.words[1]?.sourceRange).toEqual({
      start: { value: 500_000, rate: { numerator: 1_000_000, denominator: 1 } },
      duration: { value: 50_000, rate: { numerator: 1_000_000, denominator: 1 } },
    });
    expect(first.transcript.words[1]?.confidence).toBe(1);
    expect(first.quality).toEqual(expect.objectContaining({
      inputWords: 3,
      outputWords: 3,
      clampedOverlaps: 1,
    }));
  });

  it("drops empty and collapsed timestamps and rejects results without usable words", () => {
    expect(() => normalizeAsrResult({
      asset,
      audioStreamIndex: 1,
      rawResult: { segments: [{ words: [
        { word: " ", start: 0, end: 1 },
        { word: "坏", start: 1, end: 1 },
      ] }] },
      rawResultUri: "raw.json",
      provider: "test",
      model: "test",
      providerVersion: "1",
      actor: { kind: "workflow", id: "asr_job" },
      createdAt: "2026-07-18T05:01:00Z",
      streamDuration: { value: 10, rate: { numerator: 1, denominator: 1 } },
    })).toThrowError(expect.objectContaining({ code: "NO_WORD_TIMESTAMPS" }));
  });

  it("drops unreliable fallback segments and keeps all ranges inside the media stream", () => {
    const normalized = normalizeAsrResult({
      asset,
      audioStreamIndex: 1,
      rawResult: { segments: [
        {
          words: [{ word: " 正常", start: 0.5, end: 1, probability: 0.98 }],
          temperature: 0,
          compression_ratio: 1.2,
          avg_logprob: -0.1,
        },
        {
          words: [{ word: " scriptures", start: 1, end: 1.1, probability: 0.8 }],
          temperature: 1,
          compression_ratio: 22,
          avg_logprob: null,
        },
        {
          words: [
            { word: " 边界", start: 1.8, end: 2.2, probability: 0.9 },
            { word: " 越界", start: 2.1, end: 2.3, probability: 0.9 },
          ],
        },
      ] },
      rawResultUri: "raw.json",
      provider: "test",
      model: "test",
      providerVersion: "1",
      actor: { kind: "workflow", id: "asr_job" },
      createdAt: "2026-07-18T05:01:00Z",
      streamDuration: { value: 2, rate: { numerator: 1, denominator: 1 } },
    });
    expect(normalized.transcript.words.map((word) => word.text)).toEqual(["正常", "边界"]);
    expect(normalized.transcript.words.at(-1)?.sourceRange).toEqual({
      start: { value: 1_800_000, rate: { numerator: 1_000_000, denominator: 1 } },
      duration: { value: 200_000, rate: { numerator: 1_000_000, denominator: 1 } },
    });
    expect(normalized.quality).toEqual(expect.objectContaining({
      inputWords: 4,
      outputWords: 2,
      droppedUnreliableSegments: 1,
      droppedUnreliableWords: 1,
      droppedOutOfBounds: 1,
      clampedToMedia: 1,
    }));
  });
});
