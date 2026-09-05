import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "@agentcut/project-store";
import { assertProjectDocument, type AgentCutProjectDocument } from "@agentcut/timeline-schema";
import { afterEach, describe, expect, it } from "vitest";
import { runAlphaAuditCli } from "./audit-cli.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Alpha audit CLI", () => {
  it("atomically writes a deterministic audit draft from a real ProjectStore", async () => {
    const projectRoot = createProject();
    const outputPath = join(projectRoot, "evidence", "audit.json");
    const stdout: string[] = [];

    const exitCode = await runAlphaAuditCli(["--", projectRoot, "--output", outputPath], {
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
    });

    expect(exitCode).toBe(0);
    const draft = JSON.parse(readFileSync(outputPath, "utf8")) as {
      project: { id: string; revision: number };
      candidates: unknown[];
    };
    expect(draft.project).toEqual({
      id: "project_demo_001",
      name: "中文口播技术验证",
      revision: 0,
      sequenceId: "sequence_main",
      transcriptId: "transcript_main_001",
      sourceAssetId: "asset_camera_a",
      sourceSha256: `sha256:${"a".repeat(64)}`,
    });
    expect(draft.candidates).toHaveLength(2);
    expect(stdout.join("")).toContain("Wrote Alpha audit draft for project_demo_001 revision 0");
  });

  it("refuses to overwrite existing human evidence", async () => {
    const projectRoot = createProject();
    const outputPath = join(projectRoot, "existing-audit.json");
    writeFileSync(outputPath, "human evidence", "utf8");
    const stderr: string[] = [];

    const exitCode = await runAlphaAuditCli([projectRoot, "--output", outputPath], {
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(2);
    expect(readFileSync(outputPath, "utf8")).toBe("human evidence");
    expect(stderr.join("")).toContain("Refusing to overwrite existing audit evidence");
  });
});

function createProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "agentcut-alpha-audit-cli-"));
  temporaryDirectories.push(projectRoot);
  const store = ProjectStore.create(join(projectRoot, "agentcut.sqlite"), fixture());
  store.close();
  return projectRoot;
}

function fixture(): AgentCutProjectDocument {
  const url = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(url, "utf8"));
  assertProjectDocument(value);
  return structuredClone(value);
}
