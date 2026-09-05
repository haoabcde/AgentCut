import type { ProjectStore } from "@agentcut/project-store";
import type { Actor, Asset, Time } from "@agentcut/timeline-schema";
import {
  normalizeAsrResult,
  type NormalizedAsrArtifacts,
  type RawAsrResult,
} from "./normalize.js";
import {
  AsrRunnerError,
  runMlxWhisper,
  type MlxWhisperRunOptions,
  type MlxWhisperRunResult,
} from "./runner.js";

export interface PersistedAsrJobOptions {
  store: ProjectStore;
  jobId: string;
  runner: MlxWhisperRunOptions;
  asset: Asset;
  audioStreamIndex: number;
  streamDuration: Time;
  rawResultUri: string;
  providerVersion: string;
  actor: Actor;
  transactionId: string;
  idempotencyKey: string;
  reason?: string;
  run?: (options: MlxWhisperRunOptions) => Promise<MlxWhisperRunResult>;
}

export async function runPersistedAsrJob(
  options: PersistedAsrJobOptions,
): Promise<NormalizedAsrArtifacts> {
  options.store.startJob(options.jobId);
  try {
    const run = options.run ?? runMlxWhisper;
    const result = await run(options.runner);
    const latest = options.store.getJob(options.jobId);
    if (latest.cancelRequested || options.runner.signal?.aborted) {
      if (!latest.cancelRequested) options.store.requestJobCancellation(options.jobId);
      options.store.markJobCancelled(options.jobId);
      throw new AsrRunnerError("CANCELLED", "ASR job was cancelled before artifact commit");
    }
    options.store.updateJobProgress(options.jobId, 0.95, { stage: "normalizing" });
    const normalized = normalizeAsrResult({
      asset: options.asset,
      audioStreamIndex: options.audioStreamIndex,
      rawResult: result.rawResult,
      rawResultUri: options.rawResultUri,
      provider: "mlx-whisper",
      model: options.runner.model,
      providerVersion: options.providerVersion,
      actor: options.actor,
      createdAt: new Date().toISOString(),
      streamDuration: options.streamDuration,
    });
    const document = options.store.snapshot();
    options.store.commit({
      protocolVersion: "0.1.0",
      transactionId: options.transactionId,
      idempotencyKey: options.idempotencyKey,
      projectId: document.project.id,
      sequenceId: document.project.activeSequenceId,
      baseRevision: document.project.revision,
      actor: options.actor,
      reason: options.reason ?? "Persist ASR provider output and normalized Transcript",
      preconditions: [{ type: "asset_online", assetId: options.asset.id }],
      operations: [
        { type: "artifact.put", artifact: normalized.providerArtifact },
        { type: "artifact.put", artifact: normalized.transcript },
      ],
    });
    options.store.succeedJob(options.jobId, [
      normalized.providerArtifact.id,
      normalized.transcript.id,
    ]);
    return normalized;
  } catch (error) {
    const job = options.store.getJob(options.jobId);
    if (job.status === "running") {
      if (job.cancelRequested || error instanceof AsrRunnerError && error.code === "CANCELLED") {
        if (!job.cancelRequested) options.store.requestJobCancellation(options.jobId);
        options.store.markJobCancelled(options.jobId);
      } else {
        options.store.failJob(
          options.jobId,
          {
            code: error instanceof AsrRunnerError ? error.code : "ASR_WORKFLOW_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
          { retryable: true },
        );
      }
    }
    throw error;
  }
}

export function providerWordCount(result: RawAsrResult): number {
  return result.segments.reduce((count, segment) => count + (segment.words?.length ?? 0), 0);
}
