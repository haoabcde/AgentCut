import type { PreviewSegment } from "./api.js";

export interface PreviewSourcePosition {
  segmentIndex: number;
  sourceSeconds: number;
}

export interface PreviewPlaybackProjection {
  segmentIndex: number;
  timelineSeconds: number;
  jumpToSourceSeconds?: number;
  ended: boolean;
}

export interface PreviewTimelinePosition {
  segmentIndex: number;
  timelineSeconds: number;
}

export function candidateCutLoopWindow(
  segments: readonly PreviewSegment[],
  candidateSourceEndSeconds: number,
  previewDurationSeconds: number,
  contextSeconds = 1.5,
): { startSeconds: number; endSeconds: number } {
  const rightSegment = segments.find((segment) =>
    segment.sourceStartSeconds >= candidateSourceEndSeconds - 0.000_001,
  );
  const boundary = rightSegment?.timelineStartSeconds ?? previewDurationSeconds;
  return {
    startSeconds: Math.max(0, boundary - contextSeconds),
    endSeconds: Math.min(previewDurationSeconds, boundary + contextSeconds),
  };
}

export function timelineToSource(
  segments: readonly PreviewSegment[],
  requestedTimelineSeconds: number,
): PreviewSourcePosition {
  if (segments.length === 0) throw new Error("Preview has no playable segments");
  const timelineSeconds = Math.max(0, requestedTimelineSeconds);
  const segmentIndex = segments.findIndex((segment, index) => {
    const end = segment.timelineStartSeconds + segment.durationSeconds;
    return timelineSeconds >= segment.timelineStartSeconds
      && (timelineSeconds < end || index === segments.length - 1);
  });
  const resolvedIndex = segmentIndex < 0 ? segments.length - 1 : segmentIndex;
  const segment = segments[resolvedIndex]!;
  const offset = Math.min(
    segment.durationSeconds,
    Math.max(0, timelineSeconds - segment.timelineStartSeconds),
  );
  return {
    segmentIndex: resolvedIndex,
    sourceSeconds: segment.sourceStartSeconds + offset,
  };
}

export function projectSourcePlayback(
  segments: readonly PreviewSegment[],
  currentSegmentIndex: number,
  sourceSeconds: number,
): PreviewPlaybackProjection {
  const segment = segments[currentSegmentIndex];
  if (!segment) throw new Error("Preview segment is no longer available");
  const sourceEnd = segment.sourceStartSeconds + segment.durationSeconds;
  if (sourceSeconds >= sourceEnd) {
    const next = segments[currentSegmentIndex + 1];
    if (next) {
      return {
        segmentIndex: currentSegmentIndex + 1,
        timelineSeconds: next.timelineStartSeconds,
        jumpToSourceSeconds: next.sourceStartSeconds,
        ended: false,
      };
    }
    return {
      segmentIndex: currentSegmentIndex,
      timelineSeconds: segment.timelineStartSeconds + segment.durationSeconds,
      ended: true,
    };
  }
  return {
    segmentIndex: currentSegmentIndex,
    timelineSeconds: segment.timelineStartSeconds
      + Math.max(0, sourceSeconds - segment.sourceStartSeconds),
    ended: false,
  };
}

export function sourceToTimeline(
  segments: readonly PreviewSegment[],
  sourceSeconds: number,
): PreviewTimelinePosition | undefined {
  const segmentIndex = segments.findIndex((segment, index) => {
    const end = segment.sourceStartSeconds + segment.durationSeconds;
    return sourceSeconds >= segment.sourceStartSeconds
      && (sourceSeconds < end || index === segments.length - 1 && sourceSeconds === end);
  });
  if (segmentIndex < 0) return undefined;
  const segment = segments[segmentIndex]!;
  return {
    segmentIndex,
    timelineSeconds: segment.timelineStartSeconds + sourceSeconds - segment.sourceStartSeconds,
  };
}

/**
 * Projects any source position onto the canonical edited timeline.
 * Retained source maps normally; deleted source collapses onto the following
 * cut boundary (or the final timeline end when it trails the last segment).
 */
export function sourceToTimelineAnchor(
  segments: readonly PreviewSegment[],
  sourceSeconds: number,
): PreviewTimelinePosition | undefined {
  const retained = sourceToTimeline(segments, sourceSeconds);
  if (retained) return retained;
  if (segments.length === 0) return undefined;
  const nextIndex = segments.findIndex((segment) => segment.sourceStartSeconds >= sourceSeconds);
  if (nextIndex >= 0) {
    return {
      segmentIndex: nextIndex,
      timelineSeconds: segments[nextIndex]!.timelineStartSeconds,
    };
  }
  const finalIndex = segments.length - 1;
  const final = segments[finalIndex]!;
  return {
    segmentIndex: finalIndex,
    timelineSeconds: final.timelineStartSeconds + final.durationSeconds,
  };
}
