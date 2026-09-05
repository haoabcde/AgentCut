import { createHash } from "node:crypto";
import type {
  Actor,
  AsrProviderArtifact,
  Asset,
  TranscriptArtifact,
  TranscriptWord,
  Time,
} from "@agentcut/timeline-schema";

export interface RawAsrWord {
  word: string;
  start: number;
  end: number;
  probability?: number;
}

export interface RawAsrSegment {
  words?: RawAsrWord[];
  temperature?: number | null;
  compression_ratio?: number | null;
  avg_logprob?: number | null;
}

export interface RawAsrResult {
  text?: string;
  language?: string;
  segments: RawAsrSegment[];
}

export interface AsrNormalizationOptions {
  asset: Asset;
  audioStreamIndex: number;
  rawResult: RawAsrResult;
  rawResultUri: string;
  provider: string;
  model: string;
  providerVersion: string;
  actor: Actor;
  createdAt: string;
  streamDuration: Time;
}

export interface AsrQualityReport {
  inputWords: number;
  outputWords: number;
  droppedEmpty: number;
  droppedZeroDuration: number;
  droppedUnreliableSegments: number;
  droppedUnreliableWords: number;
  droppedOutOfBounds: number;
  clampedToMedia: number;
  clampedOverlaps: number;
  averageConfidence: number;
}

export interface NormalizedAsrArtifacts {
  providerArtifact: AsrProviderArtifact;
  transcript: TranscriptArtifact;
  quality: AsrQualityReport;
}

export class AsrNormalizationError extends Error {
  constructor(
    readonly code: "INVALID_PROVIDER_RESULT" | "NO_WORD_TIMESTAMPS",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AsrNormalizationError";
  }
}

export function normalizeAsrResult(options: AsrNormalizationOptions): NormalizedAsrArtifacts {
  if (!Array.isArray(options.rawResult.segments)) {
    throw new AsrNormalizationError("INVALID_PROVIDER_RESULT", "ASR segments must be an array");
  }
  const payloadHash = hashCanonical(options.rawResult);
  const providerArtifactId = `asr_${payloadHash.slice("sha256:".length, 24 + "sha256:".length)}`;
  const providerArtifact: AsrProviderArtifact = {
    id: providerArtifactId,
    kind: "asrProviderResult",
    assetId: options.asset.id,
    audioStreamIndex: options.audioStreamIndex,
    provider: options.provider,
    model: options.model,
    providerVersion: options.providerVersion,
    payloadHash,
    uri: options.rawResultUri,
    provenance: {
      createdBy: structuredClone(options.actor),
      createdAt: options.createdAt,
      reason: `Preserve raw ${options.provider} ASR output`,
    },
  };

  const words: TranscriptWord[] = [];
  let inputWords = 0;
  let droppedEmpty = 0;
  let droppedZeroDuration = 0;
  let droppedUnreliableSegments = 0;
  let droppedUnreliableWords = 0;
  let droppedOutOfBounds = 0;
  let clampedToMedia = 0;
  let clampedOverlaps = 0;
  let confidenceTotal = 0;
  let previousEndMicros = 0;
  const streamDurationMicros = timeToMicros(options.streamDuration);
  if (streamDurationMicros <= 0) {
    throw new AsrNormalizationError("INVALID_PROVIDER_RESULT", "ASR stream duration must be positive");
  }

  options.rawResult.segments.forEach((segment, segmentIndex) => {
    if (!Array.isArray(segment.words)) return;
    if (segment.words.length === 0) return;
    if (segmentIsUnreliable(segment)) {
      inputWords += segment.words.length;
      droppedUnreliableSegments += 1;
      droppedUnreliableWords += segment.words.length;
      return;
    }
    segment.words.forEach((rawWord, wordIndex) => {
      inputWords += 1;
      const text = rawWord.word.trim();
      if (!text) {
        droppedEmpty += 1;
        return;
      }
      assertFiniteSeconds(rawWord.start, "start");
      assertFiniteSeconds(rawWord.end, "end");
      let startMicros = Math.round(rawWord.start * 1_000_000);
      let endMicros = Math.round(rawWord.end * 1_000_000);
      if (startMicros >= streamDurationMicros) {
        droppedOutOfBounds += 1;
        return;
      }
      if (endMicros > streamDurationMicros) {
        endMicros = streamDurationMicros;
        clampedToMedia += 1;
      }
      if (startMicros < previousEndMicros) {
        startMicros = previousEndMicros;
        clampedOverlaps += 1;
      }
      if (endMicros <= startMicros) {
        droppedZeroDuration += 1;
        return;
      }
      const confidence = clampConfidence(rawWord.probability);
      const idSeed = [
        options.asset.contentHash,
        options.audioStreamIndex,
        segmentIndex,
        wordIndex,
      ].join(":");
      words.push({
        id: `word_${createHash("sha256").update(idSeed).digest("hex").slice(0, 24)}`,
        text,
        sourceRange: {
          start: { value: startMicros, rate: { numerator: 1_000_000, denominator: 1 } },
          duration: {
            value: endMicros - startMicros,
            rate: { numerator: 1_000_000, denominator: 1 },
          },
        },
        confidence,
      });
      confidenceTotal += confidence;
      previousEndMicros = endMicros;
    });
  });
  if (words.length === 0) {
    throw new AsrNormalizationError("NO_WORD_TIMESTAMPS", "ASR returned no usable word timestamps", {
      inputWords,
      droppedEmpty,
      droppedZeroDuration,
      droppedUnreliableSegments,
      droppedUnreliableWords,
      droppedOutOfBounds,
      clampedToMedia,
    });
  }

  const transcriptSeed = [
    options.asset.contentHash,
    options.audioStreamIndex,
    options.provider,
    options.model,
    payloadHash,
  ].join(":");
  const transcript: TranscriptArtifact = {
    id: `transcript_${createHash("sha256").update(transcriptSeed).digest("hex").slice(0, 24)}`,
    kind: "transcript",
    assetId: options.asset.id,
    language: options.rawResult.language || "zh-CN",
    audioStreamIndex: options.audioStreamIndex,
    providerArtifactId,
    words,
    provenance: {
      createdBy: structuredClone(options.actor),
      createdAt: options.createdAt,
      reason: `Normalize ${options.provider} word timestamps into AgentCut Transcript 0.1`,
      sourceArtifactIds: [providerArtifactId],
    },
  };
  return {
    providerArtifact,
    transcript,
    quality: {
      inputWords,
      outputWords: words.length,
      droppedEmpty,
      droppedZeroDuration,
      droppedUnreliableSegments,
      droppedUnreliableWords,
      droppedOutOfBounds,
      clampedToMedia,
      clampedOverlaps,
      averageConfidence: confidenceTotal / words.length,
    },
  };
}

function segmentIsUnreliable(segment: RawAsrSegment): boolean {
  return (typeof segment.temperature === "number" && segment.temperature >= 1)
    || (typeof segment.compression_ratio === "number" && segment.compression_ratio > 2.4)
    || (typeof segment.avg_logprob === "number" && segment.avg_logprob < -2);
}

function timeToMicros(time: Time): number {
  const seconds = time.value * time.rate.denominator / time.rate.numerator;
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new AsrNormalizationError("INVALID_PROVIDER_RESULT", "ASR stream duration is invalid");
  }
  return Math.round(seconds * 1_000_000);
}

function assertFiniteSeconds(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 1_000_000) {
    throw new AsrNormalizationError("INVALID_PROVIDER_RESULT", `ASR word ${field} is invalid`);
  }
}

function clampConfidence(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex")}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}
