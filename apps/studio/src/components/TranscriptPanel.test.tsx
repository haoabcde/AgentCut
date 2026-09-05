import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReviewResponse } from "../api.js";
import { TranscriptPanel } from "./TranscriptPanel.js";

const data: ReviewResponse = {
  project: { id: "project", name: "口播工程", revision: 3 },
  transcript: { id: "transcript", language: "zh" },
  media: { assetId: "asset", url: "/media/asset", originalFileName: "口播.mp4" },
  review: {
    transcriptId: "transcript",
    projectRevision: 3,
    candidates: [],
    tokens: [],
    gaps: [],
    speechGaps: [{
      gapId: "speech_gap_leading",
      clipId: "clip_a",
      sourceRange: {
        start: { value: 0, rate: { numerator: 1_000, denominator: 1 } },
        duration: { value: 2_600, rate: { numerator: 1_000, denominator: 1 } },
      },
      timelineRange: {
        start: { value: 0, rate: { numerator: 1_000, denominator: 1 } },
        duration: { value: 2_600, rate: { numerator: 1_000, denominator: 1 } },
      },
      nextWordId: "word_001",
    }],
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

describe("TranscriptPanel speech gaps", () => {
  it("exposes Transcript-free video and its delete-preview controls", () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        data={data}
        activeWordId={undefined}
        selectedCandidateId={undefined}
        onSeek={vi.fn()}
        onSelectCandidate={vi.fn()}
        onDeleteSelection={vi.fn()}
        selectedSpeechGapId="speech_gap_leading"
        onSelectSpeechGap={vi.fn()}
        onDeleteSpeechGap={vi.fn()}
        onRestoreGap={vi.fn()}
        selectionPreviewActive={false}
        selectionPreviewBusy={false}
        onPreviewSelection={vi.fn()}
        onPreviewSpeechGap={vi.fn()}
        onStopSelectionPreview={vi.fn()}
        busy={false}
      />,
    );

    expect(html).toContain("无口播画面");
    expect(html).toContain("开头空白");
    expect(html).toContain("2.60 秒");
    expect(html).toContain("删除此段");
    expect(html).toContain("试听删除效果");
  });

  it("lists deleted speech-free footage with a restore entry", () => {
    const withDeleted: ReviewResponse = {
      ...data,
      review: {
        ...data.review,
        gaps: [{
          candidateId: "candidate_manual_gap_1",
          sourceRange: {
            start: { value: 0, rate: { numerator: 1_000, denominator: 1 } },
            duration: { value: 2_600, rate: { numerator: 1_000, denominator: 1 } },
          },
          nextWordId: "word_001",
          state: "committed_deleted",
          decoration: "committed_gap",
          reasonCodes: ["manual"],
          risk: "low",
          confidence: 1,
          explanationZh: "用户删除无口播画面。",
          transactionId: "tx_manual_gap_delete_1",
          restorable: true,
        }],
      },
    };
    const html = renderToStaticMarkup(
      <TranscriptPanel
        data={withDeleted}
        activeWordId={undefined}
        selectedCandidateId={undefined}
        onSeek={vi.fn()}
        onSelectCandidate={vi.fn()}
        onDeleteSelection={vi.fn()}
        selectedSpeechGapId={undefined}
        onSelectSpeechGap={vi.fn()}
        onDeleteSpeechGap={vi.fn()}
        onRestoreGap={vi.fn()}
        selectionPreviewActive={false}
        selectionPreviewBusy={false}
        onPreviewSelection={vi.fn()}
        onPreviewSpeechGap={vi.fn()}
        onStopSelectionPreview={vi.fn()}
        busy={false}
      />,
    );
    expect(html).toContain("已删除画面");
    expect(html).toContain("点击恢复");
  });
});
