import { describe, expect, it } from "vitest";
import type { ReviewGap, ReviewToken } from "./api.js";
import {
  contiguousWordSelection,
  validateManualDeletionSelection,
} from "./transcript-selection.js";

const wordIds = ["word_001", "word_002", "word_003", "word_004"];

describe("contiguousWordSelection", () => {
  it("selects the inclusive range in transcript order", () => {
    expect(contiguousWordSelection(wordIds, "word_002", "word_004")).toEqual([
      "word_002",
      "word_003",
      "word_004",
    ]);
  });

  it("normalizes a backwards shift selection", () => {
    expect(contiguousWordSelection(wordIds, "word_004", "word_002")).toEqual([
      "word_002",
      "word_003",
      "word_004",
    ]);
  });

  it("rejects anchors that are not in the active transcript", () => {
    expect(() => contiguousWordSelection(wordIds, "missing", "word_002"))
      .toThrow("Selection word was not found");
  });

  it("allows only normal words in a manual deletion range", () => {
    expect(validateManualDeletionSelection(tokens(), [], ["word_001", "word_002"]))
      .toEqual({ valid: true });
    expect(validateManualDeletionSelection(
      tokens({ word_002: "committed_deleted" }),
      [],
      ["word_001", "word_002"],
    )).toEqual(expect.objectContaining({
      valid: false,
      message: expect.stringContaining("已删除文字"),
    }));
    expect(validateManualDeletionSelection(
      tokens({ word_002: "candidate_remove" }),
      [],
      ["word_001", "word_002"],
    )).toEqual(expect.objectContaining({
      valid: false,
      message: expect.stringContaining("待审 AI 候选"),
    }));
  });

  it("rejects a range that crosses a reviewed or deleted gap", () => {
    const gap: ReviewGap = {
      candidateId: "gap_001",
      sourceRange: {
        start: { value: 1_000, rate: { numerator: 1_000, denominator: 1 } },
        duration: { value: 200, rate: { numerator: 1_000, denominator: 1 } },
      },
      previousWordId: "word_001",
      nextWordId: "word_002",
      state: "reviewed_keep",
      decoration: "kept_gap",
      reasonCodes: ["silence"],
      risk: "medium",
      confidence: 0.8,
      explanationZh: "保留呼吸停顿",
      restorable: true,
    };
    expect(validateManualDeletionSelection(tokens(), [gap], ["word_001", "word_002"]))
      .toEqual(expect.objectContaining({
        valid: false,
        message: expect.stringContaining("已锁定停顿"),
      }));
  });
});

function tokens(
  states: Record<string, ReviewToken["state"]> = {},
): ReviewToken[] {
  return wordIds.map((wordId, index) => ({
    wordId,
    text: wordId,
    sourceRange: {
      start: { value: index * 1_000, rate: { numerator: 1_000, denominator: 1 } },
      duration: { value: 500, rate: { numerator: 1_000, denominator: 1 } },
    },
    state: states[wordId] ?? "normal",
    decoration: "none",
    candidateIds: [],
    reasonCodes: [],
    restorable: false,
  }));
}
