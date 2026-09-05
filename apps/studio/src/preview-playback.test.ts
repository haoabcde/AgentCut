import { describe, expect, it } from "vitest";
import type { PreviewSegment } from "./api.js";
import {
  candidateCutLoopWindow,
  projectSourcePlayback,
  sourceToTimeline,
  sourceToTimelineAnchor,
  timelineToSource,
} from "./preview-playback.js";

const segments: PreviewSegment[] = [
  {
    clipId: "clip_a",
    assetId: "asset_a",
    timelineStartSeconds: 0,
    sourceStartSeconds: 0,
    durationSeconds: 3,
  },
  {
    clipId: "clip_b",
    assetId: "asset_a",
    timelineStartSeconds: 3,
    sourceStartSeconds: 5,
    durationSeconds: 5,
  },
];

describe("preview playback mapping", () => {
  it("maps edited timeline seek into the retained source range", () => {
    expect(timelineToSource(segments, 4)).toEqual({
      segmentIndex: 1,
      sourceSeconds: 6,
    });
  });

  it("chooses the next clip on an exact cut boundary", () => {
    expect(timelineToSource(segments, 3)).toEqual({
      segmentIndex: 1,
      sourceSeconds: 5,
    });
  });

  it("jumps over a deleted source interval during playback", () => {
    expect(projectSourcePlayback(segments, 0, 3.01)).toEqual({
      segmentIndex: 1,
      timelineSeconds: 3,
      jumpToSourceSeconds: 5,
      ended: false,
    });
  });

  it("marks the edited preview ended at its final source boundary", () => {
    expect(projectSourcePlayback(segments, 1, 10)).toEqual({
      segmentIndex: 1,
      timelineSeconds: 8,
      ended: true,
    });
  });

  it("maps retained words to timeline time and excludes deleted source time", () => {
    expect(sourceToTimeline(segments, 6)).toEqual({ segmentIndex: 1, timelineSeconds: 4 });
    expect(sourceToTimeline(segments, 4)).toBeUndefined();
  });

  it("collapses deleted source positions onto canonical cut boundaries", () => {
    expect(sourceToTimelineAnchor(segments, 4)).toEqual({
      segmentIndex: 1,
      timelineSeconds: 3,
    });
    expect(sourceToTimelineAnchor(segments, 12)).toEqual({
      segmentIndex: 1,
      timelineSeconds: 8,
    });
  });

  it("centers deletion-effect audition on the actual right-hand cut segment", () => {
    expect(candidateCutLoopWindow(segments, 4, 8)).toEqual({
      startSeconds: 1.5,
      endSeconds: 4.5,
    });
  });
});
