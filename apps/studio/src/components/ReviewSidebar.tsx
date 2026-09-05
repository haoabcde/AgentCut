import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CheckSquare } from "@phosphor-icons/react/CheckSquare";
import { LockKey } from "@phosphor-icons/react/LockKey";
import { Sparkle } from "@phosphor-icons/react/Sparkle";
import { Trash } from "@phosphor-icons/react/Trash";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import type {
  AlphaAuditBoundary,
  AlphaAuditResponse,
  AlphaBoundaryIssueCode,
  AlphaTimingBaselineMethod,
  AgentSessionSummary,
  CandidateSelection,
  ReviewResponse,
} from "../api.js";
import { durationLabel } from "../api.js";
import {
  isBatchAcceptableCandidate,
  reviewDecisionCounts,
} from "../review-navigation.js";
import { reviewReasonList } from "../review-reasons.js";
import { CandidateInspector } from "./CandidateInspector.js";
import { AlphaAuditPanel } from "./AlphaAuditPanel.js";
import { AgentSessionPanel } from "./AgentSessionPanel.js";
import { ReadinessChecklist } from "./ReadinessChecklist.js";
import { RoughCutControls } from "./RoughCutControls.js";
import { UiSecurityPanel } from "./UiSecurityPanel.js";

interface ReviewSidebarProps {
  data: ReviewResponse;
  alphaEvidence: AlphaAuditResponse | undefined;
  alphaEvidenceError: string | undefined;
  auditBusy: boolean;
  candidate: CandidateSelection | undefined;
  candidatePosition: { current: number; total: number; scope: "pending" | "all" };
  actionError: string | undefined;
  notice: string | undefined;
  busy: boolean;
  editingLocked: boolean;
  isLooping: boolean;
  cutPreviewActive: boolean;
  cutPreviewBusy: boolean;
  highRiskConfirmed: boolean;
  keepRemainingConfirmation: boolean;
  onAnalyzeSemantic: () => Promise<void>;
  onGenerateRoughCut: () => Promise<void>;
  onUndoLatest: () => void;
  onRequestKeepRemaining: () => void;
  onCancelKeepRemaining: () => void;
  onKeepRemaining: () => Promise<void>;
  onSelectCandidate: (candidate: CandidateSelection) => void;
  onHighRiskConfirmedChange: (confirmed: boolean) => void;
  onPreviousCandidate: () => void;
  onNextCandidate: () => void;
  onPreview: (candidate: CandidateSelection) => void;
  onPreviewEvidence: (evidence: NonNullable<CandidateSelection["evidence"]>[number]) => void;
  onStopPreview: () => void;
  onPreviewCut: (candidate: CandidateSelection) => void;
  onStopCutPreview: () => void;
  onAccept: (candidate: CandidateSelection) => Promise<void>;
  onKeep: (candidate: CandidateSelection) => Promise<void>;
  onReconsider: (candidate: CandidateSelection) => Promise<void>;
  onRestore: (transactionId: string) => Promise<void>;
  onResolveApproval: (
    approval: NonNullable<ReviewResponse["approvals"]>[number],
    decision: "approve" | "deny",
  ) => Promise<void>;
  batchReviewMode: boolean;
  batchSelectedIds: string[];
  batchAcceptableCount: number;
  onToggleBatchMode: () => void;
  onToggleBatchCandidate: (candidateId: string) => void;
  onSelectAllBatchCandidates: () => void;
  onClearBatchSelection: () => void;
  onBatchAccept: () => void;
  onRevokeAgentSession: (session: AgentSessionSummary) => Promise<void>;
  uiCredentialGeneration: number;
  onRotateUiBootstrap: () => Promise<void>;
  onLabelAuditCandidate: (candidateId: string, label: "true_positive" | "false_positive") => void;
  onPreviewAuditBoundary: (boundary: AlphaAuditBoundary) => void;
  onLabelAuditBoundary: (
    boundaryId: string,
    usable: boolean,
    issueCodes: AlphaBoundaryIssueCode[],
  ) => void;
  onBeginTiming: (
    seconds: number,
    method: AlphaTimingBaselineMethod,
    operatorId: string,
    evidenceSha256: string,
  ) => void;
  onStartTiming: () => void;
  onPauseTiming: () => void;
  onFinishTiming: () => void;
}

export function ReviewSidebar({
  data,
  alphaEvidence,
  alphaEvidenceError,
  auditBusy,
  candidate,
  candidatePosition,
  actionError,
  notice,
  busy,
  editingLocked,
  isLooping,
  cutPreviewActive,
  cutPreviewBusy,
  highRiskConfirmed,
  keepRemainingConfirmation,
  onAnalyzeSemantic,
  onGenerateRoughCut,
  onUndoLatest,
  onRequestKeepRemaining,
  onCancelKeepRemaining,
  onKeepRemaining,
  onSelectCandidate,
  onHighRiskConfirmedChange,
  onPreviousCandidate,
  onNextCandidate,
  onPreview,
  onPreviewEvidence,
  onStopPreview,
  onPreviewCut,
  onStopCutPreview,
  onAccept,
  onKeep,
  onReconsider,
  onRestore,
  onResolveApproval,
  batchReviewMode,
  batchSelectedIds,
  batchAcceptableCount,
  onToggleBatchMode,
  onToggleBatchCandidate,
  onSelectAllBatchCandidates,
  onClearBatchSelection,
  onBatchAccept,
  onRevokeAgentSession,
  uiCredentialGeneration,
  onRotateUiBootstrap,
  onLabelAuditCandidate,
  onPreviewAuditBoundary,
  onLabelAuditBoundary,
  onBeginTiming,
  onStartTiming,
  onPauseTiming,
  onFinishTiming,
}: ReviewSidebarProps) {
  const counts = reviewDecisionCounts(data.review.candidates);
  const semanticAvailable = data.capabilities?.semanticReview.available === true;
  const selectedApproval = data.approvals?.filter((approval) =>
    approval.targetId === candidate?.candidateId,
  ).at(-1);
  return (
    <aside id="workspace-assistant" className="review-sidebar" aria-label="Agent 编辑助手">
      <div className="panel-titlebar">
        <div>
          <span className="panel-kicker">AGENT</span>
          <h2>编辑助手</h2>
        </div>
        <span className="queue-count">{counts.pending} 待处理</span>
      </div>

      <div className="review-intro">
        <div className="active-tool-label"><Sparkle size={14} weight="fill" />当前工具 · 口播清理</div>
        <p>先自动移除明确的低风险停顿，再逐项试听重复、改口和说错内容。</p>
        <RoughCutControls
          status={data.roughCutStatus ?? "not_started"}
          projectRevision={data.project.revision}
          pendingCount={counts.pending}
          busy={busy || editingLocked}
          onGenerate={onGenerateRoughCut}
          keepRemainingConfirmation={keepRemainingConfirmation}
          onRequestKeepRemaining={onRequestKeepRemaining}
          onCancelKeepRemaining={onCancelKeepRemaining}
          onKeepRemaining={onKeepRemaining}
        />
        <button
          className="semantic-action"
          type="button"
          disabled={busy || editingLocked || !semanticAvailable}
          title={semanticAvailable
            ? `使用 ${data.capabilities?.semanticReview.provider ?? "本地模型"} 检查口播语义`
            : "请先启动 LM Studio 本地模型服务，再重新启动 AgentCut Studio"}
          onClick={() => void onAnalyzeSemantic()}
        >
          <Sparkle size={17} weight="fill" />
          {busy ? "正在检查整条口播…" : "AI 检查重复与改口"}
        </button>
      </div>

      {data.readiness ? (
        <ReadinessChecklist
          readiness={data.readiness}
          busy={busy || editingLocked}
          onUndoLatest={onUndoLatest}
        />
      ) : null}

      <div className="review-stats" aria-label="审阅统计">
        <span><WarningCircle size={15} />待审 {counts.pending}</span>
        <span><LockKey size={15} />保留 {counts.kept}</span>
        <span><Trash size={15} />删除 {counts.committed}</span>
      </div>

      {actionError ? <p className="inline-error" role="alert">操作失败：{actionError}</p> : null}
      {notice ? <p className="inline-notice" role="status"><CheckCircle size={16} />{notice}</p> : null}

      <CandidateInspector
        candidate={candidate}
        {...(selectedApproval ? { approval: selectedApproval } : {})}
        position={candidatePosition}
        busy={busy}
        editingLocked={editingLocked}
        isLooping={isLooping}
        cutPreviewActive={cutPreviewActive}
        cutPreviewBusy={cutPreviewBusy}
        highRiskConfirmed={highRiskConfirmed}
        sharedCommitCount={candidate?.transactionId
          ? data.review.candidates.filter((item) =>
            item.transactionId === candidate.transactionId).length
          : 1}
        onHighRiskConfirmedChange={onHighRiskConfirmedChange}
        onPrevious={onPreviousCandidate}
        onNext={onNextCandidate}
        onPreview={onPreview}
        onPreviewEvidence={onPreviewEvidence}
        onStopPreview={onStopPreview}
        onPreviewCut={onPreviewCut}
        onStopCutPreview={onStopCutPreview}
        onAccept={onAccept}
        onKeep={onKeep}
        onReconsider={onReconsider}
        onRestore={onRestore}
        onResolveApproval={onResolveApproval}
      />

      <div className="queue-heading">
        <span>候选队列</span>
        <small>{batchReviewMode ? "勾选批量项" : "点击定位文稿"}</small>
        <button
          type="button"
          className={`batch-mode-toggle ${batchReviewMode ? "active" : ""}`}
          aria-pressed={batchReviewMode}
          disabled={busy || editingLocked || batchAcceptableCount === 0}
          title={batchAcceptableCount === 0
            ? "没有可批量审阅的候选（低/中风险、待审且不是重叠组非主项）"
            : batchReviewMode ? "退出批量审阅" : "批量审阅低/中风险候选"}
          onClick={onToggleBatchMode}
        >
          <CheckSquare size={14} weight={batchReviewMode ? "fill" : "regular"} />
          {batchReviewMode ? "退出批量审阅" : "批量审阅"}
        </button>
      </div>
      {batchReviewMode ? (
        <div className="batch-review-bar" role="group" aria-label="批量审阅操作">
          <p>
            可批量：低/中风险待审候选；高风险候选仍需逐项试听并确认。已勾选项按
            <strong>一次可恢复事务</strong>提交，恢复时整批还原。
          </p>
          <div className="batch-review-actions">
            <button
              type="button"
              disabled={busy || editingLocked || batchAcceptableCount === 0
                || batchSelectedIds.length === batchAcceptableCount}
              onClick={onSelectAllBatchCandidates}
            >全选可批量项（{batchAcceptableCount}）</button>
            <button
              type="button"
              disabled={busy || editingLocked || batchSelectedIds.length === 0}
              onClick={onClearBatchSelection}
            >清空选择</button>
            <button
              type="button"
              className="primary"
              disabled={busy || editingLocked || batchSelectedIds.length === 0}
              title="按一次可恢复事务删除全部勾选候选"
              onClick={onBatchAccept}
            >
              <Trash size={14} />删除选中 {batchSelectedIds.length} 项
            </button>
          </div>
        </div>
      ) : null}
      <div className="candidate-queue">
        {data.review.candidates.length === 0 ? (
          <p className="queue-empty">尚无候选。运行 AI 检查，或等待机械检测结果。</p>
        ) : data.review.candidates.map((item, index) => {
          const selected = item.candidateId === candidate?.candidateId;
          const batchAcceptable = isBatchAcceptableCandidate(item);
          const batchDisabledReason = batchDisabledReasonFor(item);
          const body = (
            <>
              <span className={`queue-index risk-${item.risk}`}>{String(index + 1).padStart(2, "0")}</span>
              <span className="queue-copy">
                <strong>{reviewReasonList(item.reasonCodes)}</strong>
                <small>{durationLabel(item.sourceRange)} · {Math.round(item.confidence * 100)}%</small>
              </span>
              <span className="queue-state">
                {item.state === "committed_deleted"
                  ? "已删除"
                  : item.overlapResolvedByCandidateId
                    ? "随主项解决"
                    : item.state === "reviewed_keep"
                      ? "已保留"
                      : item.overlapDecisionAnchorId === item.candidateId
                        ? "冲突主项"
                        : item.overlapDecisionAnchorId
                          ? "等待主项"
                          : item.risk.toUpperCase()}
              </span>
            </>
          );
          if (batchReviewMode) {
            return (
              <div
                key={item.candidateId}
                className={`queue-item batch ${selected ? "selected" : ""} ${item.state} ${batchAcceptable ? "batch-acceptable" : ""}`}
              >
                <input
                  type="checkbox"
                  className="batch-checkbox"
                  checked={batchSelectedIds.includes(item.candidateId)}
                  disabled={busy || editingLocked || !batchAcceptable}
                  aria-label={`批量选择候选 ${index + 1}：${reviewReasonList(item.reasonCodes)}`}
                  title={batchDisabledReason}
                  onChange={() => onToggleBatchCandidate(item.candidateId)}
                />
                <button
                  type="button"
                  className="queue-item-body"
                  aria-pressed={selected}
                  onClick={() => onSelectCandidate(item)}
                >
                  {body}
                </button>
              </div>
            );
          }
          return (
            <button
              key={item.candidateId}
              type="button"
              className={`queue-item ${selected ? "selected" : ""} ${item.state}`}
              aria-pressed={selected}
              onClick={() => onSelectCandidate(item)}
            >
              {body}
            </button>
          );
        })}
      </div>

      <div className="assistant-secondary" aria-label="工程治理与验收">
        <AgentSessionPanel
          sessions={data.agentSessions ?? []}
          busy={busy}
          onRevoke={onRevokeAgentSession}
        />

        <UiSecurityPanel
          generation={uiCredentialGeneration}
          busy={busy}
          onRotate={onRotateUiBootstrap}
        />

        {alphaEvidence ? (
          <AlphaAuditPanel
            evidence={alphaEvidence}
            selectedCandidateId={candidate?.candidateId}
            busy={auditBusy}
            onLabelCandidate={onLabelAuditCandidate}
            onPreviewBoundary={onPreviewAuditBoundary}
            onLabelBoundary={onLabelAuditBoundary}
            onBeginTiming={onBeginTiming}
            onStartTiming={onStartTiming}
            onPauseTiming={onPauseTiming}
            onFinishTiming={onFinishTiming}
          />
        ) : alphaEvidenceError ? (
          <p className="alpha-audit-unavailable">Alpha 验收暂不可用：{alphaEvidenceError}</p>
        ) : null}
      </div>
    </aside>
  );
}

function batchDisabledReasonFor(candidate: CandidateSelection): string {
  if (candidate.overlapResolvedByCandidateId) return "已随冲突主项解决";
  if (candidate.state === "reviewed_keep") return "已保留并锁定";
  if (candidate.state === "committed_deleted") return "已删除";
  if (candidate.overlapDecisionAnchorId
    && candidate.overlapDecisionAnchorId !== candidate.candidateId) {
    return "与更高风险主项重叠，需随主项一起决定";
  }
  if (candidate.risk === "high") {
    return "高风险候选必须逐项试听并确认，不能进入批量删除";
  }
  return "";
}
