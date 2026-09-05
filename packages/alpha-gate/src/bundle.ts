import { createHash } from "node:crypto";
import type { AlphaAuditCandidate } from "./audit.js";
import type {
  AlphaBoundaryIssueCode,
  AlphaEvidenceEvent,
  AlphaEvidenceResponse,
} from "./evidence.js";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BUNDLE_SCHEMA_VERSION = "1.0" as const;

export class AlphaEvidenceBundleError extends Error {
  constructor(
    readonly code: "INVALID_BUNDLE" | "BUNDLE_INTEGRITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "AlphaEvidenceBundleError";
  }
}

export interface AlphaEvidenceBundleCandidate {
  candidateId: string;
  decision: AlphaAuditCandidate["decision"];
  risk: AlphaAuditCandidate["risk"];
  state: AlphaAuditCandidate["state"];
  label: AlphaAuditCandidate["humanLabel"];
}

export interface AlphaEvidenceBundleBoundary {
  boundaryId: string;
  candidateIds: string[];
  usable: boolean | null;
  issueCodes: AlphaBoundaryIssueCode[];
}

export type AlphaEvidenceBundleEvent = Omit<AlphaEvidenceEvent, "note"> & {
  noteSha256: string | null;
};

interface AlphaEvidenceBundlePayload {
  schemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  project: {
    id: string;
    revision: number;
    sourceSha256: string;
    transcriptId: string;
    alphaTrial?: {
      mode: "formal";
      enrolledAt: string;
    } | null;
  };
  review: {
    projectCompleted: boolean;
    pendingCandidateIds: string[];
  };
  candidates: AlphaEvidenceBundleCandidate[];
  boundaries: AlphaEvidenceBundleBoundary[];
  derived: {
    highRiskAutoDeletedCandidateIds: string[];
    firstHumanDecisionRevision?: number | null;
  };
  export: {
    reportId: string;
    sourceRevision: number;
    outputSha256: string;
    videoCodec: string;
    audioCodec: string;
    qualityPassed: boolean;
  } | null;
  timing?: {
    manualBaselineSeconds: number;
    method: "stopwatch" | "screen_recording" | "editor_log";
    operatorIdHash: string;
    evidenceSha256: string;
    agentCutActiveSeconds: number;
    complete: boolean;
  } | null;
  progress: AlphaEvidenceResponse["progress"];
  events: AlphaEvidenceBundleEvent[];
}

export interface AlphaEvidenceBundle extends AlphaEvidenceBundlePayload {
  integrity: {
    algorithm: "sha256";
    payloadSha256: string;
  };
}

export function createAlphaEvidenceBundle(evidence: AlphaEvidenceResponse): AlphaEvidenceBundle {
  const payload: AlphaEvidenceBundlePayload = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    project: {
      id: evidence.audit.project.id,
      revision: evidence.audit.project.revision,
      sourceSha256: evidence.audit.project.sourceSha256,
      transcriptId: evidence.audit.project.transcriptId,
      alphaTrial: evidence.audit.project.alphaTrial ?? null,
    },
    review: {
      projectCompleted: evidence.audit.review.completed,
      pendingCandidateIds: [...evidence.audit.review.pendingCandidateIds],
    },
    candidates: evidence.audit.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      decision: candidate.decision,
      risk: candidate.risk,
      state: candidate.state,
      label: candidate.humanLabel,
    })),
    boundaries: evidence.audit.boundaries.map((boundary) => ({
      boundaryId: boundary.boundaryId,
      candidateIds: [...boundary.candidateIds],
      usable: boundary.humanUsable,
      issueCodes: [...boundary.humanIssueCodes],
    })),
    derived: {
      highRiskAutoDeletedCandidateIds: [...evidence.audit.derived.highRiskAutoDeletedCandidateIds],
      firstHumanDecisionRevision: evidence.audit.derived.firstHumanDecisionRevision,
    },
    export: evidence.audit.export ? {
      reportId: evidence.audit.export.reportId,
      sourceRevision: evidence.audit.export.sourceRevision,
      outputSha256: evidence.audit.export.outputSha256,
      videoCodec: evidence.audit.export.videoCodec,
      audioCodec: evidence.audit.export.audioCodec,
      qualityPassed: evidence.audit.export.quality.passed,
    } : null,
    timing: evidence.timing.baseline ? {
      ...evidence.timing.baseline,
      agentCutActiveSeconds: evidence.timing.agentCutActiveSeconds,
      complete: evidence.timing.complete,
    } : null,
    progress: structuredClone(evidence.progress),
    events: evidence.events.map(({ note, ...event }) => ({
      ...structuredClone(event),
      noteSha256: note === null ? null : sha256Text(note),
    })),
  };
  return {
    ...payload,
    integrity: {
      algorithm: "sha256",
      payloadSha256: sha256Canonical(payload),
    },
  };
}

export function serializeAlphaEvidenceBundle(bundle: AlphaEvidenceBundle): string {
  validateAlphaEvidenceBundle(bundle);
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function parseAlphaEvidenceBundle(source: string): AlphaEvidenceBundle {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new AlphaEvidenceBundleError(
      "INVALID_BUNDLE",
      `Alpha evidence bundle is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateAlphaEvidenceBundle(value);
  return value;
}

export function alphaEvidenceBundleFileSha256(source: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function validateAlphaEvidenceBundle(value: unknown): asserts value is AlphaEvidenceBundle {
  if (!isRecord(value) || value.schemaVersion !== BUNDLE_SCHEMA_VERSION || !isRecord(value.integrity)) {
    invalid("Expected Alpha evidence bundle schemaVersion 1.0 and integrity");
  }
  if (value.integrity.algorithm !== "sha256" || !isSha256(value.integrity.payloadSha256)) {
    invalid("Alpha evidence bundle has invalid integrity metadata");
  }
  const { integrity: _integrity, ...payload } = value;
  const actualPayloadSha256 = sha256Canonical(payload);
  if (actualPayloadSha256 !== value.integrity.payloadSha256) {
    throw new AlphaEvidenceBundleError(
      "BUNDLE_INTEGRITY_MISMATCH",
      `Alpha evidence payload hash mismatch: expected ${value.integrity.payloadSha256}, got ${actualPayloadSha256}`,
    );
  }
  validatePayload(payload);
}

function validatePayload(value: unknown): asserts value is AlphaEvidenceBundlePayload {
  if (!isRecord(value)) invalid("Alpha evidence payload must be an object");
  if (!isRecord(value.project)
    || !requiredText(value.project.id)
    || !Number.isSafeInteger(value.project.revision)
    || Number(value.project.revision) < 0
    || !isSha256(value.project.sourceSha256)
    || !requiredText(value.project.transcriptId)) {
    invalid("Alpha evidence bundle has an invalid project binding");
  }
  if (value.project.alphaTrial !== undefined
    && value.project.alphaTrial !== null
    && (!isRecord(value.project.alphaTrial)
      || value.project.alphaTrial.mode !== "formal"
      || !isTimestamp(value.project.alphaTrial.enrolledAt))) {
    invalid("Alpha evidence bundle has an invalid formal trial binding");
  }
  if (!isRecord(value.review)
    || typeof value.review.projectCompleted !== "boolean"
    || !isStringArray(value.review.pendingCandidateIds)) {
    invalid("Alpha evidence bundle has invalid review state");
  }
  if (value.review.projectCompleted && value.review.pendingCandidateIds.length > 0) {
    invalid("Completed project review cannot contain pending candidates");
  }
  if (!Array.isArray(value.candidates) || !Array.isArray(value.boundaries) || !Array.isArray(value.events)) {
    invalid("Alpha evidence bundle candidates, boundaries and events must be arrays");
  }
  const candidateIds = new Set<string>();
  for (const candidate of value.candidates) {
    if (!isRecord(candidate)
      || !requiredText(candidate.candidateId)
      || !["definite_remove", "suggest_remove", "suggest_keep"].includes(String(candidate.decision))
      || !["low", "medium", "high"].includes(String(candidate.risk))
      || !["candidate_remove", "candidate_keep", "reviewed_keep", "committed_deleted"].includes(String(candidate.state))
      || ![null, "true_positive", "false_positive"].includes(candidate.label as null | string)) {
      invalid("Alpha evidence bundle contains an invalid candidate row");
    }
    if (candidateIds.has(candidate.candidateId)) invalid(`Duplicate candidate ID ${candidate.candidateId}`);
    candidateIds.add(candidate.candidateId);
  }
  const boundaryIds = new Set<string>();
  for (const boundary of value.boundaries) {
    if (!isRecord(boundary)
      || !requiredText(boundary.boundaryId)
      || !isStringArray(boundary.candidateIds)
      || ![null, true, false].includes(boundary.usable as null | boolean)
      || !isIssueCodeArray(boundary.issueCodes)) {
      invalid("Alpha evidence bundle contains an invalid boundary row");
    }
    if (boundary.usable === false && boundary.issueCodes.length === 0) {
      invalid(`Unusable boundary ${boundary.boundaryId} requires an issue code`);
    }
    if (boundary.usable !== false && boundary.issueCodes.length > 0) {
      invalid(`Boundary ${boundary.boundaryId} cannot carry issue codes in its current state`);
    }
    if (boundaryIds.has(boundary.boundaryId)) invalid(`Duplicate boundary ID ${boundary.boundaryId}`);
    boundaryIds.add(boundary.boundaryId);
  }
  if (!isRecord(value.derived) || !isStringArray(value.derived.highRiskAutoDeletedCandidateIds)) {
    invalid("Alpha evidence bundle has invalid derived evidence");
  }
  const firstHumanDecisionRevision = value.derived.firstHumanDecisionRevision;
  if (firstHumanDecisionRevision !== undefined
    && firstHumanDecisionRevision !== null
    && (!Number.isSafeInteger(firstHumanDecisionRevision)
      || Number(firstHumanDecisionRevision) < 1
      || Number(firstHumanDecisionRevision) > Number(value.project.revision))) {
    invalid("Alpha evidence bundle has an invalid first human decision revision");
  }
  if (value.derived.highRiskAutoDeletedCandidateIds.some((candidateId) => !candidateIds.has(candidateId))) {
    invalid("Alpha evidence bundle references an unknown high-risk auto-deleted candidate");
  }
  validateExport(value.export);
  validateFinalLabelExportBinding(
    value.export,
    Number(value.project.revision),
    value.candidates,
    value.boundaries,
  );
  validateTiming(value.timing);
  if (value.timing !== undefined
    && value.timing !== null
    && (!isRecord(value.project.alphaTrial) || value.project.alphaTrial.mode !== "formal")) {
    invalid("Alpha timing evidence requires prospective formal trial enrollment");
  }
  if (value.timing !== undefined && value.timing !== null && firstHumanDecisionRevision === undefined) {
    invalid("Legacy Alpha evidence without timing-origin proof cannot contain timing evidence");
  }
  validateProgress(value.progress, value.candidates, value.boundaries);
  validateEvents(
    value.events,
    value.project as unknown as AlphaEvidenceBundlePayload["project"],
    value.candidates,
    value.boundaries,
  );
  validateFormalTrialTimingOrigin(value.project.alphaTrial, value.timing, value.events);
  validateTimingConsistency(value.timing, value.events);
  validateTimingOrigin(value.timing, value.events, firstHumanDecisionRevision);
  validateFinalLabelTimingOrder(value.timing, value.events);
}

function validateFormalTrialTimingOrigin(
  alphaTrial: unknown,
  timing: unknown,
  events: unknown[],
): void {
  if (timing === undefined || timing === null) return;
  if (!isRecord(alphaTrial) || !isTimestamp(alphaTrial.enrolledAt)) {
    invalid("Alpha timing evidence requires a valid formal trial enrollment timestamp");
  }
  const firstTimingEvent = events.find((event) => isRecord(event) && event.targetType === "timing");
  if (!isRecord(firstTimingEvent)
    || !isRecord(firstTimingEvent.timingEvent)
    || firstTimingEvent.timingEvent.kind !== "baseline"
    || !isTimestamp(firstTimingEvent.createdAt)) {
    invalid("Alpha timing evidence must begin with a valid baseline event");
  }
  if (Date.parse(alphaTrial.enrolledAt) > Date.parse(firstTimingEvent.createdAt)) {
    invalid("Formal Alpha enrollment must precede the first timing baseline");
  }
}

function validateExport(value: unknown): void {
  if (value === null) return;
  if (!isRecord(value)
    || !requiredText(value.reportId)
    || !Number.isSafeInteger(value.sourceRevision)
    || Number(value.sourceRevision) < 0
    || !isSha256(value.outputSha256)
    || !requiredText(value.videoCodec)
    || !requiredText(value.audioCodec)
    || typeof value.qualityPassed !== "boolean") {
    invalid("Alpha evidence bundle has invalid export evidence");
  }
}

function validateFinalLabelExportBinding(
  exportEvidence: unknown,
  projectRevision: number,
  candidates: AlphaEvidenceBundleCandidate[],
  boundaries: AlphaEvidenceBundleBoundary[],
): void {
  const hasFinalLabels = candidates.some((candidate) => candidate.label !== null)
    || boundaries.some((boundary) => boundary.usable !== null);
  if (!hasFinalLabels) return;
  if (!isRecord(exportEvidence)
    || exportEvidence.qualityPassed !== true
    || Number(exportEvidence.sourceRevision) + 1 !== projectRevision) {
    invalid("Final Alpha labels require a passing export for the accepted project revision");
  }
}

function validateTiming(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)
    || !Number.isFinite(value.manualBaselineSeconds)
    || Number(value.manualBaselineSeconds) <= 0
    || !["stopwatch", "screen_recording", "editor_log"].includes(String(value.method))
    || !isSha256(value.operatorIdHash)
    || !isSha256(value.evidenceSha256)
    || !Number.isFinite(value.agentCutActiveSeconds)
    || Number(value.agentCutActiveSeconds) < 0
    || typeof value.complete !== "boolean"
    || (value.complete && Number(value.agentCutActiveSeconds) <= 0)) {
    invalid("Alpha evidence bundle has invalid timing evidence");
  }
}

function validateProgress(
  value: unknown,
  candidates: AlphaEvidenceBundleCandidate[],
  boundaries: AlphaEvidenceBundleBoundary[],
): void {
  const expected = {
    candidateLabeled: candidates.filter((candidate) => candidate.label !== null).length,
    candidateTotal: candidates.length,
    boundaryLabeled: boundaries.filter((boundary) => boundary.usable !== null).length,
    boundaryTotal: boundaries.length,
  };
  if (!isRecord(value)
    || value.candidateLabeled !== expected.candidateLabeled
    || value.candidateTotal !== expected.candidateTotal
    || value.boundaryLabeled !== expected.boundaryLabeled
    || value.boundaryTotal !== expected.boundaryTotal
    || value.complete !== (
      expected.candidateLabeled === expected.candidateTotal
      && expected.boundaryLabeled === expected.boundaryTotal
    )) {
    invalid("Alpha evidence bundle progress does not match its labels");
  }
}

function validateEvents(
  values: unknown[],
  project: AlphaEvidenceBundlePayload["project"],
  candidates: AlphaEvidenceBundleCandidate[],
  boundaries: AlphaEvidenceBundleBoundary[],
): void {
  const latestByTarget = new Map<string, AlphaEvidenceBundleEvent>();
  const requestIds = new Set<string>();
  let previousSequence = 0;
  let previousTimingRevision = -1;
  for (const value of values) {
    if (!isEvidenceEvent(value)) invalid("Alpha evidence bundle contains an invalid event");
    if (value.projectId !== project.id
      || value.sourceSha256 !== project.sourceSha256) {
      invalid(`Evidence event ${value.requestId} has another project binding`);
    }
    if (value.targetType === "timing") {
      if (value.projectRevision > project.revision) {
        invalid(`Timing event ${value.requestId} is newer than the bundle project revision`);
      }
      if (value.projectRevision < previousTimingRevision) {
        invalid("Timing event project revisions must not move backwards");
      }
      previousTimingRevision = value.projectRevision;
    } else if (value.projectRevision !== project.revision) {
      invalid(`Evidence event ${value.requestId} has another project binding`);
    }
    if (value.sequence <= previousSequence) invalid("Evidence event sequence must increase");
    previousSequence = value.sequence;
    if (requestIds.has(value.requestId)) invalid(`Duplicate evidence request ID ${value.requestId}`);
    requestIds.add(value.requestId);
    latestByTarget.set(`${value.targetType}:${value.targetId}`, value);
  }
  for (const candidate of candidates) {
    const event = latestByTarget.get(`candidate:${candidate.candidateId}`);
    if ((event?.candidateLabel ?? null) !== candidate.label) {
      invalid(`Candidate ${candidate.candidateId} label does not match the append-only event log`);
    }
  }
  for (const boundary of boundaries) {
    const event = latestByTarget.get(`boundary:${boundary.boundaryId}`);
    if ((event?.boundaryUsable ?? null) !== boundary.usable
      || JSON.stringify(event?.boundaryIssueCodes ?? []) !== JSON.stringify(boundary.issueCodes)) {
      invalid(`Boundary ${boundary.boundaryId} label does not match the append-only event log`);
    }
  }
}

function validateTimingConsistency(value: unknown, events: unknown[]): void {
  if (value === undefined || value === null || !isRecord(value) || value.complete !== true) return;
  let baseline: {
    manualBaselineSeconds: number;
    method: string;
    operatorIdHash: string;
    evidenceSha256: string;
  } | null = null;
  let activeMillis = 0;
  let sessionId: string | null = null;
  let lastActivityAt: string | null = null;
  let finished = false;
  for (const rawEvent of events) {
    if (!isRecord(rawEvent) || rawEvent.targetType !== "timing" || !isRecord(rawEvent.timingEvent)) continue;
    const event = rawEvent.timingEvent;
    const createdAt = String(rawEvent.createdAt);
    if (event.kind === "baseline") {
      baseline = {
        manualBaselineSeconds: Number(event.manualBaselineSeconds),
        method: String(event.method),
        operatorIdHash: String(event.operatorIdHash),
        evidenceSha256: String(event.evidenceSha256),
      };
      activeMillis = 0;
      sessionId = null;
      lastActivityAt = createdAt;
      finished = false;
    } else if (event.kind === "start") {
      sessionId = String(event.sessionId);
      lastActivityAt = createdAt;
    } else if (event.kind === "heartbeat" && sessionId === event.sessionId && lastActivityAt) {
      activeMillis += evidenceElapsedMillis(lastActivityAt, createdAt);
      lastActivityAt = createdAt;
    } else if (event.kind === "pause" && sessionId === event.sessionId && lastActivityAt) {
      activeMillis += evidenceElapsedMillis(lastActivityAt, createdAt);
      sessionId = null;
      lastActivityAt = createdAt;
    } else if (event.kind === "finish") {
      if (sessionId && lastActivityAt) activeMillis += evidenceElapsedMillis(lastActivityAt, createdAt);
      sessionId = null;
      finished = true;
    }
  }
  if (!finished || !baseline
    || baseline.manualBaselineSeconds !== value.manualBaselineSeconds
    || baseline.method !== value.method
    || baseline.operatorIdHash !== value.operatorIdHash
    || baseline.evidenceSha256 !== value.evidenceSha256
    || Math.round(activeMillis) / 1_000 !== value.agentCutActiveSeconds) {
    invalid("Alpha timing summary does not match its append-only event log");
  }
}

function validateTimingOrigin(
  timing: unknown,
  events: unknown[],
  firstHumanDecisionRevision: unknown,
): void {
  if (timing === undefined || timing === null || firstHumanDecisionRevision === null) return;
  if (!Number.isSafeInteger(firstHumanDecisionRevision)) {
    invalid("Alpha timing evidence is missing its human-decision origin proof");
  }
  let firstStartRevision: number | null = null;
  for (const rawEvent of events) {
    if (!isRecord(rawEvent)
      || rawEvent.targetType !== "timing"
      || !isRecord(rawEvent.timingEvent)) continue;
    const eventRevision = Number(rawEvent.projectRevision);
    if (rawEvent.timingEvent.kind === "baseline" && eventRevision >= Number(firstHumanDecisionRevision)) {
      invalid("Alpha timing baseline was recorded after human content decisions began");
    }
    if (rawEvent.timingEvent.kind === "start" && firstStartRevision === null) {
      firstStartRevision = eventRevision;
    }
  }
  if (firstStartRevision === null || firstStartRevision >= Number(firstHumanDecisionRevision)) {
    invalid("Alpha timing did not start before human content decisions began");
  }
}

function validateFinalLabelTimingOrder(timing: unknown, events: unknown[]): void {
  const labelEvents = events.filter((event) => isRecord(event)
    && (event.targetType === "candidate" || event.targetType === "boundary"));
  if (labelEvents.length === 0 || timing === undefined || timing === null) return;
  if (!isRecord(timing) || timing.complete !== true) {
    invalid("Final Alpha labels require completed active-time evidence when timing was collected");
  }
  const finishSequences = events.flatMap((event) =>
    isRecord(event)
      && event.targetType === "timing"
      && isRecord(event.timingEvent)
      && event.timingEvent.kind === "finish"
      && Number.isSafeInteger(event.sequence)
      ? [Number(event.sequence)]
      : [],
  );
  const finalFinishSequence = Math.max(...finishSequences);
  if (!Number.isFinite(finalFinishSequence)
    || labelEvents.some((event) => Number((event as Record<string, unknown>).sequence) <= finalFinishSequence)) {
    invalid("Final Alpha labels must be recorded after active-time evidence is finished");
  }
}

function evidenceElapsedMillis(start: string, end: string): number {
  const elapsed = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 30_000) {
    invalid("Alpha timing event log contains an invalid active-time gap");
  }
  return elapsed;
}

function isEvidenceEvent(value: unknown): value is AlphaEvidenceBundleEvent {
  return isRecord(value)
    && Number.isSafeInteger(value.sequence)
    && Number(value.sequence) > 0
    && requiredText(value.requestId)
    && requiredText(value.projectId)
    && Number.isSafeInteger(value.projectRevision)
    && Number(value.projectRevision) >= 0
    && isSha256(value.sourceSha256)
    && ["candidate", "boundary", "correctness", "timing"].includes(String(value.targetType))
    && requiredText(value.targetId)
    && [null, "true_positive", "false_positive"].includes(value.candidateLabel as null | string)
    && [null, true, false].includes(value.boundaryUsable as null | boolean)
    && isIssueCodeArray(value.boundaryIssueCodes)
    && correctnessResultMatchesTarget(value.targetType, value.correctnessResult)
    && timingEventMatchesTarget(value.targetType, value.timingEvent)
    && (value.noteSha256 === null || isSha256(value.noteSha256))
    && isTimestamp(value.createdAt)
    && /^[a-f0-9]{64}$/.test(String(value.payloadHash));
}

function timingEventMatchesTarget(targetType: unknown, value: unknown): boolean {
  if (targetType !== "timing") return value === undefined;
  if (!isRecord(value) || !["baseline", "start", "heartbeat", "pause", "finish"].includes(String(value.kind))) {
    return false;
  }
  if (value.kind === "baseline") {
    return Number.isFinite(value.manualBaselineSeconds)
      && Number(value.manualBaselineSeconds) > 0
      && ["stopwatch", "screen_recording", "editor_log"].includes(String(value.method))
      && isSha256(value.operatorIdHash)
      && isSha256(value.evidenceSha256);
  }
  if (value.kind === "finish") return Object.keys(value).length === 1;
  if (!requiredText(value.sessionId)) return false;
  return value.kind !== "pause" || ["user", "idle", "page_hidden"].includes(String(value.reason));
}

function correctnessResultMatchesTarget(targetType: unknown, value: unknown): boolean {
  if (targetType !== "correctness") return value === undefined;
  if (!isRecord(value) || !isSha256(value.sourceStateHash) || !isRecord(value.checks)) return false;
  for (const kind of ["undo", "restart", "idempotency", "revisionConflict"]) {
    const check = value.checks[kind];
    if (!isRecord(check)
      || typeof check.passed !== "boolean"
      || !requiredText(check.code)
      || !isPrimitiveRecord(check.details)) return false;
  }
  return true;
}

function sha256Canonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new AlphaEvidenceBundleError("INVALID_BUNDLE", "Bundle contains a non-canonical value");
}

function isIssueCodeArray(value: unknown): value is AlphaBoundaryIssueCode[] {
  const allowed = new Set(["swallowed_word", "clipped_syllable", "av_sync", "unnatural_pacing", "other"]);
  return Array.isArray(value)
    && value.every((candidate) => typeof candidate === "string" && allowed.has(candidate))
    && new Set(value).size === value.length;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(requiredText);
}

function isPrimitiveRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((candidate) =>
    typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean",
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function requiredText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return requiredText(value) && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new AlphaEvidenceBundleError("INVALID_BUNDLE", message);
}
