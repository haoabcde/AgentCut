import type { ReviewGap, ReviewToken } from "./api.js";

export function contiguousWordSelection(
  transcriptWordIds: readonly string[],
  anchorWordId: string,
  targetWordId: string,
): string[] {
  const anchorIndex = transcriptWordIds.indexOf(anchorWordId);
  const targetIndex = transcriptWordIds.indexOf(targetWordId);
  if (anchorIndex < 0 || targetIndex < 0) {
    throw new Error("Selection word was not found in the active transcript");
  }
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return transcriptWordIds.slice(start, end + 1);
}

export interface ManualSelectionValidation {
  valid: boolean;
  message?: string;
}

export function validateManualDeletionSelection(
  tokens: readonly ReviewToken[],
  gaps: readonly ReviewGap[],
  selectedWordIds: readonly string[],
): ManualSelectionValidation {
  if (selectedWordIds.length === 0) {
    return { valid: false, message: "请先连续选择至少一个词。" };
  }
  const selected = new Set(selectedWordIds);
  const selectedTokens = tokens.filter((token) => selected.has(token.wordId));
  if (selectedTokens.length !== selectedWordIds.length) {
    return { valid: false, message: "选择范围已不属于当前 Transcript，请重新选择。" };
  }
  const blockedToken = selectedTokens.find((token) => token.state !== "normal");
  if (blockedToken) {
    return {
      valid: false,
      message: blockedToken.state === "committed_deleted"
        ? "范围包含已删除文字；请先恢复该删除，或只选择仍在当前初剪中的普通文字。"
        : blockedToken.state === "reviewed_keep"
          ? "范围包含已锁定保留文字；请先重新审阅解除保护，或缩小选择范围。"
          : "范围包含待审 AI 候选；请先在候选检查器中决定该项，或只选择普通文字。",
    };
  }
  const blockedGap = gaps.find((gap) =>
    gap.previousWordId !== undefined
    && gap.nextWordId !== undefined
    && selected.has(gap.previousWordId)
    && selected.has(gap.nextWordId)
  );
  if (blockedGap) {
    return {
      valid: false,
      message: blockedGap.state === "committed_deleted"
        ? "范围跨过已删除停顿，不能再次作为一段删除；请缩小到同一保留片段。"
        : blockedGap.state === "reviewed_keep"
          ? "范围跨过已锁定停顿；请先重新审阅解除保护，或缩小选择范围。"
          : "范围跨过待审停顿候选；请先决定该候选，或缩小选择范围。",
    };
  }
  return { valid: true };
}
