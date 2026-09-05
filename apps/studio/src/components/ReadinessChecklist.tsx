import { ArrowCounterClockwise } from "@phosphor-icons/react/ArrowCounterClockwise";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleDashed } from "@phosphor-icons/react/CircleDashed";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import type { RoughCutReadiness } from "../api.js";

interface ReadinessChecklistProps {
  readiness: RoughCutReadiness;
  busy: boolean;
  onUndoLatest: () => void;
}

/**
 * Breaks "rough cut confirmed" into independent, verifiable signals so that
 * clearing the candidate queue is never mistaken for a fully reviewed and
 * exported cut. Also surfaces the single most recent restorable deletion as a
 * global undo entry.
 */
export function ReadinessChecklist({ readiness, busy, onUndoLatest }: ReadinessChecklistProps) {
  return (
    <section className="readiness-checklist" aria-label="初剪完成度">
      <div className="readiness-heading">
        <span>完成度</span>
        <small>候选清零 ≠ 成片已验收</small>
      </div>
      <ul>
        <ReadinessRow
          done={readiness.candidatesDecided}
          doneLabel="候选已全部决定"
          pendingLabel={`还有 ${readiness.candidatesPending} 项候选待决定`}
        />
        <ReadinessRow
          done={readiness.speechGapsRemaining === 0}
          doneLabel="无口播画面已清理"
          pendingLabel={`还有 ${readiness.speechGapsRemaining} 段无口播画面可在文稿中试听删除`}
        />
        <ReadinessRow
          done={readiness.exportUpToDate}
          doneLabel="已导出当前版本成片"
          pendingLabel={readiness.exportSucceeded
            ? "成片已过期：工程在导出后继续剪辑，需重新导出"
            : "尚未导出成片"}
          tone={readiness.exportSucceeded && !readiness.exportUpToDate ? "warning" : "pending"}
        />
      </ul>
      {readiness.undo ? (
        <button
          type="button"
          className="undo-latest"
          disabled={busy}
          title={`恢复最近一次删除事务 ${readiness.undo.transactionId}（Cmd/Ctrl+Z）`}
          onClick={onUndoLatest}
        >
          <ArrowCounterClockwise size={14} />
          撤销最近一次删除（{readiness.undo.labelZh} · {formatSeconds(readiness.undo.removedDurationSeconds)}）
        </button>
      ) : null}
    </section>
  );
}

function ReadinessRow({
  done,
  doneLabel,
  pendingLabel,
  tone = "pending",
}: {
  done: boolean;
  doneLabel: string;
  pendingLabel: string;
  tone?: "pending" | "warning";
}) {
  return (
    <li className={`readiness-row ${done ? "done" : tone}`}>
      {done
        ? <CheckCircle size={15} weight="fill" />
        : tone === "warning"
          ? <WarningCircle size={15} weight="fill" />
          : <CircleDashed size={15} />}
      <span>{done ? doneLabel : pendingLabel}</span>
    </li>
  );
}

function formatSeconds(seconds: number): string {
  return seconds >= 1 ? `${seconds.toFixed(2)} 秒` : `${Math.round(seconds * 1000)} 毫秒`;
}
