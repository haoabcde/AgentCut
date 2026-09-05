import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { Scissors } from "@phosphor-icons/react/Scissors";

export type RoughCutStatus = "not_started" | "reviewing" | "rough_cut_ready";

interface RoughCutControlsProps {
  status: RoughCutStatus;
  projectRevision: number;
  pendingCount: number;
  busy: boolean;
  onGenerate: () => Promise<void>;
  keepRemainingConfirmation: boolean;
  onRequestKeepRemaining: () => void;
  onCancelKeepRemaining: () => void;
  onKeepRemaining: () => Promise<void>;
}

export function RoughCutControls({
  status,
  projectRevision,
  pendingCount,
  busy,
  onGenerate,
  keepRemainingConfirmation,
  onRequestKeepRemaining,
  onCancelKeepRemaining,
  onKeepRemaining,
}: RoughCutControlsProps) {
  if (status === "rough_cut_ready") {
    return (
      <div className="rough-cut-state ready" role="status">
        <CheckCircle size={17} weight="fill" />
        <span><strong>初剪内容已确认</strong><small>所有候选均已删除或锁定保留</small></span>
      </div>
    );
  }

  if (status === "reviewing") {
    return (
      <div className="rough-cut-state reviewing">
        <p>还剩 {pendingCount} 项必须决定，确认后才能导出。</p>
        {keepRemainingConfirmation ? (
          <div className="keep-remaining-confirmation" role="alert">
            <strong>确认保留 REV {projectRevision} 的 {pendingCount} 项？</strong>
            <small>这些内容不会被删除，但会写入保护锁并结束当前审阅；之后仍可逐项重新审阅。</small>
            <div>
              <button
                className="secondary-workflow-action confirm"
                type="button"
                disabled={busy || pendingCount === 0}
                onClick={() => void onKeepRemaining()}
              >
                <CheckCircle size={16} />
                {busy ? "正在写入保护锁…" : `确认保留 ${pendingCount} 项`}
              </button>
              <button
                className="secondary-workflow-action cancel"
                type="button"
                disabled={busy}
                onClick={onCancelKeepRemaining}
              >取消</button>
            </div>
          </div>
        ) : (
          <button
            className="secondary-workflow-action"
            type="button"
            disabled={busy || pendingCount === 0}
            onClick={onRequestKeepRemaining}
          >
            <CheckCircle size={16} />
            保留全部剩余
          </button>
        )}
      </div>
    );
  }

  return (
    <button
      className="rough-cut-action"
      type="button"
      disabled={busy}
      onClick={() => void onGenerate()}
    >
      <Scissors size={17} weight="bold" />
      {busy ? "正在生成初剪…" : "生成初剪"}
    </button>
  );
}
