import { createHash } from "node:crypto";
import { compareTime, convertTime, rangeEnd } from "@agentcut/timeline-engine";
import type {
  AgentCutProjectDocument,
  TimeRange,
  TranscriptArtifact,
  TranscriptWord,
} from "@agentcut/timeline-schema";

export interface SpeechGapProjection {
  gapId: string;
  clipId: string;
  sourceRange: TimeRange;
  timelineRange: TimeRange;
  previousWordId?: string;
  nextWordId?: string;
}

export interface SpeechGapProjectionOptions {
  minimumDurationMicros?: number;
}

const DEFAULT_MINIMUM_DURATION_MICROS = 150_000;

/**
 * Projects retained video that is not covered by any Transcript word.
 * Results are derived from the current Timeline clips, so already deleted
 * source never reappears as another selectable gap.
 */
export function buildSpeechGapProjection(
  document: AgentCutProjectDocument,
  transcriptId: string,
  options: SpeechGapProjectionOptions = {},
): SpeechGapProjection[] {
  const transcript = findTranscript(document, transcriptId);
  const minimumDuration = options.minimumDurationMicros ?? DEFAULT_MINIMUM_DURATION_MICROS;
  if (!Number.isSafeInteger(minimumDuration) || minimumDuration < 1) {
    throw new RangeError("Speech-gap minimum duration must be a positive safe integer");
  }
  const sequence = document.sequences.find((item) => item.id === document.project.activeSequenceId);
  if (!sequence) return [];
  const clips = sequence.tracks
    .filter((track) => track.enabled && track.kind === "video")
    .flatMap((track) => track.clips)
    .filter((clip) => clip.enabled && clip.assetId === transcript.assetId && clip.sourceRange)
    .sort((left, right) => compareTime(left.timelineRange.start, right.timelineRange.start));
  const gaps: SpeechGapProjection[] = [];
  for (const clip of clips) {
    if (!clip.sourceRange) continue;
    const sourceStart = toMicros(clip.sourceRange.start);
    const sourceEnd = toMicros(rangeEnd(clip.sourceRange));
    const timelineStart = toMicros(clip.timelineRange.start);
    const words = transcript.words
      .filter((word) => toMicros(rangeEnd(word.sourceRange)) > sourceStart
        && toMicros(word.sourceRange.start) < sourceEnd)
      .sort((left, right) => compareTime(left.sourceRange.start, right.sourceRange.start));
    let cursor = sourceStart;
    let previousWordId: string | undefined;
    for (const word of words) {
      const wordStart = Math.max(sourceStart, toMicros(word.sourceRange.start));
      const wordEnd = Math.min(sourceEnd, toMicros(rangeEnd(word.sourceRange)));
      addGap(gaps, {
        clipId: clip.id,
        sourceStart: cursor,
        sourceEnd: wordStart,
        timelineStart: timelineStart + cursor - sourceStart,
        minimumDuration,
        ...(previousWordId ? { previousWordId } : {}),
        nextWordId: word.id,
      });
      cursor = Math.max(cursor, wordEnd);
      previousWordId = word.id;
    }
    addGap(gaps, {
      clipId: clip.id,
      sourceStart: cursor,
      sourceEnd,
      timelineStart: timelineStart + cursor - sourceStart,
      minimumDuration,
      ...(previousWordId ? { previousWordId } : {}),
    });
  }
  return gaps;
}

function addGap(
  gaps: SpeechGapProjection[],
  input: {
    clipId: string;
    sourceStart: number;
    sourceEnd: number;
    timelineStart: number;
    minimumDuration: number;
    previousWordId?: string;
    nextWordId?: string;
  },
): void {
  const duration = input.sourceEnd - input.sourceStart;
  if (duration < input.minimumDuration) return;
  const sourceRange = microsRange(input.sourceStart, duration);
  gaps.push({
    gapId: `speech_gap_${digest(`${input.clipId}:${input.sourceStart}:${input.sourceEnd}`)}`,
    clipId: input.clipId,
    sourceRange,
    timelineRange: microsRange(input.timelineStart, duration),
    ...(input.previousWordId ? { previousWordId: input.previousWordId } : {}),
    ...(input.nextWordId ? { nextWordId: input.nextWordId } : {}),
  });
}

function findTranscript(
  document: AgentCutProjectDocument,
  transcriptId: string,
): TranscriptArtifact {
  const transcript = document.artifacts.find((artifact) => artifact.id === transcriptId);
  if (!transcript || transcript.kind !== "transcript") {
    throw new Error(`Transcript ${transcriptId} is missing`);
  }
  return transcript;
}

function toMicros(time: TranscriptWord["sourceRange"]["start"]): number {
  return convertTime(time, microsRate(), "nearest").value;
}

function microsRange(start: number, duration: number): TimeRange {
  return {
    start: { value: start, rate: microsRate() },
    duration: { value: duration, rate: microsRate() },
  };
}

function microsRate(): { numerator: 1_000_000; denominator: 1 } {
  return { numerator: 1_000_000, denominator: 1 };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
