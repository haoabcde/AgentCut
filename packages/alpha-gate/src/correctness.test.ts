import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashProjectState } from "@agentcut/edit-commands";
import { ProjectStore } from "@agentcut/project-store";
import { assertProjectDocument, type AgentCutProjectDocument } from "@agentcut/timeline-schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  AlphaCorrectnessError,
  verifyAlphaProjectCorrectness,
} from "./correctness.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Alpha project correctness verifier", () => {
  it("proves undo, restart, idempotency and stale-revision rejection on a disposable SQLite backup", async () => {
    const databasePath = createProject();
    const before = ProjectStore.open(databasePath);
    const beforeDocument = before.snapshot();
    const beforeHash = hashProjectState(beforeDocument);
    const beforeRecords = before.listRecords();
    before.close();

    const run = await verifyAlphaProjectCorrectness({
      databasePath,
      requestId: "sample-correctness-r0",
      projectId: beforeDocument.project.id,
      projectRevision: beforeDocument.project.revision,
      sourceSha256: `sha256:${"a".repeat(64)}`,
    });

    expect(run).toEqual(expect.objectContaining({
      runId: "sample-correctness-r0",
      projectId: "project_demo_001",
      projectRevision: 0,
      sourceSha256: `sha256:${"a".repeat(64)}`,
      sourceStateHash: beforeHash,
      checks: {
        undo: expect.objectContaining({ passed: true, code: "DOMAIN_STATE_RESTORED" }),
        restart: expect.objectContaining({ passed: true, code: "STATE_REOPEN_MATCH" }),
        idempotency: expect.objectContaining({ passed: true, code: "IDEMPOTENT_REPLAY" }),
        revisionConflict: expect.objectContaining({ passed: true, code: "REVISION_CONFLICT_REJECTED" }),
      },
    }));

    const after = ProjectStore.open(databasePath);
    expect(hashProjectState(after.snapshot())).toBe(beforeHash);
    expect(after.snapshot().project.revision).toBe(0);
    expect(after.listRecords()).toEqual(beforeRecords);
    after.close();
  });

  it("rejects a stale binding before reporting any correctness result", async () => {
    const databasePath = createProject();

    await expect(verifyAlphaProjectCorrectness({
      databasePath,
      requestId: "wrong-revision",
      projectId: "project_demo_001",
      projectRevision: 99,
      sourceSha256: `sha256:${"a".repeat(64)}`,
    })).rejects.toThrowError(expect.objectContaining<Partial<AlphaCorrectnessError>>({
      code: "CORRECTNESS_BINDING_MISMATCH",
    }));
  });
});

function createProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentcut-alpha-correctness-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "agentcut.sqlite");
  ProjectStore.create(databasePath, fixture()).close();
  return databasePath;
}

function fixture(): AgentCutProjectDocument {
  const url = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(url, "utf8"));
  assertProjectDocument(value);
  return structuredClone(value);
}
