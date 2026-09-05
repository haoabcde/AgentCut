import type { CommandRecord } from "@agentcut/edit-commands";
import type { SpeechGapProjection } from "./speech-gaps.js";
import type { TranscriptReviewProjection } from "./transcript-review.js";

export interface RoughCutUndoTarget {
  transactionId: string;
  committedRevision: number;
  removedDurationSeconds: number;
  labelZh: string;
}

export interface RoughCutReadiness {
  candidatesPending: number;
  candidatesDecided: boolean;
  speechGapsRemaining: number;
  exportSucceeded: boolean;
  exportStale: boolean;
  exportUpToDate: boolean;
  undo: RoughCutUndoTarget | null;
}

export interface RoughCutReadinessInput {
  review: TranscriptReviewProjection;
  speechGaps: SpeechGapProjection[];
  currentRevision: number;
  exports: Array<{ status: string; sourceRevision: number }>;
  records: CommandRecord[];
}

/**
 * Derives the independent rough-cut readiness signals so that "no pending
 * candidates" is never conflated with "the cut is reviewed and exported".
 * Also resolves the single most recent still-restorable deletion so the UI
 * can offer a global undo without scanning the command log itself.
 */
export function buildRoughCutReadiness(input: RoughCutReadinessInput): RoughCutReadiness {
  const candidatesPending = input.review.candidates.filter((candidate) =>
    candidate.state === "candidate_remove" || candidate.state === "candidate_keep",
  ).length;
  const latestSucceededRevision = input.exports
    .filter((job) => job.status === "succeeded")
    .map((job) => job.sourceRevision)
    .sort((left, right) => right - left)[0];
  const exportSucceeded = latestSucceededRevision !== undefined;
  // A succeeded export registers its artifacts in the following revision, so the
  // downloadable file represents the current cut while currentRevision <= sourceRevision + 1.
  const exportUpToDate = exportSucceeded && latestSucceededRevision + 1 >= input.currentRevision;
  return {
    candidatesPending,
    candidatesDecided: candidatesPending === 0,
    speechGapsRemaining: input.speechGaps.length,
    exportSucceeded,
    exportStale: exportSucceeded && !exportUpToDate,
    exportUpToDate,
    undo: findLatestRestorableDeletion(input.review, input.records),
  };
}

function findLatestRestorableDeletion(
  review: TranscriptReviewProjection,
  records: CommandRecord[],
): RoughCutUndoTarget | null {
  const committedRevisionByTransaction = new Map(
    records.map((record) => [record.transactionId, record.committedRevision]),
  );
  // A batch deletion shares one transactionId across several candidates; merge
  // them so undo restores the whole batch and reports the total removed time.
  const restorableByTransaction = new Map<string, RoughCutUndoTarget>();
  for (const candidate of review.candidates) {
    if (candidate.state !== "committed_deleted" || !candidate.restorable || !candidate.transactionId) {
      continue;
    }
    const committedRevision = committedRevisionByTransaction.get(candidate.transactionId);
    if (committedRevision === undefined) continue;
    const removedDurationSeconds = timeRangeSeconds(candidate.sourceRange.duration);
    const labelZh = candidate.targetKind === "gap" ? "无口播画面" : "口播内容";
    const existing = restorableByTransaction.get(candidate.transactionId);
    if (existing) {
      existing.removedDurationSeconds += removedDurationSeconds;
    } else {
      restorableByTransaction.set(candidate.transactionId, {
        transactionId: candidate.transactionId,
        committedRevision,
        removedDurationSeconds,
        labelZh,
      });
    }
  }
  let latest: RoughCutUndoTarget | null = null;
  for (const target of restorableByTransaction.values()) {
    if (!latest || target.committedRevision > latest.committedRevision) latest = target;
  }
  return latest;
}

function timeRangeSeconds(time: { value: number; rate: { numerator: number; denominator: number } }): number {
  return time.value * time.rate.denominator / time.rate.numerator;
}
