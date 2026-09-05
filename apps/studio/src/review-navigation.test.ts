import { describe, expect, it } from "vitest";
import type { CandidateSelection } from "./api.js";
import {
  candidatePosition,
  isActionablePendingCandidate,
  isBatchAcceptableCandidate,
  nextUnlabeledAlphaCandidateId,
  nextPendingCandidateId,
  reviewDecisionCounts,
  selectRelativeCandidateId,
  shortcutForKey,
} from "./review-navigation.js";

function candidate(
  candidateId: string,
  state: CandidateSelection["state"] = "candidate_remove",
): CandidateSelection {
  return {
    candidateId,
    targetKind: "gap",
    sourceRange: {
      start: { value: 0, rate: { numerator: 1_000, denominator: 1 } },
      duration: { value: 500, rate: { numerator: 1_000, denominator: 1 } },
    },
    wordIds: [],
    state,
    reasonCodes: ["silence"],
    risk: "low",
    confidence: 0.9,
    explanationZh: "测试候选",
  };
}

describe("review navigation", () => {
  const candidates = [
    candidate("candidate_a", "committed_deleted"),
    candidate("candidate_b"),
    candidate("candidate_c", "reviewed_keep"),
    candidate("candidate_d"),
  ];

  it("keeps primary navigation inside pending work while history stays directly accessible", () => {
    expect(selectRelativeCandidateId(candidates, "candidate_b", 1)).toBe("candidate_d");
    expect(selectRelativeCandidateId(candidates, "candidate_d", 1)).toBe("candidate_b");
    expect(selectRelativeCandidateId(candidates, "candidate_b", -1)).toBe("candidate_d");
    expect(candidatePosition(candidates, "candidate_d")).toEqual({ current: 2, total: 2, scope: "pending" });

    expect(selectRelativeCandidateId(candidates, "candidate_a", -1)).toBe("candidate_d");
    expect(candidatePosition(candidates, "candidate_c")).toEqual({ current: 3, total: 4, scope: "all" });
  });

  it("advances a decision to the next pending candidate and skips review history", () => {
    expect(nextPendingCandidateId(candidates, "candidate_b")).toBe("candidate_d");
    expect(nextPendingCandidateId(candidates, "candidate_d")).toBe("candidate_b");
    expect(nextPendingCandidateId([
      candidate("candidate_a", "committed_deleted"),
      candidate("candidate_c", "reviewed_keep"),
    ], "candidate_a")).toBeUndefined();
  });

  it("advances Alpha quality labeling to the next still-unlabeled candidate", () => {
    const qualityCandidates = [
      { candidateId: "candidate_a", humanLabel: "true_positive" as const },
      { candidateId: "candidate_b", humanLabel: null },
      { candidateId: "candidate_c", humanLabel: null },
    ] as Parameters<typeof nextUnlabeledAlphaCandidateId>[0];
    expect(nextUnlabeledAlphaCandidateId(qualityCandidates, "candidate_b")).toBe("candidate_c");
    expect(nextUnlabeledAlphaCandidateId(qualityCandidates, "candidate_c")).toBe("candidate_b");
    qualityCandidates[1]!.humanLabel = "false_positive";
    expect(nextUnlabeledAlphaCandidateId(qualityCandidates, "candidate_c")).toBeUndefined();
  });

  it("maps discoverable single-key actions but preserves modified shortcuts", () => {
    expect(shortcutForKey("ArrowLeft")).toBe("previous");
    expect(shortcutForKey("ArrowRight")).toBe("next");
    expect(shortcutForKey(" ")).toBe("toggle_preview");
    expect(shortcutForKey("B")).toBe("toggle_cut_preview");
    expect(shortcutForKey("D")).toBe("accept");
    expect(shortcutForKey("k")).toBe("keep");
    expect(shortcutForKey("u")).toBe("undo");
    expect(shortcutForKey("d", { metaKey: true })).toBeUndefined();
  });

  it("counts decisions rather than the number of affected transcript tokens", () => {
    expect(reviewDecisionCounts(candidates)).toEqual({
      pending: 2,
      kept: 1,
      committed: 1,
    });
  });

  it("only treats the overlap anchor as an actionable pending decision", () => {
    const anchor = {
      ...candidate("candidate_anchor"),
      overlapCandidateIds: ["candidate_blocked"],
      overlapDecisionAnchorId: "candidate_anchor",
    };
    const blocked = {
      ...candidate("candidate_blocked"),
      overlapCandidateIds: ["candidate_anchor"],
      overlapDecisionAnchorId: "candidate_anchor",
    };
    expect(isActionablePendingCandidate(anchor)).toBe(true);
    expect(isActionablePendingCandidate(blocked)).toBe(false);
  });

  it("restricts batch acceptance to actionable low/medium pending candidates", () => {
    expect(isBatchAcceptableCandidate(candidate("candidate_b"))).toBe(true);
    expect(isBatchAcceptableCandidate(candidate("candidate_a", "committed_deleted"))).toBe(false);
    expect(isBatchAcceptableCandidate(candidate("candidate_c", "reviewed_keep"))).toBe(false);
    expect(isBatchAcceptableCandidate({ ...candidate("candidate_high"), risk: "high" })).toBe(false);
    expect(isBatchAcceptableCandidate({
      ...candidate("candidate_medium"),
      risk: "medium",
    })).toBe(true);
    const anchor = {
      ...candidate("candidate_anchor"),
      overlapCandidateIds: ["candidate_blocked"],
      overlapDecisionAnchorId: "candidate_anchor",
    };
    const blocked = {
      ...candidate("candidate_blocked"),
      overlapCandidateIds: ["candidate_anchor"],
      overlapDecisionAnchorId: "candidate_anchor",
    };
    expect(isBatchAcceptableCandidate(anchor)).toBe(true);
    expect(isBatchAcceptableCandidate(blocked)).toBe(false);
  });
});
