import { createHash } from "node:crypto";
import {
  addTime,
  compareTime,
  convertTime,
  rangeEnd,
  rangesOverlap,
  subtractTime,
} from "@agentcut/timeline-engine";
import type {
  AgentCutProjectDocument,
  CaptionCue,
  Clip,
  TimeRange,
  TranscriptArtifact,
  TranscriptWord,
} from "@agentcut/timeline-schema";
import { RenderError } from "./types.js";

export interface MappedTranscriptWord {
  word: TranscriptWord;
  clipId: string;
  timelineRange: TimeRange;
}

export interface TranscriptTimelineMapping {
  words: MappedTranscriptWord[];
  removedWordIds: string[];
  partialWordIds: string[];
}

export interface CaptionGenerationOptions {
  maximumCharacters?: number;
  maximumDurationMillis?: number;
  maximumGapMillis?: number;
}

export function mapTranscriptToTimeline(
  document: AgentCutProjectDocument,
  transcriptArtifactId: string,
  sequenceId: string,
): TranscriptTimelineMapping {
  const transcript = findTranscript(document, transcriptArtifactId);
  const sequence = document.sequences.find((candidate) => candidate.id === sequenceId);
  if (!sequence) throw new RenderError("UNSUPPORTED_TIMELINE", `Sequence ${sequenceId} does not exist`);
  const clips = sequence.tracks
    .filter((track) => track.enabled && track.kind === "video")
    .flatMap((track) => track.clips)
    .filter((clip): clip is Clip & { assetId: string; sourceRange: TimeRange } =>
      clip.enabled && clip.kind === "media" && clip.assetId === transcript.assetId
        && clip.sourceRange !== undefined,
    )
    .sort((left, right) => compareTime(left.timelineRange.start, right.timelineRange.start));
  const mapped: MappedTranscriptWord[] = [];
  const mappedIds = new Set<string>();
  const partialIds = new Set<string>();
  for (const clip of clips) {
    if (compareTime(clip.timelineRange.duration, clip.sourceRange.duration) !== 0) {
      throw new RenderError("UNSUPPORTED_TIMELINE", `Time-warped clip ${clip.id} cannot map captions`);
    }
    for (const word of transcript.words) {
      if (rangeContains(clip.sourceRange, word.sourceRange)) {
        if (mappedIds.has(word.id)) {
          throw new RenderError(
            "UNSUPPORTED_TIMELINE",
            `Transcript word ${word.id} maps to more than one enabled clip`,
          );
        }
        mappedIds.add(word.id);
        mapped.push({
          word,
          clipId: clip.id,
          timelineRange: mapSourceRangeToTimeline(clip, word.sourceRange),
        });
      } else if (rangesOverlap(clip.sourceRange, word.sourceRange)) {
        partialIds.add(word.id);
      }
    }
  }
  mapped.sort((left, right) => compareTime(left.timelineRange.start, right.timelineRange.start));
  return {
    words: mapped,
    removedWordIds: transcript.words.filter((word) => !mappedIds.has(word.id)).map((word) => word.id),
    partialWordIds: [...partialIds].filter((wordId) => !mappedIds.has(wordId)),
  };
}

export function generateCaptionCues(
  mappedWords: MappedTranscriptWord[],
  options: CaptionGenerationOptions = {},
): CaptionCue[] {
  const maximumCharacters = options.maximumCharacters ?? 16;
  const maximumDurationMillis = options.maximumDurationMillis ?? 5_000;
  const maximumGapMillis = options.maximumGapMillis ?? 800;
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 4
    || !Number.isSafeInteger(maximumDurationMillis) || maximumDurationMillis < 500
    || !Number.isSafeInteger(maximumGapMillis) || maximumGapMillis < 0) {
    throw new RenderError("INVALID_CONFIGURATION", "Caption limits are invalid");
  }
  const groups: MappedTranscriptWord[][] = [];
  let current: MappedTranscriptWord[] = [];
  for (const mapped of mappedWords) {
    const previous = current.at(-1);
    const proposed = [...current, mapped];
    const shouldSplit = previous !== undefined && (
      previous.clipId !== mapped.clipId
      || gapMillis(previous.timelineRange, mapped.timelineRange) > maximumGapMillis
      || durationMillis(proposed[0]!.timelineRange.start, rangeEnd(mapped.timelineRange))
        > maximumDurationMillis
      || captionText(proposed.map((item) => item.word)).length > maximumCharacters
      || /[。！？!?]$/.test(previous.word.text.trim())
    );
    if (shouldSplit) {
      groups.push(current);
      current = [];
    }
    current.push(mapped);
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group) => {
    const first = group[0]!;
    const last = group.at(-1)!;
    const start = convertTime(first.timelineRange.start, microsRate(), "nearest");
    const end = convertTime(rangeEnd(last.timelineRange), microsRate(), "nearest");
    const wordIds = group.map((item) => item.word.id);
    const text = captionText(group.map((item) => item.word));
    const seed = `${wordIds.join(":")}:${start.value}:${end.value}:${text}`;
    return {
      id: `caption_cue_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`,
      text,
      wordIds,
      timelineRange: {
        start,
        duration: { value: end.value - start.value, rate: microsRate() },
      },
    };
  });
}

export function formatSrt(cues: CaptionCue[]): string {
  return `${cues.map((cue, index) => {
    const start = toMicros(cue.timelineRange.start);
    const end = start + toMicros(cue.timelineRange.duration);
    return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${cue.text}`;
  }).join("\n\n")}\n`;
}

export function formatAss(cues: CaptionCue[], width: number, height: number): string {
  const fontSize = Math.max(24, Math.round(height * 0.05));
  const marginVertical = Math.max(28, Math.round(height * 0.07));
  const events = cues.map((cue) => {
    const start = toMicros(cue.timelineRange.start);
    const end = start + toMicros(cue.timelineRange.duration);
    return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${escapeAss(cue.text)}`;
  });
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,PingFang SC,${fontSize},&H00FFFFFF,&H000000FF,&H00151515,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,48,48,${marginVertical},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

function findTranscript(document: AgentCutProjectDocument, id: string): TranscriptArtifact {
  const transcript = document.artifacts.find((artifact) => artifact.id === id);
  if (!transcript || transcript.kind !== "transcript") {
    throw new RenderError("UNSUPPORTED_TIMELINE", `Transcript ${id} does not exist`);
  }
  return transcript;
}

function mapSourceRangeToTimeline(clip: Clip & { sourceRange: TimeRange }, range: TimeRange): TimeRange {
  const sourceStart = convertTime(range.start, microsRate(), "nearest");
  const clipSourceStart = convertTime(clip.sourceRange.start, microsRate(), "nearest");
  const timelineStart = convertTime(clip.timelineRange.start, microsRate(), "nearest");
  return {
    start: {
      value: timelineStart.value + sourceStart.value - clipSourceStart.value,
      rate: microsRate(),
    },
    duration: convertTime(range.duration, microsRate(), "nearest"),
  };
}

function rangeContains(container: TimeRange, child: TimeRange): boolean {
  return compareTime(container.start, child.start) <= 0
    && compareTime(rangeEnd(container), rangeEnd(child)) >= 0;
}

function gapMillis(previous: TimeRange, next: TimeRange): number {
  return Math.max(0, durationMillis(rangeEnd(previous), next.start));
}

function durationMillis(start: TimeRange["start"], end: TimeRange["start"]): number {
  return toMicros(subtractTime(end, start, microsRate(), "nearest")) / 1_000;
}

function captionText(words: TranscriptWord[]): string {
  let result = "";
  for (const word of words) {
    const text = word.text.trim();
    if (!text) continue;
    const needsSpace = result.length > 0 && /[A-Za-z0-9]$/.test(result) && /^[A-Za-z0-9]/.test(text);
    result += `${needsSpace ? " " : ""}${text}`;
  }
  return result;
}

function formatSrtTime(micros: number): string {
  const millis = Math.round(micros / 1_000);
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor(millis % 3_600_000 / 60_000);
  const seconds = Math.floor(millis % 60_000 / 1_000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${String(millis % 1_000).padStart(3, "0")}`;
}

function formatAssTime(micros: number): string {
  const centis = Math.round(micros / 10_000);
  const hours = Math.floor(centis / 360_000);
  const minutes = Math.floor(centis % 360_000 / 6_000);
  const seconds = Math.floor(centis % 6_000 / 100);
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${String(centis % 100).padStart(2, "0")}`;
}

function escapeAss(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("{", "\\{").replaceAll("}", "\\}")
    .replaceAll("\n", "\\N");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function microsRate(): { numerator: 1_000_000; denominator: 1 } {
  return { numerator: 1_000_000, denominator: 1 };
}

function toMicros(time: TimeRange["start"]): number {
  return convertTime(time, microsRate(), "nearest").value;
}
