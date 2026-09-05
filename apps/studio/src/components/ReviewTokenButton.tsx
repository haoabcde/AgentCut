import { memo } from "react";
import type { ReviewToken } from "../api.js";
import { reviewReasonList } from "../review-reasons.js";

interface ReviewTokenButtonProps {
  token: ReviewToken;
  active: boolean;
  candidateSelected: boolean;
  manuallySelected: boolean;
  onActivate: (token: ReviewToken, extendSelection: boolean) => void;
  onSelectCandidate: (token: ReviewToken) => void;
}

export const ReviewTokenButton = memo(function ReviewTokenButton({
  token,
  active,
  candidateSelected,
  manuallySelected,
  onActivate,
  onSelectCandidate,
}: ReviewTokenButtonProps) {
  const reasons = reviewReasonList(token.reasonCodes, "、");
  const title = token.state === "committed_deleted"
    ? `已删除：${reasons}。点击定位，双击恢复本次提交。`
    : token.state.startsWith("candidate")
      ? `Agent 建议：${reasons}，风险 ${token.risk}`
      : "点击定位原片";
  return (
    <button
      type="button"
      className={`review-token ${token.state} ${active ? "active" : ""} ${candidateSelected ? "candidate-selected" : ""} ${manuallySelected ? "manual-selected" : ""}`}
      data-selected-candidate={candidateSelected ? "true" : undefined}
      title={title}
      aria-label={`${token.text}。${title}`}
      aria-pressed={manuallySelected}
      onClick={(event) => {
        onActivate(token, event.shiftKey);
        if (token.state !== "normal") onSelectCandidate(token);
      }}
    >
      {token.text}
    </button>
  );
});
