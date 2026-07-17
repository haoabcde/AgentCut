import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  EditError,
  type EditOperation,
  type EditTransaction,
} from "@agentcut/edit-commands";
import {
  assertProjectDocument,
  type Actor,
  type AgentCutProjectDocument,
} from "@agentcut/timeline-schema";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore, type FailurePoint } from "./project-store.js";

const user: Actor = { kind: "user", id: "local_user" };
const fixedClock = () => "2026-07-18T03:30:00Z";
const temporaryDirectories: string[] = [];

function fixture(): AgentCutProjectDocument {
  const fixtureUrl = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  assertProjectDocument(value);
  return structuredClone(value);
}

function tempPath(name = "project.sqlite"): string {
  const directory = mkdtempSync(join(tmpdir(), "agentcut-project-store-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

function transaction(
  baseRevision: number,
  operations?: EditOperation[],
  overrides: Partial<EditTransaction> = {},
): EditTransaction {
  return {
    protocolVersion: "0.1.0",
    transactionId: `tx_${baseRevision}`,
    idempotencyKey: `key_${baseRevision}`,
    projectId: "project_demo_001",
    sequenceId: "sequence_main",
    baseRevision,
    actor: user,
    reason: "project store technical validation",
    preconditions: [],
    operations: operations ?? [{
      type: "clip.update",
      clipId: "clip_take_1",
      patch: { enabled: false },
    }],
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("project store", () => {
  it("uses WAL and persists command, inverse, checkpoint, and state across restart", () => {
    const path = tempPath();
    const store = ProjectStore.create(path, fixture(), {
      clock: fixedClock,
      checkpointInterval: 1,
    });
    expect(store.journalMode()).toBe("wal");
    const request = transaction(0, undefined, {
      transactionId: "tx_persisted",
      idempotencyKey: "persisted",
    });
    const first = store.commit(request);
    expect(first.document.project.revision).toBe(1);
    expect(first.record.inverseOperations).toHaveLength(1);
    store.close();

    const reopened = ProjectStore.open(path, { clock: fixedClock, checkpointInterval: 1 });
    expect(reopened.snapshot().project.revision).toBe(1);
    expect(reopened.getRecord("tx_persisted")?.inverseOperations).toHaveLength(1);
    expect(reopened.listCheckpoints().map(({ revision }) => revision)).toEqual([0, 1]);
    const replay = reopened.commit(request);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.document.project.revision).toBe(1);
    const undone = reopened.undo("tx_persisted", user, "tx_undo_persisted");
    expect(undone.document.project.revision).toBe(2);
    expect(undone.document.sequences[0]?.tracks[0]?.clips[0]?.enabled).toBe(true);
    expect(reopened.verify()).toEqual(expect.objectContaining({
      integrity: "ok",
      headRevision: 2,
      replayedCommands: 2,
    }));
    reopened.close();
  });

  it("serializes two writers and rejects a stale revision without partial writes", () => {
    const path = tempPath();
    ProjectStore.create(path, fixture(), { clock: fixedClock }).close();
    const first = ProjectStore.open(path, { clock: fixedClock });
    const second = ProjectStore.open(path, { clock: fixedClock });
    first.commit(transaction(0, undefined, {
      transactionId: "tx_writer_a",
      idempotencyKey: "writer-a",
    }));
    expect(() => second.commit(transaction(0, undefined, {
      transactionId: "tx_writer_b",
      idempotencyKey: "writer-b",
    }))).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
    expect(second.snapshot().project.revision).toBe(1);
    expect(second.listRecords()).toHaveLength(1);
    first.close();
    second.close();
  });

  it("rejects reuse of an idempotency key with a different payload after restart", () => {
    const path = tempPath();
    const store = ProjectStore.create(path, fixture(), { clock: fixedClock });
    store.commit(transaction(0, undefined, {
      transactionId: "tx_original",
      idempotencyKey: "shared-key",
    }));
    store.close();
    const reopened = ProjectStore.open(path, { clock: fixedClock });
    expect(() => reopened.commit(transaction(0, [{
      type: "clip.update",
      clipId: "clip_take_1",
      patch: { content: { text: "different payload" } },
    }], {
      transactionId: "tx_other",
      idempotencyKey: "shared-key",
    }))).toThrowError(EditError);
    expect(reopened.snapshot().project.revision).toBe(1);
    reopened.close();
  });

  it("rolls back every database write when an injected pre-commit failure throws", () => {
    const path = tempPath();
    ProjectStore.create(path, fixture(), { clock: fixedClock }).close();
    const store = ProjectStore.open(path, {
      clock: fixedClock,
      checkpointInterval: 1,
      failureInjector(point) {
        if (point === "after_state_update") throw new Error("injected failure");
      },
    });
    expect(() => store.commit(transaction(0))).toThrow("injected failure");
    expect(store.snapshot().project.revision).toBe(0);
    expect(store.listRecords()).toHaveLength(0);
    expect(store.listCheckpoints()).toHaveLength(1);
    store.close();
  });

  it("recovers from real process death at each transaction boundary", () => {
    const preCommitPoints: FailurePoint[] = [
      "after_begin",
      "after_apply",
      "after_command_insert",
      "after_state_update",
      "after_checkpoint",
      "before_commit",
    ];
    const workerPath = fileURLToPath(new URL("../test-fixtures/crash-worker.mjs", import.meta.url));

    for (const point of preCommitPoints) {
      const path = tempPath(`${point}.sqlite`);
      ProjectStore.create(path, fixture(), { clock: fixedClock, checkpointInterval: 1 }).close();
      const transactionPath = join(dirname(path), `${point}.json`);
      writeFileSync(transactionPath, JSON.stringify(transaction(0, undefined, {
        transactionId: `tx_${point}`,
        idempotencyKey: `key_${point}`,
      })));
      const child = spawnSync(process.execPath, [workerPath, path, transactionPath, point]);
      expect(child.status === null || child.status !== 0).toBe(true);
      const recovered = ProjectStore.open(path, { clock: fixedClock, checkpointInterval: 1 });
      expect(recovered.snapshot().project.revision, point).toBe(0);
      expect(recovered.listRecords(), point).toHaveLength(0);
      expect(recovered.verify().headRevision, point).toBe(0);
      recovered.close();
    }

    const committedPath = tempPath("after_commit.sqlite");
    ProjectStore.create(committedPath, fixture(), {
      clock: fixedClock,
      checkpointInterval: 1,
    }).close();
    const committedTransactionPath = join(dirname(committedPath), "after_commit.json");
    writeFileSync(committedTransactionPath, JSON.stringify(transaction(0, undefined, {
      transactionId: "tx_after_commit",
      idempotencyKey: "key_after_commit",
    })));
    const child = spawnSync(process.execPath, [
      workerPath,
      committedPath,
      committedTransactionPath,
      "after_commit",
    ]);
    expect(child.status === null || child.status !== 0).toBe(true);
    const recovered = ProjectStore.open(committedPath, {
      clock: fixedClock,
      checkpointInterval: 1,
    });
    expect(recovered.snapshot().project.revision).toBe(1);
    expect(recovered.getRecord("tx_after_commit")).toBeDefined();
    expect(recovered.verify().headRevision).toBe(1);
    recovered.close();
  });
});
