import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AlphaAuditDraft } from "./audit.js";
import type { AlphaCorrectnessRun } from "./correctness.js";

const EVIDENCE_STORE_VERSION = 1;
const TIMING_STALE_AFTER_MS = 30_000;
const BOUNDARY_ISSUE_CODES = [
  "swallowed_word",
  "clipped_syllable",
  "av_sync",
  "unnatural_pacing",
  "other",
] as const;

export type AlphaBoundaryIssueCode = typeof BOUNDARY_ISSUE_CODES[number];
export type AlphaTimingBaselineMethod = "stopwatch" | "screen_recording" | "editor_log";
export type AlphaTimingPauseReason = "user" | "idle" | "page_hidden";
export type AlphaTimingEvent =
  | {
    kind: "baseline";
    manualBaselineSeconds: number;
    method: AlphaTimingBaselineMethod;
    operatorIdHash: string;
    evidenceSha256: string;
  }
  | { kind: "start"; sessionId: string }
  | { kind: "heartbeat"; sessionId: string }
  | { kind: "pause"; sessionId: string; reason: AlphaTimingPauseReason }
  | { kind: "finish" };

export interface AlphaTimingSummary {
  baseline: {
    manualBaselineSeconds: number;
    method: AlphaTimingBaselineMethod;
    operatorIdHash: string;
    evidenceSha256: string;
  } | null;
  agentCutActiveSeconds: number;
  state: "not_started" | "running" | "paused" | "finished";
  activeSessionId: string | null;
  lastActivityAt: string | null;
  complete: boolean;
}

export class AlphaEvidenceError extends Error {
  constructor(
    readonly code: "ALPHA_TRIAL_ENROLLMENT_REQUIRED" | "IDEMPOTENCY_CONFLICT" | "INVALID_LABEL" | "INVALID_TIMING_ORIGIN" | "INVALID_TIMING_STATE" | "TARGET_NOT_FOUND" | "STORE_CORRUPT",
    message: string,
  ) {
    super(message);
    this.name = "AlphaEvidenceError";
  }
}

export interface AlphaEvidenceEvent {
  sequence: number;
  requestId: string;
  projectId: string;
  projectRevision: number;
  sourceSha256: string;
  targetType: "candidate" | "boundary" | "correctness" | "timing";
  targetId: string;
  candidateLabel: "true_positive" | "false_positive" | null;
  boundaryUsable: boolean | null;
  boundaryIssueCodes: AlphaBoundaryIssueCode[];
  correctnessResult?: {
    sourceStateHash: string;
    checks: AlphaCorrectnessRun["checks"];
  };
  timingEvent?: AlphaTimingEvent;
  note: string | null;
  createdAt: string;
  payloadHash: string;
}

export interface AlphaEvidenceResponse {
  audit: AlphaAuditDraft;
  progress: {
    candidateLabeled: number;
    candidateTotal: number;
    boundaryLabeled: number;
    boundaryTotal: number;
    complete: boolean;
  };
  timing: AlphaTimingSummary;
  events: AlphaEvidenceEvent[];
}

export interface AlphaEvidenceStoreOptions {
  clock?: () => string;
  busyTimeoutMs?: number;
}

interface StoredPayload {
  projectId: string;
  projectRevision: number;
  sourceSha256: string;
  targetType: "candidate" | "boundary" | "correctness" | "timing";
  targetId: string;
  candidateLabel: "true_positive" | "false_positive" | null;
  boundaryUsable: boolean | null;
  boundaryIssueCodes: AlphaBoundaryIssueCode[];
  correctnessResult?: {
    sourceStateHash: string;
    checks: AlphaCorrectnessRun["checks"];
  };
  timingEvent?: AlphaTimingEvent;
  note: string | null;
}

export class AlphaEvidenceStore implements Disposable {
  readonly #db: DatabaseSync;
  readonly #clock: () => string;
  #closed = false;

  private constructor(databasePath: string, options: AlphaEvidenceStoreOptions = {}) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.#db = new DatabaseSync(databasePath, {
      timeout: options.busyTimeoutMs ?? 5_000,
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      defensive: true,
    });
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS evidence_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = ${EVIDENCE_STORE_VERSION};
    `);
    const version = this.#db.prepare("PRAGMA user_version").get();
    if (readNumber(version, "user_version") !== EVIDENCE_STORE_VERSION) {
      this.#db.close();
      throw new AlphaEvidenceError("STORE_CORRUPT", "Unsupported Alpha evidence store version");
    }
  }

  static open(databasePath: string, options: AlphaEvidenceStoreOptions = {}): AlphaEvidenceStore {
    return new AlphaEvidenceStore(databasePath, options);
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  labelCandidate(
    draft: AlphaAuditDraft,
    input: {
      requestId: string;
      candidateId: string;
      label: "true_positive" | "false_positive";
      note?: string;
    },
  ): AlphaEvidenceResponse {
    assertReviewCompleted(draft);
    assertFinalLabelTimingFinished(draft, this.apply(draft).timing);
    if (!draft.candidates.some((candidate) => candidate.candidateId === input.candidateId)) {
      throw new AlphaEvidenceError("TARGET_NOT_FOUND", `Candidate ${input.candidateId} is not in this audit`);
    }
    return this.#record(draft, input.requestId, {
      ...binding(draft),
      targetType: "candidate",
      targetId: requiredText(input.candidateId, "candidateId"),
      candidateLabel: input.label,
      boundaryUsable: null,
      boundaryIssueCodes: [],
      note: optionalNote(input.note),
    });
  }

  labelBoundary(
    draft: AlphaAuditDraft,
    input: {
      requestId: string;
      boundaryId: string;
      usable: boolean;
      issueCodes: AlphaBoundaryIssueCode[];
      note?: string;
    },
  ): AlphaEvidenceResponse {
    assertReviewCompleted(draft);
    assertFinalLabelTimingFinished(draft, this.apply(draft).timing);
    if (!draft.boundaries.some((boundary) => boundary.boundaryId === input.boundaryId)) {
      throw new AlphaEvidenceError("TARGET_NOT_FOUND", `Boundary ${input.boundaryId} is not in this audit`);
    }
    const issueCodes = normalizeIssueCodes(input.issueCodes);
    if (!input.usable && issueCodes.length === 0) {
      throw new AlphaEvidenceError("INVALID_LABEL", "An unusable boundary requires at least one issue code");
    }
    if (input.usable && issueCodes.length > 0) {
      throw new AlphaEvidenceError("INVALID_LABEL", "A usable boundary cannot include issue codes");
    }
    return this.#record(draft, input.requestId, {
      ...binding(draft),
      targetType: "boundary",
      targetId: requiredText(input.boundaryId, "boundaryId"),
      candidateLabel: null,
      boundaryUsable: input.usable,
      boundaryIssueCodes: issueCodes,
      note: optionalNote(input.note),
    });
  }

  recordCorrectnessRun(draft: AlphaAuditDraft, run: AlphaCorrectnessRun): AlphaEvidenceResponse {
    if (run.projectId !== draft.project.id
      || run.projectRevision !== draft.project.revision
      || run.sourceSha256 !== draft.project.sourceSha256) {
      throw new AlphaEvidenceError(
        "INVALID_LABEL",
        "Correctness run binding does not match the current Alpha audit",
      );
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(run.sourceStateHash)) {
      throw new AlphaEvidenceError("INVALID_LABEL", "Correctness run state hash is invalid");
    }
    validateCorrectnessChecks(run.checks);
    return this.#record(draft, run.runId, {
      ...binding(draft),
      targetType: "correctness",
      targetId: requiredText(run.runId, "runId"),
      candidateLabel: null,
      boundaryUsable: null,
      boundaryIssueCodes: [],
      correctnessResult: {
        sourceStateHash: run.sourceStateHash,
        checks: structuredClone(run.checks),
      },
      note: null,
    });
  }

  setTimingBaseline(
    draft: AlphaAuditDraft,
    input: {
      requestId: string;
      manualBaselineSeconds: number;
      method: AlphaTimingBaselineMethod;
      operatorId: string;
      evidenceSha256: string;
    },
  ): AlphaEvidenceResponse {
    assertFormalTimingEnrollment(draft);
    const proof = timingBaselineProof(draft, input);
    const payload = timingPayload(draft, {
      kind: "baseline",
      manualBaselineSeconds: input.manualBaselineSeconds,
      method: input.method,
      ...proof,
    });
    return this.#recordTiming(draft, input.requestId, payload, (evidence) => {
      assertTimingOriginOpen(draft);
      const timing = evidence.timing;
      if (timing.state === "running" || timing.state === "finished") {
        throw new AlphaEvidenceError(
          "INVALID_TIMING_STATE",
          timing.state === "running"
            ? "Pause the active timing session before replacing its baseline"
            : "Finished timing evidence cannot be changed until the Timeline revision advances",
        );
      }
    });
  }

  beginTiming(
    draft: AlphaAuditDraft,
    input: {
      requestId: string;
      manualBaselineSeconds: number;
      method: AlphaTimingBaselineMethod;
      operatorId: string;
      evidenceSha256: string;
      sessionId: string;
    },
  ): AlphaEvidenceResponse {
    assertFormalTimingEnrollment(draft);
    const proof = timingBaselineProof(draft, input);
    const sessionId = requiredText(input.sessionId, "sessionId");
    const requestId = requiredText(input.requestId, "requestId");
    const baselinePayload = timingPayload(draft, {
      kind: "baseline",
      manualBaselineSeconds: input.manualBaselineSeconds,
      method: input.method,
      ...proof,
    });
    const startPayload = timingPayload(draft, { kind: "start", sessionId });
    return this.#recordTimingBatch(draft, requestId, [
      { suffix: "baseline", payload: baselinePayload },
      { suffix: "start", payload: startPayload },
    ], (evidence) => {
      assertTimingOriginOpen(draft);
      if (evidence.timing.baseline || evidence.timing.state !== "not_started") {
        throw new AlphaEvidenceError(
          "INVALID_TIMING_STATE",
          "Atomic timing begin requires a project without existing timing evidence",
        );
      }
    });
  }

  startTiming(
    draft: AlphaAuditDraft,
    input: { requestId: string; sessionId: string },
  ): AlphaEvidenceResponse {
    assertFormalTimingEnrollment(draft);
    const sessionId = requiredText(input.sessionId, "sessionId");
    const payload = timingPayload(draft, { kind: "start", sessionId });
    return this.#recordTiming(draft, input.requestId, payload, (evidence) => {
      const hasPriorStart = evidence.events.some((event) =>
        event.targetType === "timing" && event.timingEvent?.kind === "start",
      );
      if (!hasPriorStart) assertTimingOriginOpen(draft);
      const timing = evidence.timing;
      if (timing.state === "running" || timing.state === "finished") {
        throw new AlphaEvidenceError(
          "INVALID_TIMING_STATE",
          timing.state === "finished" ? "Finished timing cannot restart" : "A timing session is already running",
        );
      }
    });
  }

  heartbeatTiming(
    draft: AlphaAuditDraft,
    input: { requestId: string; sessionId: string },
  ): AlphaEvidenceResponse {
    assertFormalTimingEnrollment(draft);
    const sessionId = requiredText(input.sessionId, "sessionId");
    const payload = timingPayload(draft, { kind: "heartbeat", sessionId });
    return this.#recordTiming(draft, input.requestId, payload, (evidence) => {
      assertActiveTimingSession(evidence.timing, sessionId);
    });
  }

  pauseTiming(
    draft: AlphaAuditDraft,
    input: { requestId: string; sessionId: string; reason: AlphaTimingPauseReason },
  ): AlphaEvidenceResponse {
    const sessionId = requiredText(input.sessionId, "sessionId");
    if (!["user", "idle", "page_hidden"].includes(input.reason)) {
      throw new AlphaEvidenceError("INVALID_LABEL", "Timing pause reason is invalid");
    }
    const payload = timingPayload(draft, { kind: "pause", sessionId, reason: input.reason });
    return this.#recordTiming(draft, input.requestId, payload, (evidence) => {
      assertActiveTimingSession(evidence.timing, sessionId);
    });
  }

  finishTiming(
    draft: AlphaAuditDraft,
    input: { requestId: string },
  ): AlphaEvidenceResponse {
    assertFormalTimingEnrollment(draft);
    const payload = timingPayload(draft, { kind: "finish" });
    return this.#recordTiming(draft, input.requestId, payload, (evidence) => {
      const timing = evidence.timing;
      if (!timing.baseline || timing.state === "not_started" || timing.state === "finished") {
        throw new AlphaEvidenceError(
          "INVALID_TIMING_STATE",
          "Timing requires a manual baseline and an unfinished active-time session",
        );
      }
      const openSeconds = timing.state === "running" && timing.lastActivityAt
        ? boundedElapsedSeconds(timing.lastActivityAt, this.#clock())
        : 0;
      if (timing.agentCutActiveSeconds + openSeconds <= 0) {
        throw new AlphaEvidenceError("INVALID_TIMING_STATE", "No active editing time has been counted");
      }
    });
  }

  apply(draft: AlphaAuditDraft): AlphaEvidenceResponse {
    const audit = structuredClone(draft);
    const events = this.#eventsFor(draft);
    const candidates = new Map(audit.candidates.map((candidate) => [candidate.candidateId, candidate]));
    const boundaries = new Map(audit.boundaries.map((boundary) => [boundary.boundaryId, boundary]));
    for (const event of events) {
      if (event.targetType === "candidate") {
        const candidate = candidates.get(event.targetId);
        if (!candidate || !event.candidateLabel) continue;
        candidate.humanLabel = event.candidateLabel;
        candidate.humanNote = event.note;
      } else if (event.targetType === "boundary") {
        const boundary = boundaries.get(event.targetId);
        if (!boundary || event.boundaryUsable === null) continue;
        boundary.humanUsable = event.boundaryUsable;
        boundary.humanIssueCodes = [...event.boundaryIssueCodes];
        boundary.humanNote = event.note;
      }
    }
    const candidateLabeled = audit.candidates.filter((candidate) => candidate.humanLabel !== null).length;
    const boundaryLabeled = audit.boundaries.filter((boundary) => boundary.humanUsable !== null).length;
    const candidateTotal = audit.candidates.length;
    const boundaryTotal = audit.boundaries.length;
    return {
      audit,
      progress: {
        candidateLabeled,
        candidateTotal,
        boundaryLabeled,
        boundaryTotal,
        complete: candidateLabeled === candidateTotal && boundaryLabeled === boundaryTotal,
      },
      timing: deriveTiming(events, this.#clock(), draft.project.revision),
      events,
    };
  }

  #recordTiming(
    draft: AlphaAuditDraft,
    requestId: string,
    payload: StoredPayload,
    validate: (evidence: AlphaEvidenceResponse) => void,
  ): AlphaEvidenceResponse {
    const replay = this.#replay(draft, requestId, payload);
    if (replay) return replay;
    validate(this.apply(draft));
    return this.#record(draft, requestId, payload);
  }

  #recordTimingBatch(
    draft: AlphaAuditDraft,
    requestId: string,
    items: Array<{ suffix: string; payload: StoredPayload }>,
    validate: (evidence: AlphaEvidenceResponse) => void,
  ): AlphaEvidenceResponse {
    const normalizedRequestId = requiredText(requestId, "requestId");
    const records = items.map(({ suffix, payload }) => {
      const childRequestId = `${normalizedRequestId}:${suffix}`;
      const payloadJson = JSON.stringify(payload);
      return {
        requestId: childRequestId,
        payloadJson,
        payloadHash: createHash("sha256").update(payloadJson).digest("hex"),
      };
    });
    let committed = false;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = records.map((record) => this.#db.prepare(
        "SELECT payload_hash FROM evidence_events WHERE request_id = ?",
      ).get(record.requestId));
      if (existing.some(Boolean)) {
        const exactReplay = existing.every((row, index) =>
          row && readString(row, "payload_hash") === records[index]!.payloadHash,
        );
        if (!exactReplay) {
          throw new AlphaEvidenceError(
            "IDEMPOTENCY_CONFLICT",
            `Evidence requestId ${normalizedRequestId} was reused or only partially recorded`,
          );
        }
        this.#db.exec("COMMIT");
        committed = true;
        return this.apply(draft);
      }
      validate(this.apply(draft));
      const createdAt = this.#clock();
      const insert = this.#db.prepare(`
        INSERT INTO evidence_events(request_id, payload_hash, payload_json, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const record of records) {
        insert.run(record.requestId, record.payloadHash, record.payloadJson, createdAt);
      }
      this.#db.exec("COMMIT");
      committed = true;
      return this.apply(draft);
    } catch (error) {
      if (!committed && this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #replay(draft: AlphaAuditDraft, requestId: string, payload: StoredPayload): AlphaEvidenceResponse | null {
    const normalizedRequestId = requiredText(requestId, "requestId");
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const existing = this.#db.prepare(
      "SELECT payload_hash FROM evidence_events WHERE request_id = ?",
    ).get(normalizedRequestId);
    if (!existing) return null;
    if (readString(existing, "payload_hash") !== payloadHash) {
      throw new AlphaEvidenceError(
        "IDEMPOTENCY_CONFLICT",
        `Evidence requestId ${normalizedRequestId} was reused with another payload`,
      );
    }
    return this.apply(draft);
  }

  #record(draft: AlphaAuditDraft, requestId: string, payload: StoredPayload): AlphaEvidenceResponse {
    const normalizedRequestId = requiredText(requestId, "requestId");
    const payloadJson = JSON.stringify(payload);
    const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
    let committed = false;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db.prepare(
        "SELECT payload_hash FROM evidence_events WHERE request_id = ?",
      ).get(normalizedRequestId);
      if (existing) {
        if (readString(existing, "payload_hash") !== payloadHash) {
          throw new AlphaEvidenceError(
            "IDEMPOTENCY_CONFLICT",
            `Evidence requestId ${normalizedRequestId} was reused with another payload`,
          );
        }
        this.#db.exec("COMMIT");
        committed = true;
        return this.apply(draft);
      }
      this.#db.prepare(`
        INSERT INTO evidence_events(request_id, payload_hash, payload_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(normalizedRequestId, payloadHash, payloadJson, this.#clock());
      this.#db.exec("COMMIT");
      committed = true;
      return this.apply(draft);
    } catch (error) {
      if (!committed && this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #eventsFor(draft: AlphaAuditDraft): AlphaEvidenceEvent[] {
    return this.#db.prepare(`
      SELECT sequence, request_id, payload_hash, payload_json, created_at
      FROM evidence_events
      ORDER BY sequence
    `).all().flatMap((row) => {
      const payload = parsePayload(readString(row, "payload_json"));
      if (payload.projectId !== draft.project.id
        || payload.sourceSha256 !== draft.project.sourceSha256) return [];
      if (payload.targetType === "timing") {
        if (payload.projectRevision > draft.project.revision) return [];
      } else if (payload.projectRevision !== draft.project.revision) {
        return [];
      }
      return [{
        sequence: readNumber(row, "sequence"),
        requestId: readString(row, "request_id"),
        ...payload,
        createdAt: readString(row, "created_at"),
        payloadHash: readString(row, "payload_hash"),
      }];
    });
  }
}

function binding(draft: AlphaAuditDraft): Pick<StoredPayload, "projectId" | "projectRevision" | "sourceSha256"> {
  return {
    projectId: draft.project.id,
    projectRevision: draft.project.revision,
    sourceSha256: draft.project.sourceSha256,
  };
}

function timingPayload(draft: AlphaAuditDraft, event: AlphaTimingEvent): StoredPayload {
  return {
    ...binding(draft),
    targetType: "timing",
    targetId: "timing",
    candidateLabel: null,
    boundaryUsable: null,
    boundaryIssueCodes: [],
    timingEvent: event,
    note: null,
  };
}

function assertActiveTimingSession(timing: AlphaTimingSummary, sessionId: string): void {
  if (timing.state !== "running" || timing.activeSessionId !== sessionId) {
    throw new AlphaEvidenceError(
      "INVALID_TIMING_STATE",
      "Timing session is not active or no longer owns the active clock",
    );
  }
}

function assertTimingOriginOpen(draft: AlphaAuditDraft): void {
  const firstHumanDecisionRevision = draft.derived.firstHumanDecisionRevision;
  if (firstHumanDecisionRevision === null || draft.project.revision < firstHumanDecisionRevision) return;
  throw new AlphaEvidenceError(
    "INVALID_TIMING_ORIGIN",
    `Formal timing must start before the first human content decision at revision ${firstHumanDecisionRevision}`,
  );
}

function assertFormalTimingEnrollment(draft: AlphaAuditDraft): void {
  if (draft.project.alphaTrial?.mode === "formal") return;
  throw new AlphaEvidenceError(
    "ALPHA_TRIAL_ENROLLMENT_REQUIRED",
    "Paired Alpha timing requires prospective formal trial enrollment",
  );
}

function assertReviewCompleted(draft: AlphaAuditDraft): void {
  if (!draft.review.completed || draft.review.pendingCandidateIds.length > 0) {
    throw new AlphaEvidenceError(
      "INVALID_LABEL",
      "Finish all rough-cut content decisions before recording final Alpha labels",
    );
  }
  if (!draft.export?.quality.passed
    || draft.export.sourceRevision + 1 !== draft.project.revision) {
    throw new AlphaEvidenceError(
      "INVALID_LABEL",
      "Export and verify the accepted rough-cut revision before recording final Alpha labels",
    );
  }
}

function assertFinalLabelTimingFinished(
  draft: AlphaAuditDraft,
  timing: AlphaTimingSummary,
): void {
  if ((!draft.project.alphaTrial && !timing.baseline) || timing.complete) return;
  throw new AlphaEvidenceError(
    "INVALID_TIMING_STATE",
    "Finish Alpha active-time evidence before recording final quality labels",
  );
}

function deriveTiming(
  events: AlphaEvidenceEvent[],
  now: string,
  currentRevision: number,
): AlphaTimingSummary {
  let baseline: AlphaTimingSummary["baseline"] = null;
  let activeMillis = 0;
  let state: AlphaTimingSummary["state"] = "not_started";
  let activeSessionId: string | null = null;
  let lastActivityAt: string | null = null;
  let finishedRevision: number | null = null;

  for (const event of events) {
    if (event.targetType !== "timing" || !event.timingEvent) continue;
    const timingEvent = event.timingEvent;
    if (timingEvent.kind === "baseline") {
      baseline = {
        manualBaselineSeconds: timingEvent.manualBaselineSeconds,
        method: timingEvent.method,
        operatorIdHash: timingEvent.operatorIdHash,
        evidenceSha256: timingEvent.evidenceSha256,
      };
      activeMillis = 0;
      state = "not_started";
      activeSessionId = null;
      lastActivityAt = event.createdAt;
      finishedRevision = null;
      continue;
    }
    if (timingEvent.kind === "start") {
      if (state === "finished"
        && (finishedRevision === null || event.projectRevision <= finishedRevision)) continue;
      state = "running";
      activeSessionId = timingEvent.sessionId;
      lastActivityAt = event.createdAt;
      continue;
    }
    if (timingEvent.kind === "heartbeat") {
      if (state !== "running" || activeSessionId !== timingEvent.sessionId || !lastActivityAt) continue;
      const delta = boundedElapsedMillis(lastActivityAt, event.createdAt);
      if (delta === null) {
        state = "paused";
        activeSessionId = null;
        continue;
      }
      activeMillis += delta;
      lastActivityAt = event.createdAt;
      continue;
    }
    if (timingEvent.kind === "pause") {
      if (state !== "running" || activeSessionId !== timingEvent.sessionId || !lastActivityAt) continue;
      const delta = boundedElapsedMillis(lastActivityAt, event.createdAt);
      if (delta !== null) activeMillis += delta;
      state = "paused";
      activeSessionId = null;
      lastActivityAt = event.createdAt;
      continue;
    }
    if (timingEvent.kind === "finish") {
      if (state === "running" && lastActivityAt) {
        const delta = boundedElapsedMillis(lastActivityAt, event.createdAt);
        if (delta !== null) activeMillis += delta;
      }
      state = "finished";
      activeSessionId = null;
      lastActivityAt = event.createdAt;
      finishedRevision = event.projectRevision;
    }
  }

  if (state === "finished" && finishedRevision !== null && finishedRevision < currentRevision) {
    state = "paused";
  }
  if (state === "running" && lastActivityAt && boundedElapsedMillis(lastActivityAt, now) === null) {
    state = "paused";
    activeSessionId = null;
  }
  const agentCutActiveSeconds = Math.round(activeMillis) / 1_000;
  return {
    baseline,
    agentCutActiveSeconds,
    state,
    activeSessionId,
    lastActivityAt,
    complete: state === "finished" && baseline !== null && agentCutActiveSeconds > 0,
  };
}

function boundedElapsedSeconds(start: string, end: string): number {
  return (boundedElapsedMillis(start, end) ?? 0) / 1_000;
}

function boundedElapsedMillis(start: string, end: string): number | null {
  const elapsed = Date.parse(end) - Date.parse(start);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= TIMING_STALE_AFTER_MS ? elapsed : null;
}

function optionalNote(value: string | undefined): string | null {
  if (value === undefined) return null;
  const note = value.trim();
  if (note.length > 2_000) throw new AlphaEvidenceError("INVALID_LABEL", "Evidence note is too long");
  return note || null;
}

function normalizeIssueCodes(values: AlphaBoundaryIssueCode[]): AlphaBoundaryIssueCode[] {
  if (!Array.isArray(values)) throw new AlphaEvidenceError("INVALID_LABEL", "issueCodes must be an array");
  const allowed = new Set<string>(BOUNDARY_ISSUE_CODES);
  const normalized = [...new Set(values)];
  if (normalized.some((value) => !allowed.has(value))) {
    throw new AlphaEvidenceError("INVALID_LABEL", "Boundary issue code is invalid");
  }
  return normalized;
}

function validateCorrectnessChecks(checks: AlphaCorrectnessRun["checks"]): void {
  for (const kind of ["undo", "restart", "idempotency", "revisionConflict"] as const) {
    const check = checks[kind];
    if (!check || typeof check.passed !== "boolean" || !check.code.trim() || !isPrimitiveRecord(check.details)) {
      throw new AlphaEvidenceError("INVALID_LABEL", `Correctness check ${kind} is invalid`);
    }
  }
}

function isPrimitiveRecord(value: unknown): value is Record<string, string | number | boolean> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every((candidate) =>
      typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean",
    );
}

function requiredText(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AlphaEvidenceError("INVALID_LABEL", `${name} must be a non-empty string`);
  }
  return value.trim();
}

function assertTimingBaselineInput(
  manualBaselineSeconds: number,
  method: AlphaTimingBaselineMethod,
): void {
  if (!Number.isFinite(manualBaselineSeconds) || manualBaselineSeconds <= 0) {
    throw new AlphaEvidenceError("INVALID_LABEL", "manualBaselineSeconds must be positive");
  }
  if (!["stopwatch", "screen_recording", "editor_log"].includes(method)) {
    throw new AlphaEvidenceError("INVALID_LABEL", "Timing baseline method is invalid");
  }
}

function timingBaselineProof(
  draft: AlphaAuditDraft,
  input: {
    manualBaselineSeconds: number;
    method: AlphaTimingBaselineMethod;
    operatorId: string;
    evidenceSha256: string;
  },
): Pick<Extract<AlphaTimingEvent, { kind: "baseline" }>, "operatorIdHash" | "evidenceSha256"> {
  assertTimingBaselineInput(input.manualBaselineSeconds, input.method);
  const operatorId = requiredText(input.operatorId, "operatorId");
  if (operatorId.length > 100) {
    throw new AlphaEvidenceError("INVALID_LABEL", "operatorId must not exceed 100 characters");
  }
  const evidenceSha256 = input.evidenceSha256.toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(evidenceSha256)) {
    throw new AlphaEvidenceError("INVALID_LABEL", "Baseline evidence SHA-256 is invalid");
  }
  if (evidenceSha256 === draft.project.sourceSha256.toLowerCase()) {
    throw new AlphaEvidenceError("INVALID_LABEL", "Baseline evidence must not reuse the source-media hash");
  }
  return {
    operatorIdHash: `sha256:${createHash("sha256").update(operatorId).digest("hex")}`,
    evidenceSha256,
  };
}

function parsePayload(value: string): StoredPayload {
  try {
    const parsed = JSON.parse(value) as StoredPayload;
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return parsed;
  } catch (error) {
    throw new AlphaEvidenceError(
      "STORE_CORRUPT",
      `Alpha evidence payload is corrupt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readString(row: unknown, key: string): string {
  if (!row || typeof row !== "object" || typeof (row as Record<string, unknown>)[key] !== "string") {
    throw new AlphaEvidenceError("STORE_CORRUPT", `Expected string column ${key}`);
  }
  return (row as Record<string, string>)[key]!;
}

function readNumber(row: unknown, key: string): number {
  if (!row || typeof row !== "object" || typeof (row as Record<string, unknown>)[key] !== "number") {
    throw new AlphaEvidenceError("STORE_CORRUPT", `Expected number column ${key}`);
  }
  return (row as Record<string, number>)[key]!;
}
