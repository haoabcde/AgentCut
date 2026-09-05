import { useEffect } from "react";
import type { CandidateSelection } from "./api.js";
import { isPendingCandidate, shortcutForKey } from "./review-navigation.js";

export interface ReviewKeyboardOptions {
  candidate: CandidateSelection | undefined;
  busy: boolean;
  isLooping: boolean;
  cutPreviewActive: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onPreview: (candidate: CandidateSelection) => void;
  onStopPreview: () => void;
  onPreviewCut: (candidate: CandidateSelection) => void;
  onStopCutPreview: () => void;
  onAccept: (candidate: CandidateSelection) => void;
  onKeep: (candidate: CandidateSelection) => void;
  onUndo: (candidate: CandidateSelection) => void;
}

export function useReviewKeyboard(options: ReviewKeyboardOptions): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isTypingTarget(event.target)) return;
      const action = shortcutForKey(event.key, event);
      if (!action || options.busy) return;
      if (performReviewShortcut(options, action)) event.preventDefault();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [options]);
}

export function performReviewShortcut(
  options: ReviewKeyboardOptions,
  action: ReturnType<typeof shortcutForKey>,
): boolean {
  if (!action || options.busy) return false;
  if (action === "previous") {
    options.onPrevious();
    return true;
  }
  if (action === "next") {
    options.onNext();
    return true;
  }
  const candidate = options.candidate;
  if (!candidate) return false;
  if (action === "toggle_preview") {
    if (options.isLooping) options.onStopPreview();
    else options.onPreview(candidate);
    return true;
  }
  if (action === "toggle_cut_preview" && isPendingCandidate(candidate)) {
    if (options.cutPreviewActive) options.onStopCutPreview();
    else options.onPreviewCut(candidate);
    return true;
  }
  if (action === "accept" && isPendingCandidate(candidate)) {
    options.onAccept(candidate);
    return true;
  }
  if (action === "keep" && isPendingCandidate(candidate)) {
    options.onKeep(candidate);
    return true;
  }
  if (action === "undo"
    && (candidate.state === "committed_deleted" || candidate.state === "reviewed_keep")) {
    options.onUndo(candidate);
    return true;
  }
  return false;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable
    || target.tagName === "INPUT"
    || target.tagName === "TEXTAREA"
    || target.tagName === "SELECT"
    || target.tagName === "VIDEO"
    || target.tagName === "AUDIO";
}
