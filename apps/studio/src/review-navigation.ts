import type { AlphaAuditResponse, CandidateSelection } from "./api.js";

export type ReviewShortcut =
  | "previous"
  | "next"
  | "toggle_preview"
  | "toggle_cut_preview"
  | "accept"
  | "keep"
  | "undo";

export function shortcutForKey(
  key: string,
  modifiers: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {},
): ReviewShortcut | undefined {
  if (modifiers.altKey || modifiers.ctrlKey || modifiers.metaKey) return undefined;
  if (key === "ArrowLeft") return "previous";
  if (key === "ArrowRight") return "next";
  if (key === " ") return "toggle_preview";
  if (key.toLowerCase() === "b") return "toggle_cut_preview";
  if (key.toLowerCase() === "d") return "accept";
  if (key.toLowerCase() === "k") return "keep";
  if (key.toLowerCase() === "u") return "undo";
  return undefined;
}

export function selectRelativeCandidateId(
  candidates: CandidateSelection[],
  selectedCandidateId: string | undefined,
  direction: -1 | 1,
): string | undefined {
  if (candidates.length === 0) return undefined;
  const selected = candidates.find((candidate) => candidate.candidateId === selectedCandidateId);
  const pending = candidates.filter(isPendingCandidate);
  const navigationCandidates = pending.length > 0 && (!selected || isPendingCandidate(selected))
    ? pending
    : candidates;
  const currentIndex = navigationCandidates.findIndex((candidate) =>
    candidate.candidateId === selectedCandidateId,
  );
  if (currentIndex < 0) {
    return navigationCandidates[direction === 1 ? 0 : navigationCandidates.length - 1]!.candidateId;
  }
  return navigationCandidates[
    (currentIndex + direction + navigationCandidates.length) % navigationCandidates.length
  ]!.candidateId;
}

export function nextPendingCandidateId(
  candidates: CandidateSelection[],
  reviewedCandidateId: string,
): string | undefined {
  if (candidates.length === 0) return undefined;
  const currentIndex = candidates.findIndex((candidate) =>
    candidate.candidateId === reviewedCandidateId,
  );
  for (let offset = 1; offset < candidates.length; offset += 1) {
    const index = (Math.max(currentIndex, 0) + offset) % candidates.length;
    const candidate = candidates[index]!;
    if (isPendingCandidate(candidate)) return candidate.candidateId;
  }
  return undefined;
}

export function nextUnlabeledAlphaCandidateId(
  candidates: AlphaAuditResponse["audit"]["candidates"],
  currentCandidateId: string,
): string | undefined {
  const currentIndex = candidates.findIndex((candidate) => candidate.candidateId === currentCandidateId);
  if (currentIndex < 0) return candidates.find((candidate) => candidate.humanLabel === null)?.candidateId;
  for (let offset = 1; offset < candidates.length; offset += 1) {
    const candidate = candidates[(currentIndex + offset) % candidates.length];
    if (candidate?.humanLabel === null) return candidate.candidateId;
  }
  return undefined;
}

export function isPendingCandidate(candidate: CandidateSelection): boolean {
  return candidate.state === "candidate_remove" || candidate.state === "candidate_keep";
}

export function isActionablePendingCandidate(candidate: CandidateSelection): boolean {
  return isPendingCandidate(candidate)
    && (candidate.overlapDecisionAnchorId === undefined
      || candidate.overlapDecisionAnchorId === candidate.candidateId);
}

export function isBatchAcceptableCandidate(candidate: CandidateSelection): boolean {
  return isActionablePendingCandidate(candidate) && candidate.risk !== "high";
}

export function candidatePosition(
  candidates: CandidateSelection[],
  selectedCandidateId: string | undefined,
): { current: number; total: number; scope: "pending" | "all" } {
  const selected = candidates.find((candidate) => candidate.candidateId === selectedCandidateId);
  const pending = candidates.filter(isPendingCandidate);
  const scopedCandidates = selected && isPendingCandidate(selected) ? pending : candidates;
  const index = scopedCandidates.findIndex((candidate) => candidate.candidateId === selectedCandidateId);
  return {
    current: index < 0 ? 0 : index + 1,
    total: scopedCandidates.length,
    scope: selected && isPendingCandidate(selected) ? "pending" : "all",
  };
}

export function reviewDecisionCounts(candidates: CandidateSelection[]): {
  pending: number;
  kept: number;
  committed: number;
} {
  return candidates.reduce((counts, candidate) => {
    if (isPendingCandidate(candidate)) counts.pending += 1;
    else if (candidate.state === "reviewed_keep") counts.kept += 1;
    else if (candidate.state === "committed_deleted") counts.committed += 1;
    return counts;
  }, { pending: 0, kept: 0, committed: 0 });
}
