import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CandidateSelection, ReviewResponse } from "../api.js";
import { ReviewSidebar } from "./ReviewSidebar.js";

function candidate(
  candidateId: string,
  overrides: Partial<CandidateSelection> = {},
): CandidateSelection {
  return {
    candidateId,
    targetKind: "gap",
    sourceRange: {
      start: { value: 0, rate: { numerator: 1_000, denominator: 1 } },
      duration: { value: 500, rate: { numerator: 1_000, denominator: 1 } },
    },
    wordIds: [],
    state: "candidate_remove",
    reasonCodes: ["silence"],
    risk: "low",
    confidence: 0.9,
    explanationZh: "测试候选",
    ...overrides,
  };
}

function response(candidates: CandidateSelection[]): ReviewResponse {
  return {
    project: { id: "project_test", name: "批量审阅测试", revision: 3 },
    roughCutStatus: "reviewing",
    transcript: { id: "transcript_main", language: "zh-CN" },
    media: { assetId: "asset_camera_a", url: "/media/asset_camera_a", originalFileName: "source.mov" },
    review: {
      transcriptId: "transcript_main",
      projectRevision: 3,
      candidates,
      tokens: [],
    gaps: [],
    speechGaps: [],
      summary: {
        normalTokens: 0,
        candidateTokens: 0,
        deletedTokens: 0,
        reviewedKeepTokens: 0,
        candidateGaps: 0,
        committedGaps: 0,
        reviewedKeepGaps: 0,
      },
    },
    jobs: [],
  };
}

function renderSidebar(
  data: ReviewResponse,
  overrides: Partial<Parameters<typeof ReviewSidebar>[0]> = {},
): string {
  return renderToStaticMarkup(
    <ReviewSidebar
      data={data}
      alphaEvidence={undefined}
      alphaEvidenceError={undefined}
      auditBusy={false}
      candidate={data.review.candidates.find((item) => item.state === "candidate_remove")}
      candidatePosition={{ current: 1, total: 1, scope: "pending" }}
      actionError={undefined}
      notice={undefined}
      busy={false}
      editingLocked={false}
      isLooping={false}
      cutPreviewActive={false}
      cutPreviewBusy={false}
      highRiskConfirmed={false}
      keepRemainingConfirmation={false}
      onAnalyzeSemantic={vi.fn()}
      onGenerateRoughCut={vi.fn()}
      onUndoLatest={vi.fn()}
      onRequestKeepRemaining={vi.fn()}
      onCancelKeepRemaining={vi.fn()}
      onKeepRemaining={vi.fn()}
      onSelectCandidate={vi.fn()}
      onHighRiskConfirmedChange={vi.fn()}
      onPreviousCandidate={vi.fn()}
      onNextCandidate={vi.fn()}
      onPreview={vi.fn()}
      onPreviewEvidence={vi.fn()}
      onStopPreview={vi.fn()}
      onPreviewCut={vi.fn()}
      onStopCutPreview={vi.fn()}
      onAccept={vi.fn()}
      onKeep={vi.fn()}
      onReconsider={vi.fn()}
      onRestore={vi.fn()}
      onResolveApproval={vi.fn()}
      onRevokeAgentSession={vi.fn()}
      uiCredentialGeneration={1}
      onRotateUiBootstrap={vi.fn()}
      onLabelAuditCandidate={vi.fn()}
      onPreviewAuditBoundary={vi.fn()}
      onLabelAuditBoundary={vi.fn()}
      onBeginTiming={vi.fn()}
      onStartTiming={vi.fn()}
      onPauseTiming={vi.fn()}
      onFinishTiming={vi.fn()}
      batchReviewMode={false}
      batchSelectedIds={[]}
      batchAcceptableCount={2}
      onToggleBatchMode={vi.fn()}
      onToggleBatchCandidate={vi.fn()}
      onSelectAllBatchCandidates={vi.fn()}
      onClearBatchSelection={vi.fn()}
      onBatchAccept={vi.fn()}
      {...overrides}
    />,
  );
}

describe("ReviewSidebar batch review", () => {
  const candidates = [
    candidate("candidate_low"),
    candidate("candidate_medium", { risk: "medium" }),
    candidate("candidate_high", { risk: "high" }),
    candidate("candidate_member", {
      overlapDecisionAnchorId: "candidate_high",
      overlapCandidateIds: ["candidate_high"],
    }),
    candidate("candidate_deleted", {
      state: "committed_deleted",
      transactionId: "tx_review_accept_batch_shared",
    }),
    candidate("candidate_deleted_high", {
      state: "committed_deleted",
      risk: "high",
      transactionId: "tx_review_accept_high_single",
    }),
    candidate("candidate_resolved_member", {
      state: "reviewed_keep",
      overlapResolvedByCandidateId: "candidate_high",
      lockId: "lock_resolved_member",
    }),
  ];

  it("offers batch review when at least one candidate is batchable", () => {
    const html = renderSidebar(response(candidates), {
      batchAcceptableCount: 2,
    });
    expect(html).toContain("批量审阅");
    expect(html).not.toContain("退出批量审阅");
    expect(html).not.toContain("删除选中 0 项");
  });

  it("shows per-candidate checkboxes only for low/medium actionable pending items", () => {
    const html = renderSidebar(response(candidates), {
      batchReviewMode: true,
      batchSelectedIds: ["candidate_low"],
      batchAcceptableCount: 2,
    });
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('aria-label="批量选择候选 1：停顿');
    expect(html).toContain("高风险候选必须逐项试听并确认，不能进入批量删除");
    expect(html).toContain("与更高风险主项重叠，需随主项一起决定");
    expect(html).toContain("已随冲突主项解决");
    expect(html).toContain("删除选中 1 项");
    expect(html).toContain("全选可批量项（2）");
    expect(html).toContain("一次可恢复事务");
  });

  it("explains already-processed state before risk for disabled checkboxes", () => {
    const html = renderSidebar(response(candidates), {
      batchReviewMode: true,
      batchSelectedIds: [],
      batchAcceptableCount: 2,
    });
    // 已删除候选（含一条 high 风险）：禁用原因都应是状态而不是风险
    expect(html.split('title="已删除"').length - 1).toBe(2);
    // 待审的高风险候选仍显示风险原因
    expect(html.split("高风险候选必须逐项试听并确认，不能进入批量删除").length - 1).toBe(1);
  });

  it("disables the batch submit without a selection and explains the restore semantics", () => {
    const html = renderSidebar(response(candidates), {
      batchReviewMode: true,
      batchSelectedIds: [],
      batchAcceptableCount: 2,
    });
    expect(html).toContain("删除选中 0 项");
    expect(html).toContain("恢复时整批还原");
  });

  it("shows the whole shared transaction size on committed candidates", () => {
    const sharedBatch = [
      candidate("candidate_deleted_a", {
        state: "committed_deleted",
        transactionId: "tx_review_accept_batch_shared",
      }),
      candidate("candidate_deleted_b", {
        state: "committed_deleted",
        transactionId: "tx_review_accept_batch_shared",
      }),
      candidate("candidate_deleted_single", {
        state: "committed_deleted",
        transactionId: "tx_review_accept_single",
      }),
    ];
    const html = renderSidebar(response(sharedBatch), {
      candidate: sharedBatch[0],
      candidatePosition: { current: 1, total: 3, scope: "all" },
    });
    expect(html).toContain("恢复本次提交（批量 2 项，将一并恢复）");
    expect(html).toContain("恢复本次提交");
  });
});
