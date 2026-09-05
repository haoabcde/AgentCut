import { FileText } from "@phosphor-icons/react/FileText";
import { FolderOpen } from "@phosphor-icons/react/FolderOpen";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { useEffect, useRef, useState } from "react";
import type {
  CandidateSelection,
  ReviewResponse,
  ReviewToken,
  SpeechGap,
} from "../api.js";
import { durationLabel } from "../api.js";
import { ReviewGapButton } from "./ReviewGapButton.js";
import { ReviewTokenButton } from "./ReviewTokenButton.js";
import { reviewDecisionCounts } from "../review-navigation.js";
import {
  contiguousWordSelection,
  validateManualDeletionSelection,
} from "../transcript-selection.js";

type Filter = "all" | "candidates" | "reviewed" | "committed";
type DockView = "media" | "transcript";

interface TranscriptPanelProps {
  data: ReviewResponse;
  activeWordId: string | undefined;
  selectedCandidateId: string | undefined;
  onSeek: (token: ReviewToken) => void;
  onSelectCandidate: (candidate: CandidateSelection) => void;
  onDeleteSelection: (wordIds: string[]) => Promise<void>;
  selectedSpeechGapId: string | undefined;
  onSelectSpeechGap: (gap: SpeechGap | undefined) => void;
  onDeleteSpeechGap: (gapId: string) => Promise<void>;
  onRestoreGap: (transactionId: string) => void;
  selectionPreviewActive: boolean;
  selectionPreviewBusy: boolean;
  onPreviewSelection: (wordIds: string[]) => void;
  onPreviewSpeechGap: (gap: SpeechGap) => void;
  onStopSelectionPreview: () => void;
  busy: boolean;
  editingLocked?: boolean;
}

const filters: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "全部文稿" },
  { id: "candidates", label: "待审阅" },
  { id: "reviewed", label: "已保留" },
  { id: "committed", label: "已删除" },
];

export function TranscriptPanel({
  data,
  activeWordId,
  selectedCandidateId,
  onSeek,
  onSelectCandidate,
  onDeleteSelection,
  selectedSpeechGapId,
  onSelectSpeechGap,
  onDeleteSpeechGap,
  onRestoreGap,
  selectionPreviewActive,
  selectionPreviewBusy,
  onPreviewSelection,
  onPreviewSpeechGap,
  onStopSelectionPreview,
  busy,
  editingLocked = false,
}: TranscriptPanelProps) {
  const [dockView, setDockView] = useState<DockView>("transcript");
  const [filter, setFilter] = useState<Filter>("all");
  const [mediaQuery, setMediaQuery] = useState("");
  const [selectionAnchorId, setSelectionAnchorId] = useState<string>();
  const [selectedWordIds, setSelectedWordIds] = useState<string[]>([]);
  const [selectionError, setSelectionError] = useState<string>();
  const transcriptBodyRef = useRef<HTMLElement>(null);
  const gapsBeforeWord = new Map<string, typeof data.review.gaps>();
  for (const gap of data.review.gaps) {
    if (!gap.nextWordId) continue;
    gapsBeforeWord.set(gap.nextWordId, [...(gapsBeforeWord.get(gap.nextWordId) ?? []), gap]);
  }
  const candidateById = new Map(data.review.candidates.map((candidate) => [
    candidate.candidateId,
    candidate,
  ]));
  const decisionCounts = reviewDecisionCounts(data.review.candidates);
  useEffect(() => {
    const selected = transcriptBodyRef.current?.querySelector<HTMLElement>(
      '[data-selected-candidate="true"]',
    );
    selected?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [data.review.projectRevision, selectedCandidateId]);
  useEffect(() => {
    setSelectionAnchorId(undefined);
    setSelectedWordIds([]);
    setSelectionError(undefined);
  }, [data.review.projectRevision]);
  const transcriptWordIds = data.review.tokens.map((token) => token.wordId);
  const selectedWordIdSet = new Set(selectedWordIds);
  const selectedSpeechGap = data.review.speechGaps.find((gap) =>
    gap.gapId === selectedSpeechGapId
  );
  const committedGaps = data.review.gaps.filter((gap) =>
    gap.state === "committed_deleted" && gap.restorable && gap.transactionId,
  );
  const activateToken = (token: ReviewToken, extendSelection: boolean) => {
    onStopSelectionPreview();
    onSelectSpeechGap(undefined);
    if (extendSelection && selectionAnchorId) {
      const wordIds = contiguousWordSelection(
        transcriptWordIds,
        selectionAnchorId,
        token.wordId,
      );
      const validation = validateManualDeletionSelection(
        data.review.tokens,
        data.review.gaps,
        wordIds,
      );
      if (!validation.valid) {
        setSelectedWordIds([]);
        setSelectionError(validation.message);
        return;
      }
      setSelectedWordIds(wordIds);
      setSelectionError(undefined);
      return;
    }
    if (token.state !== "normal") {
      setSelectionAnchorId(undefined);
      setSelectedWordIds([]);
      setSelectionError(token.state === "committed_deleted"
        ? "已删除文字不能作为新补删起点；可双击对应删除记录恢复。"
        : token.state === "reviewed_keep"
          ? "已锁定文字不能作为新补删起点；请先重新审阅解除保护。"
          : "待审 AI 候选请先在候选检查器中决定，再进行手工补删。");
      onSeek(token);
      return;
    }
    setSelectionAnchorId(token.wordId);
    setSelectedWordIds([]);
    setSelectionError(undefined);
    onSeek(token);
  };
  const isDimmed = (state: ReviewToken["state"]) => stateIsDimmed(filter, state);
  return (
    <section id="workspace-transcript" className="transcript-column" aria-label="素材与同步文稿">
      <div className="dock-tabs" role="tablist" aria-label="素材与文稿">
        <button type="button" role="tab" aria-selected={dockView === "media"} className={dockView === "media" ? "active" : ""} onClick={() => setDockView("media")}>
          <FolderOpen size={15} />素材
        </button>
        <button type="button" role="tab" aria-selected={dockView === "transcript"} className={dockView === "transcript" ? "active" : ""} onClick={() => setDockView("transcript")}>
          <FileText size={15} />文稿
        </button>
      </div>
      {dockView === "media" ? (
        <div className="media-library" role="tabpanel" aria-label="工程素材">
          <label className="media-search"><MagnifyingGlass size={15} /><input type="search" value={mediaQuery} onChange={(event) => setMediaQuery(event.currentTarget.value)} placeholder="搜索素材" aria-label="搜索素材" /></label>
          {data.media.originalFileName.toLocaleLowerCase().includes(mediaQuery.trim().toLocaleLowerCase()) ? (
            <button type="button" className="asset-card" onClick={() => setDockView("transcript")}>
              <video src={data.media.url} muted preload="metadata" aria-hidden="true" />
              <span><strong>{data.media.originalFileName}</strong><small>视频 · Transcript 已就绪</small></span>
            </button>
          ) : <p className="queue-empty">没有匹配的工程素材。</p>}
          <p className="media-hint">当前 Alpha 先打通单条主视频；后续视频、音频、图片与字幕仍在同一素材库管理。</p>
        </div>
      ) : (
        <>
          <div className="transcript-toolbar">
            <div className="summary-row" aria-label="审阅统计">
              <span><i className="dot candidate" />待审 {decisionCounts.pending}</span>
              <span><i className="dot kept" />保留 {decisionCounts.kept}</span>
              <span><i className="dot committed" />删除 {decisionCounts.committed}</span>
            </div>
          </div>
          <nav className="filter-tabs" aria-label="文稿筛选">
            {filters.map((item) => (
              <button key={item.id} type="button" className={filter === item.id ? "active" : ""} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
                {item.label}
              </button>
            ))}
          </nav>
          {data.review.speechGaps.length > 0 ? (
            <section className="speech-gap-strip" aria-label="无口播画面">
              <strong>无口播画面</strong>
              <span>点击片段后可试听并删除</span>
              <div>
                {data.review.speechGaps.map((gap) => (
                  <button
                    key={gap.gapId}
                    type="button"
                    className={gap.gapId === selectedSpeechGapId ? "selected" : ""}
                    aria-pressed={gap.gapId === selectedSpeechGapId}
                    onClick={() => {
                      onStopSelectionPreview();
                      setSelectionAnchorId(undefined);
                      setSelectedWordIds([]);
                      setSelectionError(undefined);
                      onSelectSpeechGap(gap.gapId === selectedSpeechGapId ? undefined : gap);
                    }}
                  >
                    <span>{speechGapLabel(gap)}</span>
                    <small>{durationLabel(gap.sourceRange)}</small>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          {committedGaps.length > 0 ? (
            <section className="deleted-gap-strip" aria-label="已删除画面">
              <strong>已删除画面</strong>
              <span>删除不影响源文件，可随时恢复</span>
              <div>
                {committedGaps.map((gap) => (
                  <button
                    key={gap.candidateId}
                    type="button"
                    className="deleted-gap"
                    disabled={busy || editingLocked}
                    title={`恢复这段已删除的${speechGapLabel(gap)}（${durationLabel(gap.sourceRange)}）`}
                    onClick={() => onRestoreGap(gap.transactionId!)}
                  >
                    <span>{speechGapLabel(gap)}</span>
                    <small>{durationLabel(gap.sourceRange)} · 点击恢复</small>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          <div className={`selection-toolbar ${selectedWordIds.length > 0 || selectedSpeechGap ? "visible" : ""} ${selectionError ? "invalid" : ""}`} aria-live="polite">
            {selectedSpeechGap ? (
              <>
                <span>已选择{speechGapLabel(selectedSpeechGap)} · {durationLabel(selectedSpeechGap.sourceRange)}</span>
                <button type="button" disabled={busy || editingLocked} onClick={() => void onDeleteSpeechGap(selectedSpeechGap.gapId)}>删除此段</button>
                <button
                  type="button"
                  disabled={busy || selectionPreviewBusy}
                  onClick={() => {
                    if (selectionPreviewActive) onStopSelectionPreview();
                    else onPreviewSpeechGap(selectedSpeechGap);
                  }}
                >
                  {selectionPreviewBusy
                    ? "正在准备…"
                    : selectionPreviewActive
                      ? "停止删除效果"
                      : "试听删除效果"}
                </button>
                <button type="button" disabled={busy} onClick={() => {
                  onStopSelectionPreview();
                  onSelectSpeechGap(undefined);
                }}>取消</button>
              </>
            ) : selectedWordIds.length > 0 ? (
              <>
                <span>已连续选择 {selectedWordIds.length} 个词</span>
                <button type="button" disabled={busy || editingLocked} onClick={() => void onDeleteSelection(selectedWordIds)}>删除选中</button>
                <button
                  type="button"
                  disabled={busy || selectionPreviewBusy}
                  onClick={() => {
                    if (selectionPreviewActive) onStopSelectionPreview();
                    else onPreviewSelection(selectedWordIds);
                  }}
                >
                  {selectionPreviewBusy
                    ? "正在准备…"
                    : selectionPreviewActive
                      ? "停止删除效果"
                      : "试听删除效果"}
                </button>
                <button type="button" disabled={busy} onClick={() => {
                  onStopSelectionPreview();
                  setSelectedWordIds([]);
                  setSelectionError(undefined);
                }}>取消</button>
              </>
            ) : selectionError ? (
              <>
                <span role="alert">{selectionError}</span>
                <button type="button" disabled={busy} onClick={() => {
                  setSelectionAnchorId(undefined);
                  setSelectionError(undefined);
                }}>重新选择</button>
              </>
            ) : <span>点击普通文字作为起点，再按住 Shift 点击终点，可手工补删</span>}
          </div>
          <article ref={transcriptBodyRef} className="transcript-body" aria-label="可点击同步文稿">
            {data.review.tokens.map((token) => (
              <span key={token.wordId} className={isDimmed(token.state) ? "context-dimmed" : undefined}>
                {(gapsBeforeWord.get(token.wordId) ?? []).map((gap) => (
                  <ReviewGapButton key={gap.candidateId} gap={gap} selected={selectedCandidateId === gap.candidateId} dimmed={stateIsDimmed(filter, gap.state)} onSelect={(selectedGap) => {
                    const candidate = candidateById.get(selectedGap.candidateId);
                    if (candidate) onSelectCandidate(candidate);
                  }} />
                ))}
                <ReviewTokenButton
                  token={token}
                  active={activeWordId === token.wordId}
                  candidateSelected={Boolean(selectedCandidateId && token.candidateIds.includes(selectedCandidateId))}
                  manuallySelected={selectedWordIdSet.has(token.wordId)}
                  onActivate={activateToken}
                  onSelectCandidate={(selectedToken) => {
                    const candidate = selectedToken.candidateIds
                      .map((candidateId) => candidateById.get(candidateId))
                      .find((candidate) => candidate?.state === selectedToken.state)
                      ?? candidateById.get(selectedToken.candidateIds[0] ?? "");
                    if (candidate) onSelectCandidate(candidate);
                  }}
                />
              </span>
            ))}
          </article>
          <footer className="transcript-legend">
            <span><i className="legend-swatch candidate" />AI 候选</span>
            <span><i className="legend-swatch kept" />锁定保留</span>
            <span><i className="legend-swatch committed" />已删除可恢复</span>
          </footer>
        </>
      )}
    </section>
  );
}

function stateIsDimmed(filter: Filter, state: ReviewToken["state"]): boolean {
  if (filter === "candidates") return state !== "candidate_remove" && state !== "candidate_keep";
  if (filter === "reviewed") return state !== "reviewed_keep";
  if (filter === "committed") return state !== "committed_deleted";
  return false;
}

function speechGapLabel(gap: { previousWordId?: string; nextWordId?: string }): string {
  if (!gap.previousWordId && gap.nextWordId) return "开头空白";
  if (gap.previousWordId && !gap.nextWordId) return "结尾空白";
  if (gap.previousWordId && gap.nextWordId) return "句间空白";
  return "无口播片段";
}
