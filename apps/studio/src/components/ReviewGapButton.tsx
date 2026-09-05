import { ArrowCounterClockwise } from "@phosphor-icons/react/ArrowCounterClockwise";
import { LockKey } from "@phosphor-icons/react/LockKey";
import { PauseCircle } from "@phosphor-icons/react/PauseCircle";
import { durationLabel, type ReviewGap } from "../api.js";

interface ReviewGapButtonProps {
  gap: ReviewGap;
  dimmed: boolean;
  selected: boolean;
  onSelect: (gap: ReviewGap) => void;
}

export function ReviewGapButton({ gap, dimmed, selected, onSelect }: ReviewGapButtonProps) {
  const committed = gap.state === "committed_deleted";
  const kept = gap.state === "reviewed_keep";
  const label = `${committed ? "已删除停顿" : kept ? "已保留停顿" : "停顿候选"} ${durationLabel(gap.sourceRange)}`;
  return (
    <button
      type="button"
      className={`gap-chip ${committed ? "committed" : kept ? "kept" : "candidate"} ${selected ? "selected" : ""} ${dimmed ? "context-dimmed" : ""}`}
      data-selected-candidate={selected ? "true" : undefined}
      title={committed ? "选择后可恢复本次提交" : kept ? "已保留并锁定，选择后可重新审阅" : `风险 ${gap.risk}，尚未修改时间线`}
      onClick={() => onSelect(gap)}
    >
      {committed ? <ArrowCounterClockwise size={12} /> : kept ? <LockKey size={12} /> : <PauseCircle size={12} />}
      {label}
    </button>
  );
}
