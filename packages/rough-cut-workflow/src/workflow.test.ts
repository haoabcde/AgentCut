import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "@agentcut/project-store";
import { findPreviewProxyAsset } from "@agentcut/host-extensions";
import {
  type Asset,
  type TranscriptArtifact,
} from "@agentcut/timeline-schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessProjectResume,
  assertAlphaTrialResumeMode,
  buildInitialRoughCutProject,
  createRoughCutProject,
} from "./workflow.js";

const hash = `sha256:${"a".repeat(64)}`;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("rough-cut project workflow", () => {
  it("builds a valid one-track project around the probed source dimensions", () => {
    const document = buildInitialRoughCutProject({
      projectId: "project_a",
      name: "测试口播",
      createdAt: "2026-07-28T00:00:00.000Z",
      width: 1280,
      height: 720,
      frameRate: { numerator: 30, denominator: 1 },
    });

    expect(document.project).toEqual(expect.objectContaining({
      id: "project_a",
      name: "测试口播",
      revision: 0,
      activeSequenceId: "sequence_main",
    }));
    expect(document.sequences[0]?.tracks).toEqual([
      expect.objectContaining({ id: "track_v1", kind: "video", clips: [] }),
    ]);
  });

  it("distinguishes a completed resume from interrupted transcription", () => {
    const base = buildInitialRoughCutProject({
      projectId: "project_a",
      name: "测试口播",
      createdAt: "2026-07-28T00:00:00.000Z",
      width: 1280,
      height: 720,
      frameRate: { numerator: 30, denominator: 1 },
    });
    base.assets.push({ id: "asset_a", kind: "video", contentHash: hash } as Asset);
    expect(assessProjectResume(base, hash)).toBe("transcription_required");
    base.artifacts.push({ kind: "transcript", assetId: "asset_a" } as TranscriptArtifact);
    expect(assessProjectResume(base, hash)).toBe("complete");
  });

  it("persists formal Alpha enrollment in canonical project extensions", () => {
    const document = buildInitialRoughCutProject({
      projectId: "project_trial",
      name: "正式样本",
      createdAt: "2026-08-10T00:00:00.000Z",
      width: 1280,
      height: 720,
      frameRate: { numerator: 30, denominator: 1 },
      alphaTrial: true,
    });

    expect(document.extensions).toEqual({
      "agentcut.alphaTrial": {
        schemaVersion: "1.0",
        mode: "formal",
        enrolledAt: "2026-08-10T00:00:00.000Z",
      },
    });
    expect(() => assertAlphaTrialResumeMode(document, false))
      .toThrow("rerun with --alpha-trial");
    expect(() => assertAlphaTrialResumeMode(document, true)).not.toThrow();

    const ordinary = buildInitialRoughCutProject({
      projectId: "project_ordinary",
      name: "普通工程",
      createdAt: "2026-08-10T00:00:00.000Z",
      width: 1280,
      height: 720,
      frameRate: { numerator: 30, denominator: 1 },
    });
    expect(() => assertAlphaTrialResumeMode(ordinary, true))
      .toThrow("create a new project directory");
  });

  it("refuses to reuse a project directory for different source bytes", () => {
    const document = buildInitialRoughCutProject({
      projectId: "project_a",
      name: "测试口播",
      createdAt: "2026-07-28T00:00:00.000Z",
      width: 1280,
      height: 720,
      frameRate: { numerator: 30, denominator: 1 },
    });
    document.assets.push({ id: "asset_a", kind: "video", contentHash: hash } as Asset);
    expect(() => assessProjectResume(document, `sha256:${"b".repeat(64)}`))
      .toThrow("different source media");
  });

  it("does not accept a generated proxy hash as the rough-cut source identity", () => {
    const document = buildInitialRoughCutProject({
      projectId: "project_a",
      name: "测试口播",
      createdAt: "2026-07-28T00:00:00.000Z",
      width: 1280,
      height: 720,
      frameRate: { numerator: 30, denominator: 1 },
    });
    document.assets.push(
      { id: "asset_source", kind: "video", contentHash: hash } as Asset,
      { id: "asset_proxy", kind: "generated", contentHash: `sha256:${"b".repeat(64)}` } as Asset,
    );
    expect(() => assessProjectResume(document, `sha256:${"b".repeat(64)}`))
      .toThrow("different source media");
  });

  it("registers an HEVC browser proxy without changing clip or Transcript source identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcut-roughcut-proxy-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "source-hevc.mov");
    const projectRoot = join(directory, "project");
    const ffmpegPath = process.env.AGENTCUT_FFMPEG_PATH ?? "ffmpeg";
    const ffprobePath = process.env.AGENTCUT_FFPROBE_PATH ?? "ffprobe";
    const generated = spawnSync(ffmpegPath, [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=0.8",
      "-f", "lavfi", "-i", "sine=frequency=550:sample_rate=48000:duration=0.8",
      "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p",
      "-x265-params", "log-level=error:pools=1:frame-threads=1",
      "-c:a", "aac", "-shortest", sourcePath,
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (generated.status !== 0) throw new Error(generated.stderr);

    const options = {
      sourcePath,
      projectRoot,
      name: "HEVC 代理集成测试",
      pythonPath: "python",
      workerScriptPath: "unused-worker.py",
      ffmpegPath,
      ffprobePath,
      clock: () => "2026-08-13T00:00:00.000Z",
      asrRun: async () => ({
        stderr: "",
        rawResult: {
          language: "zh",
          segments: [{ words: [{ word: "测试", start: 0.1, end: 0.5, probability: 0.99 }] }],
        },
      }),
    };
    const created = await createRoughCutProject(options);
    expect(created).toEqual(expect.objectContaining({
      resumed: false,
      playbackKind: "proxy",
      playbackAssetId: expect.stringMatching(/^asset_preview_/),
    }));

    const store = ProjectStore.open(created.databasePath);
    const document = store.snapshot();
    const transcript = document.artifacts.find((artifact) => artifact.kind === "transcript");
    const source = document.assets.find((asset) => asset.contentHash === created.sourceHash)!;
    const proxy = findPreviewProxyAsset(document, source);
    const mainClip = document.sequences[0]?.tracks[0]?.clips[0];
    expect(proxy?.id).toBe(created.playbackAssetId);
    expect(existsSync(join(projectRoot, proxy!.uri))).toBe(true);
    expect(mainClip?.assetId).toBe(source.id);
    expect(transcript?.assetId).toBe(source.id);
    const revision = document.project.revision;
    store.close();

    const resumed = await createRoughCutProject(options);
    expect(resumed).toEqual(expect.objectContaining({
      resumed: true,
      playbackKind: "proxy",
      playbackAssetId: created.playbackAssetId,
      projectRevision: revision,
    }));
  });
});
