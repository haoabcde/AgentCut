import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { Flask } from "@phosphor-icons/react/Flask";
import { Play } from "@phosphor-icons/react/Play";
import { useEffect, useRef, useState } from "react";
import type {
  AlphaAuditBoundary,
  AlphaAuditResponse,
  AlphaBoundaryIssueCode,
  AlphaTimingBaselineMethod,
} from "../api.js";
import { sha256File } from "../file-sha256.js";

interface AlphaAuditPanelProps {
  evidence: AlphaAuditResponse;
  selectedCandidateId: string | undefined;
  busy: boolean;
  onLabelCandidate: (
    candidateId: string,
    label: "true_positive" | "false_positive",
  ) => void;
  onPreviewBoundary: (boundary: AlphaAuditBoundary) => void;
  onLabelBoundary: (
    boundaryId: string,
    usable: boolean,
    issueCodes: AlphaBoundaryIssueCode[],
  ) => void;
  onBeginTiming: (
    seconds: number,
    method: AlphaTimingBaselineMethod,
    operatorId: string,
    evidenceSha256: string,
  ) => void;
  onStartTiming: () => void;
  onPauseTiming: () => void;
  onFinishTiming: () => void;
}

const boundaryIssues: Array<{ code: AlphaBoundaryIssueCode; label: string }> = [
  { code: "swallowed_word", label: "吞字" },
  { code: "clipped_syllable", label: "截断音节" },
  { code: "av_sync", label: "音画不同步" },
  { code: "unnatural_pacing", label: "节奏不自然" },
  { code: "other", label: "其他" },
];

export function AlphaAuditPanel({
  evidence,
  selectedCandidateId,
  busy,
  onLabelCandidate,
  onPreviewBoundary,
  onLabelBoundary,
  onBeginTiming,
  onStartTiming,
  onPauseTiming,
  onFinishTiming,
}: AlphaAuditPanelProps) {
  const [baselineSeconds, setBaselineSeconds] = useState("");
  const [baselineMethod, setBaselineMethod] = useState<AlphaTimingBaselineMethod>("stopwatch");
  const [baselineOperatorId, setBaselineOperatorId] = useState("");
  const [baselineEvidenceSha256, setBaselineEvidenceSha256] = useState("");
  const [baselineHashState, setBaselineHashState] = useState<{
    status: "idle" | "hashing" | "ready" | "error";
    fileName?: string;
    percent?: number;
    message?: string;
  }>({ status: "idle" });
  const baselineHashAbort = useRef<AbortController | null>(null);
  useEffect(() => () => baselineHashAbort.current?.abort(), []);

  async function hashBaselineEvidence(file: File | undefined): Promise<void> {
    baselineHashAbort.current?.abort();
    if (!file) {
      setBaselineHashState({ status: "idle" });
      return;
    }

    const controller = new AbortController();
    baselineHashAbort.current = controller;
    setBaselineEvidenceSha256("");
    setBaselineHashState({ status: "hashing", fileName: file.name, percent: 0 });
    try {
      const digest = await sha256File(file, {
        signal: controller.signal,
        onProgress: (processed, total) => {
          setBaselineHashState({
            status: "hashing",
            fileName: file.name,
            percent: Math.round((processed / total) * 100),
          });
        },
      });
      if (!controller.signal.aborted) {
        setBaselineEvidenceSha256(digest);
        setBaselineHashState({ status: "ready", fileName: file.name, percent: 100 });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setBaselineHashState({
          status: "error",
          fileName: file.name,
          message: error instanceof Error ? error.message : "无法计算文件 SHA-256",
        });
      }
    } finally {
      if (baselineHashAbort.current === controller) {
        baselineHashAbort.current = null;
      }
    }
  }

  function updateEvidenceSha256(value: string): void {
    baselineHashAbort.current?.abort();
    baselineHashAbort.current = null;
    setBaselineHashState({ status: "idle" });
    setBaselineEvidenceSha256(value);
  }
  const candidate = evidence.audit.candidates.find((item) =>
    item.candidateId === selectedCandidateId,
  ) ?? evidence.audit.candidates.find((item) => item.humanLabel === null)
    ?? evidence.audit.candidates[0];
  const contentDecisionsReady = evidence.audit.review.completed
    && evidence.audit.review.pendingCandidateIds.length === 0;
  const acceptedExportReady = evidence.audit.export?.quality.passed === true
    && evidence.audit.export.sourceRevision + 1 === evidence.audit.project.revision;
  const formalTrial = evidence.audit.project.alphaTrial;
  const timingBaseline = evidence.timing.baseline;
  const acceptedRoughCutReady = contentDecisionsReady && acceptedExportReady;
  const timingSealingRequired = Boolean(formalTrial || timingBaseline);
  const finalLabelingReady = acceptedRoughCutReady
    && (!timingSealingRequired || evidence.timing.complete);
  const timingOriginLocked = evidence.audit.derived.firstHumanDecisionRevision !== null
    && evidence.timing.state === "not_started";
  return (
    <details className="alpha-audit-panel" open={shouldOpenAlphaAuditPanel(evidence)}>
      <summary>
        <span><Flask size={14} weight="fill" />Alpha 验收</span>
        <small>
          候选 {evidence.progress.candidateLabeled}/{evidence.progress.candidateTotal}
          <b>·</b>
          边界 {evidence.progress.boundaryLabeled}/{evidence.progress.boundaryTotal}
        </small>
      </summary>
      <div className="alpha-audit-body">
        <p className="alpha-binding">
          REV {evidence.audit.project.revision} · {evidence.audit.project.sourceSha256.slice(0, 18)}…
          {evidence.progress.complete
            ? <strong><CheckCircle size={13} weight="fill" />本 revision 标注完成</strong>
            : null}
        </p>
        {formalTrial ? (
          <p className={`alpha-trial-status ${evidence.timing.state === "running" ? "active" : "locked"}`} role="status">
            <strong>正式 Alpha 样本</strong>
            {evidence.timing.state === "running"
              ? "计时正在运行，初剪修改已解锁。"
              : evidence.timing.state === "finished"
                ? "计时证据已封存，初剪结果不可继续修改。"
                : "初剪修改已锁定；登记对照并开始计时，或继续已有计时。"}
          </p>
        ) : null}
        <section className="alpha-timing" aria-label="初剪时间证据">
          <header>
            <strong>成对初剪用时</strong>
            <span>{timingStateLabel(evidence)}</span>
          </header>
          {!formalTrial ? (
            <p className="alpha-labeling-gate" role="status">
              非正式工程不采集提效时间。需要进入 Alpha 计时分母时，请用尚未审阅的新素材通过 <code>--alpha-trial</code> 建项。
            </p>
          ) : timingOriginLocked ? (
            <p className="alpha-labeling-gate" role="status">
              本工程已在 REV {evidence.audit.derived.firstHumanDecisionRevision} 开始人工内容取舍，不能事后启动正式计时；请用未开始审阅的新工程采集提效证据。
            </p>
          ) : null}
          {formalTrial && !timingBaseline ? (
            <form onSubmit={(event) => {
              event.preventDefault();
              const value = Number(baselineSeconds);
              if (Number.isFinite(value) && value > 0) {
                onBeginTiming(value, baselineMethod, baselineOperatorId.trim(), baselineEvidenceSha256.trim());
              }
            }}>
              <label>
                手工初剪对照（秒）
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={baselineSeconds}
                  disabled={busy || timingOriginLocked}
                  onChange={(event) => setBaselineSeconds(event.target.value)}
                  placeholder="例如 600"
                />
              </label>
              <label>
                操作者代号
                <input
                  type="text"
                  value={baselineOperatorId}
                  disabled={busy || timingOriginLocked}
                  onChange={(event) => setBaselineOperatorId(event.target.value)}
                  placeholder="例如 partner-01"
                />
              </label>
              <label className="alpha-proof-file">
                本地证据文件（不会上传）
                <input
                  type="file"
                  disabled={busy || timingOriginLocked}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    void hashBaselineEvidence(file);
                  }}
                />
                <small>录屏、编辑器日志或秒表记录只在此浏览器本地分块计算；AgentCut 不上传、不保存文件。</small>
              </label>
              <p className={`alpha-proof-status ${baselineHashState.status}`} role="status" aria-live="polite">
                {baselineHashState.status === "hashing"
                  ? `正在本地计算 ${baselineHashState.fileName ?? "证据文件"}… ${baselineHashState.percent ?? 0}%`
                  : baselineHashState.status === "ready"
                    ? `已完成 ${baselineHashState.fileName ?? "证据文件"} 的本地 SHA-256`
                    : baselineHashState.status === "error"
                      ? `计算失败：${baselineHashState.message ?? "请重试或手工粘贴 SHA-256"}`
                      : "也可在下方手工粘贴已有 SHA-256。"}
              </p>
              <label>
                证据 SHA-256（自动生成或手工粘贴）
                <input
                  type="text"
                  value={baselineEvidenceSha256}
                  disabled={busy || timingOriginLocked}
                  onChange={(event) => updateEvidenceSha256(event.target.value)}
                  placeholder="sha256:…"
                />
              </label>
              <label>
                证据来源
                <select
                  value={baselineMethod}
                  disabled={busy || timingOriginLocked}
                  onChange={(event) => setBaselineMethod(event.target.value as AlphaTimingBaselineMethod)}
                >
                  <option value="stopwatch">秒表</option>
                  <option value="screen_recording">录屏</option>
                  <option value="editor_log">编辑器日志</option>
                </select>
              </label>
              <button type="submit" disabled={busy
                || timingOriginLocked
                || baselineHashState.status === "hashing"
                || Number(baselineSeconds) <= 0
                || baselineOperatorId.trim().length === 0
                || !/^sha256:[a-f0-9]{64}$/i.test(baselineEvidenceSha256.trim())}
              >登记对照并开始计时</button>
            </form>
          ) : formalTrial && timingBaseline ? (
            <div className="alpha-timing-summary">
              <span>手工对照 <strong>{formatDuration(timingBaseline.manualBaselineSeconds)}</strong></span>
              <span>AgentCut 活跃 <strong>{formatDuration(evidence.timing.agentCutActiveSeconds)}</strong></span>
              <span>操作者承诺 <code>{timingBaseline.operatorIdHash.slice(0, 18)}…</code></span>
              <span>对照证据 <code>{timingBaseline.evidenceSha256.slice(0, 18)}…</code></span>
              {evidence.timing.complete ? (
                <p><CheckCircle size={13} weight="fill" />已形成成对时间证据 · {formatReduction(evidence)} 减少</p>
              ) : (
                <div className="alpha-timing-actions">
                  {evidence.timing.state === "running" ? (
                    <button type="button" disabled={busy} onClick={onPauseTiming}>暂停计时</button>
                  ) : (
                    <button type="button" disabled={busy || timingOriginLocked} onClick={onStartTiming}>
                      {evidence.timing.state === "paused" ? "继续计时" : "开始 AgentCut 计时"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="finish"
                    disabled={busy || evidence.timing.state === "running"
                      || evidence.timing.agentCutActiveSeconds <= 0
                      || Boolean(formalTrial && !acceptedRoughCutReady)}
                    title={formalTrial && !acceptedRoughCutReady
                      ? "正式样本需先完成全部内容取舍，并成功导出当前初剪"
                      : undefined}
                    onClick={onFinishTiming}
                  >完成本次计时</button>
                </div>
              )}
            </div>
          ) : null}
          {formalTrial && timingBaseline && !finalLabelingReady ? (
            <p className="alpha-labeling-gate" role="status">
              正式样本需完成全部内容取舍并成功导出当前初剪，之后才能封存计时证据。
            </p>
          ) : null}
          {formalTrial ? (
            <small>首次登记会在同一事务写入手工对照并立即开始计时，必须发生在第一次人工内容取舍前；计时可跨编辑 revision 连续累计，后台、空闲和服务中断不计入。</small>
          ) : null}
        </section>
        {!contentDecisionsReady ? (
          <p className="alpha-labeling-gate" role="status">
            先完成 {evidence.audit.review.pendingCandidateIds.length} 项内容取舍，再做最终候选与边界标注；否则 revision 变化会使旧结论失效。
          </p>
        ) : !acceptedExportReady ? (
          <p className="alpha-labeling-gate" role="status">
            先导出并通过当前初剪的质量检查，再做最终候选与边界标注；导出登记会推进 revision，提前标注会失效。
          </p>
        ) : timingSealingRequired && !evidence.timing.complete ? (
          <p className="alpha-labeling-gate" role="status">
            先完成本次计时，再试听并记录最终候选与边界标签；质量标注时间不会混入粗剪提效数据。
          </p>
        ) : null}
        {candidate ? (
          <section className="alpha-candidate-label" aria-label="当前候选人工标签">
            <small>当前候选 · {candidate.decision === "definite_remove" ? "明确删除" : "建议删除"}</small>
            <p>{candidate.text}</p>
            <div>
              <button
                type="button"
                className={candidate.humanLabel === "true_positive" ? "selected" : ""}
                disabled={busy || !finalLabelingReady}
                onClick={() => onLabelCandidate(candidate.candidateId, "true_positive")}
              >{candidate.humanLabel === "true_positive" ? "已确认正确" : "判断正确"}</button>
              <button
                type="button"
                className={candidate.humanLabel === "false_positive" ? "selected warning" : "warning"}
                disabled={busy || !finalLabelingReady}
                onClick={() => onLabelCandidate(candidate.candidateId, "false_positive")}
              >{candidate.humanLabel === "false_positive" ? "已标为误报" : "误报"}</button>
            </div>
          </section>
        ) : <p className="alpha-empty">当前 revision 没有候选。</p>}
        <div className="alpha-boundary-heading">
          <span>真实剪切边界</span>
          <small>试听剪后跳转，再判断是否吞字</small>
        </div>
        <div className="alpha-boundary-list">
          {evidence.audit.boundaries.length === 0 ? (
            <p className="alpha-empty">当前时间线没有实际剪切边界。</p>
          ) : evidence.audit.boundaries.map((boundary, index) => (
            <article className="alpha-boundary" key={boundary.boundaryId}>
              <header>
                <strong>边界 {index + 1}</strong>
                <span>{formatMicros(boundary.timelineMicros)} · 删除 {formatMicros(boundary.removedDurationMicros)}</span>
              </header>
              <button
                type="button"
                className="alpha-preview-boundary"
                onClick={() => onPreviewBoundary(boundary)}
              ><Play size={12} weight="fill" />试听剪后边界</button>
              <div className="alpha-boundary-labels">
                <button
                  type="button"
                  className={boundary.humanUsable === true ? "selected" : ""}
                  disabled={busy || !finalLabelingReady}
                  onClick={() => onLabelBoundary(boundary.boundaryId, true, [])}
                >可用</button>
                {boundaryIssues.map((issue) => (
                  <button
                    type="button"
                    key={issue.code}
                    className={boundary.humanUsable === false
                      && boundary.humanIssueCodes.includes(issue.code) ? "selected warning" : "warning"}
                    disabled={busy || !finalLabelingReady}
                    onClick={() => onLabelBoundary(boundary.boundaryId, false, [issue.code])}
                  >{issue.label}</button>
                ))}
              </div>
            </article>
          ))}
        </div>
        {formalTrial && acceptedRoughCutReady && evidence.timing.complete && evidence.progress.complete ? (
          <section className="alpha-collection-ready" aria-label="Alpha 证据收集就绪" role="status">
            <strong><CheckCircle size={13} weight="fill" />本 revision 已可收集</strong>
            <p>候选、边界、导出和成对计时证据均已封存。下一步由 Codex 或终端运行 <code>pnpm alpha:collect</code>，写入内容寻址 evidence bundle；重复运行保持幂等。</p>
          </section>
        ) : null}
      </div>
    </details>
  );
}

export function shouldOpenAlphaAuditPanel(evidence: AlphaAuditResponse): boolean {
  const contentDecisionsReady = evidence.audit.review.completed
    && evidence.audit.review.pendingCandidateIds.length === 0;
  const acceptedExportReady = evidence.audit.export?.quality.passed === true
    && evidence.audit.export.sourceRevision + 1 === evidence.audit.project.revision;
  const timingSealingRequired = Boolean(evidence.audit.project.alphaTrial || evidence.timing.baseline);
  const finalLabelingReady = contentDecisionsReady && acceptedExportReady
    && (!timingSealingRequired || evidence.timing.complete);
  const timingOriginLocked = evidence.audit.derived.firstHumanDecisionRevision !== null
    && evidence.timing.state === "not_started";
  const formalTimingNeedsAttention = Boolean(evidence.audit.project.alphaTrial)
    && !timingOriginLocked
    && !evidence.timing.complete;
  const formalCollectionReady = Boolean(evidence.audit.project.alphaTrial)
    && acceptedExportReady
    && evidence.timing.complete
    && evidence.progress.complete;
  return formalTimingNeedsAttention
    || (finalLabelingReady && !evidence.progress.complete)
    || formalCollectionReady;
}

function timingStateLabel(evidence: AlphaAuditResponse): string {
  if (!evidence.audit.project.alphaTrial) return "不计入";
  if (evidence.timing.complete) return "已完成";
  if (evidence.timing.state === "running") return "计时中";
  if (evidence.timing.state === "paused") return "已暂停";
  return evidence.timing.baseline ? "待开始" : "缺少对照";
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return minutes > 0 ? `${minutes}分${String(remainder).padStart(2, "0")}秒` : `${remainder}秒`;
}

function formatReduction(evidence: AlphaAuditResponse): string {
  const baseline = evidence.timing.baseline?.manualBaselineSeconds ?? 0;
  if (baseline <= 0) return "0.0%";
  return `${((baseline - evidence.timing.agentCutActiveSeconds) / baseline * 100).toFixed(1)}%`;
}

function formatMicros(value: number): string {
  const seconds = value / 1_000_000;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}.${String(Math.floor(seconds * 10) % 10)}`;
}
