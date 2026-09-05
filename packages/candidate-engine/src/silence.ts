import { basename } from "node:path";
import { spawnSync } from "node:child_process";
import type { TimeRange } from "@agentcut/timeline-schema";

export interface SilenceDetectionOptions {
  ffmpegPath?: string;
  noiseDb?: number;
  minimumDurationSeconds?: number;
}

export class CandidateDetectionError extends Error {
  constructor(
    readonly code:
      | "SILENCE_ANALYSIS_FAILED"
      | "INVALID_SILENCE_OUTPUT"
      | "NO_CANDIDATES"
      | "CANDIDATE_UNAVAILABLE"
      | "CANDIDATE_ALREADY_REVIEWED"
      | "HIGH_RISK_CONFIRMATION_REQUIRED"
      | "APPROVAL_NOT_REQUIRED"
      | "INVALID_SELECTION",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CandidateDetectionError";
  }
}

export function detectSilences(
  mediaPath: string,
  options: SilenceDetectionOptions = {},
): TimeRange[] {
  const noiseDb = options.noiseDb ?? -40;
  const minimumDuration = options.minimumDurationSeconds ?? 0.5;
  if (!Number.isFinite(noiseDb) || !Number.isFinite(minimumDuration) || minimumDuration <= 0) {
    throw new RangeError("Silence detection thresholds must be finite and duration must be positive");
  }
  const result = spawnSync(options.ffmpegPath ?? "ffmpeg", [
    "-hide_banner", "-nostats", "-i", mediaPath,
    "-vn", "-af", `silencedetect=noise=${noiseDb}dB:d=${minimumDuration}`,
    "-f", "null", "-",
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new CandidateDetectionError(
      "SILENCE_ANALYSIS_FAILED",
      `Could not analyze silence in ${basename(mediaPath)}`,
      { cause: result.error?.message ?? result.stderr.slice(-4_000) },
    );
  }

  const ranges: TimeRange[] = [];
  let pendingStart: number | undefined;
  for (const line of result.stderr.split(/\r?\n/)) {
    const startMatch = /silence_start:\s*([0-9]+(?:\.[0-9]+)?)/.exec(line);
    if (startMatch) {
      pendingStart = secondsToMicros(startMatch[1]!);
      continue;
    }
    const endMatch = /silence_end:\s*([0-9]+(?:\.[0-9]+)?)/.exec(line);
    if (!endMatch || pendingStart === undefined) continue;
    const end = secondsToMicros(endMatch[1]!);
    if (end > pendingStart) {
      ranges.push({
        start: { value: pendingStart, rate: { numerator: 1_000_000, denominator: 1 } },
        duration: { value: end - pendingStart, rate: { numerator: 1_000_000, denominator: 1 } },
      });
    }
    pendingStart = undefined;
  }
  return ranges;
}

function secondsToMicros(value: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new CandidateDetectionError(
      "INVALID_SILENCE_OUTPUT",
      `Invalid silence timestamp ${value}`,
    );
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const micros = BigInt(whole) * 1_000_000n
    + BigInt(fraction.slice(0, 6).padEnd(6, "0") || "0");
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CandidateDetectionError("INVALID_SILENCE_OUTPUT", "Silence timestamp is too large");
  }
  return Number(micros);
}
