import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashProjectState } from "@agentcut/edit-commands";
import { ProjectStore } from "@agentcut/project-store";
import { assertProjectDocument, type AgentCutProjectDocument } from "@agentcut/timeline-schema";
import { afterEach, describe, expect, it } from "vitest";
import { runAlphaCorrectnessCli } from "./correctness-cli.js";
import { createAlphaAuditDraft } from "./audit.js";
import { AlphaEvidenceStore } from "./evidence.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Alpha correctness CLI", () => {
  it("records four machine checks while leaving the canonical project unchanged", async () => {
    const projectRoot = createProject();
    const databasePath = join(projectRoot, "agentcut.sqlite");
    const before = ProjectStore.open(databasePath);
    const beforeHash = hashProjectState(before.snapshot());
    before.close();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const first = await runAlphaCorrectnessCli([
      "--",
      projectRoot,
      "--request-id",
      "correctness-r0",
    ], io(stdout, stderr));
    const replay = await runAlphaCorrectnessCli([
      projectRoot,
      "--request-id",
      "correctness-r0",
    ], io(stdout, stderr));

    expect({ first, replay, stderr }).toEqual({ first: 0, replay: 0, stderr: [] });
    expect(stdout.join("")).toContain("undo=passed restart=passed idempotency=passed revisionConflict=passed");
    const after = ProjectStore.open(databasePath);
    expect(after.snapshot().project.revision).toBe(0);
    expect(hashProjectState(after.snapshot())).toBe(beforeHash);
    const draft = createAlphaAuditDraft(after.snapshot(), after.listRecords());
    after.close();
    const evidence = AlphaEvidenceStore.open(join(projectRoot, "alpha-evidence.sqlite"));
    expect(evidence.apply(draft).events.filter((event) => event.targetType === "correctness"))
      .toHaveLength(1);
    evidence.close();
  });
});

function io(stdout: string[], stderr: string[]) {
  return {
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
  };
}

function createProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "agentcut-alpha-correctness-cli-"));
  temporaryDirectories.push(projectRoot);
  ProjectStore.create(join(projectRoot, "agentcut.sqlite"), fixture()).close();
  return projectRoot;
}

function fixture(): AgentCutProjectDocument {
  const url = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(url, "utf8"));
  assertProjectDocument(value);
  return structuredClone(value);
}
