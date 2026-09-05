import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "@agentcut/project-store";
import { assertProjectDocument, type AgentCutProjectDocument } from "@agentcut/timeline-schema";
import { afterEach, describe, expect, it } from "vitest";
import { parseAlphaEvidenceBundle } from "./bundle.js";
import { runAlphaEvidenceCli } from "./evidence-cli.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Alpha evidence CLI", () => {
  it("exports deterministic current-project evidence and refuses to overwrite", async () => {
    const projectRoot = createProject();
    const firstPath = join(projectRoot, "bundles", "evidence-1.json");
    const secondPath = join(projectRoot, "bundles", "evidence-2.json");
    const stdout: string[] = [];
    const initialStderr: string[] = [];

    expect({
      exitCode: await runAlphaEvidenceCli(["--", projectRoot, "--output", firstPath], io(stdout, initialStderr)),
      stderr: initialStderr,
    }).toEqual({ exitCode: 0, stderr: [] });
    expect(await runAlphaEvidenceCli([projectRoot, "--output", secondPath], io(stdout))).toBe(0);
    expect(readFileSync(secondPath, "utf8")).toBe(readFileSync(firstPath, "utf8"));

    const bundle = parseAlphaEvidenceBundle(readFileSync(firstPath, "utf8"));
    expect(bundle.project).toEqual(expect.objectContaining({
      id: "project_demo_001",
      revision: 0,
      sourceSha256: `sha256:${"a".repeat(64)}`,
    }));
    expect(bundle.progress).toEqual({
      candidateLabeled: 0,
      candidateTotal: 2,
      boundaryLabeled: 0,
      boundaryTotal: 0,
      complete: false,
    });
    expect(stdout.join("")).toMatch(/file sha256:[a-f0-9]{64}/);

    const stderr: string[] = [];
    expect(await runAlphaEvidenceCli([projectRoot, "--output", firstPath], io([], stderr))).toBe(2);
    expect(stderr.join("")).toContain("Refusing to overwrite existing Alpha evidence bundle");
  });
});

function io(stdout: string[], stderr: string[] = []) {
  return {
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
  };
}

function createProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "agentcut-alpha-evidence-cli-"));
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
