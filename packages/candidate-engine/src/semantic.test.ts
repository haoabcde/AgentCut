import { readFileSync } from "node:fs";
import {
  assertProjectDocument,
  type AgentCutProjectDocument,
  type TranscriptArtifact,
} from "@agentcut/timeline-schema";
import { describe, expect, it } from "vitest";
import {
  buildSemanticReviewWindows,
  generateSemanticReviewCandidates,
  LmStudioSemanticReviewProvider,
  parseSemanticFindings,
  SemanticReviewError,
  type SemanticReviewProvider,
} from "./semantic.js";

function fixture(): AgentCutProjectDocument {
  const url = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(url, "utf8"));
  assertProjectDocument(value);
  return structuredClone(value);
}

function semanticTranscript(document: AgentCutProjectDocument): TranscriptArtifact {
  const transcript = document.artifacts.find((artifact) => artifact.kind === "transcript");
  if (!transcript || transcript.kind !== "transcript") throw new Error("Fixture transcript missing");
  transcript.words = [
    "我们", "采用", "第一种", "方案", "，", "不对", "，", "采用", "第二种", "方案", "。",
  ].map((text, index) => ({
    id: `semantic_word_${index}`,
    text,
    confidence: 0.98,
    sourceRange: {
      start: { value: 1_000 + index * 300, rate: { numerator: 1_000, denominator: 1 } },
      duration: { value: 240, rate: { numerator: 1_000, denominator: 1 } },
    },
  }));
  return transcript;
}

describe("semantic talking-head review", () => {
  it("turns a validated local-AI correction into a high-risk word candidate", async () => {
    const document = fixture();
    const transcript = semanticTranscript(document);
    const provider: SemanticReviewProvider = {
      id: "test-local-model",
      async analyze() {
        return [{
          category: "correction",
          removeStartWordId: "semantic_word_0",
          removeEndWordId: "semantic_word_6",
          keepStartWordId: "semantic_word_7",
          keepEndWordId: "semantic_word_10",
          confidence: 0.91,
          explanationZh: "说话者用“不对”明确推翻第一种方案，随后给出第二种方案。",
        }];
      },
    };
    const generated = await generateSemanticReviewCandidates({
      document,
      transcriptArtifactId: transcript.id,
      sequenceId: "sequence_main",
      clipId: "clip_take_1",
      actor: { kind: "workflow", id: "semantic_review" },
      createdAt: "2026-07-18T09:00:00Z",
      provider,
    });
    expect(generated.report).toEqual(expect.objectContaining({
      windows: 1,
      rawFindings: 1,
      acceptedCandidates: 1,
      rejectedFindings: 0,
    }));
    expect(generated.candidateSet).toEqual(expect.objectContaining({
      detectorVersion: "semantic-review/0.2/test-local-model",
      evidenceContracts: ["retained-comparison-v1"],
      projectRevision: document.project.revision,
    }));
    expect(generated.candidateSet.candidates[0]).toEqual(expect.objectContaining({
      reasonCodes: ["correction"],
      decision: "suggest_remove",
      risk: "high",
      confidence: 0.91,
      explanationZh: expect.stringContaining("保留后一段"),
      evidence: [{
        role: "retained_comparison",
        target: {
          kind: "words",
          wordIds: [
            "semantic_word_7", "semantic_word_8", "semantic_word_9", "semantic_word_10",
          ],
          sourceRange: {
            start: { value: 3_100_000, rate: { numerator: 1_000_000, denominator: 1 } },
            duration: { value: 1_140_000, rate: { numerator: 1_000_000, denominator: 1 } },
          },
        },
      }],
      target: expect.objectContaining({
        kind: "words",
        wordIds: [
          "semantic_word_0", "semantic_word_1", "semantic_word_2", "semantic_word_3",
          "semantic_word_4", "semantic_word_5", "semantic_word_6",
        ],
      }),
    }));
  });

  it("trims normal lead-in words from a model-selected restatement range", async () => {
    const document = fixture();
    const transcript = semanticTranscript(document);
    transcript.words = [
      "校企结合", "引导", "青年", "学子", "树立", "理念",
      "引导", "青年", "学子", "树立", "完整", "理念",
    ].map((text, index) => ({
      id: `boundary_word_${index}`,
      text,
      confidence: 0.98,
      sourceRange: {
        start: { value: 1_000 + index * 300, rate: { numerator: 1_000, denominator: 1 } },
        duration: { value: 240, rate: { numerator: 1_000, denominator: 1 } },
      },
    }));
    const generated = await generateSemanticReviewCandidates({
      document,
      transcriptArtifactId: transcript.id,
      sequenceId: "sequence_main",
      clipId: "clip_take_1",
      actor: { kind: "workflow", id: "semantic_review" },
      createdAt: "2026-07-18T09:00:00Z",
      provider: {
        id: "imprecise-boundary-model",
        async analyze() {
          return [{
            category: "restatement",
            removeStartWordId: "boundary_word_0",
            removeEndWordId: "boundary_word_5",
            keepStartWordId: "boundary_word_6",
            keepEndWordId: "boundary_word_11",
            confidence: 0.9,
            explanationZh: "前一句未完成，随后从引导青年重新表述。",
          }];
        },
      },
    });
    expect(generated.candidateSet.candidates[0]?.target).toEqual(expect.objectContaining({
      kind: "words",
      wordIds: [
        "boundary_word_1", "boundary_word_2", "boundary_word_3",
        "boundary_word_4", "boundary_word_5",
      ],
    }));
  });

  it("rejects invented IDs, backward keep ranges, and overlapping duplicate suggestions", async () => {
    const document = fixture();
    const transcript = semanticTranscript(document);
    const provider: SemanticReviewProvider = {
      id: "unsafe-model-output",
      async analyze() {
        return [
          {
            category: "correction",
            removeStartWordId: "invented",
            removeEndWordId: "semantic_word_2",
            keepStartWordId: "semantic_word_7",
            keepEndWordId: "semantic_word_10",
            confidence: 0.99,
            explanationZh: "invented id",
          },
          {
            category: "restatement",
            removeStartWordId: "semantic_word_0",
            removeEndWordId: "semantic_word_3",
            keepStartWordId: "semantic_word_2",
            keepEndWordId: "semantic_word_4",
            confidence: 0.9,
            explanationZh: "backward keep",
          },
          {
            category: "correction",
            removeStartWordId: "semantic_word_0",
            removeEndWordId: "semantic_word_6",
            keepStartWordId: "semantic_word_7",
            keepEndWordId: "semantic_word_10",
            confidence: 0.8,
            explanationZh: "first valid range",
          },
          {
            category: "correction",
            removeStartWordId: "semantic_word_2",
            removeEndWordId: "semantic_word_6",
            keepStartWordId: "semantic_word_7",
            keepEndWordId: "semantic_word_10",
            confidence: 0.7,
            explanationZh: "overlaps first valid range",
          },
        ];
      },
    };
    const generated = await generateSemanticReviewCandidates({
      document,
      transcriptArtifactId: transcript.id,
      sequenceId: "sequence_main",
      clipId: "clip_take_1",
      actor: { kind: "workflow", id: "semantic_review" },
      createdAt: "2026-07-18T09:00:00Z",
      provider,
    });
    expect(generated.report).toEqual(expect.objectContaining({
      rawFindings: 4,
      acceptedCandidates: 1,
      rejectedFindings: 2,
      overlappingFindings: 1,
    }));
  });

  it("windows long transcripts with overlap and strictly parses provider JSON", () => {
    const document = fixture();
    const transcript = semanticTranscript(document);
    transcript.words = Array.from({ length: 45 }, (_, index) => ({
      id: `window_word_${index}`,
      text: `词${index}`,
      confidence: 0.99,
      sourceRange: {
        start: { value: index, rate: { numerator: 1, denominator: 1 } },
        duration: { value: 1, rate: { numerator: 2, denominator: 1 } },
      },
    }));
    const windows = buildSemanticReviewWindows(transcript, 20, 5);
    expect(windows.map((window) => [window.startWordIndex, window.endWordIndex]))
      .toEqual([[0, 19], [15, 34], [30, 44]]);
    expect(parseSemanticFindings({ findings: [] })).toEqual([]);
    expect(() => parseSemanticFindings({ findings: [{ category: "repetition" }] }))
      .toThrowError(SemanticReviewError);
  });

  it("refuses non-loopback semantic endpoints", () => {
    expect(() => new LmStudioSemanticReviewProvider({
      baseUrl: "https://example.com/v1",
      model: "remote-model",
    })).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });
});
