import { ArrowCounterClockwise } from "@phosphor-icons/react/ArrowCounterClockwise";
import { CaretLeft } from "@phosphor-icons/react/CaretLeft";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import { LockKey } from "@phosphor-icons/react/LockKey";
import { Play } from "@phosphor-icons/react/Play";
import { Stop } from "@phosphor-icons/react/Stop";
import { Trash } from "@phosphor-icons/react/Trash";
import { durationLabel, type ApprovalSummary, type CandidateSelection } from "../api.js";
import { reviewReasonList } from "../review-reasons.js";

interface CandidateInspectorProps {
  candidate: CandidateSelection | undefined;
  approval?: ApprovalSummary;
  position: { current: number; total: number; scope: "pending" | "all" };
  busy: boolean;
  editingLocked?: boolean;
  isLooping: boolean;
  cutPreviewActive: boolean;
  cutPreviewBusy: boolean;
  highRiskConfirmed: boolean;
  sharedCommitCount?: number;
  onHighRiskConfirmedChange: (confirmed: boolean) => void;
  onPrevious: () => void;
  onNext: () => void;
  onPreview: (candidate: CandidateSelection) => void;
  onPreviewEvidence: (evidence: NonNullable<CandidateSelection["evidence"]>[number]) => void;
  onStopPreview: () => void;
  onPreviewCut: (candidate: CandidateSelection) => void;
  onStopCutPreview: () => void;
  onAccept: (candidate: CandidateSelection) => Promise<void>;
  onKeep: (candidate: CandidateSelection) => Promise<void>;
  onReconsider: (candidate: CandidateSelection) => Promise<void>;
  onRestore: (transactionId: string) => Promise<void>;
  onResolveApproval: (approval: ApprovalSummary, decision: "approve" | "deny") => Promise<void>;
}

export function CandidateInspector({
  candidate,
  approval,
  position,
  busy,
  editingLocked = false,
  isLooping,
  cutPreviewActive,
  cutPreviewBusy,
  highRiskConfirmed,
  sharedCommitCount = 1,
  onHighRiskConfirmedChange,
  onPrevious,
  onNext,
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
}: CandidateInspectorProps) {
  if (!candidate) {
    return <aside className="candidate-inspector empty">选择黄色候选，试听上下文后再决定。</aside>;
  }
  const committed = candidate.state === "committed_deleted";
  const kept = candidate.state === "reviewed_keep";
  const pending = candidate.state === "candidate_remove" || candidate.state === "candidate_keep";
  const blockedByOverlap = pending && candidate.overlapDecisionAnchorId !== undefined
    && candidate.overlapDecisionAnchorId !== candidate.candidateId;
  const overlapAnchor = pending && candidate.overlapDecisionAnchorId === candidate.candidateId
    && (candidate.overlapCandidateIds?.length ?? 0) > 0;
  const awaitingApprovalDecision = approval?.state === "pending";
  const waitingForAgent = approval?.state === "approved";
  const needsHighRiskConfirmation = pending && !blockedByOverlap
    && candidate.risk === "high" && !approval;
  return (
    <aside className={`candidate-inspector ${committed ? "committed" : kept ? "kept" : "candidate"}`}>
      <div className="candidate-copy">
        <span className="candidate-kicker">
          {`${position.scope === "pending" ? "待审" : "候选"} ${position.current} / ${position.total} · `}
          {reviewReasonList(candidate.reasonCodes)}
          {` · ${durationLabel(candidate.sourceRange)} · ${candidate.risk.toUpperCase()}`}
        </span>
        <strong>{candidate.explanationZh}</strong>
        {candidate.evidence?.map((evidence, index) => (
          <section className="candidate-evidence" key={`${evidence.role}-${index}`}>
            <span>对照保留段</span>
            <q>{evidence.text}</q>
            <button
              type="button"
              disabled={busy}
              onClick={() => onPreviewEvidence(evidence)}
            ><Play size={13} weight="fill" />试听保留段</button>
          </section>
        ))}
        {candidate.evidenceStatus === "legacy_missing" ? (
          <p className="candidate-evidence-warning" role="status">
            历史候选没有保存结构化对照范围。请以原片上下文和删除效果试听为准；需要机器可核验的保留段时，重新运行 AI 检查。
          </p>
        ) : null}
        {blockedByOverlap ? (
          <p className="candidate-evidence-warning" role="status">
            此范围与更高风险的候选重叠。必须先决定冲突主项；当前候选不能单独提交，避免重复剪切或截断词首。
          </p>
        ) : overlapAnchor ? (
          <p className="candidate-evidence-warning" role="status">
            本项是重叠候选组的主项。决定后，其余 {candidate.overlapCandidateIds!.length} 项会在同一可恢复事务中锁定为替代项，不会再次剪切。
          </p>
        ) : candidate.overlapResolvedByCandidateId ? (
          <p className="candidate-evidence-warning" role="status">
            此候选与已决定的主项重叠，已作为替代项锁定，没有单独执行第二次剪切。
          </p>
        ) : null}
        <small>判断置信度 {Math.round(candidate.confidence * 100)}%</small>
        {needsHighRiskConfirmation ? (
          <label className="high-risk-confirmation">
            <input
              type="checkbox"
              checked={highRiskConfirmed}
              disabled={busy}
              onChange={(event) => onHighRiskConfirmedChange(event.currentTarget.checked)}
            />
            我已试听上下文，仍确认删除这条高风险候选
          </label>
        ) : null}
        {approval ? (
          <section className={`agent-approval state-${approval.state}`} aria-label="Agent 高风险操作批准">
            <strong>Agent 请求删除这条高风险候选</strong>
            <small>绑定 REV {approval.baseRevision} 与当前候选内容；工程变化后批准自动失效。</small>
            {awaitingApprovalDecision ? (
              <div className="agent-approval-actions">
                <button
                  type="button"
                  className="danger"
                  disabled={busy || editingLocked}
                  onClick={() => void onResolveApproval(approval, "approve")}
                >批准本次删除</button>
                <button
                  type="button"
                  disabled={busy || editingLocked}
                  onClick={() => void onResolveApproval(approval, "deny")}
                >拒绝</button>
              </div>
            ) : (
              <span>{approvalStateLabel(approval.state)}</span>
            )}
          </section>
        ) : null}
      </div>
      <div className="candidate-actions">
        <div className="candidate-nav" aria-label="候选导航">
          <button type="button" disabled={busy || position.total < 2} onClick={onPrevious} aria-label="上一个候选" aria-keyshortcuts="ArrowLeft">
            <CaretLeft size={15} />
          </button>
          <button type="button" disabled={busy || position.total < 2} onClick={onNext} aria-label="下一个候选" aria-keyshortcuts="ArrowRight">
            <CaretRight size={15} />
          </button>
        </div>
        <button type="button" disabled={busy} aria-keyshortcuts="Space" onClick={() => {
          if (isLooping) onStopPreview();
          else onPreview(candidate);
        }}>
          {isLooping ? <Stop size={14} weight="fill" /> : <Play size={14} weight="fill" />}
          {isLooping ? "停止试听" : committed ? "试听原片" : "循环试听"}
        </button>
        {pending ? (
          <button type="button" disabled={busy || cutPreviewBusy} aria-keyshortcuts="B" onClick={() => {
            if (cutPreviewActive) onStopCutPreview();
            else onPreviewCut(candidate);
          }}>
            {cutPreviewActive ? <Stop size={14} weight="fill" /> : <Play size={14} weight="fill" />}
            {cutPreviewBusy ? "正在准备…" : cutPreviewActive ? "停止删除效果" : "试听删除效果"}
          </button>
        ) : null}
        {committed && candidate.transactionId ? (
          <button type="button" className="danger" disabled={busy || editingLocked} aria-keyshortcuts="U" onClick={() => void onRestore(candidate.transactionId!)}>
            <ArrowCounterClockwise size={14} />
            {sharedCommitCount > 1
              ? `恢复本次提交（批量 ${sharedCommitCount} 项，将一并恢复）`
              : "恢复本次提交"}
          </button>
        ) : kept && candidate.lockId ? (
          candidate.overlapResolvedByCandidateId ? (
            <span className="candidate-resolution-note">如需改判，请恢复或重审对应冲突主项。</span>
          ) : (
            <button type="button" disabled={busy || editingLocked} aria-keyshortcuts="U" onClick={() => void onReconsider(candidate)}>
              <ArrowCounterClockwise size={14} />重新审阅
            </button>
          )
        ) : (
          <>
            <button
              type="button"
              className="primary"
              disabled={busy || editingLocked || awaitingApprovalDecision || waitingForAgent
                || blockedByOverlap
                || (needsHighRiskConfirmation && !highRiskConfirmed)}
              title={blockedByOverlap
                ? "请先决定重叠候选组的主项"
                : needsHighRiskConfirmation && !highRiskConfirmed
                ? "请先试听并勾选高风险确认"
                : undefined}
              aria-keyshortcuts="D"
              onClick={() => void onAccept(candidate)}
            >
              <Trash size={14} />删除此段
            </button>
            <button type="button" disabled={busy || editingLocked || blockedByOverlap} aria-keyshortcuts="K" onClick={() => void onKeep(candidate)}>
              <LockKey size={14} />保留并锁定
            </button>
          </>
        )}
      </div>
      <div className="shortcut-help" aria-label="审阅快捷键">
        <span><kbd>←</kbd><kbd>→</kbd>切换</span>
        <span><kbd>Space</kbd>试听</span>
        <span><kbd>B</kbd>删除效果</span>
        <span><kbd>D</kbd>删除</span>
        <span><kbd>K</kbd>保留</span>
        <span><kbd>U</kbd>恢复 / 重审</span>
      </div>
    </aside>
  );
}

function approvalStateLabel(state: ApprovalSummary["state"]): string {
  if (state === "approved") return "用户已批准，等待 Agent 应用；Agent 不能修改批准范围。";
  if (state === "denied") return "用户已拒绝这次 Agent 请求。";
  if (state === "consumed") return "批准已应用并消费，不能再次使用。";
  if (state === "expired") return "请求已过期，需要 Agent 基于最新工程重新申请。";
  if (state === "stale") return "工程 revision 已变化，请 Agent 读取 diff 后重新申请。";
  return "等待用户决定。";
}
