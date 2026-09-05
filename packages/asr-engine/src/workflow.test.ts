import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "@agentcut/project-store";
import { assertProjectDocument, type AgentCutProjectDocument } from "@agentcut/timeline-schema";
import { afterEach, describe, expect, it } from "vitest";
import { runPersistedAsrJob } from "./workflow.js";

const directories: string[] = [];

function fixture(): AgentCutProjectDocument {
  const url = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(url, "utf8"));
  assertProjectDocument(value);
  return structuredClone(value);
}

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentcut-asr-workflow-"));
  directories.push(directory);
  return join(directory, "project.sqlite");
}

afterEach(() => directories.splice(0).forEach((directory) => {
  rmSync(directory, { recursive: true, force: true });
}));

describe("persisted ASR workflow", () => {
  it("moves a job through running, artifact commit, and succeeded atomically", async () => {
    const document = fixture();
    const asset = document.assets[0];
    if (!asset) throw new Error("Fixture asset is missing");
    const store = ProjectStore.create(path(), document, {
      clock: () => "2026-07-18T06:00:00Z",
      checkpointInterval: 1,
    });
    store.createJob({
      id: "job_asr_success",
      type: "asr.transcribe",
      payload: { assetId: asset.id },
      maxAttempts: 2,
    });
    const normalized = await runPersistedAsrJob({
      store,
      jobId: "job_asr_success",
      runner: {
        pythonPath: "python",
        workerScriptPath: "worker.py",
        inputPath: "input.wav",
        outputPath: "output.json",
        model: "mlx-community/whisper-large-v3-turbo",
      },
      asset,
      audioStreamIndex: 0,
      streamDuration: { value: 10, rate: { numerator: 1, denominator: 1 } },
      rawResultUri: "artifacts/raw.json",
      providerVersion: "0.4.3",
      actor: { kind: "workflow", id: "asr_job" },
      transactionId: "tx_asr_artifacts",
      idempotencyKey: "asr-artifacts",
      run: async () => ({
        stderr: "",
        rawResult: {
          language: "zh",
          segments: [{ words: [{ word: "测试", start: 1, end: 1.5, probability: 0.99 }] }],
        },
      }),
    });
    expect(store.getJob("job_asr_success")).toEqual(expect.objectContaining({
      status: "succeeded",
      outputArtifactIds: [normalized.providerArtifact.id, normalized.transcript.id],
    }));
    expect(store.snapshot().artifacts.map((artifact) => artifact.id)).toEqual(expect.arrayContaining([
      normalized.providerArtifact.id,
      normalized.transcript.id,
    ]));
    expect(store.verify()).toEqual(expect.objectContaining({ headRevision: 1, replayedCommands: 1 }));
    store.close();
  });

  it("records a retryable failure without changing project revision", async () => {
    const document = fixture();
    const asset = document.assets[0];
    if (!asset) throw new Error("Fixture asset is missing");
    const store = ProjectStore.create(path(), document, { clock: () => "2026-07-18T06:00:00Z" });
    store.createJob({ id: "job_asr_fail", type: "asr.transcribe", payload: {}, maxAttempts: 2 });
    await expect(runPersistedAsrJob({
      store,
      jobId: "job_asr_fail",
      runner: {
        pythonPath: "python",
        workerScriptPath: "worker.py",
        inputPath: "input.wav",
        outputPath: "output.json",
        model: "model",
      },
      asset,
      audioStreamIndex: 0,
      streamDuration: { value: 10, rate: { numerator: 1, denominator: 1 } },
      rawResultUri: "raw.json",
      providerVersion: "0.4.3",
      actor: { kind: "workflow", id: "asr_job" },
      transactionId: "tx_never",
      idempotencyKey: "never",
      run: async () => { throw new Error("simulated worker failure"); },
    })).rejects.toThrow("simulated worker failure");
    expect(store.getJob("job_asr_fail")).toEqual(expect.objectContaining({
      status: "failed",
      retryable: true,
    }));
    expect(store.snapshot().project.revision).toBe(0);
    store.close();
  });
});
