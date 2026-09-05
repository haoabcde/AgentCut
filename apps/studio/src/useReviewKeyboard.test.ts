import { describe, expect, it, vi } from "vitest";
import type { CandidateSelection } from "./api.js";
import {
  performReviewShortcut,
  type ReviewKeyboardOptions,
} from "./useReviewKeyboard.js";

const pendingCandidate: CandidateSelection = {
  candidateId: "candidate_pending",
  targetKind: "gap",
  sourceRange: {
    start: { value: 2_000, rate: { numerator: 1_000, denominator: 1 } },
    duration: { value: 400, rate: { numerator: 1_000, denominator: 1 } },
  },
  wordIds: [],
  state: "candidate_remove",
  reasonCodes: ["silence"],
  risk: "medium",
  confidence: 0.85,
  explanationZh: "测试候选",
};

describe("review keyboard dispatch", () => {
  it("toggles the pending candidate deletion-effect preview with B", () => {
    const options = createOptions();
    expect(performReviewShortcut(options, "toggle_cut_preview")).toBe(true);
    expect(options.onPreviewCut).toHaveBeenCalledWith(pendingCandidate);

    const active = createOptions({ cutPreviewActive: true });
    expect(performReviewShortcut(active, "toggle_cut_preview")).toBe(true);
    expect(active.onStopCutPreview).toHaveBeenCalledOnce();
    expect(active.onPreviewCut).not.toHaveBeenCalled();
  });

  it("does not expose deletion-effect playback for a decided candidate", () => {
    const options = createOptions({
      candidate: { ...pendingCandidate, state: "committed_deleted", transactionId: "tx_1" },
    });
    expect(performReviewShortcut(options, "toggle_cut_preview")).toBe(false);
    expect(options.onPreviewCut).not.toHaveBeenCalled();
  });
});

function createOptions(
  overrides: Partial<ReviewKeyboardOptions> = {},
): ReviewKeyboardOptions {
  return {
    candidate: pendingCandidate,
    busy: false,
    isLooping: false,
    cutPreviewActive: false,
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onPreview: vi.fn(),
    onStopPreview: vi.fn(),
    onPreviewCut: vi.fn(),
    onStopCutPreview: vi.fn(),
    onAccept: vi.fn(),
    onKeep: vi.fn(),
    onUndo: vi.fn(),
    ...overrides,
  };
}
