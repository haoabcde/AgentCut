import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ReviewResponse } from "../api.js";
import { TimelinePanel } from "./TimelinePanel.js";

const data: ReviewResponse = {
  project: { id: "project", name: "通用剪辑工程", revision: 2 },
  preview: {
    revision: 2,
    durationSeconds: 8,
    segments: [{
      clipId: "clip_a",
      assetId: "asset",
      timelineStartSeconds: 0,
      sourceStartSeconds: 0,
      durationSeconds: 3,
    }, {
      clipId: "clip_b",
      assetId: "asset",
      timelineStartSeconds: 3,
      sourceStartSeconds: 5,
      durationSeconds: 5,
    }],
  },
  transcript: { id: "transcript", language: "zh" },
  media: { assetId: "asset", url: "/media/asset", originalFileName: "原始采访素材.mp4" },
  review: {
    transcriptId: "transcript",
    projectRevision: 2,
    tokens: [{
      wordId: "word_001",
      text: "测试",
      sourceRange: {
        start: { value: 0, rate: { numerator: 1_000, denominator: 1 } },
        duration: { value: 10_000, rate: { numerator: 1_000, denominator: 1 } },
      },
      state: "candidate_remove",
      decoration: "candidate_background",
      candidateIds: ["candidate_001"],
      reasonCodes: ["restatement"],
      restorable: false,
    }],
    candidates: [{
      candidateId: "candidate_001",
      targetKind: "words",
      sourceRange: {
        start: { value: 2_000, rate: { numerator: 1_000, denominator: 1 } },
        duration: { value: 1_500, rate: { numerator: 1_000, denominator: 1 } },
      },
      wordIds: ["word_001"],
      state: "candidate_remove",
      reasonCodes: ["restatement"],
      risk: "high",
      confidence: 0.8,
      explanationZh: "测试候选",
    }],
    gaps: [],
    speechGaps: [],
    summary: {
      normalTokens: 0,
      candidateTokens: 1,
      deletedTokens: 0,
      reviewedKeepTokens: 0,
      candidateGaps: 0,
      committedGaps: 0,
      reviewedKeepGaps: 0,
    },
  },
  jobs: [],
};

describe("TimelinePanel", () => {
  it("presents the oral-review range inside a general editing timeline", () => {
    const markup = renderToStaticMarkup(
      <TimelinePanel
        data={data}
        selectedCandidateId="candidate_001"
        selectedSpeechGapId={undefined}
        currentTimeSeconds={0}
        onSelectCandidate={vi.fn()}
        onSelectSpeechGap={vi.fn()}
        onSeek={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="时间线"');
    expect(markup).toContain("当前工具：口播清理");
    expect(markup).toContain("主画面");
    expect(markup).toContain("原始采访素材.mp4");
    expect(markup).toContain("定位 重说候选");
    expect(markup).toContain("0:00 / 0:08");
    expect(markup).not.toContain("定位 restatement 候选");
    expect(markup).not.toContain("口播剪辑地图");
  });

  it("shows the current playhead and exposes click-to-seek on the clip", () => {
    const InteractiveTimelinePanel = TimelinePanel as ComponentType<{
      data: ReviewResponse;
      selectedCandidateId: string | undefined;
      selectedSpeechGapId: string | undefined;
      currentTimeSeconds: number;
      onSelectCandidate: () => void;
      onSelectSpeechGap: () => void;
      onSeek: () => void;
    }>;
    const markup = renderToStaticMarkup(
      <InteractiveTimelinePanel
        data={data}
        selectedCandidateId={undefined}
        selectedSpeechGapId={undefined}
        currentTimeSeconds={4}
        onSelectCandidate={vi.fn()}
        onSelectSpeechGap={vi.fn()}
        onSeek={vi.fn()}
      />,
    );

    expect(markup).toContain("0:04 / 0:08");
    expect(markup).toContain('aria-label="定位时间线，当前 0:04"');
    expect(markup).toContain("--playhead-position:50%");
  });

  it("places deleted-source candidates on the collapsed edited boundary", () => {
    const deletedCandidateData = structuredClone(data);
    deletedCandidateData.review.candidates[0]!.sourceRange = {
      start: { value: 3_200, rate: { numerator: 1_000, denominator: 1 } },
      duration: { value: 1_500, rate: { numerator: 1_000, denominator: 1 } },
    };
    deletedCandidateData.review.candidates[0]!.state = "committed_deleted";
    const markup = renderToStaticMarkup(
      <TimelinePanel
        data={deletedCandidateData}
        selectedCandidateId="candidate_001"
        selectedSpeechGapId={undefined}
        currentTimeSeconds={3}
        onSelectCandidate={vi.fn()}
        onSelectSpeechGap={vi.fn()}
        onSeek={vi.fn()}
      />,
    );

    expect(markup).toContain('title="重说 · 0:03"');
    expect(markup).toContain("--candidate-start:37.5%");
    expect(markup).toContain("--candidate-span:0.8%");
  });

  it("renders Transcript-free video as a selectable timeline range", () => {
    const speechGapData = structuredClone(data);
    speechGapData.review.speechGaps = [{
      gapId: "speech_gap_001",
      clipId: "clip_b",
      sourceRange: {
        start: { value: 5_000, rate: { numerator: 1_000, denominator: 1 } },
        duration: { value: 500, rate: { numerator: 1_000, denominator: 1 } },
      },
      timelineRange: {
        start: { value: 3_000, rate: { numerator: 1_000, denominator: 1 } },
        duration: { value: 500, rate: { numerator: 1_000, denominator: 1 } },
      },
    }];
    const markup = renderToStaticMarkup(
      <TimelinePanel
        data={speechGapData}
        selectedCandidateId={undefined}
        selectedSpeechGapId="speech_gap_001"
        currentTimeSeconds={3}
        onSelectCandidate={vi.fn()}
        onSelectSpeechGap={vi.fn()}
        onSeek={vi.fn()}
      />,
    );

    expect(markup).toContain("选择无口播画面，0.50 秒");
    expect(markup).toContain("--speech-gap-start:37.5%");
    expect(markup).toContain("timeline-speech-gap selected");
  });
});
