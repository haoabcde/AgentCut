import { readFileSync } from "node:fs";
import { assertProjectDocument, type AgentCutProjectDocument } from "@agentcut/timeline-schema";
import { describe, expect, it } from "vitest";
import { createLowRiskProposal, generateTalkingHeadCandidates } from "./candidates.js";

function fixture(): AgentCutProjectDocument {
  const url = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(url, "utf8"));
  assertProjectDocument(value);
  return structuredClone(value);
}

describe("talking-head candidates", () => {
  it("generates explainable filler and handled silence candidates with stable IDs", () => {
    const document = fixture();
    const transcript = document.artifacts.find((artifact) => artifact.kind === "transcript");
    if (!transcript || transcript.kind !== "transcript") throw new Error("Fixture transcript missing");
    transcript.words[2]!.sourceRange.start.value = 3_000;
    transcript.words[3]!.sourceRange.start.value = 3_500;
    const options = {
      document,
      transcriptArtifactId: "transcript_main_001",
      sequenceId: "sequence_main",
      clipId: "clip_take_1",
      silences: [{
        start: { value: 1_900, rate: { numerator: 1_000, denominator: 1 } },
        duration: { value: 1_100, rate: { numerator: 1_000, denominator: 1 } },
      }],
      actor: { kind: "workflow" as const, id: "candidate_detector" },
      createdAt: "2026-07-18T07:00:00Z",
    };
    const first = generateTalkingHeadCandidates(options);
    const second = generateTalkingHeadCandidates(options);
    expect(first.candidateSet.evidenceContracts).toEqual(["retained-comparison-v1"]);
    expect(second.candidateSet.candidates.map((candidate) => candidate.id)).toEqual(
      first.candidateSet.candidates.map((candidate) => candidate.id),
    );
    expect(first.candidateSet.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reasonCodes: ["filler"],
        decision: "definite_remove",
        target: expect.objectContaining({ kind: "words", wordIds: ["word_002"] }),
      }),
      expect.objectContaining({
        reasonCodes: ["silence"],
        decision: "suggest_remove",
        target: expect.objectContaining({ kind: "gap" }),
      }),
    ]));
    expect(first.report).toEqual(expect.objectContaining({
      fillerCandidates: 1,
      repetitionCandidates: 0,
      silenceCandidates: 1,
    }));
  });

  it("keeps long inter-segment pauses as suggest-only candidates", () => {
    // 浸泡彩排实证：真实口播段间停顿（≥800ms）会被判 definite_remove + low risk
    // 并由 generate 路径自动提交，而 precision 证据只统计 definite_remove——长停顿
    // 自动删除在 Gate 上不可审计。锁定「只有填充词可 definite，停顿一律 suggest」。
    const document = fixture();
    const transcript = document.artifacts.find((artifact) => artifact.kind === "transcript");
    if (!transcript || transcript.kind !== "transcript") throw new Error("Fixture transcript missing");
    // fixture 词间天然间隙只有 100ms，放不下「两侧各 150ms 余量 + ≥350ms 可删段」，
    // 因此把 word_003(今天, 3200–3600ms) 与 word_004(3700–4600ms) 后移，使
    // word_002(嗯, 结束 1900ms) 到 word_003(开始 3200ms) 形成 1.3s 真实间隙；
    // 停顿 2.0s→3.1s 覆盖其中段：bounded 2.15s→2.95s = 800ms ≥ 350ms 可删。
    transcript.words[2]!.sourceRange.start.value = 3_200;
    transcript.words[3]!.sourceRange.start.value = 3_700;
    const generated = generateTalkingHeadCandidates({
      document,
      transcriptArtifactId: "transcript_main_001",
      sequenceId: "sequence_main",
      clipId: "clip_take_1",
      silences: [{
        start: { value: 2_000, rate: { numerator: 1_000, denominator: 1 } },
        duration: { value: 1_100, rate: { numerator: 1_000, denominator: 1 } },
      }],
      actor: { kind: "workflow", id: "candidate_detector" },
      createdAt: "2026-07-18T07:00:00Z",
    });
    const silence = generated.candidateSet.candidates.filter((candidate) =>
      candidate.reasonCodes.includes("silence"),
    );
    expect(silence.length).toBeGreaterThan(0);
    for (const candidate of silence) {
      expect(candidate.decision).toBe("suggest_remove");
      expect(candidate.risk).toBe("medium");
    }
    // 长停顿候选绝不进入低风险自动提案（definite 只剩填充词）。
    const proposal = createLowRiskProposal(generated.candidateSet, {
      actor: { kind: "agent", id: "codex" },
      createdAt: "2026-07-18T07:01:00Z",
    });
    expect(proposal.selectedCandidateIds).toHaveLength(1);
  });

  it("creates a hash-bound proposal containing only definite low-risk candidates", () => {
    const document = fixture();
    const generated = generateTalkingHeadCandidates({
      document,
      transcriptArtifactId: "transcript_main_001",
      sequenceId: "sequence_main",
      clipId: "clip_take_1",
      silences: [],
      actor: { kind: "workflow", id: "candidate_detector" },
      createdAt: "2026-07-18T07:00:00Z",
    });
    const proposal = createLowRiskProposal(generated.candidateSet, {
      actor: { kind: "agent", id: "codex" },
      createdAt: "2026-07-18T07:01:00Z",
    });
    expect(proposal.selectedCandidateIds).toHaveLength(1);
    expect(proposal.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(proposal.estimatedRemovedDuration.value).toBe(200_000);
  });

  it("suggests only the first span of an immediate exact phrase repetition", () => {
    const document = fixture();
    const transcript = document.artifacts.find((artifact) => artifact.kind === "transcript");
    if (!transcript || transcript.kind !== "transcript") throw new Error("Fixture transcript missing");
    transcript.words = ["请", "看", "卡", "片", "卡", "片", "内容"].map((text, index) => ({
      id: `word_repeat_${index}`,
      text,
      normalizedText: text,
      confidence: index === 4 ? 0.87 : 0.99,
      sourceRange: {
        start: { value: 1_000 + index * 250, rate: { numerator: 1_000, denominator: 1 } },
        duration: { value: 200, rate: { numerator: 1_000, denominator: 1 } },
      },
    }));

    const generated = generateTalkingHeadCandidates({
      document,
      transcriptArtifactId: transcript.id,
      sequenceId: "sequence_main",
      clipId: "clip_take_1",
      silences: [],
      actor: { kind: "workflow", id: "candidate_detector" },
      createdAt: "2026-07-18T07:00:00Z",
    });
    const repetition = generated.candidateSet.candidates.find((candidate) =>
      candidate.reasonCodes.includes("repetition"),
    );
    expect(generated.candidateSet.evidenceContracts).toEqual(["retained-comparison-v1"]);
    expect(repetition).toEqual(expect.objectContaining({
      decision: "suggest_remove",
      risk: "medium",
      confidence: 0.87,
      explanationZh: expect.stringContaining("卡片"),
      target: expect.objectContaining({
        kind: "words",
        wordIds: ["word_repeat_2", "word_repeat_3"],
        sourceRange: {
          start: { value: 1_500_000, rate: { numerator: 1_000_000, denominator: 1 } },
          duration: { value: 450_000, rate: { numerator: 1_000_000, denominator: 1 } },
        },
      }),
      evidence: [{
        role: "retained_comparison",
        target: expect.objectContaining({
          kind: "words",
          wordIds: ["word_repeat_4", "word_repeat_5"],
        }),
      }],
    }));
    expect(generated.report.repetitionCandidates).toBe(1);
    expect(generated.report.definiteRemove).toBe(0);

    transcript.words[4]!.confidence = 0.4;
    const lowConfidence = generateTalkingHeadCandidates({
      document,
      transcriptArtifactId: transcript.id,
      sequenceId: "sequence_main",
      clipId: "clip_take_1",
      silences: [],
      actor: { kind: "workflow", id: "candidate_detector" },
      createdAt: "2026-07-18T07:00:00Z",
    }).candidateSet;
    const riskyRepetition = lowConfidence.candidates.find((candidate) =>
      candidate.reasonCodes.includes("repetition"),
    );
    expect(riskyRepetition).toEqual(expect.objectContaining({
      decision: "suggest_remove",
      risk: "high",
      confidence: 0.4,
      explanationZh: expect.stringContaining("必须试听确认"),
    }));
    expect(lowConfidence.id).not.toBe(generated.candidateSet.id);
  });

  it("does not cross punctuation or flag one-character reduplication", () => {
    const document = fixture();
    const transcript = document.artifacts.find((artifact) => artifact.kind === "transcript");
    if (!transcript || transcript.kind !== "transcript") throw new Error("Fixture transcript missing");
    transcript.words = ["看", "看", "，", "今天", "。", "今天"].map((text, index) => ({
      id: `word_safe_${index}`,
      text,
      normalizedText: text,
      confidence: 0.99,
      sourceRange: {
        start: { value: 1_000 + index * 250, rate: { numerator: 1_000, denominator: 1 } },
        duration: { value: 200, rate: { numerator: 1_000, denominator: 1 } },
      },
    }));
    const generated = generateTalkingHeadCandidates({
      document,
      transcriptArtifactId: transcript.id,
      sequenceId: "sequence_main",
      clipId: "clip_take_1",
      silences: [],
      actor: { kind: "workflow", id: "candidate_detector" },
      createdAt: "2026-07-18T07:00:00Z",
    });
    expect(generated.report.repetitionCandidates).toBe(0);
  });
});
