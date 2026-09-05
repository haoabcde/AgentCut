import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReviewToken } from "../api.js";
import { ReviewTokenButton } from "./ReviewTokenButton.js";

describe("ReviewTokenButton", () => {
  it("uses Chinese reason labels for committed and candidate transcript text", () => {
    const committed = renderToken({ state: "committed_deleted", reasonCodes: ["restatement"] });
    expect(committed).toContain("已删除：重说");
    expect(committed).not.toContain("restatement");

    const candidate = renderToken({ state: "candidate_remove", reasonCodes: ["correction"] });
    expect(candidate).toContain("Agent 建议：说错纠正");
    expect(candidate).not.toContain("correction");
  });
});

function renderToken(overrides: Partial<ReviewToken>): string {
  const token: ReviewToken = {
    wordId: "word_001",
    text: "测试",
    sourceRange: {
      start: { value: 1_000, rate: { numerator: 1_000, denominator: 1 } },
      duration: { value: 500, rate: { numerator: 1_000, denominator: 1 } },
    },
    state: "normal",
    decoration: "none",
    candidateIds: [],
    reasonCodes: [],
    restorable: false,
    ...overrides,
  };
  return renderToStaticMarkup(
    <ReviewTokenButton
      token={token}
      active={false}
      candidateSelected={false}
      manuallySelected={false}
      onActivate={vi.fn()}
      onSelectCandidate={vi.fn()}
    />,
  );
}
