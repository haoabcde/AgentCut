import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReviewResponse } from "../api.js";
import { describeVideoError, PlayerPanel } from "./PlayerPanel.js";

describe("describeVideoError diagnostics", () => {
  it("explains a network interruption and points at the local service", () => {
    expect(describeVideoError({ code: 2 } as MediaError, "proxy")).toContain("网络中断");
  });
  it("explains an unsupported source codec and suggests a proxy", () => {
    expect(describeVideoError({ code: 4 } as MediaError, "source")).toContain("HEVC");
    expect(describeVideoError({ code: 4 } as MediaError, "source")).toContain("兼容代理");
  });
  it("explains an unsupported proxy format as an H.264/AAC expectation", () => {
    expect(describeVideoError({ code: 4 } as MediaError, "proxy")).toContain("H.264/AAC");
  });
  it("falls back to a reload hint when no error code is available", () => {
    expect(describeVideoError(null, "source")).toContain("重新加载预览");
  });
});

describe("PlayerPanel preview media", () => {
  it("discloses a local proxy without changing the source filename or Timeline semantics", () => {
    const data = reviewResponse();
    data.media.playback = {
      assetId: "asset_preview_source",
      kind: "proxy",
      profile: "browser-h264-aac-1280-v1",
    };
    data.media.url = "/media/asset_preview_source";

    const html = renderToStaticMarkup(<PlayerPanel
      data={data}
      activeWordId={undefined}
      isLooping={false}
      mode="rough-cut"
      segmentIndex={0}
      playbackTimeSeconds={0}
      preview={data.preview}
      onModeChange={vi.fn()}
      onSegmentChange={vi.fn()}
      onEditedSeek={vi.fn()}
      onPlaybackTimeChange={vi.fn()}
    />);

    expect(html).toContain("/media/asset_preview_source");
    expect(html).toContain("source-hevc.mov");
    expect(html).toContain("本地兼容代理 · 时间与剪辑仍绑定原片");
  });

  it("does not claim a proxy when the immutable source is directly playable", () => {
    const html = renderToStaticMarkup(<PlayerPanel
      data={reviewResponse()}
      activeWordId={undefined}
      isLooping={false}
      mode="rough-cut"
      segmentIndex={0}
      playbackTimeSeconds={0}
      preview={reviewResponse().preview}
      onModeChange={vi.fn()}
      onSegmentChange={vi.fn()}
      onEditedSeek={vi.fn()}
      onPlaybackTimeChange={vi.fn()}
    />);

    expect(html).not.toContain("本地兼容代理");
  });
});

function reviewResponse(): ReviewResponse {
  return {
    project: { id: "project", name: "Proxy test", revision: 1 },
    transcript: { id: "transcript", language: "zh" },
    media: {
      assetId: "asset_source",
      url: "/media/asset_source",
      originalFileName: "source-hevc.mov",
      playback: { assetId: "asset_source", kind: "source" },
    },
    preview: {
      revision: 1,
      durationSeconds: 1,
      segments: [{
        clipId: "clip_source",
        assetId: "asset_source",
        timelineStartSeconds: 0,
        sourceStartSeconds: 0,
        durationSeconds: 1,
      }],
    },
    review: {
      transcriptId: "transcript",
      projectRevision: 1,
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
}
