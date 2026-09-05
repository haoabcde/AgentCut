import { compareTime, convertTime } from "@agentcut/timeline-engine";
import type {
  AgentCutProjectDocument,
  Clip,
  TimeRange,
  TranscriptArtifact,
} from "@agentcut/timeline-schema";
import type { PreviewPlan, RenderPlan } from "./types.js";
import { RenderError } from "./types.js";

export interface EvaluatedTimelineSegment {
  clipId: string;
  assetId: string;
  timelineStartMicros: number;
  sourceStartMicros: number;
  durationMicros: number;
}

export interface EvaluatedTimeline {
  durationMicros: number;
  segments: EvaluatedTimelineSegment[];
}

export function evaluateTimelineSegments(
  document: AgentCutProjectDocument,
  sequenceId: string,
  transcriptArtifactId: string,
): EvaluatedTimeline {
  const sequence = document.sequences.find((candidate) => candidate.id === sequenceId);
  if (!sequence) {
    throw new RenderError("UNSUPPORTED_TIMELINE", `Sequence ${sequenceId} does not exist`);
  }
  const transcript = document.artifacts.find((artifact) => artifact.id === transcriptArtifactId);
  if (!transcript || transcript.kind !== "transcript") {
    throw new RenderError("UNSUPPORTED_TIMELINE", `Transcript ${transcriptArtifactId} does not exist`);
  }
  const videoTracks = sequence.tracks.filter((track) => track.enabled && track.kind === "video");
  if (videoTracks.length !== 1) {
    throw new RenderError(
      "UNSUPPORTED_TIMELINE",
      "Alpha render supports exactly one enabled video track",
      { enabledVideoTracks: videoTracks.length },
    );
  }
  const track = videoTracks[0]!;
  if (track.transitions.length > 0) {
    throw new RenderError("UNSUPPORTED_TIMELINE", "Alpha render does not support transitions");
  }
  const clips = track.clips.filter((clip) => clip.enabled)
    .sort((left, right) => compareTime(left.timelineRange.start, right.timelineRange.start));
  if (clips.length === 0 || clips.some((clip) => clip.kind !== "media")) {
    throw new RenderError("UNSUPPORTED_TIMELINE", "Alpha render requires enabled media clips only");
  }
  const segments: EvaluatedTimelineSegment[] = [];
  let expectedTimelineStart = 0;
  for (const clip of clips) {
    assertSupportedClip(clip, transcript);
    const timelineStartMicros = toMicros(clip.timelineRange.start);
    const durationMicros = toMicros(clip.timelineRange.duration);
    const sourceStartMicros = toMicros(clip.sourceRange.start);
    if (timelineStartMicros !== expectedTimelineStart) {
      throw new RenderError(
        "UNSUPPORTED_TIMELINE",
        "Alpha render requires a contiguous, non-overlapping main track starting at zero",
        { clipId: clip.id, expectedTimelineStart, actualTimelineStart: timelineStartMicros },
      );
    }
    expectedTimelineStart += durationMicros;
    segments.push({
      clipId: clip.id,
      assetId: clip.assetId,
      timelineStartMicros,
      sourceStartMicros,
      durationMicros,
    });
  }
  return { durationMicros: expectedTimelineStart, segments };
}

export function createPreviewPlan(plan: RenderPlan): PreviewPlan {
  return {
    revision: plan.sourceRevision,
    planHash: plan.planHash,
    durationSeconds: seconds(plan.timelineDuration.value, plan.timelineDuration.rate),
    segments: plan.segments.map((segment) => ({
      clipId: segment.clipId,
      assetId: segment.assetId,
      timelineStartSeconds: segment.timelineStartMicros / 1_000_000,
      sourceStartSeconds: segment.sourceStartMicros / 1_000_000,
      durationSeconds: segment.durationMicros / 1_000_000,
    })),
  };
}

function seconds(value: number, rate: { numerator: number; denominator: number }): number {
  return value * rate.denominator / rate.numerator;
}

function assertSupportedClip(
  clip: Clip,
  transcript: TranscriptArtifact,
): asserts clip is Clip & { assetId: string; streamIndex: number; sourceRange: TimeRange } {
  if (clip.kind !== "media" || !clip.assetId || clip.streamIndex === undefined || !clip.sourceRange) {
    throw new RenderError("UNSUPPORTED_TIMELINE", `Clip ${clip.id} is not a complete media clip`);
  }
  if (clip.assetId !== transcript.assetId) {
    throw new RenderError(
      "UNSUPPORTED_TIMELINE",
      "Alpha render currently supports one transcript-bound source asset",
      { clipId: clip.id, assetId: clip.assetId, transcriptAssetId: transcript.assetId },
    );
  }
  if (compareTime(clip.timelineRange.duration, clip.sourceRange.duration) !== 0) {
    throw new RenderError("UNSUPPORTED_TIMELINE", `Time-warped clip ${clip.id} is unsupported`);
  }
  if (hasValues(clip.transform) || hasValues(clip.audio)
    || (clip.animations?.length ?? 0) > 0 || (clip.effects?.length ?? 0) > 0) {
    throw new RenderError(
      "UNSUPPORTED_TIMELINE",
      `Clip ${clip.id} uses effects outside the Alpha parity subset`,
    );
  }
}

function hasValues(value: Record<string, unknown> | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function toMicros(time: TimeRange["start"]): number {
  return convertTime(time, microsRate(), "nearest").value;
}

function microsRate(): { numerator: 1_000_000; denominator: 1 } {
  return { numerator: 1_000_000, denominator: 1 };
}
