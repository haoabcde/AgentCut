import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile, probeMedia } from "@agentcut/media-ingest";
import { ProjectStore } from "@agentcut/project-store";
import type { AgentCutProjectDocument } from "@agentcut/timeline-schema";
import { afterEach, describe, expect, it } from "vitest";
import { buildRenderPlan } from "./plan.js";
import { recoverRunningPersistedRenderJob, runPersistedRenderJob } from "./workflow.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("persisted FFmpeg render workflow", () => {
  it("renders burned Chinese captions, verifies media, and commits derived artifacts", async () => {
    const fixture = await createRenderProject();
    const store = ProjectStore.create(fixture.databasePath, fixture.document, { checkpointInterval: 1 });
    try {
      store.createJob({
        id: "job_render_success",
        type: "export.render",
        payload: { revision: 0, sequenceId: "sequence_main" },
      });
      const result = await runPersistedRenderJob({
        store,
        jobId: "job_render_success",
        projectRoot: fixture.directory,
        sequenceId: "sequence_main",
        transcriptArtifactId: "transcript_fixture",
        actor: { kind: "workflow", id: "render_engine" },
        transactionId: "tx_render_success",
        idempotencyKey: "render-success",
      });
      expect(store.snapshot().project.revision).toBe(1);
      expect(store.getJob("job_render_success")).toEqual(expect.objectContaining({
        status: "succeeded",
        progress: 1,
        outputArtifactIds: [
          result.outputAsset.id,
          result.captionArtifact.id,
          result.renderReport.id,
        ],
      }));
      expect(result.renderReport.quality).toEqual(expect.objectContaining({
        width: 320,
        height: 180,
        hasAudio: true,
        subtitleCueCount: 1,
        passed: true,
      }));
      expect(result.renderReport.quality.durationDeltaMillis).toBeLessThanOrEqual(40);
      expect(readFileSync(result.captionPath, "utf8")).toContain("你好世界");
      expect(probeMedia(result.outputPath).streams.map((stream) => stream.type))
        .toEqual(expect.arrayContaining(["video", "audio"]));
      expect(bottomFrameHasCaption(result.outputPath)).toBe(true);
      expect(store.verify()).toEqual(expect.objectContaining({ integrity: "ok", headRevision: 1 }));
    } finally {
      store.close();
    }
  }, 30_000);

  it("renders a 1080x1920 cover-fit vertical preset with an honest approximate quality flag", async () => {
    const fixture = await createRenderProject();
    const store = ProjectStore.create(fixture.databasePath, fixture.document, { checkpointInterval: 1 });
    try {
      store.createJob({
        id: "job_render_vertical",
        type: "export.render",
        payload: { revision: 0, sequenceId: "sequence_main", preset: "vertical-9-16" },
      });
      const result = await runPersistedRenderJob({
        store,
        jobId: "job_render_vertical",
        projectRoot: fixture.directory,
        sequenceId: "sequence_main",
        transcriptArtifactId: "transcript_fixture",
        actor: { kind: "workflow", id: "render_engine" },
        transactionId: "tx_render_vertical",
        idempotencyKey: "render-vertical",
        output: { width: 1080, height: 1920, fitMode: "cover" },
      });
      expect(result.plan.fitMode).toBe("cover");
      expect(result.renderReport.quality).toEqual(expect.objectContaining({
        width: 1080,
        height: 1920,
        hasAudio: true,
        passed: true,
        fitMode: "cover",
        fitModeApproximate: true,
      }));
      expect(result.plan.warnings.some((warning) => warning.includes("cover"))).toBe(true);
      const probe = probeMedia(result.outputPath);
      const video = probe.streams.find((stream) => stream.type === "video");
      expect(video?.video?.width).toBe(1080);
      expect(video?.video?.height).toBe(1920);
      // 竖屏 preset 的 planHash 必须不同于源画布导出，保证产物文件名不会互相覆盖。
      const sourcePlan = buildRenderPlan({
        document: fixture.document,
        projectRoot: fixture.directory,
        sequenceId: "sequence_main",
        transcriptArtifactId: "transcript_fixture",
      });
      expect(result.plan.planHash).not.toBe(sourcePlan.planHash);
    } finally {
      store.close();
    }
  }, 30_000);

  it("refuses to overwrite an existing completed output", async () => {
    const fixture = await createRenderProject();
    const store = ProjectStore.create(fixture.databasePath, fixture.document);
    try {
      const plan = buildRenderPlan({
        document: fixture.document,
        projectRoot: fixture.directory,
        sequenceId: "sequence_main",
        transcriptArtifactId: "transcript_fixture",
      });
      const digest = plan.planHash.slice("sha256:".length, "sha256:".length + 12);
      const outputPath = join(
        fixture.directory,
        "renders",
        `agentcut-project_render_fixture-r0-${digest}.mp4`,
      );
      mkdirSync(join(fixture.directory, "renders"));
      writeFileSync(outputPath, "existing-successful-render");
      store.createJob({ id: "job_render_collision", type: "export.render", payload: {} });
      await expect(runPersistedRenderJob({
        store,
        jobId: "job_render_collision",
        projectRoot: fixture.directory,
        sequenceId: "sequence_main",
        transcriptArtifactId: "transcript_fixture",
        actor: { kind: "workflow", id: "render_engine" },
        transactionId: "tx_render_collision",
        idempotencyKey: "render-collision",
      })).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
      expect(readFileSync(outputPath, "utf8")).toBe("existing-successful-render");
      expect(store.snapshot().project.revision).toBe(0);
      expect(store.getJob("job_render_collision")).toEqual(expect.objectContaining({
        status: "failed",
        retryable: false,
      }));
    } finally {
      store.close();
    }
  }, 30_000);

  it("refuses to render when managed source bytes no longer match the recorded content hash", async () => {
    const fixture = await createRenderProject();
    const sourcePath = join(fixture.directory, "media", "source.mp4");
    writeFileSync(sourcePath, "tampered-source-bytes");
    const store = ProjectStore.create(fixture.databasePath, fixture.document);
    try {
      store.createJob({ id: "job_render_tampered_source", type: "export.render", payload: {} });
      await expect(runPersistedRenderJob({
        store,
        jobId: "job_render_tampered_source",
        projectRoot: fixture.directory,
        sequenceId: "sequence_main",
        transcriptArtifactId: "transcript_fixture",
        actor: { kind: "workflow", id: "render_engine" },
        transactionId: "tx_render_tampered_source",
        idempotencyKey: "render-tampered-source",
      })).rejects.toMatchObject({
        code: "SOURCE_INTEGRITY_FAILED",
        details: {
          assetId: "asset_source",
          expected: fixture.document.assets[0]!.contentHash,
        },
      });
      expect(store.snapshot().project.revision).toBe(0);
      expect(store.getJob("job_render_tampered_source")).toEqual(expect.objectContaining({
        status: "failed",
        retryable: false,
      }));
      expect(existsSync(join(fixture.directory, "renders"))).toBe(false);
    } finally {
      store.close();
    }
  }, 30_000);

  it("adopts a verified MP4/SRT pair left published before Timeline registration", async () => {
    const fixture = await createRenderProject();
    const firstStore = ProjectStore.create(fixture.databasePath, fixture.document);
    firstStore.createJob({ id: "job_render_before_restart", type: "export.render", payload: {} });
    const published = await runPersistedRenderJob({
      store: firstStore,
      jobId: "job_render_before_restart",
      projectRoot: fixture.directory,
      sequenceId: "sequence_main",
      transcriptArtifactId: "transcript_fixture",
      actor: { kind: "workflow", id: "render_engine" },
      transactionId: "tx_render_before_restart",
      idempotencyKey: "render-before-restart",
    });
    firstStore.close();

    const recoveryStore = ProjectStore.create(
      join(fixture.directory, "recovery.sqlite"),
      fixture.document,
    );
    try {
      recoveryStore.createJob({ id: "job_render_recovery", type: "export.render", payload: {} });
      recoveryStore.startJob("job_render_recovery");
      const recovered = await recoverRunningPersistedRenderJob({
        store: recoveryStore,
        jobId: "job_render_recovery",
        projectRoot: fixture.directory,
        sequenceId: "sequence_main",
        transcriptArtifactId: "transcript_fixture",
        actor: { kind: "workflow", id: "render_engine" },
        transactionId: "tx_render_recovery",
        idempotencyKey: "render-recovery",
      });

      if (!recovered) throw new Error("Published output was not recovered");

      expect(recovered.outputPath).toBe(published.outputPath);
      expect(recovered.captionPath).toBe(published.captionPath);
      expect(recovered.outputAsset.contentHash).toBe(published.outputAsset.contentHash);
      expect(recoveryStore.snapshot().project.revision).toBe(1);
      expect(recoveryStore.getJob("job_render_recovery")).toEqual(expect.objectContaining({
        status: "succeeded",
        progress: 1,
      }));
    } finally {
      recoveryStore.close();
    }
  }, 30_000);

  it("refuses to adopt published outputs after the managed source bytes drift", async () => {
    const fixture = await createRenderProject();
    const firstStore = ProjectStore.create(fixture.databasePath, fixture.document);
    firstStore.createJob({ id: "job_render_before_source_drift", type: "export.render", payload: {} });
    await runPersistedRenderJob({
      store: firstStore,
      jobId: "job_render_before_source_drift",
      projectRoot: fixture.directory,
      sequenceId: "sequence_main",
      transcriptArtifactId: "transcript_fixture",
      actor: { kind: "workflow", id: "render_engine" },
      transactionId: "tx_render_before_source_drift",
      idempotencyKey: "render-before-source-drift",
    });
    firstStore.close();
    writeFileSync(join(fixture.directory, "media", "source.mp4"), "drifted-source-bytes");

    const recoveryStore = ProjectStore.create(
      join(fixture.directory, "source-drift-recovery.sqlite"),
      fixture.document,
    );
    try {
      recoveryStore.createJob({ id: "job_render_source_drift_recovery", type: "export.render", payload: {} });
      recoveryStore.startJob("job_render_source_drift_recovery");
      await expect(recoverRunningPersistedRenderJob({
        store: recoveryStore,
        jobId: "job_render_source_drift_recovery",
        projectRoot: fixture.directory,
        sequenceId: "sequence_main",
        transcriptArtifactId: "transcript_fixture",
        actor: { kind: "workflow", id: "render_engine" },
        transactionId: "tx_render_source_drift_recovery",
        idempotencyKey: "render-source-drift-recovery",
      })).rejects.toMatchObject({ code: "SOURCE_INTEGRITY_FAILED" });
      expect(recoveryStore.snapshot().project.revision).toBe(0);
      expect(recoveryStore.getJob("job_render_source_drift_recovery").status).toBe("running");
    } finally {
      recoveryStore.close();
    }
  }, 30_000);

  it("preserves an incomplete published artifact and renders a safe alternate pair", async () => {
    const fixture = await createRenderProject();
    const plan = buildRenderPlan({
      document: fixture.document,
      projectRoot: fixture.directory,
      sequenceId: "sequence_main",
      transcriptArtifactId: "transcript_fixture",
    });
    const planDigest = plan.planHash.slice("sha256:".length, "sha256:".length + 12);
    const rendersDirectory = join(fixture.directory, "renders");
    const blockedOutput = join(
      rendersDirectory,
      `agentcut-project_render_fixture-r0-${planDigest}.mp4`,
    );
    mkdirSync(rendersDirectory);
    writeFileSync(blockedOutput, "interrupted-output-must-survive");
    const store = ProjectStore.create(fixture.databasePath, fixture.document);
    try {
      store.createJob({ id: "job_render_safe_retry", type: "export.render", payload: {} });
      const recovered = await runPersistedRenderJob({
        store,
        jobId: "job_render_safe_retry",
        projectRoot: fixture.directory,
        sequenceId: "sequence_main",
        transcriptArtifactId: "transcript_fixture",
        actor: { kind: "workflow", id: "render_engine" },
        transactionId: "tx_render_safe_retry",
        idempotencyKey: "render-safe-retry",
        existingOutputPolicy: "recover_or_preserve",
      });

      expect(readFileSync(blockedOutput, "utf8")).toBe("interrupted-output-must-survive");
      expect(recovered.outputPath).not.toBe(blockedOutput);
      expect(recovered.outputPath).toContain("safe-retry");
      expect(store.getJob("job_render_safe_retry").status).toBe("succeeded");
    } finally {
      store.close();
    }
  }, 30_000);

  it("turns an aborted running render into cancelled without publishing or editing Timeline", async () => {
    const fixture = await createRenderProject();
    const store = ProjectStore.create(fixture.databasePath, fixture.document);
    const controller = new AbortController();
    controller.abort();
    try {
      store.createJob({ id: "job_render_cancelled", type: "export.render", payload: {} });
      await expect(runPersistedRenderJob({
        store,
        jobId: "job_render_cancelled",
        projectRoot: fixture.directory,
        sequenceId: "sequence_main",
        transcriptArtifactId: "transcript_fixture",
        actor: { kind: "workflow", id: "render_engine" },
        transactionId: "tx_render_cancelled",
        idempotencyKey: "render-cancelled",
        signal: controller.signal,
      })).rejects.toMatchObject({ code: "RENDER_CANCELLED" });
      expect(store.getJob("job_render_cancelled")).toEqual(expect.objectContaining({
        status: "cancelled",
        cancelRequested: true,
      }));
      expect(store.snapshot().project.revision).toBe(0);
      expect(existsSync(join(fixture.directory, "renders"))).toBe(false);
    } finally {
      store.close();
    }
  }, 30_000);

  it("honors a persisted cancellation request instead of recovering interrupted output", async () => {
    const fixture = await createRenderProject();
    const store = ProjectStore.create(fixture.databasePath, fixture.document);
    const jobId = "job_render_recovery_cancelled";
    const workId = createHash("sha256").update(jobId).digest("hex").slice(0, 16);
    const workDirectory = join(fixture.directory, "renders", `.work-${workId}`);
    try {
      store.createJob({ id: jobId, type: "export.render", payload: {} });
      store.startJob(jobId);
      store.requestJobCancellation(jobId, {
        requestId: "cancel-recovery-001",
        requestedBy: "local_user",
      });
      mkdirSync(workDirectory, { recursive: true });
      writeFileSync(join(workDirectory, "partial.mp4"), "partial");
      await expect(recoverRunningPersistedRenderJob({
        store,
        jobId,
        projectRoot: fixture.directory,
        sequenceId: "sequence_main",
        transcriptArtifactId: "transcript_fixture",
        actor: { kind: "workflow", id: "render_engine" },
        transactionId: "tx_render_recovery_cancelled",
        idempotencyKey: "render-recovery-cancelled",
      })).resolves.toBeNull();
      expect(store.getJob(jobId).status).toBe("cancelled");
      expect(store.snapshot().project.revision).toBe(0);
      expect(existsSync(workDirectory)).toBe(false);
    } finally {
      store.close();
    }
  }, 30_000);
});

async function createRenderProject(): Promise<{
  directory: string;
  databasePath: string;
  document: AgentCutProjectDocument;
}> {
  const directory = mkdtempSync(join(tmpdir(), "agentcut-render-workflow-"));
  temporaryDirectories.push(directory);
  const mediaDirectory = join(directory, "media");
  mkdirSync(mediaDirectory);
  const mediaPath = join(mediaDirectory, "source.mp4");
  const generated = spawnSync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=2",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-t", "2",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    mediaPath,
  ], { encoding: "utf8" });
  if (generated.error || generated.status !== 0) {
    throw new Error(generated.error?.message ?? generated.stderr);
  }
  const probe = probeMedia(mediaPath);
  const contentHash = await hashFile(mediaPath);
  const duration = probe.duration;
  const document: AgentCutProjectDocument = {
    schemaVersion: "0.1.0",
    project: {
      id: "project_render_fixture",
      name: "Render Fixture",
      createdAt: "2026-07-18T10:00:00Z",
      updatedAt: "2026-07-18T10:00:00Z",
      activeSequenceId: "sequence_main",
      revision: 0,
    },
    assets: [{
      id: "asset_source",
      kind: "video",
      uri: "media/source.mp4",
      contentHash,
      availability: "online",
      provenance: {
        createdBy: { kind: "user", id: "local_user" },
        createdAt: "2026-07-18T10:00:00Z",
        reason: "Render workflow fixture",
      },
      metadata: { mediaProbe: probe },
    }],
    sequences: [{
      id: "sequence_main",
      name: "Main",
      canvas: { width: 320, height: 180, background: "#000000" },
      frameRate: { numerator: 30, denominator: 1 },
      tracks: [{
        id: "track_v1",
        kind: "video",
        name: "Main",
        order: 0,
        locked: false,
        enabled: true,
        clips: [{
          id: "clip_source",
          kind: "media",
          assetId: "asset_source",
          streamIndex: 0,
          timelineRange: { start: micros(0), duration },
          sourceRange: { start: micros(0), duration },
          enabled: true,
          provenance: {
            createdBy: { kind: "user", id: "local_user" },
            createdAt: "2026-07-18T10:00:00Z",
            reason: "Render source",
          },
        }],
        transitions: [],
      }],
      locks: [],
      markers: [],
    }],
    styleSpecs: [],
    artifacts: [{
      id: "transcript_fixture",
      kind: "transcript",
      assetId: "asset_source",
      language: "zh",
      audioStreamIndex: 1,
      words: [
        { id: "word_hello", text: "你好", confidence: 0.99, sourceRange: range(200_000, 500_000) },
        { id: "word_world", text: "世界", confidence: 0.99, sourceRange: range(800_000, 500_000) },
      ],
      provenance: {
        createdBy: { kind: "workflow", id: "asr" },
        createdAt: "2026-07-18T10:00:00Z",
        reason: "Render fixture transcript",
      },
    }],
    exportPresets: [],
    versions: [],
    history: { headRevision: 0, records: [] },
  };
  return { directory, databasePath: join(directory, "agentcut.sqlite"), document };
}

function bottomFrameHasCaption(path: string): boolean {
  const frame = spawnSync("ffmpeg", [
    "-v", "error",
    "-ss", "0.5",
    "-i", path,
    "-vf", "crop=320:90:0:90,format=gray",
    "-frames:v", "1",
    "-f", "rawvideo",
    "-",
  ], { maxBuffer: 320 * 180 * 4 });
  if (frame.error || frame.status !== 0 || !Buffer.isBuffer(frame.stdout)) return false;
  let brightPixels = 0;
  for (const value of frame.stdout) if (value > 180) brightPixels += 1;
  return brightPixels > 20;
}

function range(start: number, duration: number) {
  return { start: micros(start), duration: micros(duration) };
}

function micros(value: number) {
  return { value, rate: { numerator: 1_000_000, denominator: 1 } };
}
