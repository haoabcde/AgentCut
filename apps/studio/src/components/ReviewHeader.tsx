import { HardDrives } from "@phosphor-icons/react/HardDrives";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import type { ExportJobResponse, ExportPreset, ReviewResponse } from "../api.js";
import { ExportControl } from "./ExportControl.js";

export type CompactPanel = "assistant" | "transcript" | "viewer" | "timeline";

interface ReviewHeaderProps {
  data: ReviewResponse;
  compactPanel: CompactPanel;
  onCompactPanelChange: (panel: CompactPanel) => void;
  exportJob?: ExportJobResponse | undefined;
  exportBusy: boolean;
  exportDisabledReason?: string | undefined;
  onExport: (preset: ExportPreset) => Promise<void>;
  onCancelExport: () => Promise<void>;
}

const compactPanels: Array<{ id: CompactPanel; label: string; shortLabel: string }> = [
  { id: "assistant", label: "编辑助手", shortLabel: "助手" },
  { id: "transcript", label: "文稿", shortLabel: "文稿" },
  { id: "viewer", label: "画面预览", shortLabel: "画面" },
  { id: "timeline", label: "时间线", shortLabel: "时间线" },
];

export function ReviewHeader({
  data,
  compactPanel,
  onCompactPanelChange,
  exportJob,
  exportBusy,
  exportDisabledReason,
  onExport,
  onCancelExport,
}: ReviewHeaderProps) {
  const job = data.jobs.at(-1);
  return (
    <header className="app-header">
      <div className="brand-lockup" aria-label="AgentCut">
        <span className="brand-wordmark">AgentCut</span>
        <span className="alpha-label">ALPHA</span>
      </div>
      <div className="project-heading">
        <h1>{data.project.name}</h1>
        <span>通用剪辑工作区</span>
      </div>
      <div className="header-status" aria-label="工程状态">
        <span className="local-status"><HardDrives size={14} />本地工程</span>
        {job ? <span className="status-pill success"><ShieldCheck size={14} />ASR {job.status}</span> : null}
        <span className="revision-pill">REV {data.project.revision}</span>
        <ExportControl
          roughCutReady={data.roughCutStatus === "rough_cut_ready"}
          busy={exportBusy}
          currentRevision={data.project.revision}
          disabledReason={exportDisabledReason}
          job={exportJob}
          onExport={onExport}
          onCancel={onCancelExport}
        />
      </div>
      <nav className="compact-workspace-nav" aria-label="工作区视图">
        {compactPanels.map((panel) => (
          <button
            key={panel.id}
            type="button"
            role="tab"
            aria-label={panel.label}
            aria-selected={compactPanel === panel.id}
            aria-controls={`workspace-${panel.id}`}
            onClick={() => onCompactPanelChange(panel.id)}
          >
            {panel.shortLabel}
          </button>
        ))}
      </nav>
    </header>
  );
}
