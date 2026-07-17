import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyTransaction,
  EditError,
  hashProjectState,
  type Clock,
  type CommandRecord,
  type CommitResult,
  type EditTransaction,
} from "@agentcut/edit-commands";
import {
  assertProjectDocument,
  type Actor,
  type AgentCutProjectDocument,
} from "@agentcut/timeline-schema";

const STORE_VERSION = 1;

export type FailurePoint =
  | "after_begin"
  | "after_apply"
  | "after_command_insert"
  | "after_state_update"
  | "after_checkpoint"
  | "before_commit"
  | "after_commit";

export interface ProjectStoreOptions {
  clock?: Clock;
  checkpointInterval?: number;
  busyTimeoutMs?: number;
  failureInjector?: (point: FailurePoint) => void;
}

export interface StoreCheckpoint {
  revision: number;
  stateHash: string;
  createdAt: string;
}

export interface StoreVerification {
  integrity: "ok";
  genesisRevision: number;
  headRevision: number;
  replayedCommands: number;
  checkpoints: number;
  stateHash: string;
}

export class ProjectStoreError extends Error {
  constructor(
    readonly code: "STORE_ALREADY_INITIALIZED" | "STORE_NOT_INITIALIZED" | "STORE_CORRUPT",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ProjectStoreError";
  }
}

interface StateRow {
  projectId: string;
  revision: number;
  documentJson: string;
  stateHash: string;
  updatedAt: string;
}

interface CommandRow {
  payloadHash: string;
  recordJson: string;
}

export class ProjectStore implements Disposable {
  readonly #db: DatabaseSync;
  readonly #clock: Clock;
  readonly #checkpointInterval: number;
  readonly #failureInjector: ((point: FailurePoint) => void) | undefined;
  #closed = false;

  private constructor(databasePath: string, options: ProjectStoreOptions = {}) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.#db = new DatabaseSync(databasePath, {
      timeout: options.busyTimeoutMs ?? 5_000,
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      defensive: true,
    });
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#checkpointInterval = options.checkpointInterval ?? 25;
    if (!Number.isInteger(this.#checkpointInterval) || this.#checkpointInterval < 1) {
      this.#db.close();
      throw new RangeError("checkpointInterval must be a positive integer");
    }
    this.#failureInjector = options.failureInjector;
    this.#configure();
    this.#createSchema();
  }

  static create(
    databasePath: string,
    document: AgentCutProjectDocument,
    options: ProjectStoreOptions = {},
  ): ProjectStore {
    assertProjectDocument(document);
    const store = new ProjectStore(databasePath, options);
    try {
      if (store.#readState(false)) {
        throw new ProjectStoreError(
          "STORE_ALREADY_INITIALIZED",
          `Project store ${databasePath} is already initialized`,
        );
      }
      store.#initialize(document);
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  static open(databasePath: string, options: ProjectStoreOptions = {}): ProjectStore {
    const store = new ProjectStore(databasePath, options);
    try {
      store.#readState();
      store.#assertStoreVersion();
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  journalMode(): string {
    const row = this.#db.prepare("PRAGMA journal_mode").get();
    return readString(row, "journal_mode");
  }

  snapshot(): AgentCutProjectDocument {
    return parseDocument(this.#readState().documentJson);
  }

  getRecord(transactionId: string): CommandRecord | undefined {
    const row = this.#db.prepare(
      "SELECT record_json FROM command_log WHERE transaction_id = ?",
    ).get(transactionId);
    return row ? parseRecord(readString(row, "record_json")) : undefined;
  }

  listRecords(): CommandRecord[] {
    return this.#db.prepare(
      "SELECT record_json FROM command_log ORDER BY committed_revision",
    ).all().map((row) => parseRecord(readString(row, "record_json")));
  }

  listCheckpoints(): StoreCheckpoint[] {
    return this.#db.prepare(
      "SELECT revision, state_hash, created_at FROM checkpoints ORDER BY revision",
    ).all().map((row) => ({
      revision: readNumber(row, "revision"),
      stateHash: readString(row, "state_hash"),
      createdAt: readString(row, "created_at"),
    }));
  }

  commit(transaction: EditTransaction): CommitResult {
    let committed = false;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#inject("after_begin");
      const state = this.#readState();
      const payloadHash = hashCanonical(transaction);
      const existing = this.#findByIdempotencyKey(transaction.idempotencyKey);
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new EditError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used with a different transaction payload",
            { idempotencyKey: transaction.idempotencyKey },
          );
        }
        const record = parseRecord(existing.recordJson);
        const document = parseDocument(state.documentJson);
        this.#db.exec("COMMIT");
        committed = true;
        return { document, record, idempotentReplay: true };
      }
      const duplicateTransaction = this.#db.prepare(
        "SELECT idempotency_key FROM command_log WHERE transaction_id = ?",
      ).get(transaction.transactionId);
      if (duplicateTransaction) {
        throw new EditError(
          "IDEMPOTENCY_CONFLICT",
          "Transaction ID was already used with another idempotency key",
          {
            transactionId: transaction.transactionId,
            previousIdempotencyKey: readString(duplicateTransaction, "idempotency_key"),
          },
        );
      }

      const current = parseDocument(state.documentJson);
      if (hashProjectState(current) !== state.stateHash) {
        throw new ProjectStoreError("STORE_CORRUPT", "Current project state hash does not match");
      }
      const result = applyTransaction(current, transaction, this.#clock);
      this.#inject("after_apply");
      this.#insertCommand(transaction, payloadHash, result.record);
      this.#inject("after_command_insert");
      this.#updateState(result.document, result.record.afterHash, result.record.committedAt);
      this.#inject("after_state_update");
      if (result.record.committedRevision % this.#checkpointInterval === 0) {
        this.#insertCheckpoint(result.document, result.record.afterHash, result.record.committedAt);
      }
      this.#inject("after_checkpoint");
      this.#inject("before_commit");
      this.#db.exec("COMMIT");
      committed = true;
      this.#inject("after_commit");
      return result;
    } catch (error) {
      if (!committed) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  undo(transactionId: string, actor: Actor, undoTransactionId: string): CommitResult {
    const record = this.getRecord(transactionId);
    if (!record) throw new EditError("OBJECT_NOT_FOUND", `Command ${transactionId} does not exist`);
    const document = this.snapshot();
    return this.commit({
      protocolVersion: "0.1.0",
      transactionId: undoTransactionId,
      idempotencyKey: `undo:${transactionId}:${document.project.revision}`,
      projectId: document.project.id,
      sequenceId: record.request.sequenceId,
      baseRevision: document.project.revision,
      actor,
      reason: `Undo ${transactionId}: ${record.request.reason}`,
      preconditions: [],
      operations: structuredClone(record.inverseOperations),
    });
  }

  createCheckpoint(): StoreCheckpoint {
    let committed = false;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.#readState();
      const document = parseDocument(state.documentJson);
      const actualHash = hashProjectState(document);
      if (actualHash !== state.stateHash) {
        throw new ProjectStoreError("STORE_CORRUPT", "Cannot checkpoint a state with a mismatched hash");
      }
      this.#insertCheckpoint(document, actualHash, this.#clock());
      this.#db.exec("COMMIT");
      committed = true;
      const row = this.#db.prepare(
        "SELECT revision, state_hash, created_at FROM checkpoints WHERE revision = ?",
      ).get(document.project.revision);
      if (!row) throw new ProjectStoreError("STORE_CORRUPT", "Checkpoint disappeared after commit");
      return {
        revision: readNumber(row, "revision"),
        stateHash: readString(row, "state_hash"),
        createdAt: readString(row, "created_at"),
      };
    } catch (error) {
      if (!committed) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  verify(): StoreVerification {
    const integrityRows = this.#db.prepare("PRAGMA integrity_check").all();
    if (integrityRows.length === 0
      || integrityRows.some((row) => readString(row, "integrity_check") !== "ok")) {
      throw new ProjectStoreError("STORE_CORRUPT", "SQLite integrity_check failed", {
        results: integrityRows,
      });
    }

    const checkpointRow = this.#db.prepare(
      "SELECT revision, document_json, state_hash FROM checkpoints ORDER BY revision ASC LIMIT 1",
    ).get();
    if (!checkpointRow) throw new ProjectStoreError("STORE_CORRUPT", "Genesis checkpoint is missing");
    const genesisRevision = readNumber(checkpointRow, "revision");
    let replayed = parseDocument(readString(checkpointRow, "document_json"));
    const genesisHash = readString(checkpointRow, "state_hash");
    if (hashProjectState(replayed) !== genesisHash) {
      throw new ProjectStoreError("STORE_CORRUPT", "Genesis checkpoint hash does not match");
    }

    const rows = this.#db.prepare(
      "SELECT record_json FROM command_log WHERE committed_revision > ? ORDER BY committed_revision",
    ).all(genesisRevision);
    let replayedCommands = 0;
    for (const row of rows) {
      const record = parseRecord(readString(row, "record_json"));
      const replay = applyTransaction(replayed, record.request, () => record.committedAt);
      if (replay.record.beforeHash !== record.beforeHash
        || replay.record.afterHash !== record.afterHash
        || replay.record.committedRevision !== record.committedRevision) {
        throw new ProjectStoreError("STORE_CORRUPT", "Command replay diverged", {
          transactionId: record.transactionId,
        });
      }
      replayed = replay.document;
      replayedCommands += 1;
    }

    const state = this.#readState();
    const finalHash = hashProjectState(replayed);
    if (replayed.project.revision !== state.revision || finalHash !== state.stateHash) {
      throw new ProjectStoreError("STORE_CORRUPT", "Replayed head does not match current state", {
        replayedRevision: replayed.project.revision,
        storedRevision: state.revision,
        replayedHash: finalHash,
        storedHash: state.stateHash,
      });
    }
    return {
      integrity: "ok",
      genesisRevision,
      headRevision: state.revision,
      replayedCommands,
      checkpoints: this.listCheckpoints().length,
      stateHash: state.stateHash,
    };
  }

  #configure(): void {
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA wal_autocheckpoint = 1000;
    `);
  }

  #createSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS current_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        project_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL UNIQUE CHECK (revision >= 0),
        document_json TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS command_log (
        transaction_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        project_id TEXT NOT NULL,
        sequence_id TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        committed_revision INTEGER NOT NULL UNIQUE,
        request_json TEXT NOT NULL,
        inverse_json TEXT NOT NULL,
        record_json TEXT NOT NULL,
        before_hash TEXT NOT NULL,
        after_hash TEXT NOT NULL,
        committed_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS command_log_project_revision
        ON command_log(project_id, committed_revision);
      CREATE TABLE IF NOT EXISTS checkpoints (
        revision INTEGER PRIMARY KEY,
        document_json TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = ${STORE_VERSION};
    `);
  }

  #initialize(document: AgentCutProjectDocument): void {
    let committed = false;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const stateHash = hashProjectState(document);
      const createdAt = this.#clock();
      this.#db.prepare("INSERT INTO store_meta(key, value) VALUES (?, ?)")
        .run("store_version", String(STORE_VERSION));
      this.#db.prepare("INSERT INTO store_meta(key, value) VALUES (?, ?)")
        .run("genesis_revision", String(document.project.revision));
      this.#db.prepare(`
        INSERT INTO current_state(
          singleton, project_id, revision, document_json, state_hash, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?)
      `).run(
        document.project.id,
        document.project.revision,
        JSON.stringify(document),
        stateHash,
        createdAt,
      );
      this.#insertCheckpoint(document, stateHash, createdAt);
      this.#db.exec("COMMIT");
      committed = true;
    } catch (error) {
      if (!committed) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #assertStoreVersion(): void {
    const row = this.#db.prepare("SELECT value FROM store_meta WHERE key = 'store_version'").get();
    if (!row) throw new ProjectStoreError("STORE_CORRUPT", "Store version metadata is missing");
    const version = Number(readString(row, "value"));
    if (version !== STORE_VERSION) {
      throw new ProjectStoreError("STORE_CORRUPT", `Unsupported store version ${version}`);
    }
  }

  #readState(): StateRow;
  #readState(required: true): StateRow;
  #readState(required: false): StateRow | undefined;
  #readState(required = true): StateRow | undefined {
    const row = this.#db.prepare(`
      SELECT project_id, revision, document_json, state_hash, updated_at
      FROM current_state WHERE singleton = 1
    `).get();
    if (!row) {
      if (required) throw new ProjectStoreError("STORE_NOT_INITIALIZED", "Project store is empty");
      return undefined;
    }
    return {
      projectId: readString(row, "project_id"),
      revision: readNumber(row, "revision"),
      documentJson: readString(row, "document_json"),
      stateHash: readString(row, "state_hash"),
      updatedAt: readString(row, "updated_at"),
    };
  }

  #findByIdempotencyKey(idempotencyKey: string): CommandRow | undefined {
    const row = this.#db.prepare(`
      SELECT payload_hash, record_json FROM command_log WHERE idempotency_key = ?
    `).get(idempotencyKey);
    return row ? {
      payloadHash: readString(row, "payload_hash"),
      recordJson: readString(row, "record_json"),
    } : undefined;
  }

  #insertCommand(
    transaction: EditTransaction,
    payloadHash: string,
    record: CommandRecord,
  ): void {
    this.#db.prepare(`
      INSERT INTO command_log(
        transaction_id, idempotency_key, payload_hash, project_id, sequence_id,
        base_revision, committed_revision, request_json, inverse_json, record_json,
        before_hash, after_hash, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.transactionId,
      transaction.idempotencyKey,
      payloadHash,
      record.projectId,
      transaction.sequenceId,
      record.baseRevision,
      record.committedRevision,
      JSON.stringify(record.request),
      JSON.stringify(record.inverseOperations),
      JSON.stringify(record),
      record.beforeHash,
      record.afterHash,
      record.committedAt,
    );
  }

  #updateState(document: AgentCutProjectDocument, stateHash: string, updatedAt: string): void {
    const result = this.#db.prepare(`
      UPDATE current_state
      SET revision = ?, document_json = ?, state_hash = ?, updated_at = ?
      WHERE singleton = 1 AND project_id = ?
    `).run(
      document.project.revision,
      JSON.stringify(document),
      stateHash,
      updatedAt,
      document.project.id,
    );
    if (result.changes !== 1) {
      throw new ProjectStoreError("STORE_CORRUPT", "Current project row was not updated exactly once");
    }
  }

  #insertCheckpoint(
    document: AgentCutProjectDocument,
    stateHash: string,
    createdAt: string,
  ): void {
    this.#db.prepare(`
      INSERT INTO checkpoints(revision, document_json, state_hash, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(revision) DO UPDATE SET
        document_json = excluded.document_json,
        state_hash = excluded.state_hash,
        created_at = excluded.created_at
    `).run(document.project.revision, JSON.stringify(document), stateHash, createdAt);
  }

  #inject(point: FailurePoint): void {
    this.#failureInjector?.(point);
  }
}

function parseDocument(json: string): AgentCutProjectDocument {
  const value: unknown = JSON.parse(json);
  assertProjectDocument(value);
  return value;
}

function parseRecord(json: string): CommandRecord {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object") {
    throw new ProjectStoreError("STORE_CORRUPT", "Command record is not an object");
  }
  return value as CommandRecord;
}

function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function readString(row: Record<string, unknown> | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string") {
    throw new ProjectStoreError("STORE_CORRUPT", `Expected string column ${key}`);
  }
  return value;
}

function readNumber(row: Record<string, unknown> | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ProjectStoreError("STORE_CORRUPT", `Expected safe integer column ${key}`);
  }
  return value;
}
