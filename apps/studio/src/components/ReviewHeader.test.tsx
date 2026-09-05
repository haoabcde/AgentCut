import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReviewResponse } from "../api.js";
import { ReviewHeader } from "./ReviewHeader.js";

const data: ReviewResponse = {
  project: { id: "project", name: "通用剪辑工程", revision: 9 },
  transcript: { id: "transcript", language: "zh" },
  media: { assetId: "asset", url: "/media/asset", originalFileName: "source.mp4" },
  review: {
    transcriptId: "transcript",
    projectRevision: 9,
    candidates: [],
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

describe("ReviewHeader compact workspace navigation", () => {
  it("keeps every primary workspace surface reachable in a narrow window", () => {
    const HeaderWithCompactNavigation = ReviewHeader as ComponentType<{
      data: ReviewResponse;
      compactPanel: "assistant" | "transcript" | "viewer" | "timeline";
      onCompactPanelChange: (panel: "assistant" | "transcript" | "viewer" | "timeline") => void;
    }>;
    const markup = renderToStaticMarkup(
      <HeaderWithCompactNavigation
        data={data}
        compactPanel="transcript"
        onCompactPanelChange={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="工作区视图"');
    expect(markup).toContain('aria-controls="workspace-assistant"');
    expect(markup).toContain('aria-controls="workspace-transcript"');
    expect(markup).toContain('aria-controls="workspace-viewer"');
    expect(markup).toContain('aria-controls="workspace-timeline"');
    expect(markup).toContain('aria-label="文稿" aria-selected="true"');
  });
});
