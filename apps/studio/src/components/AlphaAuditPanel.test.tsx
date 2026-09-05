import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AlphaAuditResponse } from "../api.js";
import { AlphaAuditPanel, shouldOpenAlphaAuditPanel } from "./AlphaAuditPanel.js";

describe("AlphaAuditPanel", () => {
  it("offers candidate correctness and cut-boundary listening labels without JSON editing", () => {
    const html = renderToStaticMarkup(
      <AlphaAuditPanel
        evidence={evidence()}
        selectedCandidateId="candidate_001"
        busy={false}
        onLabelCandidate={vi.fn()}
        onPreviewBoundary={vi.fn()}
        onLabelBoundary={vi.fn()}
        {...timingHandlers()}
      />,
    );

    expect(html).toContain("Alpha 验收");
    expect(html).toContain("候选 0/1");
    expect(html).toContain("边界 0/1");
    expect(html).toContain("前文[停顿]后文");
    expect(html).toContain("判断正确");
    expect(html).toContain("误报");
    expect(html).toContain("试听剪后边界");
    expect(html).toContain("可用");
    expect(html).toContain("吞字");
    expect(html).toContain("截断音节");
    expect(html).toContain("音画不同步");
    expect(html).toContain("节奏不自然");
  });

  it("shows persisted labels for the exact audit revision", () => {
    const persisted = evidence();
    persisted.audit.candidates[0]!.humanLabel = "true_positive";
    persisted.audit.boundaries[0]!.humanUsable = false;
    persisted.audit.boundaries[0]!.humanIssueCodes = ["clipped_syllable"];
    persisted.progress.candidateLabeled = 1;
    persisted.progress.boundaryLabeled = 1;
    persisted.progress.complete = true;

    const html = renderToStaticMarkup(
      <AlphaAuditPanel
        evidence={persisted}
        selectedCandidateId="candidate_001"
        busy={false}
        onLabelCandidate={vi.fn()}
        onPreviewBoundary={vi.fn()}
        onLabelBoundary={vi.fn()}
        {...timingHandlers()}
      />,
    );

    expect(html).toContain("本 revision 标注完成");
    expect(html).toContain("已确认正确");
    expect(html).toContain("截断音节");
  });

  it("shows honest paired-time collection states", () => {
    const formalMissing = evidence();
    formalMissing.audit.project.alphaTrial = {
      mode: "formal",
      enrolledAt: "2026-08-13T00:00:00.000Z",
    };
    const missing = renderToStaticMarkup(
      <AlphaAuditPanel
        evidence={formalMissing}
        selectedCandidateId="candidate_001"
        busy={false}
        onLabelCandidate={vi.fn()}
        onPreviewBoundary={vi.fn()}
        onLabelBoundary={vi.fn()}
        {...timingHandlers()}
      />,
    );
    expect(missing).toContain("登记对照并开始计时");
    expect(missing).toContain("同一事务");
    expect(missing).toContain("操作者代号");
    expect(missing).toContain("本地证据文件（不会上传）");
    expect(missing).toContain("只在此浏览器本地分块计算");
    expect(missing).toContain('type="file"');
    expect(missing).toContain("证据 SHA-256（自动生成或手工粘贴）");
    expect(missing).toMatch(/<button[^>]*disabled=""[^>]*>登记对照并开始计时<\/button>/);

    const finishedEvidence = evidence();
    finishedEvidence.audit.project.alphaTrial = {
      mode: "formal",
      enrolledAt: "2026-08-13T00:00:00.000Z",
    };
    finishedEvidence.timing = {
      baseline: { manualBaselineSeconds: 120, method: "stopwatch", operatorIdHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", evidenceSha256: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" },
      agentCutActiveSeconds: 72,
      state: "finished",
      activeSessionId: null,
      lastActivityAt: "2026-07-31T20:00:00.000Z",
      complete: true,
    };
    const finished = renderToStaticMarkup(
      <AlphaAuditPanel
        evidence={finishedEvidence}
        selectedCandidateId="candidate_001"
        busy={false}
        onLabelCandidate={vi.fn()}
        onPreviewBoundary={vi.fn()}
        onLabelBoundary={vi.fn()}
        {...timingHandlers()}
      />,
    );
    expect(finished).toContain("已形成成对时间证据");
    expect(finished).toContain("40.0%");
    expect(finished).toContain("操作者承诺");
    expect(finished).toContain("对照证据");
  });

  it("does not offer Gate timing for a nonformal project", () => {
    const html = renderToStaticMarkup(
      <AlphaAuditPanel
        evidence={evidence()}
        selectedCandidateId="candidate_001"
        busy={false}
        onLabelCandidate={vi.fn()}
        onPreviewBoundary={vi.fn()}
        onLabelBoundary={vi.fn()}
        {...timingHandlers()}
      />,
    );

    expect(html).toContain("非正式工程不采集提效时间");
    expect(html).toContain("--alpha-trial");
    expect(html).not.toContain("登记对照并开始计时");
  });

  it("makes formal sample editing lock state explicit", () => {
    const formal = evidence();
    formal.audit.project.alphaTrial = {
      mode: "formal",
      enrolledAt: "2026-08-10T00:00:00.000Z",
    };
    const locked = renderToStaticMarkup(
      <AlphaAuditPanel
        evidence={formal}
        selectedCandidateId="candidate_001"
        busy={false}
        onLabelCandidate={vi.fn()}
        onPreviewBoundary={vi.fn()}
        onLabelBoundary={vi.fn()}
        {...timingHandlers()}
      />,
    );
    expect(locked).toContain("正式 Alpha 样本");
    expect(locked).toContain("初剪修改已锁定");

    formal.timing = {
      baseline: { manualBaselineSeconds: 120, method: "stopwatch", operatorIdHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", evidenceSha256: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" },
      agentCutActiveSeconds: 5,
      state: "running",
      activeSessionId: "session_001",
      lastActivityAt: "2026-08-10T00:00:05.000Z",
      complete: false,
    };
    formal.audit.export = null;
    const running = renderToStaticMarkup(
      <AlphaAuditPanel
        evidence={formal}
        selectedCandidateId="candidate_001"
        busy={false}
        onLabelCandidate={vi.fn()}
        onPreviewBoundary={vi.fn()}
        onLabelBoundary={vi.fn()}
        {...timingHandlers()}
      />,
    );
    expect(running).toContain("计时正在运行，初剪修改已解锁");
    expect(running).toContain("正式样本需完成全部内容取舍并成功导出当前初剪");
    expect(running).toMatch(/<button[^>]*disabled=""[^>]*>完成本次计时<\/button>/);
  });

  it("keeps final quality labels disabled until all rough-cut decisions are complete", () => {
    const pending = evidence();
    pending.audit.review = { completed: false, pendingCandidateIds: ["candidate_001"] };
    const html = renderToStaticMarkup(
      <AlphaAuditPanel
        evidence={pending}
        selectedCandidateId="candidate_001"
        busy={false}
        onLabelCandidate={vi.fn()}
        onPreviewBoundary={vi.fn()}
        onLabelBoundary={vi.fn()}
        {...timingHandlers()}
      />,
    );

    expect(html).toContain("先完成 1 项内容取舍");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>判断正确<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>可用<\/button>/);
  });

  it("keeps final quality labels disabled until the accepted rough cut is exported", () => {
    const notExported = evidence();
    notExported.audit.export = null;
    const html = renderToStaticMarkup(
      <AlphaAuditPanel
        evidence={notExported}
        selectedCandidateId="candidate_001"
        busy={false}
        onLabelCandidate={vi.fn()}
        onPreviewBoundary={vi.fn()}
        onLabelBoundary={vi.fn()}
        {...timingHandlers()}
      />,
    );

    expect(html).toContain("先导出并通过当前初剪的质量检查");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>判断正确<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>可用<\/button>/);
  });

  it("keeps formal final labels disabled until active-time evidence is sealed", () => {
    const formal = evidence();
    formal.audit.project.alphaTrial = {
      mode: "formal",
      enrolledAt: "2026-08-13T00:00:00.000Z",
    };
    formal.timing = {
      baseline: { manualBaselineSeconds: 120, method: "stopwatch", operatorIdHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", evidenceSha256: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" },
      agentCutActiveSeconds: 30,
      state: "paused",
      activeSessionId: null,
      lastActivityAt: "2026-08-13T00:00:30.000Z",
      complete: false,
    };
    const paused = renderToStaticMarkup(
      <AlphaAuditPanel
        evidence={formal}
        selectedCandidateId="candidate_001"
        busy={false}
        onLabelCandidate={vi.fn()}
        onPreviewBoundary={vi.fn()}
        onLabelBoundary={vi.fn()}
        {...timingHandlers()}
      />,
    );

    expect(paused).toContain("先完成本次计时，再试听并记录最终候选与边界标签");
    expect(paused).toMatch(/<button[^>]*disabled=""[^>]*>判断正确<\/button>/);
    expect(paused).toMatch(/<button[^>]*disabled=""[^>]*>可用<\/button>/);
    expect(paused).not.toMatch(/<button[^>]*disabled=""[^>]*>完成本次计时<\/button>/);

    formal.timing = { ...formal.timing, state: "finished", complete: true };
    const finished = renderToStaticMarkup(
      <AlphaAuditPanel
        evidence={formal}
        selectedCandidateId="candidate_001"
        busy={false}
        onLabelCandidate={vi.fn()}
        onPreviewBoundary={vi.fn()}
        onLabelBoundary={vi.fn()}
        {...timingHandlers()}
      />,
    );
    expect(finished).not.toContain("先完成本次计时，再试听并记录最终候选与边界标签");
    expect(finished).not.toMatch(/<button[^>]*disabled=""[^>]*>判断正确<\/button>/);
  });

  it("blocks retroactive formal timing after a human content decision", () => {
    const decided = evidence();
    decided.audit.project.alphaTrial = {
      mode: "formal",
      enrolledAt: "2026-08-13T00:00:00.000Z",
    };
    decided.audit.derived.firstHumanDecisionRevision = 6;
    const html = renderToStaticMarkup(
      <AlphaAuditPanel
        evidence={decided}
        selectedCandidateId="candidate_001"
        busy={false}
        onLabelCandidate={vi.fn()}
        onPreviewBoundary={vi.fn()}
        onLabelBoundary={vi.fn()}
        {...timingHandlers()}
      />,
    );

    expect(html).toContain("已在 REV 6 开始人工内容取舍");
    expect(html).toContain("不能事后启动正式计时");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>登记对照并开始计时<\/button>/);
  });

  it("opens only when Alpha evidence has an action the user can take now", () => {
    const legacyPending = evidence();
    legacyPending.audit.review = { completed: false, pendingCandidateIds: ["candidate_001"] };
    legacyPending.audit.derived.firstHumanDecisionRevision = 6;
    expect(shouldOpenAlphaAuditPanel(legacyPending)).toBe(false);

    const newFormal = evidence();
    newFormal.audit.project.alphaTrial = {
      mode: "formal",
      enrolledAt: "2026-08-13T00:00:00.000Z",
    };
    newFormal.audit.review = { completed: false, pendingCandidateIds: ["candidate_001"] };
    newFormal.audit.export = null;
    expect(shouldOpenAlphaAuditPanel(newFormal)).toBe(true);

    const readyForLabels = evidence();
    expect(shouldOpenAlphaAuditPanel(readyForLabels)).toBe(true);

    readyForLabels.progress.complete = true;
    expect(shouldOpenAlphaAuditPanel(readyForLabels)).toBe(false);

    const readyToCollect = evidence();
    readyToCollect.audit.project.alphaTrial = {
      mode: "formal",
      enrolledAt: "2026-08-13T00:00:00.000Z",
    };
    readyToCollect.timing = {
      baseline: { manualBaselineSeconds: 120, method: "stopwatch", operatorIdHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", evidenceSha256: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" },
      agentCutActiveSeconds: 72,
      state: "finished",
      activeSessionId: null,
      lastActivityAt: "2026-08-13T00:01:12.000Z",
      complete: true,
    };
    readyToCollect.progress = {
      candidateLabeled: 1,
      candidateTotal: 1,
      boundaryLabeled: 1,
      boundaryTotal: 1,
      complete: true,
    };
    readyToCollect.audit.candidates[0]!.humanLabel = "true_positive";
    readyToCollect.audit.boundaries[0]!.humanUsable = true;
    expect(shouldOpenAlphaAuditPanel(readyToCollect)).toBe(true);
    const collectHtml = renderToStaticMarkup(
      <AlphaAuditPanel
        evidence={readyToCollect}
        selectedCandidateId="candidate_001"
        busy={false}
        onLabelCandidate={vi.fn()}
        onPreviewBoundary={vi.fn()}
        onLabelBoundary={vi.fn()}
        {...timingHandlers()}
      />,
    );
    expect(collectHtml).toContain("本 revision 已可收集");
    expect(collectHtml).toContain("pnpm alpha:collect");
  });
});

function timingHandlers() {
  return {
    onBeginTiming: vi.fn(),
    onStartTiming: vi.fn(),
    onPauseTiming: vi.fn(),
    onFinishTiming: vi.fn(),
  };
}

function evidence(): AlphaAuditResponse {
  return {
    audit: {
      schemaVersion: "1.0",
      project: {
        id: "project_001",
        name: "Alpha 项目",
        revision: 9,
        sequenceId: "sequence_main",
        transcriptId: "transcript_001",
        sourceAssetId: "asset_001",
        sourceSha256: "sha256:source",
      },
      review: { completed: true, pendingCandidateIds: [] },
      candidates: [{
        candidateId: "candidate_001",
        decision: "definite_remove",
        risk: "low",
        reasonCodes: ["silence"],
        confidence: 0.99,
        explanationZh: "低风险停顿",
        targetKind: "gap",
        wordIds: [],
        sourceStartMicros: 1_000_000,
        durationMicros: 800_000,
        text: "前文[停顿]后文",
        state: "committed_deleted",
        humanLabel: null,
        humanNote: null,
      }],
      boundaries: [{
        boundaryId: "boundary_001",
        assetId: "asset_001",
        timelineMicros: 1_000_000,
        leftSourceEndMicros: 1_000_000,
        rightSourceStartMicros: 1_800_000,
        removedDurationMicros: 800_000,
        candidateIds: ["candidate_001"],
        humanUsable: null,
        humanIssueCodes: [],
        humanNote: null,
      }],
      derived: {
        definiteRemovePredicted: 1,
        definiteRemoveCommitted: 1,
        highRiskAutoDeletedCandidateIds: [],
        firstHumanDecisionRevision: null,
      },
      export: {
        reportId: "render_001",
        sourceRevision: 8,
        outputAssetId: "asset_output_001",
        outputSha256: "sha256:output",
        videoCodec: "h264",
        audioCodec: "aac",
        quality: { passed: true },
      },
    },
    progress: {
      candidateLabeled: 0,
      candidateTotal: 1,
      boundaryLabeled: 0,
      boundaryTotal: 1,
      complete: false,
    },
    timing: {
      baseline: null,
      agentCutActiveSeconds: 0,
      state: "not_started",
      activeSessionId: null,
      lastActivityAt: null,
      complete: false,
    },
    events: [],
  };
}
