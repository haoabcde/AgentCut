import { Pause } from "@phosphor-icons/react/Pause";
import { Play } from "@phosphor-icons/react/Play";
import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { VideoCamera } from "@phosphor-icons/react/VideoCamera";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { forwardRef, useRef, useState, type ForwardedRef } from "react";
import type { ReviewResponse } from "../api.js";
import { projectSourcePlayback } from "../preview-playback.js";

export type PreviewMode = "original" | "rough-cut";

interface PlayerPanelProps {
  data: ReviewResponse;
  activeWordId: string | undefined;
  isLooping: boolean;
  mode: PreviewMode;
  segmentIndex: number;
  playbackTimeSeconds: number;
  preview: ReviewResponse["preview"];
  previewLabel?: string;
  editedLoopWindow?: { startSeconds: number; endSeconds: number };
  onModeChange: (mode: PreviewMode) => void;
  onSegmentChange: (index: number) => void;
  onEditedSeek: (timelineSeconds: number) => void;
  onPlaybackTimeChange: (seconds: number) => void;
}

export const PlayerPanel = forwardRef<HTMLVideoElement, PlayerPanelProps>(
  function PlayerPanel({
    data,
    activeWordId,
    isLooping,
    mode,
    segmentIndex,
    playbackTimeSeconds,
    preview,
    previewLabel,
    editedLoopWindow,
    onModeChange,
    onSegmentChange,
    onEditedSeek,
    onPlaybackTimeChange,
  }, ref) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [videoError, setVideoError] = useState<string>();
    const [reloadKey, setReloadKey] = useState(0);
    const assignRef = (node: HTMLVideoElement | null) => {
      videoRef.current = node;
      setForwardedRef(ref, node);
    };
    const reloadPreview = () => {
      setVideoError(undefined);
      setReloadKey((key) => key + 1);
    };
    const playbackKind = data.media.playback?.kind === "proxy" ? "proxy" : "source";
    const handleVideoError = (video: HTMLVideoElement) => {
      setVideoError(describeVideoError(video.error, playbackKind));
    };
    const updatePlayback = (video: HTMLVideoElement) => {
      if (mode === "original" || isLooping || !preview) {
        onPlaybackTimeChange(video.currentTime);
        return;
      }
      const projection = projectSourcePlayback(
        preview.segments,
        segmentIndex,
        video.currentTime,
      );
      if (editedLoopWindow && projection.timelineSeconds >= editedLoopWindow.endSeconds) {
        onEditedSeek(editedLoopWindow.startSeconds);
        void video.play().catch(() => undefined);
        return;
      }
      onPlaybackTimeChange(projection.timelineSeconds);
      if (projection.jumpToSourceSeconds !== undefined) {
        onSegmentChange(projection.segmentIndex);
        video.currentTime = projection.jumpToSourceSeconds;
      } else if (projection.ended) {
        video.pause();
      }
    };
    return (
      <section id="workspace-viewer" className="player-column" aria-label="视频预览">
        <div className="viewer-titlebar">
          <span><VideoCamera size={15} />VIEWER</span>
          <div className="viewer-mode-toggle" aria-label="预览版本">
            <button type="button" className={mode === "original" ? "active" : ""} aria-pressed={mode === "original"} onClick={() => onModeChange("original")}>原片</button>
            <button type="button" className={mode === "rough-cut" ? "active" : ""} aria-pressed={mode === "rough-cut"} disabled={!preview?.segments.length} onClick={() => onModeChange("rough-cut")}>{previewLabel ?? "当前初剪"}</button>
          </div>
        </div>
        <div className="video-frame">
          <video
            key={reloadKey}
            ref={assignRef}
            src={data.media.url}
            controls={mode === "original"}
            preload="metadata"
            onTimeUpdate={(event) => updatePlayback(event.currentTarget)}
            onLoadedMetadata={(event) => {
              setVideoError(undefined);
              updatePlayback(event.currentTarget);
            }}
            onError={(event) => handleVideoError(event.currentTarget)}
          >
            当前浏览器无法播放该视频。
          </video>
          {videoError ? (
            <div className="viewer-error" role="alert">
              <WarningCircle size={20} weight="fill" />
              <div className="viewer-error-copy">
                <strong>预览画面加载失败</strong>
                <p>{videoError}</p>
                <small>
                  当前播放{playbackKind === "proxy" ? "本地兼容代理" : "源文件"} · {data.media.originalFileName}
                </small>
              </div>
              <button type="button" className="viewer-reload" onClick={reloadPreview}>
                <ArrowClockwise size={14} />重新加载预览
              </button>
            </div>
          ) : null}
        </div>
        {mode === "rough-cut" && preview ? (
          <div className="edited-player-controls">
            <button type="button" aria-label="播放或暂停当前初剪" onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              if (video.paused) void video.play().catch(() => undefined);
              else video.pause();
            }}>
              {videoRef.current?.paused === false ? <Pause size={15} weight="fill" /> : <Play size={15} weight="fill" />}
            </button>
            <input
              type="range"
              min={0}
              max={preview.durationSeconds}
              step={0.01}
              value={Math.min(playbackTimeSeconds, preview.durationSeconds)}
              aria-label="当前初剪时间"
              onChange={(event) => onEditedSeek(Number(event.currentTarget.value))}
            />
            <span>{formatClock(playbackTimeSeconds)} / {formatClock(preview.durationSeconds)}</span>
          </div>
        ) : null}
        <div className="viewer-footer">
          <div>
            <strong>{data.media.originalFileName}</strong>
            <span>中文 · {data.transcript.language}</span>
            {data.media.playback?.kind === "proxy" ? (
              <span className="viewer-proxy-note">本地兼容代理 · 时间与剪辑仍绑定原片</span>
            ) : null}
          </div>
          <p className="trust-note"><ShieldCheck size={16} weight="fill" /><span><strong>非破坏编辑</strong> · 源文件不变</span></p>
          <span className="viewer-location">{activeWordId ? `定位 ${activeWordId.slice(-6)}` : "点击文字定位画面"}</span>
        </div>
      </section>
    );
  },
);

function setForwardedRef(ref: ForwardedRef<HTMLVideoElement>, node: HTMLVideoElement | null): void {
  if (typeof ref === "function") ref(node);
  else if (ref) ref.current = node;
}

export function describeVideoError(error: MediaError | null, playbackKind: "proxy" | "source"): string {
  const code = error?.code;
  // MediaError: 1=aborted 2=network 3=decode 4=src_not_supported
  if (code === 2) {
    return "读取预览时网络中断。请确认本地 Studio 服务仍在运行，然后重新加载预览。";
  }
  if (code === 3) {
    return playbackKind === "proxy"
      ? "兼容代理解码失败。请重新加载预览；若反复出现，请重新生成代理。"
      : "源文件解码失败，该编码可能不被浏览器支持。建议改用兼容代理播放。";
  }
  if (code === 4) {
    return playbackKind === "proxy"
      ? "浏览器不支持该代理格式。代理应为 H.264/AAC，请重新加载或重新生成代理。"
      : "浏览器不支持源文件编码（如 HEVC）。请为该工程生成兼容代理后再预览。";
  }
  return "预览未能正常显示画面。请重新加载预览；若仍黑屏，请检查兼容代理与本地服务状态。";
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${Math.floor(safe % 60).toString().padStart(2, "0")}`;
}
