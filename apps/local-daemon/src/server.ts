import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import {
  AlphaEvidenceStore,
  createAlphaAuditDraft,
  type AlphaBoundaryIssueCode,
  type AlphaEvidenceResponse,
  type AlphaTimingBaselineMethod,
  type AlphaTimingPauseReason,
} from "@agentcut/alpha-gate";
import {
  compileCandidateAcceptBatch,
  compileCandidateKeepBatch,
  compileCandidateAcceptance,
  compileCandidateKeep,
  compileCandidateUnlock,
  compileManualSelectionDeletion,
  compileManualSpeechGapDeletion,
  computeCandidateAcceptanceApprovalPayloadHash,
  createLowRiskProposal,
  detectSilences,
  generateTalkingHeadCandidates,
  generateSemanticReviewCandidates,
  parseSemanticFindings,
  type SemanticReviewFinding,
  type SemanticReviewProvider,
} from "@agentcut/candidate-engine";
import {
  applyTransaction,
  compileEditProposalBundle,
  EditError,
  type CommandRecord,
  type EditOperation,
  type EditTransaction,
} from "@agentcut/edit-commands";
import {
  ProjectStore,
  type AgentCapability,
  type AgentSession,
  type ProjectApproval,
  type ProjectStoreOptions,
} from "@agentcut/project-store";
import {
  evaluateTimelineSegments,
  inspectRenderEnvironment,
  recoverRunningPersistedRenderJob,
  RenderError,
  runPersistedRenderJob,
  type InspectRenderEnvironmentOptions,
  type PersistedRenderJobOptions,
  type RenderCapabilityReport,
} from "@agentcut/render-engine";
import {
  buildRoughCutReadiness,
  buildSpeechGapProjection,
  buildTranscriptReviewProjection,
} from "@agentcut/review-projection";
import type { AgentCutProjectDocument } from "@agentcut/timeline-schema";
import {
  findPreviewProxyAsset,
  readAlphaTrialEnrollment,
  readPreviewProxyBinding,
  TALKING_HEAD_EXTENSION_VALIDATORS,
} from "@agentcut/host-extensions";
import {
  readUiCredentialFile,
  rotateUiCredentialFile,
  type UiCredential,
} from "../../../scripts/agentcut-credentials.mjs";

/** 口播宿主声明的扩展语义在 daemon 的全部 store 读写路径上生效。 */
function openHostStore(databasePath: string, options: ProjectStoreOptions = {}): ProjectStore {
  return ProjectStore.open(databasePath, {
    extensionValidators: TALKING_HEAD_EXTENSION_VALIDATORS,
    ...options,
  });
}

export interface AgentCutServerOptions {
  databasePath: string;
  projectRoot: string;
  allowedOrigin?: string;
  studioRoot?: string;
  semanticReviewProvider?: SemanticReviewProvider;
  silenceDetector?: typeof detectSilences;
  renderCapabilityInspector?: (options: InspectRenderEnvironmentOptions) => RenderCapabilityReport;
  renderJobRunner?: (options: PersistedRenderJobOptions) => Promise<unknown>;
  renderRecoveryRunner?: (options: PersistedRenderJobOptions) => Promise<unknown | null>;
  alphaEvidenceClock?: () => string;
  agentBootstrapToken?: string;
  agentAccessClock?: () => string;
  approvalAfterCommitHook?: () => void;
  uiBootstrapToken?: string;
  uiCredentialPath?: string;
  uiSessionClock?: () => string;
  uiSessionNonce?: () => string;
  uiRotationTokenFactory?: () => string;
  uiRotationAfterCredentialPublishHook?: () => void;
}

const UI_SESSION_COOKIE = "agentcut_ui_session";
const UI_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const EXPORT_ABORT_CONTROLLERS = new WeakMap<AgentCutServerOptions, Map<string, AbortController>>();

export function createAgentCutServer(options: AgentCutServerOptions): Server {
  if (options.agentBootstrapToken !== undefined
    && Buffer.byteLength(options.agentBootstrapToken, "utf8") < 32) {
    throw new Error("AGENTCUT_AGENT_BOOTSTRAP_TOKEN must contain at least 32 bytes");
  }
  if (options.uiBootstrapToken !== undefined
    && Buffer.byteLength(options.uiBootstrapToken, "utf8") < 32) {
    throw new Error("AGENTCUT_UI_BOOTSTRAP_TOKEN must contain at least 32 bytes");
  }
  if (options.uiBootstrapToken && options.uiCredentialPath) {
    throw new Error("Configure AGENTCUT_UI_CREDENTIAL_PATH instead of a second in-memory UI bootstrap");
  }
  if (options.uiCredentialPath) recoverUiCredentialRotation(options);
  exportAbortControllers(options);
  recoverExportJobs(options);
  return createServer((request, response) => {
    void handleAgentCutRequest(request, response, options).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const code = typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "INTERNAL_ERROR";
      sendJson(response, statusForCode(code), {
        error: {
          code,
          message: error instanceof Error ? error.message : String(error),
          ...(typeof error === "object" && error && "details" in error
            ? { details: error.details }
            : {}),
        },
      }, options.allowedOrigin);
    });
  });
}

export async function handleAgentCutRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: AgentCutServerOptions,
): Promise<void> {
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(options.allowedOrigin));
    response.end();
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/ui/session" && request.method === "GET") {
    const session = inspectUiSession(request, options);
    sendJson(response, 200, session, options.allowedOrigin);
    return;
  }
  if (url.pathname === "/api/ui/session" && request.method === "POST") {
    const credential = requiredUiCredential(options);
    assertSecret(
      readBearerToken(request, "UI_BOOTSTRAP_DENIED", "A Bearer UI bootstrap credential is required"),
      credential.bootstrapToken,
      "UI_BOOTSTRAP_DENIED",
    );
    const store = openHostStore(options.databasePath);
    let projectId: string;
    try {
      projectId = store.snapshot().project.id;
    } finally {
      store.close();
    }
    const issued = issueUiSession(projectId, credential, options);
    recordUiAccess(options, "POST", url.pathname, true, "paired");
    sendJson(response, 201, {
      authenticated: true,
      expiresAt: issued.expiresAt,
      generation: credential.generation,
    }, options.allowedOrigin, {
      "Set-Cookie": `${UI_SESSION_COOKIE}=${issued.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${UI_SESSION_TTL_SECONDS}`,
    });
    return;
  }
  let agentSession: AgentSession | undefined;
  if (request.method === "POST" && url.pathname === "/api/agent/sessions") {
    const bootstrapToken = requiredAgentBootstrapToken(options);
    assertSecret(readBearerToken(request), bootstrapToken, "AGENT_BOOTSTRAP_DENIED");
    const body = await readJsonBody(request);
    const requestId = readStableString(body, "requestId", 128);
    const clientId = readStableString(body, "clientId", 128);
    const capabilities = readAgentCapabilities(body);
    const ttlSeconds = readAgentSessionTtl(body);
    const store = openAgentAccessStore(options);
    try {
      const projectId = store.snapshot().project.id;
      const sessionId = createAgentSessionId(projectId, clientId, requestId);
      const accessToken = createAgentAccessToken(bootstrapToken, sessionId);
      const creation = store.createAgentSession({
        id: sessionId,
        requestId,
        clientId,
        capabilities,
        ttlSeconds,
        tokenHash: hashAgentToken(accessToken),
      });
      sendJson(response, creation.idempotentReplay ? 200 : 201, {
        session: creation.session,
        accessToken,
        idempotentReplay: creation.idempotentReplay,
      }, options.allowedOrigin);
    } finally {
      store.close();
    }
    return;
  }
  const agentRoute = resolveAgentRoute(request.method ?? "", url.pathname);
  if (agentRoute) {
    const store = openAgentAccessStore(options);
    try {
      const requestId = readAgentRequestIdHeader(request);
      agentSession = store.authorizeAgentSession({
        tokenHash: hashAgentToken(readBearerToken(request)),
        capability: agentRoute.capability,
        method: request.method ?? "",
        path: url.pathname,
        ...(requestId ? { requestId } : {}),
      });
      if (agentRoute.kind === "approval_request") {
        const body = await readJsonBody(request);
        const requestId = readStableString(body, "requestId", 128);
        const candidateId = readStableString(body, "candidateId", 256);
        const baseRevision = readBaseRevision(body);
        const document = store.snapshot();
        assertCurrentRevision(document.project.revision, baseRevision);
        assertCandidateOverlapDecisionAnchor(document, store.listRecords(), candidateId);
        const payloadHash = computeCandidateAcceptanceApprovalPayloadHash(document, candidateId);
        const approvalId = createApprovalId(document.project.id, candidateId, requestId);
        const creation = store.createApproval({
          id: approvalId,
          requestId,
          kind: "content_high_risk_delete",
          targetId: candidateId,
          baseRevision,
          payloadHash,
          requestedBySessionId: agentSession.id,
          ttlSeconds: 3_600,
        });
        sendJson(response, creation.idempotentReplay ? 200 : 201, {
          approval: approvalResponse(creation.approval, document.project.revision, options),
          idempotentReplay: creation.idempotentReplay,
        }, options.allowedOrigin);
        return;
      }
      if (agentRoute.kind === "approval_get") {
        const approval = requiredApproval(store, agentRoute.approvalId);
        const currentRevision = store.snapshot().project.revision;
        sendJson(response, 200, {
          approval: approvalResponse(approval, currentRevision, options, true),
        }, options.allowedOrigin);
        return;
      }
      if (agentRoute.kind === "approval_apply") {
        const body = await readJsonBody(request);
        const requestId = readStableString(body, "requestId", 128);
        const baseRevision = readBaseRevision(body);
        const approvalToken = readStableString(body, "approvalToken", 256);
        const approval = requiredApproval(store, agentRoute.approvalId);
        if (!store.getRecord(`tx_review_accept_approval_${approval.id}`)) {
          assertAlphaTrialEditingActive(options);
        }
        applyApprovedCandidate(
          store,
          approval,
          agentSession,
          { requestId, baseRevision, approvalToken },
          options,
        );
        sendJson(response, 200, reviewResponse(store, options, agentSession), options.allowedOrigin);
        return;
      }
      if (agentRoute.kind === "project_get") {
        sendJson(response, 200, coreProjectSummary(store, agentSession), options.allowedOrigin);
        return;
      }
      if (agentRoute.kind === "timeline_transaction") {
        const body = await readJsonBody(request);
        const result = applyAgentTimelineTransaction(store, body, agentSession, options);
        sendJson(response, result.idempotentReplay ? 200 : 201, result, options.allowedOrigin);
        return;
      }
      if (agentRoute.kind === "project_diff") {
        sendJson(response, 200, projectDiffResponse(store, url), options.allowedOrigin);
        return;
      }
      if (agentRoute.kind === "transcript_get") {
        sendJson(response, 200, agentTranscriptResponse(store, url), options.allowedOrigin);
        return;
      }
      if (agentRoute.kind === "timeline_get") {
        sendJson(response, 200, agentTimelineResponse(store, url), options.allowedOrigin);
        return;
      }
      if (agentRoute.kind === "semantic_findings") {
        const body = await readJsonBody(request);
        const requestId = readStableString(body, "requestId", 128);
        if (readAgentRequestIdHeader(request) !== requestId) {
          throw new ApiError(
            "INVALID_REQUEST",
            "Agent semantic findings requestId must match X-AgentCut-Request-Id",
          );
        }
        const findingsValue = body.findings;
        if (!Array.isArray(findingsValue) || findingsValue.length === 0 || findingsValue.length > 100) {
          throw new ApiError("INVALID_REQUEST", "findings must contain 1 to 100 items");
        }
        let findings: SemanticReviewFinding[];
        try {
          findings = parseSemanticFindings({ findings: findingsValue });
        } catch (error) {
          throw new ApiError(
            "INVALID_REQUEST",
            error instanceof Error ? error.message : "Invalid semantic findings payload",
          );
        }
        assertAgentSemanticFindings(findings);
        const result = await runAgentSemanticFindings(
          store,
          options,
          agentSession,
          requestId,
          readBaseRevision(body),
          findings,
        );
        sendJson(response, 200, result, options.allowedOrigin);
        return;
      }
      url.pathname = agentRoute.canonicalPath;
    } finally {
      store.close();
    }
  }
  if ((options.uiBootstrapToken || options.uiCredentialPath)
    && !agentSession
    && requiresUiSession(request.method ?? "", url.pathname)) {
    requireUiSession(request, options);
  }
  const approvalResolve = /^\/api\/approvals\/([^/]+)\/resolve$/.exec(url.pathname);
  if (request.method === "POST" && approvalResolve) {
    const approvalId = decodeURIComponent(approvalResolve[1]!);
    const body = await readJsonBody(request);
    const requestId = readStableString(body, "requestId", 128);
    const baseRevision = readBaseRevision(body);
    const decision = body.decision;
    if (decision !== "approve" && decision !== "deny") {
      throw new ApiError("INVALID_REQUEST", "decision must be approve or deny");
    }
    const store = openAgentAccessStore(options);
    try {
      const approval = requiredApproval(store, approvalId);
      const document = store.snapshot();
      assertCurrentRevision(document.project.revision, baseRevision);
      if (approval.baseRevision !== baseRevision
        || computeCandidateAcceptanceApprovalPayloadHash(document, approval.targetId) !== approval.payloadHash) {
        throw new ApiError("APPROVAL_STALE", "Approval no longer matches the current candidate payload");
      }
      const tokenHash = decision === "approve"
        ? hashAgentToken(createApprovalToken(requiredAgentBootstrapToken(options), approval))
        : undefined;
      if (approval.resolutionRequestId !== requestId) {
        assertAlphaTrialEditingActive(options);
      }
      store.resolveApproval({
        approvalId,
        requestId,
        decision,
        resolvedBy: "local_user",
        ...(tokenHash ? { tokenHash } : {}),
      });
      sendJson(response, 200, reviewResponse(store, options), options.allowedOrigin);
    } finally {
      store.close();
    }
    return;
  }
  const agentSessionRevoke = /^\/api\/agent-sessions\/([^/]+)\/revoke$/.exec(url.pathname);
  if (request.method === "POST" && agentSessionRevoke) {
    const body = await readJsonBody(request);
    const store = openAgentAccessStore(options);
    try {
      store.revokeAgentSession({
        sessionId: decodeURIComponent(agentSessionRevoke[1]!),
        requestId: readStableString(body, "requestId", 128),
        revokedBy: "local_user",
      });
      sendJson(response, 200, reviewResponse(store, options), options.allowedOrigin);
    } finally {
      store.close();
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/ui/bootstrap/rotate") {
    const body = await readJsonBody(request);
    const requestId = readStableString(body, "requestId", 128);
    const currentSession = inspectUiSession(request, options);
    if (!currentSession.authenticated) {
      throw new ApiError(
        currentSession.reason === "expired" ? "UI_SESSION_EXPIRED" : "UI_SESSION_REQUIRED",
        "The Studio session became stale before bootstrap rotation; pair again and retry",
        { reason: currentSession.reason ?? "invalid" },
      );
    }
    const credentialPath = options.uiCredentialPath;
    if (!credentialPath) {
      throw new ApiError(
        "UI_CREDENTIAL_ROTATION_UNAVAILABLE",
        "UI bootstrap rotation requires a file-backed Studio credential",
      );
    }
    const store = openHostStore(options.databasePath, {
      ...(options.uiSessionClock ? { clock: options.uiSessionClock } : {}),
    });
    try {
      const existing = store.getUiCredentialRotation(requestId);
      let credential: UiCredential;
      let idempotentReplay: boolean;
      if (existing) {
        credential = readUiCredentialFile(credentialPath, options.projectRoot);
        if (credential.bootstrapFingerprint !== existing.currentFingerprint
          || credential.generation !== existing.generation) {
          throw new ApiError(
            "UI_CREDENTIAL_ROTATION_STALE",
            "This rotation request was already applied to an older UI credential generation",
          );
        }
        idempotentReplay = true;
      } else {
        const rotated = rotateUiCredentialFile(credentialPath, options.projectRoot, {
          requestId,
          ...(options.uiSessionClock ? { clock: options.uiSessionClock } : {}),
          ...(options.uiRotationTokenFactory ? { tokenFactory: options.uiRotationTokenFactory } : {}),
          ...(options.uiRotationAfterCredentialPublishHook
            ? { afterPublish: options.uiRotationAfterCredentialPublishHook }
            : {}),
        });
        credential = rotated.credential;
        const recording = store.recordUiCredentialRotation({
          ...rotated.rotation,
          rotatedBy: "local_user",
          createdAt: rotated.rotation.rotatedAt,
        });
        idempotentReplay = rotated.idempotentReplay || recording.idempotentReplay;
      }
      const issued = issueUiSession(store.snapshot().project.id, credential, options);
      sendJson(response, idempotentReplay ? 200 : 201, {
        authenticated: true,
        expiresAt: issued.expiresAt,
        generation: credential.generation,
        rotatedAt: credential.lastRotation?.rotatedAt,
        idempotentReplay,
      }, options.allowedOrigin, {
        "Set-Cookie": `${UI_SESSION_COOKIE}=${issued.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${UI_SESSION_TTL_SECONDS}`,
      });
    } finally {
      store.close();
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    const store = openHostStore(options.databasePath);
    try {
      // 协议 §6.1：{ok, protocolVersion} 为契约字段；projectId/revision 为本地工具的兼容附加字段。
      sendJson(response, 200, {
        ok: true,
        protocolVersion: "0.1.0",
        projectId: store.snapshot().project.id,
        revision: store.snapshot().project.revision,
      }, options.allowedOrigin);
    } finally {
      store.close();
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/review") {
    const store = openHostStore(options.databasePath);
    try {
      sendJson(response, 200, reviewResponse(store, options, agentSession), options.allowedOrigin);
    } finally {
      store.close();
    }
    return;
  }
  const candidatePreview = /^\/api\/candidates\/([^/]+)\/preview$/.exec(url.pathname);
  if (request.method === "GET" && candidatePreview) {
    const candidateId = decodeURIComponent(candidatePreview[1]!);
    const baseRevision = readCanonicalQueryInteger(url, "baseRevision", true)!;
    const store = openHostStore(options.databasePath);
    try {
      const document = store.snapshot();
      assertCurrentRevision(document.project.revision, baseRevision);
      const transcript = latestTranscript(document);
      const review = buildTranscriptReviewProjection(document, store.listRecords(), transcript.id);
      const candidate = review.candidates.find((item) => item.candidateId === candidateId);
      if (!candidate || (candidate.state !== "candidate_remove" && candidate.state !== "candidate_keep")) {
        throw new ApiError("CANDIDATE_UNAVAILABLE", `Candidate ${candidateId} is not pending review`);
      }
      const transaction = compileCandidateAcceptance(document, {
        candidateId,
        requestId: `preview_${candidateId}_r${baseRevision}`,
        actor: { kind: "user", id: "local_user" },
        createdAt: document.project.updatedAt,
        allowHighRisk: true,
      });
      const simulated = applyTransaction(
        document,
        transaction,
        () => document.project.updatedAt,
      ).document;
      const preview = buildPreviewProjection(simulated);
      sendJson(response, 200, {
        candidateId,
        baseRevision,
        preview: { ...preview, revision: baseRevision },
      }, options.allowedOrigin);
    } finally {
      store.close();
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/alpha-audit") {
    sendJson(response, 200, alphaAuditResponse(options), options.allowedOrigin);
    return;
  }
  const alphaCandidateLabel = /^\/api\/alpha-audit\/candidates\/([^/]+)$/.exec(url.pathname);
  if (request.method === "POST" && alphaCandidateLabel) {
    const body = await readJsonBody(request);
    const result = withAlphaAudit(options, (draft, evidence) => {
      assertAlphaAuditBinding(draft, readBaseRevision(body), readRequiredString(body, "sourceSha256"));
      const note = readOptionalString(body, "note");
      return evidence.labelCandidate(draft, {
        requestId: readRequiredString(body, "requestId"),
        candidateId: decodeURIComponent(alphaCandidateLabel[1]!),
        label: readCandidateLabel(body),
        ...(note !== undefined ? { note } : {}),
      });
    });
    sendJson(response, 200, result, options.allowedOrigin);
    return;
  }
  const alphaBoundaryLabel = /^\/api\/alpha-audit\/boundaries\/([^/]+)$/.exec(url.pathname);
  if (request.method === "POST" && alphaBoundaryLabel) {
    const body = await readJsonBody(request);
    const result = withAlphaAudit(options, (draft, evidence) => {
      assertAlphaAuditBinding(draft, readBaseRevision(body), readRequiredString(body, "sourceSha256"));
      const note = readOptionalString(body, "note");
      return evidence.labelBoundary(draft, {
        requestId: readRequiredString(body, "requestId"),
        boundaryId: decodeURIComponent(alphaBoundaryLabel[1]!),
        usable: readRequiredBoolean(body, "usable"),
        issueCodes: readBoundaryIssueCodes(body),
        ...(note !== undefined ? { note } : {}),
      });
    });
    sendJson(response, 200, result, options.allowedOrigin);
    return;
  }
  const alphaTimingAction = /^\/api\/alpha-audit\/timing\/(begin|baseline|start|heartbeat|pause|finish)$/.exec(
    url.pathname,
  );
  if (request.method === "POST" && alphaTimingAction) {
    const body = await readJsonBody(request);
    const result = withAlphaAudit(options, (draft, evidence) => {
      assertAlphaAuditBinding(draft, readBaseRevision(body), readRequiredString(body, "sourceSha256"));
      const requestId = readRequiredString(body, "requestId");
      if (alphaTimingAction[1] !== "pause") assertFormalAlphaTimingEnrollment(draft);
      switch (alphaTimingAction[1]) {
        case "begin":
          return evidence.beginTiming(draft, {
            requestId,
            manualBaselineSeconds: readPositiveNumber(body, "manualBaselineSeconds"),
            method: readTimingBaselineMethod(body),
            operatorId: readRequiredString(body, "operatorId"),
            evidenceSha256: readRequiredString(body, "evidenceSha256"),
            sessionId: readRequiredString(body, "sessionId"),
          });
        case "baseline":
          return evidence.setTimingBaseline(draft, {
            requestId,
            manualBaselineSeconds: readPositiveNumber(body, "manualBaselineSeconds"),
            method: readTimingBaselineMethod(body),
            operatorId: readRequiredString(body, "operatorId"),
            evidenceSha256: readRequiredString(body, "evidenceSha256"),
          });
        case "start":
          return evidence.startTiming(draft, {
            requestId,
            sessionId: readRequiredString(body, "sessionId"),
          });
        case "heartbeat":
          return evidence.heartbeatTiming(draft, {
            requestId,
            sessionId: readRequiredString(body, "sessionId"),
          });
        case "pause":
          return evidence.pauseTiming(draft, {
            requestId,
            sessionId: readRequiredString(body, "sessionId"),
            reason: readTimingPauseReason(body),
          });
        case "finish":
          if (draft.project.alphaTrial) assertAlphaTrialReadyToFinish(draft);
          return evidence.finishTiming(draft, { requestId });
        default:
          throw new ApiError("INVALID_REQUEST", "Unsupported timing action");
      }
    });
    sendJson(response, 200, result, options.allowedOrigin);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/analyze-semantic") {
    if (!options.semanticReviewProvider) {
      throw new ApiError(
        "SEMANTIC_REVIEW_UNAVAILABLE",
        "未发现可用的本地语义模型。请先启动 LM Studio 本地服务器，再重新启动 AgentCut Studio。",
      );
    }
    const body = await readJsonBody(request);
    const requestId = readRequiredString(body, "requestId");
    const baseRevision = readBaseRevision(body);
    const result = await runSemanticReview(options, requestId, baseRevision);
    sendJson(response, 200, result, options.allowedOrigin);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/rough-cut/generate") {
    const body = await readJsonBody(request);
    const result = runRoughCutGeneration(
      options,
      readRequiredString(body, "requestId"),
      readBaseRevision(body),
    );
    sendJson(response, 200, result, options.allowedOrigin);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/selections/preview") {
    const body = await readJsonBody(request);
    const requestId = readRequiredString(body, "requestId");
    const baseRevision = readBaseRevision(body);
    const wordIds = readStringArray(body, "wordIds");
    const store = openHostStore(options.databasePath);
    try {
      const document = store.snapshot();
      assertCurrentRevision(document.project.revision, baseRevision);
      const transaction = compileManualSelectionDeletion(document, {
        wordIds,
        requestId: `preview_${requestId}`,
        actor: { kind: "user", id: "local_user" },
        createdAt: document.project.updatedAt,
      });
      const simulated = applyTransaction(
        document,
        transaction,
        () => document.project.updatedAt,
      ).document;
      const preview = buildPreviewProjection(simulated);
      sendJson(response, 200, {
        wordIds,
        baseRevision,
        preview: { ...preview, revision: baseRevision },
      }, options.allowedOrigin);
    } finally {
      store.close();
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/selections/delete") {
    const body = await readJsonBody(request);
    const requestId = readRequiredString(body, "requestId");
    const baseRevision = readBaseRevision(body);
    const wordIds = readStringArray(body, "wordIds");
    const transactionId = `tx_manual_delete_${requestId}`;
    const store = openHostStore(options.databasePath);
    try {
      if (!store.getRecord(transactionId)) {
        assertAlphaTrialEditingActive(options);
        const document = store.snapshot();
        assertCurrentRevision(document.project.revision, baseRevision);
        store.commit(compileManualSelectionDeletion(document, {
          wordIds,
          requestId,
          actor: { kind: "user", id: "local_user" },
          createdAt: new Date().toISOString(),
        }));
      }
      sendJson(response, 200, reviewResponse(store, options), options.allowedOrigin);
    } finally {
      store.close();
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/speech-gaps/preview") {
    const body = await readJsonBody(request);
    const gapId = readRequiredString(body, "gapId");
    const baseRevision = readBaseRevision(body);
    const store = openHostStore(options.databasePath);
    try {
      const document = store.snapshot();
      assertCurrentRevision(document.project.revision, baseRevision);
      const gap = currentSpeechGap(document, gapId);
      const transaction = compileManualSpeechGapDeletion(document, {
        sourceRange: gap.sourceRange,
        ...(gap.previousWordId ? { previousWordId: gap.previousWordId } : {}),
        ...(gap.nextWordId ? { nextWordId: gap.nextWordId } : {}),
        requestId: `preview_${gapId}_r${baseRevision}`,
        actor: { kind: "user", id: "local_user" },
        createdAt: document.project.updatedAt,
      });
      const simulated = applyTransaction(
        document,
        transaction,
        () => document.project.updatedAt,
      ).document;
      const preview = buildPreviewProjection(simulated);
      sendJson(response, 200, {
        gapId,
        baseRevision,
        preview: { ...preview, revision: baseRevision },
      }, options.allowedOrigin);
    } finally {
      store.close();
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/speech-gaps/delete") {
    const body = await readJsonBody(request);
    const requestId = readRequiredString(body, "requestId");
    const gapId = readRequiredString(body, "gapId");
    const baseRevision = readBaseRevision(body);
    const transactionId = `tx_manual_gap_delete_${requestId}`;
    const store = openHostStore(options.databasePath);
    try {
      if (!store.getRecord(transactionId)) {
        assertAlphaTrialEditingActive(options);
        const document = store.snapshot();
        assertCurrentRevision(document.project.revision, baseRevision);
        const gap = currentSpeechGap(document, gapId);
        store.commit(compileManualSpeechGapDeletion(document, {
          sourceRange: gap.sourceRange,
          ...(gap.previousWordId ? { previousWordId: gap.previousWordId } : {}),
          ...(gap.nextWordId ? { nextWordId: gap.nextWordId } : {}),
          requestId,
          actor: { kind: "user", id: "local_user" },
          createdAt: new Date().toISOString(),
        }));
      }
      sendJson(response, 200, reviewResponse(store, options), options.allowedOrigin);
    } finally {
      store.close();
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/candidates/keep-remaining") {
    const body = await readJsonBody(request);
    const requestId = readRequiredString(body, "requestId");
    const baseRevision = readBaseRevision(body);
    const transactionId = `tx_review_keep_batch_${requestId}`;
    const store = openHostStore(options.databasePath);
    try {
      if (!store.getRecord(transactionId)) {
        assertAlphaTrialEditingActive(options);
        const document = store.snapshot();
        assertCurrentRevision(document.project.revision, baseRevision);
        const transcript = latestTranscript(document);
        const projection = buildTranscriptReviewProjection(
          document,
          store.listRecords(),
          transcript.id,
        );
        const candidateIds = projection.candidates
          .filter((candidate) =>
            candidate.state === "candidate_remove" || candidate.state === "candidate_keep",
          )
          .map((candidate) => candidate.candidateId);
        if (candidateIds.length > 0) {
          store.commit(compileCandidateKeepBatch(document, {
            candidateIds,
            requestId,
            actor: { kind: "user", id: "local_user" },
            createdAt: new Date().toISOString(),
          }));
        }
      }
      sendJson(response, 200, reviewResponse(store, options), options.allowedOrigin);
    } finally {
      store.close();
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/candidates/batch-accept") {
    const body = await readJsonBody(request);
    const requestId = readRequiredString(body, "requestId");
    const baseRevision = readBaseRevision(body);
    const candidateIds = readStringArray(body, "candidateIds");
    if (new Set(candidateIds).size !== candidateIds.length) {
      throw new ApiError("INVALID_REQUEST", "candidateIds must contain unique entries");
    }
    const transactionId = `tx_review_accept_batch_${requestId}`;
    const store = openHostStore(options.databasePath);
    try {
      if (store.getRecord(transactionId)) {
        sendJson(response, 200, reviewResponse(store, options), options.allowedOrigin);
        return;
      }
      assertAlphaTrialEditingActive(options);
      const document = store.snapshot();
      assertCurrentRevision(document.project.revision, baseRevision);
      const records = store.listRecords();
      const resolveOverlapCandidateIds: Record<string, string[]> = {};
      for (const candidateId of candidateIds) {
        const members = assertCandidateOverlapDecisionAnchor(document, records, candidateId);
        if (members.length > 0) resolveOverlapCandidateIds[candidateId] = members;
      }
      store.commit(compileCandidateAcceptBatch(document, {
        candidateIds,
        requestId,
        actor: { kind: "user", id: "local_user" },
        createdAt: new Date().toISOString(),
        ...(Object.keys(resolveOverlapCandidateIds).length > 0
          ? { resolveOverlapCandidateIds }
          : {}),
      }));
      sendJson(response, 200, reviewResponse(store, options), options.allowedOrigin);
    } finally {
      store.close();
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/exports") {
    const body = await readJsonBody(request);
    const requestId = readRequiredString(body, "requestId");
    const baseRevision = readBaseRevision(body);
    const preset = readExportPreset(body);
    const jobId = `job_export_${requestId}`;
    const store = openHostStore(options.databasePath);
    let shouldSchedule = false;
    try {
      let job;
      try {
        job = store.getJob(jobId);
        const input = exportJobInput(job.input);
        if (input.sourceRevision !== baseRevision) {
          throw new ApiError("IDEMPOTENCY_CONFLICT", "Export requestId was reused for another revision");
        }
        if (input.preset !== preset) {
          throw new ApiError("IDEMPOTENCY_CONFLICT", "Export requestId was reused for another preset");
        }
      } catch (error) {
        if (!isErrorCode(error, "JOB_NOT_FOUND")) throw error;
        assertAlphaTrialEditingActive(options);
        const document = store.snapshot();
        assertCurrentRevision(document.project.revision, baseRevision);
        assertRoughCutReady(store, document);
        const capability = (options.renderCapabilityInspector ?? inspectRenderEnvironment)({
          projectRoot: options.projectRoot,
          ...(process.env.AGENTCUT_FFMPEG_PATH
            ? { ffmpegPath: process.env.AGENTCUT_FFMPEG_PATH }
            : {}),
          ...(process.env.AGENTCUT_FFPROBE_PATH
            ? { ffprobePath: process.env.AGENTCUT_FFPROBE_PATH }
            : {}),
        });
        if (!capability.ready) {
          throw new ApiError(
            "RENDER_CAPABILITY_MISSING",
            `当前 FFmpeg 环境不能可靠导出：${capability.missing.join(", ")}`,
            { missing: capability.missing, capability },
          );
        }
        const transcript = latestTranscript(document);
        job = store.createJob({
          id: jobId,
          type: "export.render",
          maxAttempts: 2,
          payload: {
            sourceRevision: baseRevision,
            sequenceId: document.project.activeSequenceId!,
            transcriptArtifactId: transcript.id,
            preset,
          },
        });
        shouldSchedule = true;
      }
      sendJson(response, 202, exportJobResponse(store, jobId), options.allowedOrigin);
    } finally {
      store.close();
    }
    if (shouldSchedule) scheduleExportJob(options, jobId);
    return;
  }
  const exportStatus = /^\/api\/exports\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && exportStatus) {
    const store = openHostStore(options.databasePath);
    try {
      sendJson(
        response,
        200,
        exportJobResponse(store, decodeURIComponent(exportStatus[1]!)),
        options.allowedOrigin,
      );
    } finally {
      store.close();
    }
    return;
  }
  const exportCancellation = /^\/api\/exports\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && exportCancellation) {
    const body = await readJsonBody(request);
    const requestId = readStableString(body, "requestId", 128);
    if (agentSession && readAgentRequestIdHeader(request) !== requestId) {
      throw new ApiError(
        "INVALID_REQUEST",
        "Agent export cancellation requestId must match X-AgentCut-Request-Id",
      );
    }
    const jobId = decodeURIComponent(exportCancellation[1]!);
    const store = openHostStore(options.databasePath);
    try {
      const before = store.getJob(jobId);
      if (before.type !== "export.render") {
        throw new ApiError("JOB_NOT_FOUND", `Export job ${jobId} does not exist`);
      }
      const job = store.requestJobCancellation(jobId, {
        requestId,
        requestedBy: agentSession ? `agent:${agentSession.id}` : "local_user",
      });
      if (job.cancelRequested && job.status === "running") {
        exportAbortControllers(options).get(jobId)?.abort();
      }
      sendJson(
        response,
        job.status === "running" && job.cancelRequested ? 202 : 200,
        exportJobResponse(store, jobId),
        options.allowedOrigin,
      );
    } finally {
      store.close();
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/restore") {
    const body = await readJsonBody(request);
    const transactionId = readRequiredString(body, "transactionId");
    const requestId = readRequiredString(body, "requestId");
    const baseRevision = body.baseRevision;
    if (!Number.isSafeInteger(baseRevision) || (baseRevision as number) < 0) {
      throw new ApiError("INVALID_REQUEST", "baseRevision must be a non-negative integer");
    }
    const store = openHostStore(options.databasePath);
    try {
      if (store.getRecord(`tx_restore_${requestId}`)) {
        sendJson(response, 200, reviewResponse(store, options), options.allowedOrigin);
        return;
      }
      assertAlphaTrialEditingActive(options);
      const record = store.getRecord(transactionId);
      if (!record) throw new ApiError("OBJECT_NOT_FOUND", `Transaction ${transactionId} does not exist`);
      store.commit({
        protocolVersion: "0.1.0",
        transactionId: `tx_restore_${requestId}`,
        idempotencyKey: `restore:${requestId}`,
        projectId: record.projectId,
        sequenceId: record.request.sequenceId,
        baseRevision: baseRevision as number,
        actor: { kind: "user", id: "local_user" },
        reason: `Restore ${transactionId} from Transcript review`,
        preconditions: [],
        operations: structuredClone(record.inverseOperations),
      });
      sendJson(response, 200, reviewResponse(store, options), options.allowedOrigin);
    } finally {
      store.close();
    }
    return;
  }
  const candidateAction = /^\/api\/candidates\/([^/]+)\/(accept|keep)$/.exec(url.pathname);
  if (request.method === "POST" && candidateAction) {
    const candidateId = decodeURIComponent(candidateAction[1]!);
    const action = candidateAction[2] as "accept" | "keep";
    const body = await readJsonBody(request);
    const requestId = readRequiredString(body, "requestId");
    const baseRevision = readBaseRevision(body);
    const transactionId = action === "accept"
      ? `tx_review_accept_${requestId}`
      : `tx_review_keep_${requestId}`;
    const store = openHostStore(options.databasePath);
    try {
      if (store.getRecord(transactionId)) {
        sendJson(response, 200, reviewResponse(store, options), options.allowedOrigin);
        return;
      }
      assertAlphaTrialEditingActive(options);
      const document = store.snapshot();
      assertCurrentRevision(document.project.revision, baseRevision);
      const resolveOverlapCandidateIds = assertCandidateOverlapDecisionAnchor(
        document,
        store.listRecords(),
        candidateId,
      );
      const transaction = action === "accept"
        ? compileCandidateAcceptance(document, {
          candidateId,
          requestId,
          actor: { kind: "user", id: "local_user" },
          createdAt: new Date().toISOString(),
          allowHighRisk: body.confirmHighRisk === true,
          resolveOverlapCandidateIds,
        })
        : compileCandidateKeep(document, {
          candidateId,
          requestId,
          actor: { kind: "user", id: "local_user" },
          createdAt: new Date().toISOString(),
          resolveOverlapCandidateIds,
        });
      store.commit(transaction);
      sendJson(response, 200, reviewResponse(store, options), options.allowedOrigin);
    } finally {
      store.close();
    }
    return;
  }
  const unlockAction = /^\/api\/locks\/([^/]+)\/remove$/.exec(url.pathname);
  if (request.method === "POST" && unlockAction) {
    const lockId = decodeURIComponent(unlockAction[1]!);
    const body = await readJsonBody(request);
    const requestId = readRequiredString(body, "requestId");
    const baseRevision = readBaseRevision(body);
    const transactionId = `tx_review_unlock_${requestId}`;
    const store = openHostStore(options.databasePath);
    try {
      if (store.getRecord(transactionId)) {
        sendJson(response, 200, reviewResponse(store, options), options.allowedOrigin);
        return;
      }
      assertAlphaTrialEditingActive(options);
      const document = store.snapshot();
      assertCurrentRevision(document.project.revision, baseRevision);
      store.commit(compileCandidateUnlock(document, {
        lockId,
        requestId,
        actor: { kind: "user", id: "local_user" },
      }));
      sendJson(response, 200, reviewResponse(store, options), options.allowedOrigin);
    } finally {
      store.close();
    }
    return;
  }
  const mediaMatch = /^\/media\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && mediaMatch) {
    serveMedia(request, response, options, decodeURIComponent(mediaMatch[1]!));
    return;
  }
  const artifactMatch = /^\/artifacts\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && artifactMatch) {
    serveArtifact(response, options, decodeURIComponent(artifactMatch[1]!));
    return;
  }
  if (request.method === "GET" && options.studioRoot
    && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/media/")) {
    serveStudio(response, options.studioRoot, url.pathname, options.allowedOrigin);
    return;
  }
  sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Route not found" } }, options.allowedOrigin);
}

type AgentRoute =
  | { kind: "mapped"; canonicalPath: string; capability: AgentCapability }
  | { kind: "project_get"; capability: AgentCapability }
  | { kind: "project_diff"; capability: AgentCapability }
  | { kind: "transcript_get"; capability: AgentCapability }
  | { kind: "timeline_get"; capability: AgentCapability }
  | { kind: "timeline_transaction"; capability: AgentCapability }
  | { kind: "semantic_findings"; capability: AgentCapability }
  | { kind: "approval_request"; capability: AgentCapability }
  | { kind: "approval_get"; capability: AgentCapability; approvalId: string }
  | { kind: "approval_apply"; capability: AgentCapability; approvalId: string };

function resolveAgentRoute(method: string, path: string): AgentRoute | undefined {
  if (method === "GET" && path === "/api/agent/status") {
    return { kind: "mapped", canonicalPath: "/api/review", capability: "project:read" };
  }
  if (method === "GET" && path === "/api/agent/candidates") {
    return { kind: "mapped", canonicalPath: "/api/alpha-audit", capability: "project:read" };
  }
  if (method === "GET" && path === "/api/agent/transcript") {
    return { kind: "transcript_get", capability: "transcript:read" };
  }
  if (method === "GET" && path === "/api/agent/timeline") {
    return { kind: "timeline_get", capability: "project:read" };
  }
  if (method === "POST" && path === "/api/agent/semantic-findings") {
    return { kind: "semantic_findings", capability: "analysis:propose" };
  }
  if (method === "GET" && path === "/api/agent/project") {
    return { kind: "project_get", capability: "project:read" };
  }
  if (method === "GET" && path === "/api/agent/project/diff") {
    return { kind: "project_diff", capability: "project:read" };
  }
  if (method === "POST" && path === "/api/agent/timeline/transactions") {
    return { kind: "timeline_transaction", capability: "timeline:write:low_risk_only" };
  }
  if (method === "POST" && path === "/api/agent/approvals") {
    return { kind: "approval_request", capability: "approval:request" };
  }
  const approval = /^\/api\/agent\/approvals\/([^/]+)$/.exec(path);
  if (method === "GET" && approval) {
    return {
      kind: "approval_get",
      capability: "project:read",
      approvalId: decodeURIComponent(approval[1]!),
    };
  }
  const approvalApply = /^\/api\/agent\/approvals\/([^/]+)\/apply$/.exec(path);
  if (method === "POST" && approvalApply) {
    return {
      kind: "approval_apply",
      capability: "timeline:write:approved",
      approvalId: decodeURIComponent(approvalApply[1]!),
    };
  }
  if (method === "POST" && path === "/api/agent/rough-cut/generate") {
    return {
      kind: "mapped",
      canonicalPath: "/api/rough-cut/generate",
      capability: "timeline:write:low_risk_only",
    };
  }
  if (method === "POST" && path === "/api/agent/analyze-semantic") {
    return { kind: "mapped", canonicalPath: "/api/analyze-semantic", capability: "analysis:local" };
  }
  if (method === "POST" && path === "/api/agent/exports") {
    return { kind: "mapped", canonicalPath: "/api/exports", capability: "export:write" };
  }
  const exportStatus = /^\/api\/agent\/exports\/([^/]+)$/.exec(path);
  if (method === "GET" && exportStatus) {
    return {
      kind: "mapped",
      canonicalPath: `/api/exports/${exportStatus[1]}`,
      capability: "project:read",
    };
  }
  const exportCancellation = /^\/api\/agent\/exports\/([^/]+)\/cancel$/.exec(path);
  if (method === "POST" && exportCancellation) {
    return {
      kind: "mapped",
      canonicalPath: `/api/exports/${exportCancellation[1]}/cancel`,
      capability: "export:write",
    };
  }
  return undefined;
}

function openAgentAccessStore(options: AgentCutServerOptions): ProjectStore {
  requiredAgentBootstrapToken(options);
  return openHostStore(options.databasePath, {
    ...(options.agentAccessClock ? { clock: options.agentAccessClock } : {}),
  });
}

function requiredAgentBootstrapToken(options: AgentCutServerOptions): string {
  if (!options.agentBootstrapToken) {
    throw new ApiError(
      "AGENT_ACCESS_UNAVAILABLE",
      "Agent access is disabled because the daemon has no bootstrap credential",
    );
  }
  return options.agentBootstrapToken;
}

function readBearerToken(
  request: IncomingMessage,
  missingCode = "AGENT_SESSION_NOT_FOUND",
  missingMessage = "A Bearer Agent credential is required",
): string {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length <= 7) {
    throw new ApiError(missingCode, missingMessage);
  }
  const token = header.slice(7);
  if (token !== token.trim()) {
    throw new ApiError(missingCode, "Bearer credential cannot have surrounding whitespace");
  }
  return token;
}

function requiredUiCredential(options: AgentCutServerOptions): UiCredential {
  if (options.uiCredentialPath) {
    const credential = readUiCredentialFile(options.uiCredentialPath, options.projectRoot);
    synchronizeUiCredentialRotation(options, credential);
    return credential;
  }
  if (!options.uiBootstrapToken) {
    throw new ApiError(
      "UI_ACCESS_UNAVAILABLE",
      "Studio write access is unavailable because the daemon has no UI bootstrap credential",
    );
  }
  return {
    schemaVersion: "0.1.0",
    projectRoot: resolve(options.projectRoot),
    bootstrapToken: options.uiBootstrapToken,
    bootstrapFingerprint: createHash("sha256").update(options.uiBootstrapToken).digest("hex"),
    generation: 0,
    createdAt: "1970-01-01T00:00:00.000Z",
  };
}

function issueUiSession(
  projectId: string,
  credential: UiCredential,
  options: AgentCutServerOptions,
): { token: string; expiresAt: string } {
  const now = options.uiSessionClock?.() ?? new Date().toISOString();
  const nowMillis = Date.parse(now);
  if (!Number.isFinite(nowMillis)) throw new ApiError("UI_SESSION_INVALID", "UI session clock is invalid");
  const expiresMillis = nowMillis + UI_SESSION_TTL_SECONDS * 1_000;
  const nonce = options.uiSessionNonce?.() ?? randomBytes(18).toString("base64url");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new ApiError("UI_SESSION_INVALID", "UI session nonce is invalid");
  }
  const signature = createHmac("sha256", credential.bootstrapToken)
    .update(`agentcut-ui:${projectId}:${expiresMillis}:${nonce}`)
    .digest("base64url");
  return {
    token: `uis_${expiresMillis}_${nonce}_${signature}`,
    expiresAt: new Date(expiresMillis).toISOString(),
  };
}

function inspectUiSession(
  request: IncomingMessage,
  options: AgentCutServerOptions,
): { authenticated: boolean; expiresAt?: string; generation?: number; reason?: string } {
  if (!options.uiBootstrapToken && !options.uiCredentialPath) {
    return { authenticated: false, reason: "unavailable" };
  }
  const credential = requiredUiCredential(options);
  const token = readCookie(request, UI_SESSION_COOKIE);
  if (!token) return { authenticated: false, reason: "missing" };
  const match = /^uis_(\d{13})_([A-Za-z0-9_-]{16,128})_([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return { authenticated: false, reason: "invalid" };
  const expiresMillis = Number(match[1]);
  const nonce = match[2]!;
  const receivedSignature = match[3]!;
  const store = openHostStore(options.databasePath);
  let projectId: string;
  try {
    projectId = store.snapshot().project.id;
  } finally {
    store.close();
  }
  const expectedSignature = createHmac("sha256", credential.bootstrapToken)
    .update(`agentcut-ui:${projectId}:${expiresMillis}:${nonce}`)
    .digest("base64url");
  const received = Buffer.from(receivedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { authenticated: false, reason: "invalid" };
  }
  const now = Date.parse(options.uiSessionClock?.() ?? new Date().toISOString());
  if (!Number.isFinite(now) || expiresMillis <= now) {
    return { authenticated: false, reason: "expired" };
  }
  return {
    authenticated: true,
    expiresAt: new Date(expiresMillis).toISOString(),
    generation: credential.generation,
  };
}

function recoverUiCredentialRotation(options: AgentCutServerOptions): void {
  if (!options.uiCredentialPath) return;
  const credential = readUiCredentialFile(options.uiCredentialPath, options.projectRoot);
  synchronizeUiCredentialRotation(options, credential);
}

function synchronizeUiCredentialRotation(
  options: AgentCutServerOptions,
  credential: UiCredential,
): void {
  if (!credential.lastRotation) return;
  const store = openHostStore(options.databasePath, {
    ...(options.uiSessionClock ? { clock: options.uiSessionClock } : {}),
  });
  try {
    store.recordUiCredentialRotation({
      ...credential.lastRotation,
      rotatedBy: "local_user",
      createdAt: credential.lastRotation.rotatedAt,
    });
  } finally {
    store.close();
  }
}

function requireUiSession(request: IncomingMessage, options: AgentCutServerOptions): void {
  const session = inspectUiSession(request, options);
  const method = request.method ?? "POST";
  // Successful video playback can issue many byte-range GETs. Keep write decisions and
  // rejected private reads auditable without turning every media chunk into a SQLite event.
  if (!session.authenticated || (method !== "GET" && method !== "HEAD")) {
    recordUiAccess(
      options,
      method,
      new URL(request.url ?? "/", "http://127.0.0.1").pathname,
      session.authenticated,
      session.authenticated
        ? "allowed"
        : session.reason === "expired" ? "expired"
          : session.reason === "invalid" ? "invalid" : "missing",
    );
  }
  if (!session.authenticated) {
    throw new ApiError(
      session.reason === "expired" ? "UI_SESSION_EXPIRED" : "UI_SESSION_REQUIRED",
      session.reason === "expired"
        ? "Studio session expired; pair this browser again"
        : "A paired Studio browser session is required for private project access",
      { reason: session.reason ?? "invalid" },
    );
  }
}

function requiresUiSession(method: string, path: string): boolean {
  if (method === "POST") return true;
  if (method !== "GET" && method !== "HEAD") return false;
  if (path.startsWith("/media/") || path.startsWith("/artifacts/")) return true;
  return path.startsWith("/api/") && path !== "/api/health";
}

function recordUiAccess(
  options: AgentCutServerOptions,
  method: string,
  path: string,
  allowed: boolean,
  reason: "paired" | "allowed" | "missing" | "invalid" | "expired",
): void {
  const store = openHostStore(options.databasePath, {
    ...(options.uiSessionClock ? { clock: options.uiSessionClock } : {}),
  });
  try {
    store.recordUiAccessEvent({ method, path, allowed, reason });
  } finally {
    store.close();
  }
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function assertSecret(received: string, expected: string, code: string): void {
  const receivedBytes = Buffer.from(received, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (receivedBytes.length !== expectedBytes.length
    || !timingSafeEqual(receivedBytes, expectedBytes)) {
    throw new ApiError(code, "Agent bootstrap credential is invalid");
  }
}

function readAgentRequestIdHeader(request: IncomingMessage): string | undefined {
  const value = request.headers["x-agentcut-request-id"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 128) {
    throw new ApiError(
      "INVALID_REQUEST",
      "X-AgentCut-Request-Id must be one stable ID of at most 128 characters",
    );
  }
  return value;
}

function readAgentCapabilities(body: Record<string, unknown>): AgentCapability[] {
  const value = body.capabilities;
  const allowed = new Set<AgentCapability>([
    "project:read",
    "transcript:read",
    "analysis:local",
    "analysis:propose",
    "timeline:write:low_risk_only",
    "approval:request",
    "timeline:write:approved",
    "export:write",
  ]);
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== "string" || !allowed.has(item as AgentCapability))) {
    throw new ApiError("INVALID_REQUEST", "capabilities must be a non-empty supported capability list");
  }
  const capabilities = value as AgentCapability[];
  if (new Set(capabilities).size !== capabilities.length) {
    throw new ApiError("INVALID_REQUEST", "capabilities cannot contain duplicates");
  }
  return [...capabilities].sort();
}

function readAgentSessionTtl(body: Record<string, unknown>): number {
  const value = body.ttlSeconds ?? 43_200;
  if (!Number.isSafeInteger(value) || (value as number) < 60 || (value as number) > 86_400) {
    throw new ApiError("INVALID_REQUEST", "ttlSeconds must be an integer between 60 and 86400");
  }
  return value as number;
}

function createAgentSessionId(projectId: string, clientId: string, requestId: string): string {
  const digest = createHash("sha256")
    .update(`${projectId}\0${clientId}\0${requestId}`)
    .digest("hex")
    .slice(0, 24);
  return `session_${digest}`;
}

function createAgentAccessToken(bootstrapToken: string, sessionId: string): string {
  return `agc_${createHmac("sha256", bootstrapToken).update(`agentcut:${sessionId}`).digest("base64url")}`;
}

function hashAgentToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function createApprovalId(projectId: string, candidateId: string, requestId: string): string {
  return `approval_${createHash("sha256")
    .update(`${projectId}\0${candidateId}\0${requestId}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function createApprovalToken(bootstrapToken: string, approval: ProjectApproval): string {
  return `aga_${createHmac("sha256", bootstrapToken)
    .update(`approval:${approval.id}:${approval.payloadHash}`)
    .digest("base64url")}`;
}

function requiredApproval(store: ProjectStore, approvalId: string): ProjectApproval {
  const approval = store.getApproval(approvalId);
  if (!approval) throw new ApiError("APPROVAL_NOT_FOUND", `Approval ${approvalId} does not exist`);
  return approval;
}

function approvalResponse(
  approval: ProjectApproval,
  currentRevision: number,
  options: AgentCutServerOptions,
  includeToken = false,
): unknown {
  const now = options.agentAccessClock?.() ?? new Date().toISOString();
  const expired = Date.parse(approval.expiresAt) <= Date.parse(now);
  const stale = approval.baseRevision !== currentRevision;
  const effectiveState = approval.state === "pending" || approval.state === "approved"
    ? expired ? "expired" : stale ? "stale" : approval.state
    : approval.state;
  return {
    id: approval.id,
    kind: approval.kind,
    targetId: approval.targetId,
    baseRevision: approval.baseRevision,
    payloadHash: approval.payloadHash,
    state: effectiveState,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    ...(approval.resolvedAt ? { resolvedAt: approval.resolvedAt } : {}),
    ...(approval.resolvedBy ? { resolvedBy: approval.resolvedBy } : {}),
    ...(approval.transactionId ? { transactionId: approval.transactionId } : {}),
    ...(effectiveState === "approved" && includeToken ? {
      approvalToken: createApprovalToken(requiredAgentBootstrapToken(options), approval),
    } : {}),
  };
}

function applyApprovedCandidate(
  store: ProjectStore,
  approval: ProjectApproval,
  session: AgentSession,
  input: { requestId: string; baseRevision: number; approvalToken: string },
  options: AgentCutServerOptions,
): void {
  const expectedToken = createApprovalToken(requiredAgentBootstrapToken(options), approval);
  assertSecret(input.approvalToken, expectedToken, "APPROVAL_TOKEN_INVALID");
  const transactionId = `tx_review_accept_approval_${approval.id}`;
  if (store.getRecord(transactionId)) {
    store.consumeApproval({
      approvalId: approval.id,
      tokenHash: hashAgentToken(input.approvalToken),
      consumedBySessionId: session.id,
      transactionId,
    });
    return;
  }
  if (approval.state !== "approved") {
    throw new ApiError("APPROVAL_STATE_INVALID", `Approval ${approval.id} is ${approval.state}`);
  }
  const document = store.snapshot();
  assertCurrentRevision(document.project.revision, input.baseRevision);
  if (approval.baseRevision !== input.baseRevision
    || computeCandidateAcceptanceApprovalPayloadHash(document, approval.targetId) !== approval.payloadHash) {
    throw new ApiError("APPROVAL_STALE", "Approval no longer matches the current candidate payload");
  }
  const resolveOverlapCandidateIds = assertCandidateOverlapDecisionAnchor(
    document,
    store.listRecords(),
    approval.targetId,
  );
  const transaction = compileCandidateAcceptance(document, {
    candidateId: approval.targetId,
    requestId: `approval_${approval.id}`,
    actor: { kind: "user", id: approval.resolvedBy ?? "local_user" },
    createdAt: approval.resolvedAt ?? approval.createdAt,
    allowHighRisk: true,
    resolveOverlapCandidateIds,
  });
  transaction.transactionId = transactionId;
  transaction.idempotencyKey = `approval:apply:${approval.id}`;
  transaction.reason = `Apply user-approved candidate ${approval.targetId} via ${session.clientId}`;
  store.commit(transaction);
  options.approvalAfterCommitHook?.();
  store.consumeApproval({
    approvalId: approval.id,
    tokenHash: hashAgentToken(input.approvalToken),
    consumedBySessionId: session.id,
    transactionId,
  });
}

/** 协议 core：工程概要，形状与 reference host 一致；扩展能力列表由宿主声明。 */
function coreProjectSummary(store: ProjectStore, session: AgentSession): unknown {
  const document = store.snapshot();
  const clips = document.sequences.flatMap((sequence) =>
    sequence.tracks.flatMap((track) => track.clips),
  );
  return {
    protocolVersion: "0.1.0",
    project: {
      id: document.project.id,
      name: document.project.name,
      revision: document.project.revision,
      createdAt: document.project.createdAt,
      updatedAt: document.project.updatedAt,
      activeSequenceId: document.project.activeSequenceId,
    },
    facts: {
      sequenceCount: document.sequences.length,
      clipCount: clips.length,
      artifactCount: document.artifacts.length,
      transcriptArtifacts: document.artifacts.filter((artifact) => artifact.kind === "transcript").length,
    },
    capabilities: {
      extensions: ["talking-head-review"],
      writePolicy: {
        timelineTransactions: {
          baseCapability: "timeline:write:low_risk_only",
          approvalCapability: "timeline:write:approved",
          approvalExtension: "talking-head-review",
          notes: "删除用户内容等高风险变更需经 talking-head-review 扩展的 revision/payload 绑定审批流；其余通过校验的事务直接提交。",
        },
      },
    },
    session: {
      id: session.id,
      clientId: session.clientId,
      capabilities: [...session.capabilities],
      expiresAt: session.expiresAt,
    },
  };
}

/** 协议 core：Agent 提交任意 typed operations 组合的原子事务；engine 与宿主策略负责校验。 */
interface AgentTimelineTransactionResult {
  protocolVersion: string;
  revision: number;
  idempotentReplay: boolean;
  record: {
    transactionId: string;
    baseRevision: number;
    committedRevision: number;
    committedAt: string;
    beforeHash: string;
    afterHash: string;
    inverseOperationCount: number;
  };
}

function applyAgentTimelineTransaction(
  store: ProjectStore,
  body: Record<string, unknown>,
  session: AgentSession,
  options: AgentCutServerOptions,
): AgentTimelineTransactionResult {
  const transaction = body as unknown as EditTransaction;
  if (transaction.protocolVersion !== "0.1.0") {
    throw new ApiError("INVALID_REQUEST", "protocolVersion must be 0.1.0");
  }
  const document = store.snapshot();
  if (transaction.projectId !== document.project.id) {
    throw new ApiError("INVALID_REQUEST", "Transaction projectId does not match this project");
  }
  // baseRevision 由 engine 校验：commit 先按 idempotencyKey 幂等重放（允许过期 baseRevision 的精确重试），
  // 非重放的过期 revision 由 engine 抛 REVISION_CONFLICT；宿主级预检会破坏重试语义。
  assertAlphaTrialEditingActive(options);
  let result;
  try {
    result = store.commit({ ...transaction, actor: { kind: "agent", id: session.clientId } });
  } catch (error) {
    if (error instanceof EditError) {
      throw new ApiError(error.code, error.message, error.details ?? {});
    }
    throw error;
  }
  return {
    protocolVersion: "0.1.0",
    revision: result.document.project.revision,
    idempotentReplay: result.idempotentReplay,
    record: {
      transactionId: result.record.transactionId,
      baseRevision: result.record.baseRevision,
      committedRevision: result.record.committedRevision,
      committedAt: result.record.committedAt,
      beforeHash: result.record.beforeHash,
      afterHash: result.record.afterHash,
      inverseOperationCount: result.record.inverseOperations.length,
    },
  };
}

function projectDiffResponse(store: ProjectStore, url: URL): unknown {
  const headRevision = store.snapshot().project.revision;
  const fromRevision = readCanonicalQueryInteger(url, "fromRevision", true);
  if (fromRevision === undefined) throw new Error("Invariant violation: required fromRevision is missing");
  const toRevision = readCanonicalQueryInteger(url, "toRevision", false) ?? headRevision;
  if (fromRevision > toRevision || toRevision > headRevision) {
    throw new ApiError(
      "INVALID_REQUEST",
      "project diff requires 0 <= fromRevision <= toRevision <= headRevision",
      { fromRevision, toRevision, headRevision },
    );
  }
  const records = store.listRecords().filter((record) =>
    record.committedRevision > fromRevision && record.committedRevision <= toRevision,
  );
  return {
    projectId: store.snapshot().project.id,
    fromRevision,
    toRevision,
    headRevision,
    changes: records.map(commandDiffSummary),
  };
}

/** 协议 core §6.4：时间线结构读取，让 Agent 能发现可编辑对象（轨道/片段 ID 与时间位置）。 */
function agentTimelineResponse(store: ProjectStore, url: URL): unknown {
  const document = store.snapshot();
  const sequenceId = url.searchParams.get("sequenceId") ?? document.project.activeSequenceId;
  const sequence = document.sequences.find((candidate) => candidate.id === sequenceId);
  if (!sequence) throw new ApiError("OBJECT_NOT_FOUND", `Sequence ${sequenceId} is missing`);
  const windowFrom = readCanonicalQueryInteger(url, "fromMicros", false);
  const windowTo = readCanonicalQueryInteger(url, "toMicros", false);
  if (windowFrom !== undefined && windowTo !== undefined && windowFrom > windowTo) {
    throw new ApiError("INVALID_REQUEST", "timeline window requires fromMicros <= toMicros",
      { fromMicros: windowFrom, toMicros: windowTo });
  }
  const offset = readBoundedQueryInteger(url, "offset", 0, 10_000_000);
  const limit = readBoundedQueryInteger(url, "limit", 200, 500, 1);
  const clips = sequence.tracks
    .flatMap((track) => track.clips.map((clip) => ({ track, clip })))
    .map(({ track, clip }) => ({
      track,
      clip,
      startMicros: toMicros(clip.timelineRange.start),
      durationMicros: toMicros(clip.timelineRange.duration),
    }))
    .filter(({ startMicros, durationMicros }) =>
      (windowFrom === undefined || startMicros + durationMicros > windowFrom)
      && (windowTo === undefined || startMicros < windowTo)
    )
    .sort((left, right) =>
      left.track.order - right.track.order
      || left.startMicros - right.startMicros
      || left.clip.id.localeCompare(right.clip.id)
    );
  const page = clips.slice(offset, offset + limit);
  return {
    protocolVersion: "0.1.0",
    project: { id: document.project.id, revision: document.project.revision },
    timeline: {
      sequenceId: sequence.id,
      name: sequence.name,
      tracks: [...sequence.tracks]
        .sort((left, right) => left.order - right.order)
        .map((track) => ({
          trackId: track.id,
          kind: track.kind,
          name: track.name,
          order: track.order,
          locked: track.locked,
          enabled: track.enabled,
        })),
      totalClips: clips.length,
      offset,
      limit,
      nextOffset: offset + page.length < clips.length ? offset + page.length : null,
      clips: page.map(({ track, clip, startMicros, durationMicros }) => ({
        clipId: clip.id,
        trackId: track.id,
        kind: clip.kind,
        ...(clip.assetId ? { assetId: clip.assetId } : {}),
        startMicros,
        durationMicros,
        enabled: clip.enabled,
      })),
    },
  };
}

function agentTranscriptResponse(store: ProjectStore, url: URL): unknown {
  const document = store.snapshot();
  const transcript = latestTranscript(document);
  const source = document.assets.find((asset) => asset.id === transcript.assetId);
  if (!source) throw new ApiError("OBJECT_NOT_FOUND", `Asset ${transcript.assetId} is missing`);
  const offset = readBoundedQueryInteger(url, "offset", 0, 10_000_000);
  const limit = readBoundedQueryInteger(url, "limit", 200, 500, 1);
  const words = transcript.words.slice(offset, offset + limit).map((word, index) => ({
    wordId: word.id,
    index: offset + index,
    text: word.text,
    startMicros: toMicros(word.sourceRange.start),
    durationMicros: toMicros(word.sourceRange.duration),
    confidence: word.confidence,
  }));
  const nextOffset = offset + words.length < transcript.words.length
    ? offset + words.length
    : null;
  return {
    protocolVersion: "0.1.0",
    project: { id: document.project.id, revision: document.project.revision },
    transcript: {
      id: transcript.id,
      language: transcript.language,
      sourceSha256: source.contentHash,
      totalWords: transcript.words.length,
      offset,
      limit,
      nextOffset,
      words,
    },
  };
}

async function runAgentSemanticFindings(
  store: ProjectStore,
  options: AgentCutServerOptions,
  session: AgentSession,
  requestId: string,
  baseRevision: number,
  findings: SemanticReviewFinding[],
): Promise<unknown> {
  const transactionId = `tx_agent_semantic_${requestId}`;
  const submissionHash = createHash("sha256")
    .update(JSON.stringify(findings))
    .digest("hex");
  const idempotencyKey = `agent-semantic:${requestId}:${submissionHash}`;
  const existing = store.getRecord(transactionId);
  if (existing) {
    if (existing.request.idempotencyKey !== idempotencyKey) {
      throw new ApiError(
        "IDEMPOTENCY_CONFLICT",
        "Agent semantic findings requestId was reused with another payload",
      );
    }
    return reviewResponse(store, options, session);
  }
  assertAlphaTrialEditingActive(options);
  const document = store.snapshot();
  assertCurrentRevision(document.project.revision, baseRevision);
  const transcript = latestTranscript(document);
  if (transcript.words.length === 0) {
    throw new ApiError("INVALID_REQUEST", "Cannot analyze an empty Transcript");
  }
  const sequence = document.sequences.find((candidate) =>
    candidate.id === document.project.activeSequenceId,
  );
  const clip = sequence?.tracks.flatMap((track) => track.clips).find((candidate) =>
    candidate.enabled && candidate.assetId === transcript.assetId,
  );
  if (!sequence || !clip) {
    throw new ApiError("OBJECT_NOT_FOUND", "Transcript source clip is unavailable");
  }
  const createdAt = new Date().toISOString();
  const generated = await generateSemanticReviewCandidates({
    document,
    transcriptArtifactId: transcript.id,
    sequenceId: sequence.id,
    clipId: clip.id,
    actor: { kind: "agent", id: session.clientId },
    createdAt,
    provider: {
      id: `agent-submit:${session.clientId}:${submissionHash.slice(0, 12)}`,
      analyze: async () => structuredClone(findings),
    },
    maximumWindowWords: Math.max(20, transcript.words.length),
    overlapWords: 0,
  });
  if (generated.report.acceptedCandidates === 0) {
    throw new ApiError(
      "INVALID_REQUEST",
      "No submitted semantic findings passed AgentCut evidence validation",
      { report: generated.report },
    );
  }
  store.commit({
    protocolVersion: "0.1.0",
    transactionId,
    idempotencyKey,
    projectId: document.project.id,
    sequenceId: sequence.id,
    baseRevision,
    actor: { kind: "agent", id: session.clientId },
    reason: `Persist ${generated.report.acceptedCandidates} high-risk semantic suggestions from ${session.clientId}`,
    preconditions: [{ type: "object_exists", objectId: transcript.id }],
    operations: [{ type: "artifact.put", artifact: generated.candidateSet }],
  });
  return reviewResponse(store, options, session);
}

function assertAgentSemanticFindings(findings: SemanticReviewFinding[]): void {
  for (const [index, finding] of findings.entries()) {
    const ids = [
      finding.removeStartWordId,
      finding.removeEndWordId,
      finding.keepStartWordId,
      finding.keepEndWordId,
    ];
    if (ids.some((value) => value !== null
      && (value.length === 0 || value.length > 256 || value !== value.trim()))) {
      throw new ApiError(
        "INVALID_REQUEST",
        `Semantic finding ${index} word IDs must be non-empty, at most 256 characters, and have no surrounding whitespace`,
      );
    }
    if (finding.confidence < 0 || finding.confidence > 1) {
      throw new ApiError(
        "INVALID_REQUEST",
        `Semantic finding ${index} confidence must be from 0 to 1`,
      );
    }
    if (finding.explanationZh.length === 0 || finding.explanationZh.length > 500
      || finding.explanationZh !== finding.explanationZh.trim()) {
      throw new ApiError(
        "INVALID_REQUEST",
        `Semantic finding ${index} explanationZh must be 1 to 500 characters without surrounding whitespace`,
      );
    }
  }
}

function readCanonicalQueryInteger(url: URL, key: string, required: boolean): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) {
    if (required) throw new ApiError("INVALID_REQUEST", `${key} is required`);
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== raw) {
    throw new ApiError("INVALID_REQUEST", `${key} must be a canonical non-negative integer`);
  }
  return value;
}

function readBoundedQueryInteger(
  url: URL,
  key: string,
  fallback: number,
  maximum: number,
  minimum = 0,
): number {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum || String(value) !== raw) {
    throw new ApiError(
      "INVALID_REQUEST",
      `${key} must be a canonical integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function toMicros(time: { value: number; rate: { numerator: number; denominator: number } }): number {
  return Math.round(time.value * time.rate.denominator / time.rate.numerator * 1_000_000);
}

function commandDiffSummary(record: CommandRecord): unknown {
  return {
    transactionId: record.transactionId,
    baseRevision: record.baseRevision,
    committedRevision: record.committedRevision,
    actor: record.request.actor,
    reason: record.request.reason,
    operationTypes: record.request.operations.map((operation) => operation.type),
    objectIds: [...new Set(record.request.operations.flatMap(operationObjectIds))],
    beforeHash: record.beforeHash,
    afterHash: record.afterHash,
    committedAt: record.committedAt,
  };
}

function operationObjectIds(operation: EditOperation): string[] {
  switch (operation.type) {
    case "asset.put": return [operation.asset.id];
    case "asset.remove": return [operation.assetId];
    case "artifact.put": return [operation.artifact.id];
    case "artifact.remove": return [operation.artifactId];
    case "track.add": return [operation.track.id];
    case "track.remove": return [operation.trackId];
    case "clip.insert": return [operation.trackId, operation.clip.id];
    case "clip.remove": return [operation.clipId];
    case "clip.split": return [operation.clipId, operation.rightClipId];
    case "clip.move": return [operation.clipId, ...(operation.toTrackId ? [operation.toTrackId] : [])];
    case "clip.trim":
    case "clip.replace":
    case "clip.update": return [operation.clipId];
    case "range.deleteRipple": return [
      ...operation.trackIds,
      ...(operation.proposalId ? [operation.proposalId] : []),
      ...Object.values(operation.rightClipIds ?? {}),
    ];
    case "lock.add": return [operation.lock.id];
    case "lock.remove": return [operation.lockId];
  }
}

function serveStudio(
  response: ServerResponse,
  studioRoot: string,
  pathname: string,
  allowedOrigin?: string,
): void {
  const root = resolve(studioRoot);
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  let path = resolve(root, requested);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new ApiError("INVALID_REQUEST", "Studio asset path escapes the build root");
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    path = resolve(root, "index.html");
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new ApiError("NOT_FOUND", "Studio build is unavailable; run pnpm build first");
  }
  const size = statSync(path).size;
  response.writeHead(200, {
    ...corsHeaders(allowedOrigin),
    "Content-Type": studioContentType(path),
    "Content-Length": String(size),
    "Cache-Control": path.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  });
  createReadStream(path).pipe(response);
}

function reviewResponse(
  store: ProjectStore,
  options: AgentCutServerOptions,
  agentSession?: AgentSession,
): unknown {
  const document = store.snapshot();
  const transcript = [...document.artifacts].reverse().find((artifact) => artifact.kind === "transcript");
  if (!transcript || transcript.kind !== "transcript") {
    throw new ApiError("OBJECT_NOT_FOUND", "Project has no Transcript");
  }
  const asset = document.assets.find((candidate) => candidate.id === transcript.assetId);
  if (!asset) throw new ApiError("OBJECT_NOT_FOUND", `Asset ${transcript.assetId} is missing`);
  const playbackAsset = findPreviewProxyAsset(document, asset) ?? asset;
  const playbackBinding = readPreviewProxyBinding(playbackAsset);
  const records = store.listRecords();
  const review = buildTranscriptReviewProjection(document, records, transcript.id);
  const hasCandidateAnalysis = document.artifacts.some((artifact) =>
    artifact.kind === "deletionCandidateSet",
  );
  const pendingCandidates = review.candidates.filter((candidate) =>
    candidate.state === "candidate_remove" || candidate.state === "candidate_keep",
  ).length;
  const speechGaps = buildSpeechGapProjection(document, transcript.id);
  const exportJobs = store.listJobs("export.render").map((job) =>
    exportJobResponse(store, job.id) as { status: string; sourceRevision: number },
  );
  const readiness = buildRoughCutReadiness({
    review,
    speechGaps,
    currentRevision: document.project.revision,
    exports: exportJobs,
    records,
  });
  return {
    project: {
      id: document.project.id,
      name: document.project.name,
      revision: document.project.revision,
    },
    transcript: {
      id: transcript.id,
      language: transcript.language,
      providerArtifactId: transcript.providerArtifactId,
    },
    media: {
      assetId: asset.id,
      url: `/media/${encodeURIComponent(playbackAsset.id)}`,
      originalFileName: typeof asset.metadata?.originalFileName === "string"
        ? asset.metadata.originalFileName
        : asset.uri,
      playback: playbackBinding ? {
        assetId: playbackAsset.id,
        kind: "proxy",
        profile: playbackBinding.profile,
      } : {
        assetId: asset.id,
        kind: "source",
      },
    },
    roughCutStatus: !hasCandidateAnalysis
      ? "not_started"
      : pendingCandidates > 0 ? "reviewing" : "rough_cut_ready",
    readiness,
    preview: buildPreviewProjection(document),
    review: {
      ...review,
      speechGaps,
    },
    jobs: store.listJobs(),
    exports: exportJobs,
    approvals: store.listApprovals().map((approval) => approvalResponse(
      approval,
      document.project.revision,
      options,
    )),
    agentSessions: store.listAgentSessions().map((session) => {
      const accessEvents = store.listAgentAccessEvents(session.id);
      return {
        id: session.id,
        clientId: session.clientId,
        capabilities: session.capabilities,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        ...(session.revokedAt ? { revokedAt: session.revokedAt } : {}),
        access: {
          total: accessEvents.length,
          allowed: accessEvents.filter((event) => event.allowed).length,
          denied: accessEvents.filter((event) => !event.allowed).length,
          ...(accessEvents.at(-1)?.createdAt
            ? { lastAccessAt: accessEvents.at(-1)!.createdAt }
            : {}),
        },
      };
    }),
    capabilities: {
      semanticReview: {
        available: Boolean(options.semanticReviewProvider),
        ...(options.semanticReviewProvider
          ? { provider: options.semanticReviewProvider.id }
          : {}),
      },
      ...(agentSession ? {
        agentSession: {
          id: agentSession.id,
          clientId: agentSession.clientId,
          capabilities: agentSession.capabilities,
          expiresAt: agentSession.expiresAt,
        },
      } : {}),
    },
  };
}

function assertCandidateOverlapDecisionAnchor(
  document: AgentCutProjectDocument,
  records: CommandRecord[],
  candidateId: string,
): string[] {
  const transcript = latestTranscript(document);
  const projection = buildTranscriptReviewProjection(document, records, transcript.id);
  const candidate = projection.candidates.find((item) => item.candidateId === candidateId);
  if (!candidate || (candidate.state !== "candidate_remove" && candidate.state !== "candidate_keep")) {
    throw new ApiError("CANDIDATE_UNAVAILABLE", `Candidate ${candidateId} is not pending review`);
  }
  if (candidate.overlapDecisionAnchorId
    && candidate.overlapDecisionAnchorId !== candidate.candidateId) {
    throw new ApiError(
      "CANDIDATE_OVERLAP_ANCHOR_REQUIRED",
      `Candidate ${candidateId} overlaps ${candidate.overlapDecisionAnchorId}; decide the higher-risk anchor first`,
      {
        candidateId,
        overlapDecisionAnchorId: candidate.overlapDecisionAnchorId,
        overlapCandidateIds: candidate.overlapCandidateIds ?? [],
      },
    );
  }
  return candidate.overlapCandidateIds ?? [];
}

function alphaAuditResponse(options: AgentCutServerOptions): AlphaEvidenceResponse {
  return withAlphaAudit(options, (draft, evidence) => evidence.apply(draft));
}

function assertAlphaTrialEditingActive(options: AgentCutServerOptions): void {
  // 未登记的项目直接放行：审计草稿按"全部 clip 为启用媒体"的口播形状渲染，
  // 对含 disabled clip 的普通工程会崩溃——登记与否只需读 extensions，无需跑完整审计。
  const project = openHostStore(options.databasePath);
  try {
    if (!readAlphaTrialEnrollment(project.snapshot())) return;
  } finally {
    project.close();
  }
  const current = alphaAuditResponse(options);
  const trial = current.audit.project.alphaTrial;
  if (!trial || current.timing.state === "running") return;
  throw new ApiError(
    "ALPHA_TRIAL_TIMING_REQUIRED",
    current.timing.state === "not_started"
      ? "正式 Alpha 样本必须先登记手工对照并开始计时，才能修改初剪"
      : current.timing.state === "paused"
        ? "正式 Alpha 样本计时已暂停；请先继续计时，再修改初剪"
        : "正式 Alpha 样本计时已经完成，不能再修改初剪结果",
    { timingState: current.timing.state, enrolledAt: trial.enrolledAt },
  );
}

function withAlphaAudit<T>(
  options: AgentCutServerOptions,
  action: (
    draft: ReturnType<typeof createAlphaAuditDraft>,
    evidence: AlphaEvidenceStore,
  ) => T,
): T {
  const project = openHostStore(options.databasePath);
  let draft: ReturnType<typeof createAlphaAuditDraft>;
  try {
    draft = createAlphaAuditDraft(project.snapshot(), project.listRecords());
  } finally {
    project.close();
  }
  const evidence = AlphaEvidenceStore.open(join(options.projectRoot, "alpha-evidence.sqlite"), {
    ...(options.alphaEvidenceClock ? { clock: options.alphaEvidenceClock } : {}),
  });
  try {
    return action(draft, evidence);
  } finally {
    evidence.close();
  }
}

function assertAlphaAuditBinding(
  draft: ReturnType<typeof createAlphaAuditDraft>,
  baseRevision: number,
  sourceSha256: string,
): void {
  assertCurrentRevision(draft.project.revision, baseRevision);
  if (draft.project.sourceSha256 !== sourceSha256) {
    throw new ApiError(
      "AUDIT_BINDING_CONFLICT",
      "Alpha evidence source hash does not match the current Transcript source",
      { expected: draft.project.sourceSha256, received: sourceSha256 },
    );
  }
}

function assertAlphaTrialReadyToFinish(
  draft: ReturnType<typeof createAlphaAuditDraft>,
): void {
  const acceptedExportReady = draft.export?.quality.passed === true
    && draft.export.sourceRevision + 1 === draft.project.revision;
  if (draft.review.completed && acceptedExportReady) return;
  throw new ApiError(
    "ALPHA_TRIAL_NOT_READY_TO_FINISH",
    !draft.review.completed
      ? `正式 Alpha 样本还有 ${draft.review.pendingCandidateIds.length} 项内容取舍，不能完成计时`
      : "正式 Alpha 样本必须先成功导出并通过当前初剪质量检查，才能完成计时",
    {
      pendingCandidateIds: draft.review.pendingCandidateIds,
      acceptedExportReady,
    },
  );
}

function assertFormalAlphaTimingEnrollment(
  draft: ReturnType<typeof createAlphaAuditDraft>,
): void {
  if (draft.project.alphaTrial?.mode === "formal") return;
  throw new ApiError(
    "ALPHA_TRIAL_ENROLLMENT_REQUIRED",
    "成对提效计时只适用于建项时使用 --alpha-trial 登记的正式样本；请用一条尚未开始审阅的新素材建项",
  );
}

function runRoughCutGeneration(
  options: AgentCutServerOptions,
  requestId: string,
  baseRevision: number,
): unknown {
  const transactionId = `tx_rough_cut_generate_${requestId}`;
  const store = openHostStore(options.databasePath);
  try {
    if (store.getRecord(transactionId)) return reviewResponse(store, options);
    assertAlphaTrialEditingActive(options);
    const document = store.snapshot();
    assertCurrentRevision(document.project.revision, baseRevision);
    const transcript = latestTranscript(document);
    const sequence = document.sequences.find((candidate) =>
      candidate.id === document.project.activeSequenceId,
    );
    const clip = sequence?.tracks.flatMap((track) => track.clips).find((candidate) =>
      candidate.enabled && candidate.assetId === transcript.assetId && candidate.sourceRange,
    );
    if (!sequence || !clip) {
      throw new ApiError("OBJECT_NOT_FOUND", "Transcript source clip is unavailable");
    }
    const asset = document.assets.find((candidate) => candidate.id === transcript.assetId);
    if (!asset) throw new ApiError("OBJECT_NOT_FOUND", `Asset ${transcript.assetId} is missing`);
    const mediaPath = resolveProjectPath(options.projectRoot, asset.uri);
    const silences = (options.silenceDetector ?? detectSilences)(mediaPath, {
      ...(process.env.AGENTCUT_FFMPEG_PATH
        ? { ffmpegPath: process.env.AGENTCUT_FFMPEG_PATH }
        : {}),
      noiseDb: -40,
      minimumDurationSeconds: 0.5,
    });
    const actor = { kind: "workflow" as const, id: "rough_cut_v1" };
    const createdAt = new Date().toISOString();
    const generated = generateTalkingHeadCandidates({
      document,
      transcriptArtifactId: transcript.id,
      sequenceId: sequence.id,
      clipId: clip.id,
      silences,
      actor,
      createdAt,
    });
    try {
      const proposal = createLowRiskProposal(generated.candidateSet, {
        actor,
        createdAt,
        reason: "Apply definite low-risk candidates for the initial rough cut",
      });
      store.commit(compileEditProposalBundle(document, generated.candidateSet, proposal, {
        transactionId,
        idempotencyKey: `rough-cut:generate:${requestId}`,
        actor,
        reason: "Generate the initial rough cut and apply only definite low-risk candidates",
      }));
    } catch (error) {
      if (!isErrorCode(error, "NO_CANDIDATES")) throw error;
      store.commit({
        protocolVersion: "0.1.0",
        transactionId,
        idempotencyKey: `rough-cut:generate:${requestId}`,
        projectId: document.project.id,
        sequenceId: sequence.id,
        baseRevision: document.project.revision,
        actor,
        reason: "Generate rough-cut candidates without automatic deletion",
        preconditions: [{ type: "object_exists", objectId: clip.id }],
        operations: [{ type: "artifact.put", artifact: generated.candidateSet }],
      });
    }
    return reviewResponse(store, options);
  } finally {
    store.close();
  }
}

function latestTranscript(document: AgentCutProjectDocument) {
  const transcript = [...document.artifacts].reverse().find((artifact) =>
    artifact.kind === "transcript",
  );
  if (!transcript || transcript.kind !== "transcript") {
    throw new ApiError("OBJECT_NOT_FOUND", "Project has no Transcript");
  }
  return transcript;
}

function currentSpeechGap(document: AgentCutProjectDocument, gapId: string) {
  const transcript = latestTranscript(document);
  const gap = buildSpeechGapProjection(document, transcript.id)
    .find((item) => item.gapId === gapId);
  if (!gap) {
    throw new ApiError(
      "CANDIDATE_UNAVAILABLE",
      `Speech gap ${gapId} is no longer present in the current Timeline`,
    );
  }
  return gap;
}

function buildPreviewProjection(document: AgentCutProjectDocument): {
  revision: number;
  durationSeconds: number;
  segments: Array<{
    clipId: string;
    assetId: string;
    timelineStartSeconds: number;
    sourceStartSeconds: number;
    durationSeconds: number;
  }>;
} {
  const transcript = latestTranscript(document);
  const evaluated = evaluateTimelineSegments(
    document,
    document.project.activeSequenceId!,
    transcript.id,
  );
  const segments = evaluated.segments.map((segment) => ({
    clipId: segment.clipId,
    assetId: segment.assetId,
    timelineStartSeconds: segment.timelineStartMicros / 1_000_000,
    sourceStartSeconds: segment.sourceStartMicros / 1_000_000,
    durationSeconds: segment.durationMicros / 1_000_000,
  }));
  return {
    revision: document.project.revision,
    durationSeconds: evaluated.durationMicros / 1_000_000,
    segments,
  };
}

function assertRoughCutReady(store: ProjectStore, document: AgentCutProjectDocument): void {
  const transcript = latestTranscript(document);
  const review = buildTranscriptReviewProjection(document, store.listRecords(), transcript.id);
  const hasCandidateAnalysis = document.artifacts.some((artifact) =>
    artifact.kind === "deletionCandidateSet",
  );
  const pending = review.candidates.filter((candidate) =>
    candidate.state === "candidate_remove" || candidate.state === "candidate_keep",
  ).length;
  if (!hasCandidateAnalysis || pending > 0) {
    throw new ApiError(
      "ROUGH_CUT_INCOMPLETE",
      hasCandidateAnalysis
        ? `还有 ${pending} 个候选尚未决定，不能导出`
        : "请先生成初剪，再导出",
      { pendingCandidates: pending },
    );
  }
}

function scheduleExportJob(options: AgentCutServerOptions, jobId: string): void {
  queueMicrotask(() => {
    const store = openHostStore(options.databasePath);
    const job = store.getJob(jobId);
    const input = exportJobInput(job.input);
    const canvas = exportSequenceCanvas(store, input.sequenceId);
    const controller = new AbortController();
    exportAbortControllers(options).set(jobId, controller);
    void (options.renderJobRunner ?? runPersistedRenderJob)({
      store,
      jobId,
      projectRoot: options.projectRoot,
      sequenceId: input.sequenceId,
      transcriptArtifactId: input.transcriptArtifactId,
      actor: { kind: "workflow", id: "rough_cut_export_v1" },
      transactionId: `tx_export_${jobId}`,
      idempotencyKey: `export:${jobId}`,
      existingOutputPolicy: "recover_or_preserve",
      output: exportPresetOutput(input.preset, canvas),
      signal: controller.signal,
      ...(process.env.AGENTCUT_FFMPEG_PATH
        ? { ffmpegPath: process.env.AGENTCUT_FFMPEG_PATH }
        : {}),
      ...(process.env.AGENTCUT_FFPROBE_PATH
        ? { ffprobePath: process.env.AGENTCUT_FFPROBE_PATH }
        : {}),
    }).catch(() => undefined).finally(() => {
      const latest = store.getJob(jobId);
      if (latest.status === "running" && latest.cancelRequested) {
        store.markJobCancelled(jobId);
      }
      exportAbortControllers(options).delete(jobId);
      store.close();
    });
  });
}

export function recoverExportJobs(options: AgentCutServerOptions): void {
  const store = openHostStore(options.databasePath);
  const pendingJobIds: string[] = [];
  const interruptedJobIds: string[] = [];
  try {
    const document = store.snapshot();
    for (const job of store.listJobs("export.render")) {
      if (job.status === "pending") {
        pendingJobIds.push(job.id);
        continue;
      }
      if (job.status !== "running") continue;
      if (job.cancelRequested) {
        interruptedJobIds.push(job.id);
        continue;
      }
      const input = exportJobInput(job.input);
      const report = document.artifacts.find((artifact) =>
        artifact.kind === "renderReport" && artifact.projectRevision === input.sourceRevision,
      );
      if (report?.kind === "renderReport") {
        const output = document.assets.find((asset) => asset.id === report.outputAssetId);
        const caption = document.artifacts.find((artifact) => artifact.id === report.captionArtifactId);
        if (output && caption?.kind === "captionDocument") {
          store.succeedJob(job.id, [output.id, caption.id, report.id]);
          continue;
        }
      }
      interruptedJobIds.push(job.id);
    }
  } finally {
    store.close();
  }
  for (const jobId of pendingJobIds) scheduleExportJob(options, jobId);
  for (const jobId of interruptedJobIds) scheduleExportRecovery(options, jobId);
}

function scheduleExportRecovery(options: AgentCutServerOptions, jobId: string): void {
  queueMicrotask(() => {
    const store = openHostStore(options.databasePath);
    const job = store.getJob(jobId);
    const input = exportJobInput(job.input);
    const controller = new AbortController();
    exportAbortControllers(options).set(jobId, controller);
    void (options.renderRecoveryRunner ?? recoverRunningPersistedRenderJob)({
      store,
      jobId,
      projectRoot: options.projectRoot,
      sequenceId: input.sequenceId,
      transcriptArtifactId: input.transcriptArtifactId,
      actor: { kind: "workflow", id: "rough_cut_export_v1" },
      transactionId: `tx_export_${jobId}`,
      idempotencyKey: `export:${jobId}`,
      output: exportPresetOutput(input.preset, exportSequenceCanvas(store, input.sequenceId)),
      signal: controller.signal,
      ...(process.env.AGENTCUT_FFPROBE_PATH
        ? { ffprobePath: process.env.AGENTCUT_FFPROBE_PATH }
        : {}),
    }).then((recovered) => {
      const latest = store.getJob(jobId);
      if (recovered || latest.status !== "running") return;
      if (latest.cancelRequested) {
        store.markJobCancelled(jobId);
        return;
      }
      markExportOutcomeUnknown(store, jobId, input.sourceRevision);
    }).catch((error: unknown) => {
      const latest = store.getJob(jobId);
      if (latest.status === "running" && latest.cancelRequested) {
        store.markJobCancelled(jobId);
      } else if (latest.status === "running") {
        if (error instanceof RenderError) {
          store.failJob(jobId, {
            code: error.code,
            message: error.message,
            details: error.details,
          }, { retryable: false });
        } else {
          markExportOutcomeUnknown(store, jobId, input.sourceRevision);
        }
      }
    }).finally(() => {
      exportAbortControllers(options).delete(jobId);
      store.close();
    });
  });
}

function markExportOutcomeUnknown(store: ProjectStore, jobId: string, sourceRevision: number): void {
  store.failJob(jobId, {
    code: "EXPORT_INTERRUPTED",
    message: "Daemon restarted before export registration; no verified matching MP4/SRT pair was adopted and existing files were preserved",
    details: { sourceRevision },
  }, { retryable: false, outcomeUnknown: true });
}

function exportAbortControllers(options: AgentCutServerOptions): Map<string, AbortController> {
  let controllers = EXPORT_ABORT_CONTROLLERS.get(options);
  if (!controllers) {
    controllers = new Map();
    EXPORT_ABORT_CONTROLLERS.set(options, controllers);
  }
  return controllers;
}

function exportJobInput(value: unknown): {
  sourceRevision: number;
  sequenceId: string;
  transcriptArtifactId: string;
  preset: ExportPreset;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Export job input is corrupt");
  }
  const input = value as Record<string, unknown>;
  if (!Number.isSafeInteger(input.sourceRevision)
    || typeof input.sequenceId !== "string"
    || typeof input.transcriptArtifactId !== "string") {
    throw new ApiError("INVALID_REQUEST", "Export job input is corrupt");
  }
  // 2026-08-11 之前的导出 job 没有 preset 字段；按既有行为视为 source（序列画布 + contain）。
  const preset = input.preset === undefined ? "source" : parseExportPreset(input.preset);
  return {
    sourceRevision: input.sourceRevision as number,
    sequenceId: input.sequenceId,
    transcriptArtifactId: input.transcriptArtifactId,
    preset,
  };
}

type ExportPreset = "source" | "vertical-9-16";

const EXPORT_PRESETS: Record<ExportPreset, {
  output: (canvas: { width: number; height: number }) => { width: number; height: number; fitMode?: "contain" | "cover" };
}> = {
  source: { output: (canvas) => ({ width: canvas.width, height: canvas.height, fitMode: "contain" }) },
  "vertical-9-16": { output: () => ({ width: 1080, height: 1920, fitMode: "cover" }) },
};

function parseExportPreset(value: unknown): ExportPreset {
  if (value === "source" || value === "vertical-9-16") return value;
  throw new ApiError("INVALID_REQUEST", `Unsupported export preset: ${String(value)}`);
}

function readExportPreset(body: Record<string, unknown>): ExportPreset {
  if (body.preset === undefined) return "source";
  return parseExportPreset(body.preset);
}

function exportPresetOutput(
  preset: ExportPreset,
  canvas: { width: number; height: number },
): { width: number; height: number; fitMode?: "contain" | "cover" } {
  return EXPORT_PRESETS[preset].output(canvas);
}

function exportSequenceCanvas(
  store: ProjectStore,
  sequenceId: string,
): { width: number; height: number } {
  const sequence = store.snapshot().sequences.find((candidate) => candidate.id === sequenceId);
  if (!sequence) {
    throw new ApiError("INVALID_REQUEST", `Export sequence ${sequenceId} does not exist`);
  }
  return { width: sequence.canvas.width, height: sequence.canvas.height };
}

function exportJobResponse(store: ProjectStore, jobId: string): unknown {
  const job = store.getJob(jobId);
  const input = exportJobInput(job.input);
  const document = store.snapshot();
  const outputAsset = job.outputArtifactIds
    .map((id) => document.assets.find((asset) => asset.id === id))
    .find(Boolean);
  const caption = job.outputArtifactIds
    .map((id) => document.artifacts.find((artifact) => artifact.id === id))
    .find((artifact) => artifact?.kind === "captionDocument");
  const report = job.outputArtifactIds
    .map((id) => document.artifacts.find((artifact) => artifact.id === id))
    .find((artifact) => artifact?.kind === "renderReport");
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    sourceRevision: input.sourceRevision,
    preset: input.preset,
    cancelRequested: job.cancelRequested,
    canCancel: job.status === "pending" || job.status === "running",
    ...(job.error ? { error: job.error } : {}),
    ...(outputAsset ? { mediaUrl: `/media/${encodeURIComponent(outputAsset.id)}` } : {}),
    ...(caption ? {
      captionArtifactId: caption.id,
      captionUrl: `/artifacts/${encodeURIComponent(caption.id)}`,
    } : {}),
    ...(report && report.kind === "renderReport" ? { quality: report.quality } : {}),
  };
}

function resolveProjectPath(projectRoot: string, uri: string): string {
  const root = resolve(projectRoot);
  const path = resolve(root, uri);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new ApiError("INVALID_REQUEST", "Asset URI escapes the project root");
  }
  return path;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function runSemanticReview(
  options: AgentCutServerOptions,
  requestId: string,
  baseRevision: number,
): Promise<unknown> {
  const provider = options.semanticReviewProvider!;
  const transactionId = `tx_semantic_review_${requestId}`;
  const jobId = `job_semantic_review_${requestId}`;
  const actor = { kind: "workflow" as const, id: "semantic_review_v1" };
  const initialStore = openHostStore(options.databasePath);
  let context: {
    document: ReturnType<ProjectStore["snapshot"]>;
    transcriptArtifactId: string;
    sequenceId: string;
    clipId: string;
  };
  try {
    if (initialStore.getRecord(transactionId)) return reviewResponse(initialStore, options);
    assertAlphaTrialEditingActive(options);
    const document = initialStore.snapshot();
    assertCurrentRevision(document.project.revision, baseRevision);
    const transcript = [...document.artifacts].reverse().find((artifact) =>
      artifact.kind === "transcript",
    );
    if (!transcript || transcript.kind !== "transcript") {
      throw new ApiError("OBJECT_NOT_FOUND", "Project has no Transcript");
    }
    const sequence = document.sequences.find((candidate) =>
      candidate.id === document.project.activeSequenceId,
    );
    const clip = sequence?.tracks.flatMap((track) => track.clips).find((candidate) =>
      candidate.enabled && candidate.assetId === transcript.assetId,
    );
    if (!sequence || !clip) {
      throw new ApiError("OBJECT_NOT_FOUND", "Transcript source clip is unavailable");
    }
    initialStore.createJob({
      id: jobId,
      type: "transcript.semantic-review",
      payload: {
        transcriptArtifactId: transcript.id,
        projectRevision: document.project.revision,
        provider: provider.id,
      },
    });
    initialStore.startJob(jobId);
    initialStore.updateJobProgress(jobId, 0.05, { stage: "local-model-review" });
    context = {
      document,
      transcriptArtifactId: transcript.id,
      sequenceId: sequence.id,
      clipId: clip.id,
    };
  } finally {
    initialStore.close();
  }

  try {
    const generated = await generateSemanticReviewCandidates({
      ...context,
      actor,
      createdAt: new Date().toISOString(),
      provider,
    });
    const store = openHostStore(options.databasePath);
    try {
      if (store.getRecord(transactionId)) return reviewResponse(store, options);
      const latest = store.snapshot();
      assertCurrentRevision(latest.project.revision, baseRevision);
      store.updateJobProgress(jobId, 0.9, {
        stage: "persisting-candidates",
        report: generated.report,
      });
      store.commit({
        protocolVersion: "0.1.0",
        transactionId,
        idempotencyKey: `semantic-review:${requestId}`,
        projectId: latest.project.id,
        sequenceId: context.sequenceId,
        baseRevision,
        actor,
        reason: "Persist high-risk local-AI semantic talking-head candidates",
        preconditions: [{ type: "object_exists", objectId: context.clipId }],
        operations: [{ type: "artifact.put", artifact: generated.candidateSet }],
      });
      store.succeedJob(jobId, [generated.candidateSet.id]);
      return reviewResponse(store, options);
    } finally {
      store.close();
    }
  } catch (error) {
    markSemanticJobFailed(options.databasePath, jobId, error);
    throw error;
  }
}

function markSemanticJobFailed(databasePath: string, jobId: string, error: unknown): void {
  const store = openHostStore(databasePath);
  try {
    const job = store.getJob(jobId);
    if (job.status !== "running") return;
    const code = typeof error === "object" && error && "code" in error
      ? String(error.code)
      : "SEMANTIC_REVIEW_FAILED";
    store.failJob(jobId, {
      code,
      message: error instanceof Error ? error.message : String(error),
    }, { retryable: code === "PROVIDER_UNAVAILABLE" });
  } finally {
    store.close();
  }
}

function serveMedia(
  request: IncomingMessage,
  response: ServerResponse,
  options: AgentCutServerOptions,
  assetId: string,
): void {
  const store = openHostStore(options.databasePath);
  let uri: string;
  try {
    const asset = store.snapshot().assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw new ApiError("OBJECT_NOT_FOUND", `Asset ${assetId} does not exist`);
    uri = asset.uri;
  } finally {
    store.close();
  }
  const root = resolve(options.projectRoot);
  const path = resolve(root, uri);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new ApiError("INVALID_REQUEST", "Asset URI escapes the project root");
  }
  const size = statSync(path).size;
  const range = parseRange(request.headers.range, size);
  const headers = {
    ...corsHeaders(options.allowedOrigin),
    "Accept-Ranges": "bytes",
    "Content-Type": mediaContentType(path),
    "Content-Length": String(range.end - range.start + 1),
    ...(range.partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}),
  };
  response.writeHead(range.partial ? 206 : 200, headers);
  createReadStream(path, { start: range.start, end: range.end }).pipe(response);
}

function serveArtifact(
  response: ServerResponse,
  options: AgentCutServerOptions,
  artifactId: string,
): void {
  const store = openHostStore(options.databasePath);
  let uri: string;
  try {
    const artifact = store.snapshot().artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact || artifact.kind !== "captionDocument") {
      throw new ApiError("OBJECT_NOT_FOUND", `Downloadable artifact ${artifactId} does not exist`);
    }
    uri = artifact.uri;
  } finally {
    store.close();
  }
  const path = resolveProjectPath(options.projectRoot, uri);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new ApiError("OBJECT_NOT_FOUND", `Artifact bytes for ${artifactId} are missing`);
  }
  response.writeHead(200, {
    ...corsHeaders(options.allowedOrigin),
    "Content-Type": "application/x-subrip; charset=utf-8",
    "Content-Length": String(statSync(path).size),
    "Content-Disposition": `attachment; filename="${artifactId}.srt"`,
  });
  createReadStream(path).pipe(response);
}

function parseRange(value: string | undefined, size: number): {
  start: number;
  end: number;
  partial: boolean;
} {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) throw new ApiError("INVALID_RANGE", "Only one explicit byte range is supported");
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || end >= size) {
    throw new ApiError("INVALID_RANGE", "Requested media range is outside the asset");
  }
  return { start, end, partial: true };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new ApiError("INVALID_REQUEST", "Request body is too large");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object");
  }
}

function readRequiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError("INVALID_REQUEST", `${key} is required`);
  }
  return value;
}

function readStableString(body: Record<string, unknown>, key: string, maxLength: number): string {
  const value = readRequiredString(body, key);
  if (value !== value.trim() || value.length > maxLength) {
    throw new ApiError(
      "INVALID_REQUEST",
      `${key} must be at most ${maxLength} characters without surrounding whitespace`,
    );
  }
  return value;
}

function readOptionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ApiError("INVALID_REQUEST", `${key} must be a string`);
  return value;
}

function readRequiredBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") throw new ApiError("INVALID_REQUEST", `${key} must be a boolean`);
  return value;
}

function readPositiveNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ApiError("INVALID_REQUEST", `${key} must be a positive number`);
  }
  return value;
}

function readTimingBaselineMethod(body: Record<string, unknown>): AlphaTimingBaselineMethod {
  const value = body.method;
  if (value !== "stopwatch" && value !== "screen_recording" && value !== "editor_log") {
    throw new ApiError("INVALID_REQUEST", "method must identify an auditable manual timing source");
  }
  return value;
}

function readTimingPauseReason(body: Record<string, unknown>): AlphaTimingPauseReason {
  const value = body.reason;
  if (value !== "user" && value !== "idle" && value !== "page_hidden") {
    throw new ApiError("INVALID_REQUEST", "reason must be user, idle or page_hidden");
  }
  return value;
}

function readCandidateLabel(body: Record<string, unknown>): "true_positive" | "false_positive" {
  const value = body.label;
  if (value !== "true_positive" && value !== "false_positive") {
    throw new ApiError("INVALID_REQUEST", "label must be true_positive or false_positive");
  }
  return value;
}

function readBoundaryIssueCodes(body: Record<string, unknown>): AlphaBoundaryIssueCode[] {
  const value = body.issueCodes;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ApiError("INVALID_REQUEST", "issueCodes must be a string array");
  }
  return value as AlphaBoundaryIssueCode[];
}

function readStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ApiError("INVALID_REQUEST", `${key} must be a non-empty string array`);
  }
  return value as string[];
}

function readBaseRevision(body: Record<string, unknown>): number {
  const value = body.baseRevision;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ApiError("INVALID_REQUEST", "baseRevision must be a non-negative integer");
  }
  return value as number;
}

function assertCurrentRevision(current: number, received: number): void {
  if (current !== received) {
    throw new ApiError(
      "REVISION_CONFLICT",
      `Project advanced from revision ${received} to ${current}`,
      { expected: current, received },
    );
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  allowedOrigin?: string,
  extraHeaders: Record<string, string> = {},
): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    ...corsHeaders(allowedOrigin),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    ...extraHeaders,
  });
  response.end(json);
}

function corsHeaders(allowedOrigin?: string): Record<string, string> {
  return {
    ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin } : {}),
    ...(allowedOrigin ? { "Access-Control-Allow-Credentials": "true" } : {}),
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-AgentCut-Request-Id",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

function mediaContentType(path: string): string {
  if (path.endsWith(".mov")) return "video/quicktime";
  if (path.endsWith(".mp4") || path.endsWith(".m4v")) return "video/mp4";
  if (path.endsWith(".webm")) return "video/webm";
  return "application/octet-stream";
}

function studioContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

export function statusForCode(code: string): number {
  if (code === "AGENT_SESSION_NOT_FOUND" || code === "AGENT_SESSION_INVALID"
    || code === "AGENT_BOOTSTRAP_DENIED") return 401;
  if (code === "UI_BOOTSTRAP_DENIED" || code === "UI_SESSION_REQUIRED"
    || code === "UI_SESSION_EXPIRED" || code === "UI_SESSION_INVALID") return 401;
  if (code === "CAPABILITY_DENIED") return 403;
  if (code === "APPROVAL_TOKEN_INVALID") return 401;
  if (code === "AGENT_ACCESS_UNAVAILABLE") return 503;
  if (code === "UI_ACCESS_UNAVAILABLE") return 503;
  if (code === "UI_CREDENTIAL_ROTATION_UNAVAILABLE") return 503;
  if (code === "OBJECT_NOT_FOUND" || code === "NOT_FOUND" || code === "TARGET_NOT_FOUND") return 404;
  if (code === "AGENT_SESSION_TARGET_NOT_FOUND") return 404;
  if (code === "APPROVAL_NOT_FOUND") return 404;
  if (code === "REVISION_CONFLICT" || code === "IDEMPOTENCY_CONFLICT"
    || code === "AUDIT_BINDING_CONFLICT" || code === "INVALID_TIMING_STATE"
    || code === "INVALID_JOB_STATE"
    || code === "APPROVAL_INVALID" || code === "APPROVAL_STATE_INVALID"
    || code === "APPROVAL_STALE" || code === "UI_CREDENTIAL_ROTATION_STALE") return 409;
  if (code === "ALPHA_TRIAL_TIMING_REQUIRED") return 423;
  if (code === "ALPHA_TRIAL_NOT_READY_TO_FINISH") return 409;
  if (code === "CANDIDATE_ALREADY_REVIEWED" || code === "HIGH_RISK_CONFIRMATION_REQUIRED") return 409;
  if (code === "CANDIDATE_UNAVAILABLE") return 404;
  if (code === "SEMANTIC_REVIEW_UNAVAILABLE" || code === "PROVIDER_UNAVAILABLE") return 503;
  if (code === "INVALID_PROVIDER_RESPONSE") return 502;
  if (code === "INVALID_RANGE") return 416;
  if (code === "INVALID_DOCUMENT" || code === "RENDER_CAPABILITY_MISSING") return 422;
  if (code === "INVALID_SELECTION") return 400;
  if (code === "LOCKED" || code === "PRECONDITION_FAILED") return 409;
  if (code === "SEQUENCE_NOT_FOUND") return 404;
  if (code === "PROJECT_MISMATCH") return 400;
  if (code === "DUPLICATE_ID" || code === "INVALID_OPERATION") return 422;
  if (code === "INVALID_REQUEST" || code === "INVALID_LABEL"
    || code === "UI_CREDENTIAL_ROTATION_INVALID") return 400;
  return 500;
}

class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}
