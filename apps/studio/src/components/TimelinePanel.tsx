import { Scissors } from "@phosphor-icons/react/Scissors";
import { Waveform } from "@phosphor-icons/react/Waveform";
import type { CSSProperties } from "react";
import {
  seconds,
  type CandidateSelection,
  type ReviewResponse,
  type SpeechGap,
} from "../api.js";
import { sourceToTimelineAnchor } from "../preview-playback.js";
import { reviewReasonList } from "../review-reasons.js";

interface TimelinePanelProps {
  data: ReviewResponse;
  selectedCandidateId: string | undefined;
  selectedSpeechGapId: string | undefined;
  currentTimeSeconds: number;
  onSelectCandidate: (candidate: CandidateSelection) => void;
  onSelectSpeechGap: (gap: SpeechGap) => void;
  onSeek: (timeSeconds: number) => void;
}

export function TimelinePanel({
  data,
  selectedCandidateId,
  selectedSpeechGapId,
  currentTimeSeconds,
  onSelectCandidate,
  onSelectSpeechGap,
  onSeek,
}: TimelinePanelProps) {
  const sourceDuration = Math.max(1, ...data.review.tokens.map((token) =>
    seconds(token.sourceRange.start) + seconds(token.sourceRange.duration),
  ));
  const duration = data.preview?.durationSeconds ?? sourceDuration;
  const previewSegments = data.preview?.segments ?? [];
  const currentTime = Math.min(Math.max(currentTimeSeconds, 0), duration);
  const playheadStyle = {
    "--playhead-position": `${currentTime / duration * 100}%`,
  } as CSSProperties;
  const ruler = [0, .25, .5, .75, 1];
  return (
    <section id="workspace-timeline" className="timeline-panel" aria-label="时间线">
      <div className="timeline-toolbar">
        <div><Scissors size={16} /><strong>时间线</strong><span>{formatClock(currentTime)} / {formatClock(duration)}</span></div>
        <span className="timeline-note">当前工具：口播清理 · 删除提交后自动 Ripple</span>
      </div>
      <div className="timeline-ruler" aria-hidden="true">
        {ruler.map((ratio) => <span key={ratio} style={{ left: `${ratio * 100}%` }}>{formatClock(duration * ratio)}</span>)}
      </div>
      <div className="timeline-track">
        <div className="track-label"><Waveform size={16} /><span>V1</span><small>主画面</small></div>
        <div className="track-lane" style={playheadStyle}>
          <button
            type="button"
            className="timeline-seek-surface"
            aria-label={`定位时间线，当前 ${formatClock(currentTime)}`}
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const ratio = bounds.width > 0
                ? Math.min(Math.max((event.clientX - bounds.left) / bounds.width, 0), 1)
                : 0;
              onSeek(duration * ratio);
            }}
          />
          <span className="timeline-clip-name">{data.media.originalFileName}</span>
          <span className="timeline-playhead" aria-hidden="true" />
          {data.review.speechGaps.map((gap) => {
            const start = seconds(gap.timelineRange.start);
            const span = seconds(gap.timelineRange.duration);
            const style = {
              "--speech-gap-start": `${start / duration * 100}%`,
              "--speech-gap-span": `${Math.max(span / duration * 100, .8)}%`,
            } as CSSProperties;
            return (
              <button
                key={gap.gapId}
                type="button"
                className={`timeline-speech-gap ${gap.gapId === selectedSpeechGapId ? "selected" : ""}`}
                style={style}
                title={`无口播画面 · ${span.toFixed(2)} 秒 · ${formatClock(start)}`}
                aria-label={`选择无口播画面，${span.toFixed(2)} 秒，位于 ${formatClock(start)}`}
                onClick={() => onSelectSpeechGap(gap)}
              />
            );
          })}
          {data.review.candidates.map((candidate) => {
            const sourceStart = seconds(candidate.sourceRange.start);
            const sourceEnd = sourceStart + seconds(candidate.sourceRange.duration);
            const projectedStart = sourceToTimelineAnchor(previewSegments, sourceStart);
            const projectedEnd = sourceToTimelineAnchor(previewSegments, sourceEnd);
            const start = projectedStart?.timelineSeconds ?? sourceStart;
            const end = projectedEnd?.timelineSeconds ?? sourceEnd;
            const span = Math.max(0, end - start);
            const reasons = reviewReasonList(candidate.reasonCodes, "、");
            const style = {
              "--candidate-start": `${start / duration * 100}%`,
              "--candidate-span": `${Math.max(span / duration * 100, .8)}%`,
            } as CSSProperties;
            return (
              <button
                key={candidate.candidateId}
                type="button"
                className={`timeline-candidate ${candidate.state} ${candidate.candidateId === selectedCandidateId ? "selected" : ""}`}
                style={style}
                title={`${reasons} · ${formatClock(start)}`}
                aria-label={`定位 ${reasons}候选，${formatClock(start)}`}
                onClick={() => onSelectCandidate(candidate)}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

function formatClock(value: number): string {
  const rounded = Math.max(0, Math.floor(value));
  const minutes = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}
