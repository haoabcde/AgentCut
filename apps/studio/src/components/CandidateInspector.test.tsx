import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CandidateSelection } from "../api.js";
import { CandidateInspector } from "./CandidateInspector.js";

const highRiskCandidate: CandidateSelection = {
  candidateId: "candidate_high_risk",
  targetKind: "words",
  sourceRange: {
    start: { value: 2_000, rate: { numerator: 1_000, denominator: 1 } },
    duration: { value: 800, rate: { numerator: 1_000, denominator: 1 } },
  },
  wordIds: ["word_001", "word_002"],
  state: "candidate_remove",
  reasonCodes: ["restatement"],
  risk: "high",
  confidence: 0.73,
  explanationZh: "删除可能改变语义，需要人工试听。",
};

describe("CandidateInspector", () => {
  it("keeps a high-risk delete disabled until the explicit checkbox is selected", () => {
    const unconfirmed = renderInspector(false);
    expect(unconfirmed).toContain("我已试听上下文，仍确认删除这条高风险候选");
    expect(unconfirmed).toContain("循环试听");
    expect(unconfirmed).toContain("试听删除效果");
    expect(buttonTag(unconfirmed, "试听删除效果")).toContain('aria-keyshortcuts="B"');
    expect(unconfirmed).toContain("删除效果");
    expect(buttonTag(unconfirmed, "删除此段")).toContain("disabled");
    expect(buttonTag(unconfirmed, "删除此段")).toContain('aria-keyshortcuts="D"');

    const confirmed = renderInspector(true);
    expect(buttonTag(confirmed, "删除此段")).not.toContain("disabled");
    expect(confirmed).toContain('checked=""');
  });

  it("shows an Agent approval request without exposing a token or direct delete bypass", () => {
    const markup = renderInspector(false, {
      id: "approval_high",
      kind: "content_high_risk_delete",
      targetId: highRiskCandidate.candidateId,
      baseRevision: 7,
      payloadHash: `sha256:${"a".repeat(64)}`,
      state: "pending",
      createdAt: "2026-08-10T01:00:00.000Z",
      expiresAt: "2026-08-10T02:00:00.000Z",
    });
    expect(markup).toContain("Agent 请求删除这条高风险候选");
    expect(markup).toContain("批准本次删除");
    expect(markup).toContain("拒绝");
    expect(markup).not.toContain("approvalToken");
    expect(buttonTag(markup, "删除此段")).toContain("disabled");
    expect(markup).not.toContain("我已试听上下文，仍确认删除这条高风险候选");
  });

  it("presents a correction as a distinct Chinese review reason", () => {
    const correction: CandidateSelection = {
      ...highRiskCandidate,
      reasonCodes: ["correction"],
      evidenceStatus: "structured",
      evidence: [{
        role: "retained_comparison",
        sourceRange: {
          start: { value: 4_000, rate: { numerator: 1_000, denominator: 1 } },
          duration: { value: 1_200, rate: { numerator: 1_000, denominator: 1 } },
        },
        wordIds: ["word_003", "word_004"],
        text: "采用第二种方案",
      }],
    };
    const markup = renderInspector(false, undefined, correction);
    expect(markup).toContain("说错纠正");
    expect(markup).toContain("对照保留段");
    expect(markup).toContain("采用第二种方案");
    expect(markup).toContain("试听保留段");
    expect(markup).not.toContain("correction");
  });

  it("warns when a historical semantic candidate has no structured comparison", () => {
    const historical: CandidateSelection = {
      ...highRiskCandidate,
      evidenceStatus: "legacy_missing",
    };
    const markup = renderInspector(false, undefined, historical);
    expect(markup).toContain("历史候选没有保存结构化对照范围");
    expect(markup).toContain("重新运行 AI 检查");
  });

  it("blocks a lower-priority overlap while explaining the reversible anchor group", () => {
    const blocked: CandidateSelection = {
      ...highRiskCandidate,
      candidateId: "candidate_overlap_gap",
      risk: "medium",
      overlapCandidateIds: [highRiskCandidate.candidateId],
      overlapDecisionAnchorId: highRiskCandidate.candidateId,
    };
    const blockedMarkup = renderInspector(false, undefined, blocked);
    expect(blockedMarkup).toContain("必须先决定冲突主项");
    expect(buttonTag(blockedMarkup, "删除此段")).toContain("disabled");
    expect(buttonTag(blockedMarkup, "保留并锁定")).toContain("disabled");

    const anchorMarkup = renderInspector(false, undefined, {
      ...highRiskCandidate,
      overlapCandidateIds: [blocked.candidateId],
      overlapDecisionAnchorId: highRiskCandidate.candidateId,
    });
    expect(anchorMarkup).toContain("重叠候选组的主项");
    expect(anchorMarkup).toContain("同一可恢复事务");
  });
});

function renderInspector(
  highRiskConfirmed: boolean,
  approval?: import("../api.js").ApprovalSummary,
  candidate: CandidateSelection = highRiskCandidate,
): string {
  const noop = vi.fn();
  return renderToStaticMarkup(
    <CandidateInspector
      candidate={candidate}
      {...(approval ? { approval } : {})}
      position={{ current: 2, total: 5, scope: "pending" }}
      busy={false}
      isLooping={false}
      cutPreviewActive={false}
      cutPreviewBusy={false}
      highRiskConfirmed={highRiskConfirmed}
      onHighRiskConfirmedChange={noop}
      onPrevious={noop}
      onNext={noop}
      onPreview={noop}
      onPreviewEvidence={noop}
      onStopPreview={noop}
      onPreviewCut={noop}
      onStopCutPreview={noop}
      onAccept={async () => undefined}
      onKeep={async () => undefined}
      onReconsider={async () => undefined}
      onRestore={async () => undefined}
      onResolveApproval={async () => undefined}
    />,
  );
}

function buttonTag(markup: string, label: string): string {
  const labelIndex = markup.indexOf(`>${label}</button>`);
  const start = markup.lastIndexOf("<button", labelIndex);
  return markup.slice(start, labelIndex + 1);
}
