import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  EditError,
  hashProjectState,
  type EditTransaction,
} from "@agentcut/edit-commands";
import { ProjectStore } from "@agentcut/project-store";
import type { AgentCutProjectDocument } from "@agentcut/timeline-schema";

const VERIFIER_CLOCK = () => "2000-01-01T00:00:00.000Z";

export type AlphaCorrectnessKind = "undo" | "restart" | "idempotency" | "revisionConflict";

export interface AlphaCorrectnessCheckResult {
  passed: boolean;
  code: string;
  details: Record<string, string | number | boolean>;
}

export interface AlphaCorrectnessRun {
  runId: string;
  projectId: string;
  projectRevision: number;
  sourceSha256: string;
  sourceStateHash: string;
  checks: Record<AlphaCorrectnessKind, AlphaCorrectnessCheckResult>;
}

export class AlphaCorrectnessError extends Error {
  constructor(
    readonly code: "CORRECTNESS_BINDING_MISMATCH" | "CORRECTNESS_BACKUP_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "AlphaCorrectnessError";
  }
}

export async function verifyAlphaProjectCorrectness(input: {
  databasePath: string;
  requestId: string;
  projectId: string;
  projectRevision: number;
  sourceSha256: string;
}): Promise<AlphaCorrectnessRun> {
  const runId = requiredText(input.requestId, "requestId");
  const sourceStore = ProjectStore.open(input.databasePath);
  let sourceDocument: AgentCutProjectDocument;
  let sourceStateHash: string;
  try {
    sourceDocument = sourceStore.snapshot();
    sourceStateHash = hashProjectState(sourceDocument);
    sourceStore.verify();
  } finally {
    sourceStore.close();
  }
  if (sourceDocument.project.id !== input.projectId
    || sourceDocument.project.revision !== input.projectRevision) {
    throw new AlphaCorrectnessError(
      "CORRECTNESS_BINDING_MISMATCH",
      "Correctness verification binding does not match the current project ID/revision",
    );
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), "agentcut-alpha-correctness-run-"));
  const clonePath = join(temporaryRoot, "project-copy.sqlite");
  try {
    await backupDatabase(input.databasePath, clonePath);
    return verifyClone({
      clonePath,
      runId,
      sourceSha256: input.sourceSha256,
      sourceDocument,
      sourceStateHash,
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function verifyClone(input: {
  clonePath: string;
  runId: string;
  sourceSha256: string;
  sourceDocument: AgentCutProjectDocument;
  sourceStateHash: string;
}): AlphaCorrectnessRun {
  const failed = (code: string, message: string): AlphaCorrectnessCheckResult => ({
    passed: false,
    code,
    details: { message },
  });
  const checks: AlphaCorrectnessRun["checks"] = {
    undo: failed("NOT_EVALUATED", "Probe transaction did not run"),
    restart: failed("NOT_EVALUATED", "Probe transaction did not run"),
    idempotency: failed("NOT_EVALUATED", "Probe transaction did not run"),
    revisionConflict: failed("NOT_EVALUATED", "Probe transaction did not run"),
  };
  let store = ProjectStore.open(input.clonePath, { clock: VERIFIER_CLOCK });
  try {
    const cloned = store.snapshot();
    if (hashProjectState(cloned) !== input.sourceStateHash) {
      throw new AlphaCorrectnessError(
        "CORRECTNESS_BACKUP_FAILED",
        "SQLite backup state hash does not match its source",
      );
    }
    const clip = cloned.sequences
      .find((sequence) => sequence.id === cloned.project.activeSequenceId)
      ?.tracks.flatMap((track) => track.clips)
      .find((candidate) => candidate.kind !== "gap");
    if (!clip) {
      const unavailable = failed("NO_EDITABLE_CLIP", "Project has no editable clip for a reversible probe");
      return result(input, {
        undo: unavailable,
        restart: unavailable,
        idempotency: unavailable,
        revisionConflict: unavailable,
      });
    }
    const suffix = createHash("sha256").update(input.runId).digest("hex").slice(0, 20);
    const probe: EditTransaction = {
      protocolVersion: "0.1.0",
      transactionId: `tx_alpha_correctness_${suffix}`,
      idempotencyKey: `alpha-correctness:${input.runId}`,
      projectId: cloned.project.id,
      sequenceId: cloned.project.activeSequenceId,
      baseRevision: cloned.project.revision,
      actor: { kind: "user", id: "local_user" },
      reason: "Disposable Alpha correctness probe",
      preconditions: [{ type: "object_exists", objectId: clip.id }],
      operations: [{ type: "clip.update", clipId: clip.id, patch: { enabled: !clip.enabled } }],
    };
    const committed = store.commit(probe);
    const probeRevision = committed.document.project.revision;
    const probeStateHash = hashProjectState(committed.document);

    const replay = store.commit(probe);
    checks.idempotency = {
      passed: replay.idempotentReplay
        && replay.document.project.revision === probeRevision
        && hashProjectState(replay.document) === probeStateHash,
      code: "IDEMPOTENT_REPLAY",
      details: {
        idempotentReplay: replay.idempotentReplay,
        revisionBefore: probeRevision,
        revisionAfter: replay.document.project.revision,
        stateUnchanged: hashProjectState(replay.document) === probeStateHash,
      },
    };

    const recordCountBeforeConflict = store.listRecords().length;
    let observedConflictCode = "NO_ERROR";
    try {
      store.commit({
        ...probe,
        transactionId: `tx_alpha_stale_${suffix}`,
        idempotencyKey: `alpha-stale:${input.runId}`,
        baseRevision: cloned.project.revision,
        reason: "Disposable stale-revision probe",
      });
    } catch (error) {
      observedConflictCode = error instanceof EditError ? error.code : errorName(error);
    }
    const afterConflict = store.snapshot();
    checks.revisionConflict = {
      passed: observedConflictCode === "REVISION_CONFLICT"
        && afterConflict.project.revision === probeRevision
        && hashProjectState(afterConflict) === probeStateHash
        && store.listRecords().length === recordCountBeforeConflict,
      code: "REVISION_CONFLICT_REJECTED",
      details: {
        observedCode: observedConflictCode,
        revisionUnchanged: afterConflict.project.revision === probeRevision,
        stateUnchanged: hashProjectState(afterConflict) === probeStateHash,
        commandCountUnchanged: store.listRecords().length === recordCountBeforeConflict,
      },
    };

    store.close();
    store = ProjectStore.open(input.clonePath, { clock: VERIFIER_CLOCK });
    const reopened = store.snapshot();
    let replayVerified = false;
    try {
      replayVerified = store.verify().stateHash === probeStateHash;
    } catch {
      replayVerified = false;
    }
    checks.restart = {
      passed: reopened.project.revision === probeRevision
        && hashProjectState(reopened) === probeStateHash
        && replayVerified,
      code: "STATE_REOPEN_MATCH",
      details: {
        expectedRevision: probeRevision,
        observedRevision: reopened.project.revision,
        stateHashMatch: hashProjectState(reopened) === probeStateHash,
        replayVerified,
      },
    };

    const undone = store.undo(probe.transactionId, { kind: "user", id: "local_user" }, `tx_alpha_undo_${suffix}`);
    let undoReplayVerified = false;
    try {
      undoReplayVerified = store.verify().stateHash === hashProjectState(undone.document);
    } catch {
      undoReplayVerified = false;
    }
    const domainRestored = domainStateHash(undone.document) === domainStateHash(input.sourceDocument);
    checks.undo = {
      passed: domainRestored
        && undone.document.project.revision === input.sourceDocument.project.revision + 2
        && undoReplayVerified,
      code: "DOMAIN_STATE_RESTORED",
      details: {
        domainStateRestored: domainRestored,
        expectedRevision: input.sourceDocument.project.revision + 2,
        observedRevision: undone.document.project.revision,
        replayVerified: undoReplayVerified,
      },
    };
    return result(input, checks);
  } catch (error) {
    if (error instanceof AlphaCorrectnessError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return result(input, {
      undo: checks.undo.passed ? checks.undo : failed("PROBE_FAILED", message),
      restart: checks.restart.passed ? checks.restart : failed("PROBE_FAILED", message),
      idempotency: checks.idempotency.passed ? checks.idempotency : failed("PROBE_FAILED", message),
      revisionConflict: checks.revisionConflict.passed
        ? checks.revisionConflict
        : failed("PROBE_FAILED", message),
    });
  } finally {
    store.close();
  }
}

async function backupDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  const source = new DatabaseSync(sourcePath, {
    readOnly: true,
    allowExtension: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    defensive: true,
  });
  try {
    await backup(source, destinationPath);
  } catch (error) {
    throw new AlphaCorrectnessError(
      "CORRECTNESS_BACKUP_FAILED",
      `Failed to create disposable SQLite backup: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    source.close();
  }
}

function domainStateHash(document: AgentCutProjectDocument): string {
  const normalized = structuredClone(document);
  normalized.project.revision = 0;
  normalized.project.updatedAt = normalized.project.createdAt;
  normalized.history = { headRevision: 0, records: [] };
  return hashProjectState(normalized);
}

function result(
  input: {
    runId: string;
    sourceSha256: string;
    sourceDocument: AgentCutProjectDocument;
    sourceStateHash: string;
  },
  checks: AlphaCorrectnessRun["checks"],
): AlphaCorrectnessRun {
  return {
    runId: input.runId,
    projectId: input.sourceDocument.project.id,
    projectRevision: input.sourceDocument.project.revision,
    sourceSha256: input.sourceSha256,
    sourceStateHash: input.sourceStateHash,
    checks,
  };
}

function requiredText(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}
