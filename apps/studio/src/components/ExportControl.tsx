import { ArrowSquareOut } from "@phosphor-icons/react/ArrowSquareOut";
import { Export } from "@phosphor-icons/react/Export";
import { XCircle } from "@phosphor-icons/react/XCircle";
import type { ExportJobResponse, ExportPreset } from "../api.js";

interface ExportControlProps {
  roughCutReady: boolean;
  busy: boolean;
  currentRevision: number;
  job?: ExportJobResponse | undefined;
  disabledReason?: string | undefined;
  onExport: (preset: ExportPreset) => Promise<void>;
  onCancel: () => Promise<void>;
}

const PRESET_LABELS: Record<ExportPreset, string> = {
  source: "原画幅",
  "vertical-9-16": "9:16 竖屏（近似取景）",
};

export function exportPresetLabel(preset: ExportPreset | undefined): string {
  return PRESET_LABELS[preset ?? "source"];
}

export function ExportControl({
  roughCutReady,
  busy,
  currentRevision,
  job,
  disabledReason,
  onExport,
  onCancel,
}: ExportControlProps) {
  if (job?.status === "succeeded" && job.mediaUrl) {
    // A completed export registers its artifacts in the following project revision.
    // Any later revision means the downloadable file no longer represents the current cut.
    const stale = job.sourceRevision + 1 < currentRevision;
    const reason = disabledReason ?? (!roughCutReady ? "还有候选未决定" : undefined);
    const disabled = busy || !roughCutReady || Boolean(disabledReason);
    return (
      <span className="export-results">
        <span className="export-preset-tag">{exportPresetLabel(job.preset)}</span>
        <a className="export-control succeeded" href={job.mediaUrl} target="_blank" rel="noreferrer"><ArrowSquareOut size={14} />打开成片</a>
        {job.captionUrl ? <a className="caption-download" href={job.captionUrl} download>下载 SRT</a> : null}
        {stale ? <span className="export-stale-note" role="status">成片已过期</span> : null}
        <button
          type="button"
          className="export-control export-again"
          disabled={disabled}
          title={reason ?? `按当前 REV ${currentRevision} 重新导出${exportPresetLabel(job.preset)}`}
          onClick={() => void onExport(job.preset ?? "source")}
        >
          <Export size={14} />
          {stale ? "重新导出当前版本" : "重新导出"}
          {reason ? <span className="visually-hidden">：{reason}</span> : null}
        </button>
        {job.quality?.fitModeApproximate
          ? <span className="export-approximate-note" role="note">竖屏为中心裁切近似取景，请目检构图</span>
          : null}
      </span>
    );
  }
  if (job?.status === "pending" || job?.status === "running") {
    return (
      <span className="export-progress-group">
        <span className="export-control progress" role="status">
          {job.cancelRequested
            ? "正在取消导出…"
            : `导出中 ${Math.round(job.progress * 100)}%（${exportPresetLabel(job.preset)}）`}
        </span>
        <button
          type="button"
          className="export-cancel"
          disabled={busy || job.cancelRequested || !job.canCancel}
          onClick={() => void onCancel()}
        >
          <XCircle size={13} />取消
        </button>
      </span>
    );
  }
  const reason = disabledReason ?? (!roughCutReady ? "还有候选未决定" : undefined);
  const disabled = busy || !roughCutReady || Boolean(disabledReason);
  const retry = job?.status === "failed" || job?.status === "outcome_unknown";
  return (
    <span className="export-start-group">
      <button
        type="button"
        className="export-control"
        disabled={disabled}
        title={reason ?? (job?.error?.message || "按序列画布导出 H.264/AAC MP4 与 SRT")}
        onClick={() => void onExport("source")}
      >
        <Export size={14} />
        {retry ? "安全重试导出" : "导出成片"}
        {reason ? <span className="visually-hidden">：{reason}</span> : null}
      </button>
      <button
        type="button"
        className="export-control export-vertical"
        disabled={disabled}
        title={reason
          ?? "导出 1080x1920 竖屏 MP4：居中放大裁切（近似取景，无人物跟踪），构图敏感素材请导出后目检"}
        onClick={() => void onExport("vertical-9-16")}
      >
        <Export size={14} />
        导出 9:16 竖屏
        {reason ? <span className="visually-hidden">：{reason}</span> : null}
      </button>
    </span>
  );
}
