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
  type ExtensionValidator,
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
  maximumDatabasePages?: number;
  failureInjector?: (point: FailurePoint) => void;
  extensionValidators?: readonly ExtensionValidator[];
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

export type JobStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

export interface ProjectJob {
  id: string;
  projectId: string;
  type: string;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
  progress: number;
  inputHash: string;
  input: unknown;
  outputArtifactIds: string[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
  retryable: boolean;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectJobEvent {
  sequence: number;
  jobId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface JobCancellationRequest {
  sequence: number;
  projectId: string;
  jobId: string;
  requestId: string;
  requestedBy: string;
  observedStatus: JobStatus;
  changed: boolean;
  createdAt: string;
}

export type AgentCapability =
  | "project:read"
  | "transcript:read"
  | "analysis:local"
  | "analysis:propose"
  | "timeline:write:low_risk_only"
  | "approval:request"
  | "timeline:write:approved"
  | "export:write";

export interface AgentSession {
  id: string;
  projectId: string;
  clientId: string;
  capabilities: AgentCapability[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface AgentSessionCreation {
  session: AgentSession;
  idempotentReplay: boolean;
}

export interface AgentSessionRevocation {
  session: AgentSession;
  idempotentReplay: boolean;
  alreadyRevoked: boolean;
}

export interface AgentSessionRevocationEvent {
  sequence: number;
  projectId: string;
  sessionId: string;
  requestId: string;
  revokedBy: string;
  changed: boolean;
  createdAt: string;
}

export interface UiAccessEvent {
  sequence: number;
  projectId: string;
  method: string;
  path: string;
  allowed: boolean;
  reason: "paired" | "allowed" | "missing" | "invalid" | "expired";
  createdAt: string;
}

export interface UiCredentialRotationEvent {
  sequence: number;
  projectId: string;
  requestId: string;
  previousFingerprint: string;
  currentFingerprint: string;
  generation: number;
  rotatedBy: "local_user";
  createdAt: string;
}

export interface UiCredentialRotationRecording {
  event: UiCredentialRotationEvent;
  idempotentReplay: boolean;
}

export interface AgentAccessEvent {
  sequence: number;
  projectId: string;
  sessionId?: string;
  capability: AgentCapability;
  method: string;
  path: string;
  requestId?: string;
  allowed: boolean;
  reason: "allowed" | "unknown_token" | "expired" | "revoked" | "capability_denied";
  createdAt: string;
}

export type ApprovalKind = "content_high_risk_delete";
export type ApprovalState = "pending" | "approved" | "denied" | "consumed";

export interface ProjectApproval {
  id: string;
  projectId: string;
  kind: ApprovalKind;
  targetId: string;
  baseRevision: number;
  payloadHash: string;
  requestedBySessionId: string;
  requestId: string;
  state: ApprovalState;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionRequestId?: string;
  consumedAt?: string;
  consumedBySessionId?: string;
  transactionId?: string;
}

export interface ApprovalCreation {
  approval: ProjectApproval;
  idempotentReplay: boolean;
}

export class ProjectStoreError extends Error {
  constructor(
    readonly code:
      | "STORE_ALREADY_INITIALIZED"
      | "STORE_NOT_INITIALIZED"
      | "STORE_CORRUPT"
      | "STORE_CAPACITY"
      | "JOB_NOT_FOUND"
      | "INVALID_JOB_STATE"
      | "AGENT_SESSION_INVALID"
      | "AGENT_SESSION_NOT_FOUND"
      | "AGENT_SESSION_TARGET_NOT_FOUND"
      | "CAPABILITY_DENIED"
      | "UI_CREDENTIAL_ROTATION_INVALID"
      | "APPROVAL_INVALID"
      | "APPROVAL_NOT_FOUND"
      | "APPROVAL_STATE_INVALID",
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
  readonly #extensionValidators: readonly ExtensionValidator[];
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
    this.#extensionValidators = options.extensionValidators ?? [];
    if (!Number.isInteger(this.#checkpointInterval) || this.#checkpointInterval < 1) {
      this.#db.close();
      throw new RangeError("checkpointInterval must be a positive integer");
    }
    this.#failureInjector = options.failureInjector;
    this.#configure();
    this.#createSchema();
    if (options.maximumDatabasePages !== undefined) {
      if (!Number.isSafeInteger(options.maximumDatabasePages) || options.maximumDatabasePages < 1) {
        this.#db.close();
        throw new RangeError("maximumDatabasePages must be a positive safe integer");
      }
      this.#db.exec(`PRAGMA max_page_count = ${options.maximumDatabasePages}`);
    }
  }

  static create(
    databasePath: string,
    document: AgentCutProjectDocument,
    options: ProjectStoreOptions = {},
  ): ProjectStore {
    assertProjectDocument(document, { extensionValidators: options.extensionValidators });
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
    let store: ProjectStore | undefined;
    try {
      store = new ProjectStore(databasePath, options);
      const state = store.#readState();
      store.#assertStoreVersion();
      const document = parseDocument(state.documentJson, store.#extensionValidators);
      const actualHash = hashProjectState(document);
      if (actualHash !== state.stateHash) {
        throw new ProjectStoreError("STORE_CORRUPT", "Current project state hash does not match", {
          expected: state.stateHash,
          actual: actualHash,
        });
      }
      return store;
    } catch (error) {
      store?.close();
      if (error instanceof ProjectStoreError) throw error;
      throw new ProjectStoreError("STORE_CORRUPT", `Failed to open project store ${databasePath}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
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
    return parseDocument(this.#readState().documentJson, this.#extensionValidators);
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

  createAgentSession(input: {
    id: string;
    requestId: string;
    clientId: string;
    capabilities: AgentCapability[];
    ttlSeconds: number;
    tokenHash: string;
  }): AgentSessionCreation {
    assertAgentSessionInput(input);
    const state = this.#readState();
    const payloadHash = hashCanonical({
      clientId: input.clientId,
      capabilities: [...input.capabilities].sort(),
      ttlSeconds: input.ttlSeconds,
    });
    let creation: AgentSessionCreation | undefined;
    this.#withImmediateTransaction(() => {
      const existing = this.#db.prepare(`
        SELECT * FROM agent_sessions WHERE create_request_id = ?
      `).get(input.requestId);
      if (existing) {
        if (readString(existing, "create_payload_hash") !== payloadHash) {
          throw new ProjectStoreError(
            "AGENT_SESSION_INVALID",
            "Agent session requestId was reused with another payload",
            { requestId: input.requestId },
          );
        }
        if (readString(existing, "token_hash") !== input.tokenHash) {
          throw new ProjectStoreError(
            "AGENT_SESSION_INVALID",
            "Agent session credential key changed; create a session with a new requestId",
            { requestId: input.requestId },
          );
        }
        creation = { session: parseAgentSession(existing), idempotentReplay: true };
        return;
      }
      if (this.#db.prepare("SELECT session_id FROM agent_sessions WHERE session_id = ?").get(input.id)) {
        throw new ProjectStoreError(
          "AGENT_SESSION_INVALID",
          `Agent session ${input.id} already exists with another request`,
        );
      }
      const createdAt = this.#clock();
      const createdMillis = Date.parse(createdAt);
      if (!Number.isFinite(createdMillis)) {
        throw new ProjectStoreError("AGENT_SESSION_INVALID", "Agent session clock returned invalid ISO time");
      }
      const expiresAt = new Date(createdMillis + input.ttlSeconds * 1_000).toISOString();
      this.#db.prepare(`
        INSERT INTO agent_sessions(
          session_id, project_id, client_id, capabilities_json,
          create_request_id, create_payload_hash, token_hash,
          created_at, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        input.id,
        state.projectId,
        input.clientId,
        JSON.stringify([...input.capabilities].sort()),
        input.requestId,
        payloadHash,
        input.tokenHash,
        createdAt,
        expiresAt,
      );
      creation = {
        session: {
          id: input.id,
          projectId: state.projectId,
          clientId: input.clientId,
          capabilities: [...input.capabilities].sort(),
          createdAt,
          expiresAt,
        },
        idempotentReplay: false,
      };
    });
    if (!creation) throw new Error("Invariant violation: agent session creation returned no result");
    return creation;
  }

  authorizeAgentSession(input: {
    tokenHash: string;
    capability: AgentCapability;
    method: string;
    path: string;
    requestId?: string;
  }): AgentSession {
    let authorized: AgentSession | undefined;
    let rejected: ProjectStoreError | undefined;
    this.#withImmediateTransaction(() => {
      const state = this.#readState();
      const row = this.#db.prepare("SELECT * FROM agent_sessions WHERE token_hash = ?")
        .get(input.tokenHash);
      const now = this.#clock();
      let reason: AgentAccessEvent["reason"] = "unknown_token";
      if (row) {
        const session = parseAgentSession(row);
        if (session.revokedAt) reason = "revoked";
        else if (Date.parse(session.expiresAt) <= Date.parse(now)) reason = "expired";
        else if (!session.capabilities.includes(input.capability)) reason = "capability_denied";
        else {
          reason = "allowed";
          authorized = session;
        }
        if (!authorized) {
          rejected = new ProjectStoreError(
            reason === "capability_denied" ? "CAPABILITY_DENIED" : "AGENT_SESSION_INVALID",
            reason === "capability_denied"
              ? `Agent session lacks ${input.capability}`
              : `Agent session is ${reason}`,
            { sessionId: session.id, capability: input.capability, reason },
          );
        }
      } else {
        rejected = new ProjectStoreError(
          "AGENT_SESSION_NOT_FOUND",
          "Agent access token is unknown",
          { capability: input.capability },
        );
      }
      this.#db.prepare(`
        INSERT INTO agent_access_events(
          project_id, session_id, capability, method, path, request_id,
          allowed, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        state.projectId,
        row ? readString(row, "session_id") : null,
        input.capability,
        input.method,
        input.path,
        input.requestId ?? null,
        authorized ? 1 : 0,
        reason,
        now,
      );
    });
    if (rejected) throw rejected;
    if (!authorized) throw new Error("Invariant violation: agent authorization returned no result");
    return authorized;
  }

  listAgentSessions(): AgentSession[] {
    return this.#db.prepare(
      "SELECT * FROM agent_sessions ORDER BY created_at DESC, session_id",
    ).all().map(parseAgentSession);
  }

  revokeAgentSession(input: {
    sessionId: string;
    requestId: string;
    revokedBy: string;
  }): AgentSessionRevocation {
    assertStableText(input.sessionId, "sessionId", "AGENT_SESSION_INVALID");
    assertStableText(input.requestId, "requestId", "AGENT_SESSION_INVALID");
    assertStableText(input.revokedBy, "revokedBy", "AGENT_SESSION_INVALID");
    const payloadHash = hashCanonical({ sessionId: input.sessionId, revokedBy: input.revokedBy });
    let result: AgentSessionRevocation | undefined;
    this.#withImmediateTransaction(() => {
      const replay = this.#db.prepare(
        "SELECT * FROM agent_session_revocations WHERE request_id = ?",
      ).get(input.requestId);
      if (replay) {
        if (readString(replay, "request_hash") !== payloadHash) {
          throw new ProjectStoreError(
            "AGENT_SESSION_INVALID",
            "Agent session revoke requestId was reused with another payload",
            { requestId: input.requestId },
          );
        }
        const row = this.#db.prepare("SELECT * FROM agent_sessions WHERE session_id = ?")
          .get(readString(replay, "session_id"));
        if (!row) throw new ProjectStoreError("STORE_CORRUPT", "Revoked Agent session is missing");
        result = {
          session: parseAgentSession(row),
          idempotentReplay: true,
          alreadyRevoked: readNumber(replay, "changed") === 0,
        };
        return;
      }
      const row = this.#db.prepare("SELECT * FROM agent_sessions WHERE session_id = ?")
        .get(input.sessionId);
      if (!row) {
        throw new ProjectStoreError(
          "AGENT_SESSION_TARGET_NOT_FOUND",
          `Agent session ${input.sessionId} does not exist`,
        );
      }
      const session = parseAgentSession(row);
      const alreadyRevoked = session.revokedAt !== undefined;
      const createdAt = this.#clock();
      this.#db.prepare(`
        INSERT INTO agent_session_revocations(
          project_id, session_id, request_id, request_hash, revoked_by, changed, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.projectId,
        session.id,
        input.requestId,
        payloadHash,
        input.revokedBy,
        alreadyRevoked ? 0 : 1,
        createdAt,
      );
      if (!alreadyRevoked) {
        this.#db.prepare("UPDATE agent_sessions SET revoked_at = ? WHERE session_id = ?")
          .run(createdAt, session.id);
      }
      const updated = this.#db.prepare("SELECT * FROM agent_sessions WHERE session_id = ?")
        .get(session.id);
      if (!updated) throw new Error("Invariant violation: revoked Agent session disappeared");
      result = {
        session: parseAgentSession(updated),
        idempotentReplay: false,
        alreadyRevoked,
      };
    });
    if (!result) throw new Error("Invariant violation: Agent session revocation returned no result");
    return result;
  }

  listAgentSessionRevocations(sessionId?: string): AgentSessionRevocationEvent[] {
    const rows = sessionId === undefined
      ? this.#db.prepare("SELECT * FROM agent_session_revocations ORDER BY sequence").all()
      : this.#db.prepare(
        "SELECT * FROM agent_session_revocations WHERE session_id = ? ORDER BY sequence",
      ).all(sessionId);
    return rows.map(parseAgentSessionRevocationEvent);
  }

  listAgentAccessEvents(sessionId?: string): AgentAccessEvent[] {
    const rows = sessionId === undefined
      ? this.#db.prepare("SELECT * FROM agent_access_events ORDER BY sequence").all()
      : this.#db.prepare(
        "SELECT * FROM agent_access_events WHERE session_id = ? ORDER BY sequence",
      ).all(sessionId);
    return rows.map(parseAgentAccessEvent);
  }

  recordUiAccessEvent(input: {
    method: string;
    path: string;
    allowed: boolean;
    reason: UiAccessEvent["reason"];
  }): UiAccessEvent {
    assertStableText(input.method, "method", "AGENT_SESSION_INVALID");
    assertStableText(input.path, "path", "AGENT_SESSION_INVALID");
    const state = this.#readState();
    const createdAt = this.#clock();
    const result = this.#db.prepare(`
      INSERT INTO ui_access_events(project_id, method, path, allowed, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      state.projectId,
      input.method,
      input.path,
      input.allowed ? 1 : 0,
      input.reason,
      createdAt,
    );
    const row = this.#db.prepare("SELECT * FROM ui_access_events WHERE sequence = ?")
      .get(Number(result.lastInsertRowid));
    if (!row) throw new Error("Invariant violation: UI access event was not stored");
    return parseUiAccessEvent(row);
  }

  listUiAccessEvents(): UiAccessEvent[] {
    return this.#db.prepare("SELECT * FROM ui_access_events ORDER BY sequence")
      .all().map(parseUiAccessEvent);
  }

  recordUiCredentialRotation(input: {
    requestId: string;
    previousFingerprint: string;
    currentFingerprint: string;
    generation: number;
    rotatedBy: "local_user";
    createdAt: string;
  }): UiCredentialRotationRecording {
    assertStableText(input.requestId, "requestId", "UI_CREDENTIAL_ROTATION_INVALID");
    if (!/^[a-f0-9]{64}$/.test(input.previousFingerprint)
      || !/^[a-f0-9]{64}$/.test(input.currentFingerprint)
      || input.previousFingerprint === input.currentFingerprint
      || !Number.isSafeInteger(input.generation) || input.generation < 1
      || !Number.isFinite(Date.parse(input.createdAt))) {
      throw new ProjectStoreError(
        "UI_CREDENTIAL_ROTATION_INVALID",
        "UI credential rotation metadata is invalid",
      );
    }
    const state = this.#readState();
    const requestHash = hashCanonical({
      previousFingerprint: input.previousFingerprint,
      currentFingerprint: input.currentFingerprint,
      generation: input.generation,
      rotatedBy: input.rotatedBy,
      createdAt: input.createdAt,
    });
    let result: UiCredentialRotationRecording | undefined;
    this.#withImmediateTransaction(() => {
      const existing = this.#db.prepare(
        "SELECT * FROM ui_credential_rotations WHERE request_id = ?",
      ).get(input.requestId);
      if (existing) {
        if (readString(existing, "request_hash") !== requestHash) {
          throw new ProjectStoreError(
            "UI_CREDENTIAL_ROTATION_INVALID",
            "UI credential rotation requestId was reused with another rotation",
          );
        }
        result = { event: parseUiCredentialRotationEvent(existing), idempotentReplay: true };
        return;
      }
      this.#db.prepare(`
        INSERT INTO ui_credential_rotations(
          project_id, request_id, request_hash, previous_fingerprint,
          current_fingerprint, generation, rotated_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        state.projectId,
        input.requestId,
        requestHash,
        input.previousFingerprint,
        input.currentFingerprint,
        input.generation,
        input.rotatedBy,
        input.createdAt,
      );
      const row = this.#db.prepare(
        "SELECT * FROM ui_credential_rotations WHERE request_id = ?",
      ).get(input.requestId);
      if (!row) throw new Error("Invariant violation: UI credential rotation was not stored");
      result = { event: parseUiCredentialRotationEvent(row), idempotentReplay: false };
    });
    if (!result) throw new Error("Invariant violation: UI credential rotation returned no result");
    return result;
  }

  getUiCredentialRotation(requestId: string): UiCredentialRotationEvent | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM ui_credential_rotations WHERE request_id = ?",
    ).get(requestId);
    return row ? parseUiCredentialRotationEvent(row) : undefined;
  }

  listUiCredentialRotations(): UiCredentialRotationEvent[] {
    return this.#db.prepare("SELECT * FROM ui_credential_rotations ORDER BY sequence")
      .all().map(parseUiCredentialRotationEvent);
  }

  createApproval(input: {
    id: string;
    requestId: string;
    kind: ApprovalKind;
    targetId: string;
    baseRevision: number;
    payloadHash: string;
    requestedBySessionId: string;
    ttlSeconds: number;
  }): ApprovalCreation {
    assertApprovalCreationInput(input);
    const state = this.#readState();
    const requestHash = hashCanonical({
      kind: input.kind,
      targetId: input.targetId,
      baseRevision: input.baseRevision,
      payloadHash: input.payloadHash,
      requestedBySessionId: input.requestedBySessionId,
      ttlSeconds: input.ttlSeconds,
    });
    let result: ApprovalCreation | undefined;
    this.#withImmediateTransaction(() => {
      const existing = this.#db.prepare(
        "SELECT * FROM approvals WHERE request_id = ?",
      ).get(input.requestId);
      if (existing) {
        if (readString(existing, "request_hash") !== requestHash) {
          throw new ProjectStoreError(
            "APPROVAL_INVALID",
            "Approval requestId was reused with another payload",
            { requestId: input.requestId },
          );
        }
        result = { approval: parseApproval(existing), idempotentReplay: true };
        return;
      }
      if (this.#db.prepare("SELECT approval_id FROM approvals WHERE approval_id = ?").get(input.id)) {
        throw new ProjectStoreError("APPROVAL_INVALID", `Approval ${input.id} already exists`);
      }
      const session = this.#db.prepare("SELECT project_id FROM agent_sessions WHERE session_id = ?")
        .get(input.requestedBySessionId);
      if (!session || readString(session, "project_id") !== state.projectId) {
        throw new ProjectStoreError("APPROVAL_INVALID", "Approval requester is not a project Agent session");
      }
      const createdAt = this.#clock();
      const createdMillis = Date.parse(createdAt);
      if (!Number.isFinite(createdMillis)) {
        throw new ProjectStoreError("APPROVAL_INVALID", "Approval clock returned invalid ISO time");
      }
      const expiresAt = new Date(createdMillis + input.ttlSeconds * 1_000).toISOString();
      this.#db.prepare(`
        INSERT INTO approvals(
          approval_id, project_id, kind, target_id, base_revision, payload_hash,
          requested_by_session_id, request_id, request_hash, state,
          created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        input.id,
        state.projectId,
        input.kind,
        input.targetId,
        input.baseRevision,
        input.payloadHash,
        input.requestedBySessionId,
        input.requestId,
        requestHash,
        createdAt,
        expiresAt,
      );
      result = {
        approval: parseApproval(this.#db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(input.id)!),
        idempotentReplay: false,
      };
    });
    if (!result) throw new Error("Invariant violation: approval creation returned no result");
    return result;
  }

  getApproval(approvalId: string): ProjectApproval | undefined {
    const row = this.#db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId);
    return row ? parseApproval(row) : undefined;
  }

  listApprovals(): ProjectApproval[] {
    return this.#db.prepare("SELECT * FROM approvals ORDER BY created_at, approval_id")
      .all().map(parseApproval);
  }

  resolveApproval(input: {
    approvalId: string;
    requestId: string;
    decision: "approve" | "deny";
    resolvedBy: string;
    tokenHash?: string;
  }): { approval: ProjectApproval; idempotentReplay: boolean } {
    assertStableText(input.approvalId, "approvalId", "APPROVAL_INVALID");
    assertStableText(input.requestId, "requestId", "APPROVAL_INVALID");
    assertStableText(input.resolvedBy, "resolvedBy", "APPROVAL_INVALID");
    if (input.decision === "approve") assertHash(input.tokenHash, "tokenHash");
    if (input.decision === "deny" && input.tokenHash !== undefined) {
      throw new ProjectStoreError("APPROVAL_INVALID", "Denied approval cannot have a token");
    }
    const resolutionHash = hashCanonical({
      approvalId: input.approvalId,
      decision: input.decision,
      resolvedBy: input.resolvedBy,
      tokenHash: input.tokenHash ?? null,
    });
    let result: { approval: ProjectApproval; idempotentReplay: boolean } | undefined;
    this.#withImmediateTransaction(() => {
      const reused = this.#db.prepare(
        "SELECT * FROM approvals WHERE resolution_request_id = ?",
      ).get(input.requestId);
      if (reused) {
        if (readString(reused, "resolution_hash") !== resolutionHash) {
          throw new ProjectStoreError("APPROVAL_INVALID", "Approval resolution requestId was reused");
        }
        result = { approval: parseApproval(reused), idempotentReplay: true };
        return;
      }
      const row = this.#db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(input.approvalId);
      if (!row) throw new ProjectStoreError("APPROVAL_NOT_FOUND", `Approval ${input.approvalId} does not exist`);
      const approval = parseApproval(row);
      if (approval.state !== "pending") {
        throw new ProjectStoreError(
          "APPROVAL_STATE_INVALID",
          `Approval ${input.approvalId} is already ${approval.state}`,
        );
      }
      if (Date.parse(approval.expiresAt) <= Date.parse(this.#clock())) {
        throw new ProjectStoreError("APPROVAL_STATE_INVALID", `Approval ${input.approvalId} is expired`);
      }
      const resolvedAt = this.#clock();
      this.#db.prepare(`
        UPDATE approvals SET
          state = ?, resolved_at = ?, resolved_by = ?,
          resolution_request_id = ?, resolution_hash = ?, token_hash = ?
        WHERE approval_id = ?
      `).run(
        input.decision === "approve" ? "approved" : "denied",
        resolvedAt,
        input.resolvedBy,
        input.requestId,
        resolutionHash,
        input.tokenHash ?? null,
        input.approvalId,
      );
      result = {
        approval: parseApproval(this.#db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(input.approvalId)!),
        idempotentReplay: false,
      };
    });
    if (!result) throw new Error("Invariant violation: approval resolution returned no result");
    return result;
  }

  consumeApproval(input: {
    approvalId: string;
    tokenHash: string;
    consumedBySessionId: string;
    transactionId: string;
  }): ProjectApproval {
    assertStableText(input.approvalId, "approvalId", "APPROVAL_INVALID");
    assertHash(input.tokenHash, "tokenHash");
    assertStableText(input.consumedBySessionId, "consumedBySessionId", "APPROVAL_INVALID");
    assertStableText(input.transactionId, "transactionId", "APPROVAL_INVALID");
    let result: ProjectApproval | undefined;
    this.#withImmediateTransaction(() => {
      const row = this.#db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(input.approvalId);
      if (!row) throw new ProjectStoreError("APPROVAL_NOT_FOUND", `Approval ${input.approvalId} does not exist`);
      const approval = parseApproval(row);
      if (approval.state === "consumed" && approval.transactionId === input.transactionId) {
        result = approval;
        return;
      }
      if (approval.state !== "approved" || readNullableString(row, "token_hash") !== input.tokenHash) {
        throw new ProjectStoreError("APPROVAL_STATE_INVALID", `Approval ${input.approvalId} is not usable`);
      }
      if (Date.parse(approval.expiresAt) <= Date.parse(this.#clock())) {
        throw new ProjectStoreError("APPROVAL_STATE_INVALID", `Approval ${input.approvalId} is expired`);
      }
      const session = this.#db.prepare("SELECT project_id FROM agent_sessions WHERE session_id = ?")
        .get(input.consumedBySessionId);
      if (!session || readString(session, "project_id") !== approval.projectId) {
        throw new ProjectStoreError("APPROVAL_INVALID", "Approval consumer is not a project Agent session");
      }
      this.#db.prepare(`
        UPDATE approvals SET state = 'consumed', consumed_at = ?,
          consumed_by_session_id = ?, transaction_id = ?
        WHERE approval_id = ?
      `).run(this.#clock(), input.consumedBySessionId, input.transactionId, input.approvalId);
      result = parseApproval(this.#db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(input.approvalId)!);
    });
    if (!result) throw new Error("Invariant violation: approval consumption returned no result");
    return result;
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

  createJob(input: {
    id: string;
    type: string;
    payload: unknown;
    maxAttempts?: number;
  }): ProjectJob {
    if (!input.id || !input.type) {
      throw new ProjectStoreError("INVALID_JOB_STATE", "Job ID and type are required");
    }
    const maxAttempts = input.maxAttempts ?? 1;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new ProjectStoreError("INVALID_JOB_STATE", "maxAttempts must be a positive integer");
    }
    const state = this.#readState();
    const now = this.#clock();
    this.#withImmediateTransaction(() => {
      try {
        this.#db.prepare(`
          INSERT INTO jobs(
            job_id, project_id, type, status, attempt, max_attempts, progress,
            input_hash, input_json, output_artifact_ids_json, error_json,
            retryable, cancel_requested, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', 0, ?, 0, ?, ?, '[]', NULL, 0, 0, ?, ?)
        `).run(
          input.id,
          state.projectId,
          input.type,
          maxAttempts,
          hashCanonical(input.payload),
          JSON.stringify(input.payload),
          now,
          now,
        );
      } catch (error) {
        throw new ProjectStoreError("INVALID_JOB_STATE", `Job ${input.id} already exists`, {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      this.#insertJobEvent(input.id, "created", { type: input.type, maxAttempts }, now);
    });
    return this.getJob(input.id);
  }

  getJob(jobId: string): ProjectJob {
    const row = this.#db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId);
    if (!row) throw new ProjectStoreError("JOB_NOT_FOUND", `Job ${jobId} does not exist`);
    return parseJob(row);
  }

  listJobs(type?: string): ProjectJob[] {
    const rows = type === undefined
      ? this.#db.prepare("SELECT * FROM jobs ORDER BY rowid").all()
      : this.#db.prepare("SELECT * FROM jobs WHERE type = ? ORDER BY rowid").all(type);
    return rows.map(parseJob);
  }

  listJobEvents(jobId: string): ProjectJobEvent[] {
    this.getJob(jobId);
    return this.#db.prepare(`
      SELECT sequence, job_id, event_type, payload_json, created_at
      FROM job_events WHERE job_id = ? ORDER BY sequence
    `).all(jobId).map((row) => ({
      sequence: readNumber(row, "sequence"),
      jobId: readString(row, "job_id"),
      type: readString(row, "event_type"),
      payload: JSON.parse(readString(row, "payload_json")) as unknown,
      createdAt: readString(row, "created_at"),
    }));
  }

  startJob(jobId: string): ProjectJob {
    const now = this.#clock();
    this.#withImmediateTransaction(() => {
      const result = this.#db.prepare(`
        UPDATE jobs
        SET status = 'running', attempt = attempt + 1, progress = 0,
            retryable = 0, error_json = NULL, updated_at = ?
        WHERE job_id = ? AND status = 'pending' AND cancel_requested = 0
          AND attempt < max_attempts
      `).run(now, jobId);
      if (result.changes !== 1) this.#throwInvalidJobTransition(jobId, "running");
      this.#insertJobEvent(jobId, "started", {}, now);
    });
    return this.getJob(jobId);
  }

  updateJobProgress(jobId: string, progress: number, payload: unknown = {}): ProjectJob {
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
      throw new ProjectStoreError("INVALID_JOB_STATE", "Job progress must be between 0 and 1");
    }
    const now = this.#clock();
    this.#withImmediateTransaction(() => {
      const result = this.#db.prepare(`
        UPDATE jobs SET progress = ?, updated_at = ?
        WHERE job_id = ? AND status = 'running'
      `).run(progress, now, jobId);
      if (result.changes !== 1) this.#throwInvalidJobTransition(jobId, "progress update");
      this.#insertJobEvent(jobId, "progress", { progress, payload }, now);
    });
    return this.getJob(jobId);
  }

  requestJobCancellation(
    jobId: string,
    audit?: { requestId: string; requestedBy: string },
  ): ProjectJob {
    const now = this.#clock();
    this.#withImmediateTransaction(() => {
      const job = this.getJob(jobId);
      if (audit) {
        assertStableText(audit.requestId, "requestId", "INVALID_JOB_STATE");
        assertStableText(audit.requestedBy, "requestedBy", "INVALID_JOB_STATE");
        const existing = this.#db.prepare(
          "SELECT * FROM job_cancellation_requests WHERE request_id = ?",
        ).get(audit.requestId);
        if (existing) {
          if (readString(existing, "job_id") !== jobId
            || readString(existing, "requested_by") !== audit.requestedBy) {
            throw new ProjectStoreError(
              "INVALID_JOB_STATE",
              "Job cancellation requestId was reused for another request",
            );
          }
          return;
        }
      }
      const changed = job.status === "pending"
        || (job.status === "running" && !job.cancelRequested);
      if (job.status === "pending") {
        this.#db.prepare(`
          UPDATE jobs SET status = 'cancelled', cancel_requested = 1, updated_at = ?
          WHERE job_id = ?
        `).run(now, jobId);
        this.#insertJobEvent(jobId, "cancelled", { beforeStart: true }, now);
      } else if (job.status === "running") {
        if (!job.cancelRequested) {
          this.#db.prepare(`UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE job_id = ?`)
            .run(now, jobId);
          this.#insertJobEvent(jobId, "cancellation_requested", {}, now);
        }
      }
      if (audit) {
        this.#db.prepare(`
          INSERT INTO job_cancellation_requests(
            project_id, job_id, request_id, requested_by, observed_status, changed, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          job.projectId,
          jobId,
          audit.requestId,
          audit.requestedBy,
          job.status,
          changed ? 1 : 0,
          now,
        );
      }
    });
    return this.getJob(jobId);
  }

  listJobCancellationRequests(jobId?: string): JobCancellationRequest[] {
    const rows = jobId === undefined
      ? this.#db.prepare("SELECT * FROM job_cancellation_requests ORDER BY sequence").all()
      : this.#db.prepare(
        "SELECT * FROM job_cancellation_requests WHERE job_id = ? ORDER BY sequence",
      ).all(jobId);
    return rows.map(parseJobCancellationRequest);
  }

  markJobCancelled(jobId: string): ProjectJob {
    const now = this.#clock();
    this.#withImmediateTransaction(() => {
      const result = this.#db.prepare(`
        UPDATE jobs SET status = 'cancelled', updated_at = ?
        WHERE job_id = ? AND status = 'running' AND cancel_requested = 1
      `).run(now, jobId);
      if (result.changes !== 1) this.#throwInvalidJobTransition(jobId, "cancelled");
      this.#insertJobEvent(jobId, "cancelled", { beforeStart: false }, now);
    });
    return this.getJob(jobId);
  }

  succeedJob(jobId: string, outputArtifactIds: string[]): ProjectJob {
    const now = this.#clock();
    this.#withImmediateTransaction(() => {
      const result = this.#db.prepare(`
        UPDATE jobs
        SET status = 'succeeded', progress = 1, output_artifact_ids_json = ?, updated_at = ?
        WHERE job_id = ? AND status = 'running' AND cancel_requested = 0
      `).run(JSON.stringify(outputArtifactIds), now, jobId);
      if (result.changes !== 1) this.#throwInvalidJobTransition(jobId, "succeeded");
      this.#insertJobEvent(jobId, "succeeded", { outputArtifactIds }, now);
    });
    return this.getJob(jobId);
  }

  failJob(
    jobId: string,
    error: { code: string; message: string; details?: Record<string, unknown> },
    options: { retryable: boolean; outcomeUnknown?: boolean },
  ): ProjectJob {
    const now = this.#clock();
    const status = options.outcomeUnknown ? "outcome_unknown" : "failed";
    const retryable = options.outcomeUnknown ? false : options.retryable;
    this.#withImmediateTransaction(() => {
      const result = this.#db.prepare(`
        UPDATE jobs SET status = ?, error_json = ?, retryable = ?, updated_at = ?
        WHERE job_id = ? AND status = 'running'
      `).run(status, JSON.stringify(error), retryable ? 1 : 0, now, jobId);
      if (result.changes !== 1) this.#throwInvalidJobTransition(jobId, status);
      this.#insertJobEvent(jobId, status, { error, retryable }, now);
    });
    return this.getJob(jobId);
  }

  retryJob(jobId: string): ProjectJob {
    const now = this.#clock();
    this.#withImmediateTransaction(() => {
      const result = this.#db.prepare(`
        UPDATE jobs
        SET status = 'pending', progress = 0, retryable = 0,
            cancel_requested = 0, updated_at = ?
        WHERE job_id = ? AND status = 'failed' AND retryable = 1
          AND attempt < max_attempts
      `).run(now, jobId);
      if (result.changes !== 1) this.#throwInvalidJobTransition(jobId, "pending retry");
      this.#insertJobEvent(jobId, "retry_scheduled", {}, now);
    });
    return this.getJob(jobId);
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
        const document = parseDocument(state.documentJson, this.#extensionValidators);
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

      const current = parseDocument(state.documentJson, this.#extensionValidators);
      if (hashProjectState(current) !== state.stateHash) {
        throw new ProjectStoreError("STORE_CORRUPT", "Current project state hash does not match");
      }
      const result = applyTransaction(current, transaction, this.#clock, this.#extensionValidators);
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
      if (!committed && this.#db.isTransaction) this.#db.exec("ROLLBACK");
      if (isStorageCapacityError(error)) {
        throw new ProjectStoreError("STORE_CAPACITY", "Project store has insufficient capacity", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
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
      const document = parseDocument(state.documentJson, this.#extensionValidators);
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
      if (!committed && this.#db.isTransaction) this.#db.exec("ROLLBACK");
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
    let replayed = parseDocument(readString(checkpointRow, "document_json"), this.#extensionValidators);
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
      const replay = applyTransaction(replayed, record.request, () => record.committedAt, this.#extensionValidators);
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
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown')
        ),
        attempt INTEGER NOT NULL CHECK (attempt >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
        progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 1),
        input_hash TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_artifact_ids_json TEXT NOT NULL,
        error_json TEXT,
        retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
        cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS job_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS job_events_job_sequence ON job_events(job_id, sequence);
      CREATE TABLE IF NOT EXISTS job_cancellation_requests (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        job_id TEXT NOT NULL REFERENCES jobs(job_id),
        request_id TEXT NOT NULL UNIQUE,
        requested_by TEXT NOT NULL,
        observed_status TEXT NOT NULL CHECK (
          observed_status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown')
        ),
        changed INTEGER NOT NULL CHECK (changed IN (0, 1)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS job_cancellation_requests_job_sequence
        ON job_cancellation_requests(job_id, sequence);
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        create_request_id TEXT NOT NULL UNIQUE,
        create_payload_hash TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_sessions_token_hash ON agent_sessions(token_hash);
      CREATE TABLE IF NOT EXISTS agent_session_revocations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES agent_sessions(session_id),
        request_id TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        revoked_by TEXT NOT NULL,
        changed INTEGER NOT NULL CHECK (changed IN (0, 1)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_session_revocations_session_sequence
        ON agent_session_revocations(session_id, sequence);
      CREATE TABLE IF NOT EXISTS agent_access_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        session_id TEXT REFERENCES agent_sessions(session_id),
        capability TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_id TEXT,
        allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
        reason TEXT NOT NULL CHECK (
          reason IN ('allowed', 'unknown_token', 'expired', 'revoked', 'capability_denied')
        ),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_access_events_session_sequence
        ON agent_access_events(session_id, sequence);
      CREATE TABLE IF NOT EXISTS ui_access_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
        reason TEXT NOT NULL CHECK (reason IN ('paired', 'allowed', 'missing', 'invalid', 'expired')),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ui_credential_rotations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        previous_fingerprint TEXT NOT NULL,
        current_fingerprint TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        rotated_by TEXT NOT NULL CHECK (rotated_by = 'local_user'),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind = 'content_high_risk_delete'),
        target_id TEXT NOT NULL,
        base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
        payload_hash TEXT NOT NULL,
        requested_by_session_id TEXT NOT NULL REFERENCES agent_sessions(session_id),
        request_id TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'consumed')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        resolution_request_id TEXT UNIQUE,
        resolution_hash TEXT,
        token_hash TEXT,
        consumed_at TEXT,
        consumed_by_session_id TEXT REFERENCES agent_sessions(session_id),
        transaction_id TEXT UNIQUE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS approvals_project_state
        ON approvals(project_id, state, created_at);
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
      if (!committed && this.#db.isTransaction) this.#db.exec("ROLLBACK");
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

  #withImmediateTransaction(work: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.#db.exec("COMMIT");
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #insertJobEvent(jobId: string, type: string, payload: unknown, createdAt: string): void {
    this.#db.prepare(`
      INSERT INTO job_events(job_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(jobId, type, JSON.stringify(payload), createdAt);
  }

  #throwInvalidJobTransition(jobId: string, target: string): never {
    const row = this.#db.prepare("SELECT status, attempt, max_attempts FROM jobs WHERE job_id = ?")
      .get(jobId);
    if (!row) throw new ProjectStoreError("JOB_NOT_FOUND", `Job ${jobId} does not exist`);
    throw new ProjectStoreError(
      "INVALID_JOB_STATE",
      `Job ${jobId} cannot transition from ${readString(row, "status")} to ${target}`,
      {
        attempt: readNumber(row, "attempt"),
        maxAttempts: readNumber(row, "max_attempts"),
      },
    );
  }
}

function parseDocument(
  json: string,
  extensionValidators: readonly ExtensionValidator[] = [],
): AgentCutProjectDocument {
  try {
    const value: unknown = JSON.parse(json);
    assertProjectDocument(value, { extensionValidators });
    return value;
  } catch (error) {
    throw new ProjectStoreError("STORE_CORRUPT", "Stored project document is invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseRecord(json: string): CommandRecord {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object") {
    throw new ProjectStoreError("STORE_CORRUPT", "Command record is not an object");
  }
  return value as CommandRecord;
}

function parseJob(row: Record<string, unknown>): ProjectJob {
  const errorJson = row.error_json;
  const parsedError = typeof errorJson === "string"
    ? JSON.parse(errorJson) as ProjectJob["error"]
    : undefined;
  return {
    id: readString(row, "job_id"),
    projectId: readString(row, "project_id"),
    type: readString(row, "type"),
    status: readString(row, "status") as JobStatus,
    attempt: readNumber(row, "attempt"),
    maxAttempts: readNumber(row, "max_attempts"),
    progress: readReal(row, "progress"),
    inputHash: readString(row, "input_hash"),
    input: JSON.parse(readString(row, "input_json")) as unknown,
    outputArtifactIds: JSON.parse(readString(row, "output_artifact_ids_json")) as string[],
    ...(parsedError ? { error: parsedError } : {}),
    retryable: readNumber(row, "retryable") === 1,
    cancelRequested: readNumber(row, "cancel_requested") === 1,
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function parseJobCancellationRequest(
  row: Record<string, unknown>,
): JobCancellationRequest {
  const observedStatus = readString(row, "observed_status") as JobStatus;
  if (!["pending", "running", "succeeded", "failed", "cancelled", "outcome_unknown"]
    .includes(observedStatus)) {
    throw new ProjectStoreError("STORE_CORRUPT", "Stored job cancellation status is invalid");
  }
  return {
    sequence: readNumber(row, "sequence"),
    projectId: readString(row, "project_id"),
    jobId: readString(row, "job_id"),
    requestId: readString(row, "request_id"),
    requestedBy: readString(row, "requested_by"),
    observedStatus,
    changed: readNumber(row, "changed") === 1,
    createdAt: readString(row, "created_at"),
  };
}

const AGENT_CAPABILITIES = new Set<AgentCapability>([
  "project:read",
  "transcript:read",
  "analysis:local",
  "analysis:propose",
  "timeline:write:low_risk_only",
  "approval:request",
  "timeline:write:approved",
  "export:write",
]);

function assertApprovalCreationInput(input: {
  id: string;
  requestId: string;
  kind: ApprovalKind;
  targetId: string;
  baseRevision: number;
  payloadHash: string;
  requestedBySessionId: string;
  ttlSeconds: number;
}): void {
  assertStableText(input.id, "id", "APPROVAL_INVALID");
  assertStableText(input.requestId, "requestId", "APPROVAL_INVALID");
  assertStableText(input.targetId, "targetId", "APPROVAL_INVALID");
  assertStableText(input.requestedBySessionId, "requestedBySessionId", "APPROVAL_INVALID");
  if (input.kind !== "content_high_risk_delete") {
    throw new ProjectStoreError("APPROVAL_INVALID", "Unsupported approval kind");
  }
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
    throw new ProjectStoreError("APPROVAL_INVALID", "Approval baseRevision must be non-negative");
  }
  assertHash(input.payloadHash, "payloadHash");
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 86_400) {
    throw new ProjectStoreError("APPROVAL_INVALID", "Approval ttlSeconds must be between 60 and 86400");
  }
}

function assertStableText(
  value: string,
  name: string,
  code:
    | "APPROVAL_INVALID"
    | "AGENT_SESSION_INVALID"
    | "UI_CREDENTIAL_ROTATION_INVALID"
    | "INVALID_JOB_STATE",
): void {
  if (!value || value !== value.trim() || value.length > 256) {
    throw new ProjectStoreError(code, `${name} must be non-empty without surrounding whitespace`);
  }
}

function assertHash(value: string | undefined, name: string): asserts value is string {
  if (!value || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ProjectStoreError("APPROVAL_INVALID", `${name} must be SHA-256`);
  }
}

function assertAgentSessionInput(input: {
  id: string;
  requestId: string;
  clientId: string;
  capabilities: AgentCapability[];
  ttlSeconds: number;
  tokenHash: string;
}): void {
  for (const [name, value] of [
    ["id", input.id],
    ["requestId", input.requestId],
    ["clientId", input.clientId],
  ] as const) {
    if (!value || value !== value.trim()) {
      throw new ProjectStoreError("AGENT_SESSION_INVALID", `${name} must be non-empty without surrounding whitespace`);
    }
  }
  if (input.capabilities.length === 0
    || new Set(input.capabilities).size !== input.capabilities.length
    || input.capabilities.some((capability) => !AGENT_CAPABILITIES.has(capability))) {
    throw new ProjectStoreError("AGENT_SESSION_INVALID", "Agent capabilities must be a unique supported non-empty list");
  }
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 86_400) {
    throw new ProjectStoreError("AGENT_SESSION_INVALID", "Agent session ttlSeconds must be between 60 and 86400");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.tokenHash)) {
    throw new ProjectStoreError("AGENT_SESSION_INVALID", "Agent session tokenHash must be SHA-256");
  }
}

function parseAgentSession(row: Record<string, unknown>): AgentSession {
  const capabilitiesValue = JSON.parse(readString(row, "capabilities_json")) as unknown;
  if (!Array.isArray(capabilitiesValue)
    || capabilitiesValue.length === 0
    || capabilitiesValue.some((value) => typeof value !== "string" || !AGENT_CAPABILITIES.has(value as AgentCapability))) {
    throw new ProjectStoreError("STORE_CORRUPT", "Agent session capabilities are invalid");
  }
  const revokedAt = readNullableString(row, "revoked_at");
  return {
    id: readString(row, "session_id"),
    projectId: readString(row, "project_id"),
    clientId: readString(row, "client_id"),
    capabilities: capabilitiesValue as AgentCapability[],
    createdAt: readString(row, "created_at"),
    expiresAt: readString(row, "expires_at"),
    ...(revokedAt ? { revokedAt } : {}),
  };
}

function parseAgentAccessEvent(row: Record<string, unknown>): AgentAccessEvent {
  const capability = readString(row, "capability") as AgentCapability;
  if (!AGENT_CAPABILITIES.has(capability)) {
    throw new ProjectStoreError("STORE_CORRUPT", "Agent access event capability is invalid");
  }
  const reason = readString(row, "reason") as AgentAccessEvent["reason"];
  if (!["allowed", "unknown_token", "expired", "revoked", "capability_denied"].includes(reason)) {
    throw new ProjectStoreError("STORE_CORRUPT", "Agent access event reason is invalid");
  }
  const sessionId = readNullableString(row, "session_id");
  const requestId = readNullableString(row, "request_id");
  return {
    sequence: readNumber(row, "sequence"),
    projectId: readString(row, "project_id"),
    ...(sessionId ? { sessionId } : {}),
    capability,
    method: readString(row, "method"),
    path: readString(row, "path"),
    ...(requestId ? { requestId } : {}),
    allowed: readNumber(row, "allowed") === 1,
    reason,
    createdAt: readString(row, "created_at"),
  };
}

function parseAgentSessionRevocationEvent(
  row: Record<string, unknown>,
): AgentSessionRevocationEvent {
  return {
    sequence: readNumber(row, "sequence"),
    projectId: readString(row, "project_id"),
    sessionId: readString(row, "session_id"),
    requestId: readString(row, "request_id"),
    revokedBy: readString(row, "revoked_by"),
    changed: readNumber(row, "changed") === 1,
    createdAt: readString(row, "created_at"),
  };
}

function parseUiAccessEvent(row: Record<string, unknown>): UiAccessEvent {
  const reason = readString(row, "reason") as UiAccessEvent["reason"];
  if (!["paired", "allowed", "missing", "invalid", "expired"].includes(reason)) {
    throw new ProjectStoreError("STORE_CORRUPT", "Stored UI access reason is invalid");
  }
  return {
    sequence: readNumber(row, "sequence"),
    projectId: readString(row, "project_id"),
    method: readString(row, "method"),
    path: readString(row, "path"),
    allowed: readNumber(row, "allowed") === 1,
    reason,
    createdAt: readString(row, "created_at"),
  };
}

function parseUiCredentialRotationEvent(
  row: Record<string, unknown>,
): UiCredentialRotationEvent {
  const rotatedBy = readString(row, "rotated_by");
  const previousFingerprint = readString(row, "previous_fingerprint");
  const currentFingerprint = readString(row, "current_fingerprint");
  const generation = readNumber(row, "generation");
  if (rotatedBy !== "local_user"
    || !/^[a-f0-9]{64}$/.test(previousFingerprint)
    || !/^[a-f0-9]{64}$/.test(currentFingerprint)
    || previousFingerprint === currentFingerprint
    || !Number.isSafeInteger(generation) || generation < 1) {
    throw new ProjectStoreError("STORE_CORRUPT", "Stored UI credential rotation is invalid");
  }
  return {
    sequence: readNumber(row, "sequence"),
    projectId: readString(row, "project_id"),
    requestId: readString(row, "request_id"),
    previousFingerprint,
    currentFingerprint,
    generation,
    rotatedBy,
    createdAt: readString(row, "created_at"),
  };
}

function parseApproval(row: Record<string, unknown>): ProjectApproval {
  const kind = readString(row, "kind") as ApprovalKind;
  const state = readString(row, "state") as ApprovalState;
  if (kind !== "content_high_risk_delete"
    || !["pending", "approved", "denied", "consumed"].includes(state)) {
    throw new ProjectStoreError("STORE_CORRUPT", "Stored approval has invalid kind or state");
  }
  const resolvedAt = readNullableString(row, "resolved_at");
  const resolvedBy = readNullableString(row, "resolved_by");
  const resolutionRequestId = readNullableString(row, "resolution_request_id");
  const consumedAt = readNullableString(row, "consumed_at");
  const consumedBySessionId = readNullableString(row, "consumed_by_session_id");
  const transactionId = readNullableString(row, "transaction_id");
  return {
    id: readString(row, "approval_id"),
    projectId: readString(row, "project_id"),
    kind,
    targetId: readString(row, "target_id"),
    baseRevision: readNumber(row, "base_revision"),
    payloadHash: readString(row, "payload_hash"),
    requestedBySessionId: readString(row, "requested_by_session_id"),
    requestId: readString(row, "request_id"),
    state,
    createdAt: readString(row, "created_at"),
    expiresAt: readString(row, "expires_at"),
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(resolvedBy ? { resolvedBy } : {}),
    ...(resolutionRequestId ? { resolutionRequestId } : {}),
    ...(consumedAt ? { consumedAt } : {}),
    ...(consumedBySessionId ? { consumedBySessionId } : {}),
    ...(transactionId ? { transactionId } : {}),
  };
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

function readNullableString(row: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = row?.[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ProjectStoreError("STORE_CORRUPT", `Expected nullable string column ${key}`);
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

function readReal(row: Record<string, unknown> | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProjectStoreError("STORE_CORRUPT", `Expected numeric column ${key}`);
  }
  return value;
}

function isStorageCapacityError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errcode?: unknown; message?: unknown };
  return candidate.errcode === 13
    || candidate.code === "SQLITE_FULL"
    || (typeof candidate.message === "string"
      && candidate.message.toLowerCase().includes("database or disk is full"));
}
