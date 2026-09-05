import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import {
  analyzeSemanticReview,
  batchAcceptCandidates,
  beginAlphaTiming,
  cancelExport,
  createExport,
  deleteSpeechGap,
  deleteTranscriptSelection,
  fetchAlphaAudit,
  fetchCandidatePreview,
  fetchExport,
  fetchReview,
  fetchUiSession,
  finishAlphaTiming,
  generateRoughCut,
  heartbeatAlphaTiming,
  keepRemainingCandidates,
  labelAlphaBoundary,
  labelAlphaCandidate,
  pauseAlphaTiming,
  pairUiSession,
  previewTranscriptSelection,
  previewSpeechGap,
  reconsiderCandidate,
  resolveApproval,
  rotateUiBootstrap,
  revokeAgentSession,
  restoreTransaction,
  reviewCandidate,
  ReviewApiError,
  seconds,
  startAlphaTiming,
  type AlphaAuditBoundary,
  type AlphaBoundaryIssueCode,
  type AlphaTimingBaselineMethod,
  type AlphaTimingPauseReason,
  type AlphaAuditResponse,
  type AgentSessionSummary,
  type ApprovalSummary,
  type CandidateSelection,
  type CandidatePreviewResponse,
  type ExportJobResponse,
  type ExportPreset,
  type ReviewResponse,
  type ReviewToken,
  type SelectionPreviewResponse,
  type SpeechGap,
  type SpeechGapPreviewResponse,
  type UiSessionResponse,
} from "./api.js";
import { PlayerPanel, type PreviewMode } from "./components/PlayerPanel.js";
import { ReviewHeader, type CompactPanel } from "./components/ReviewHeader.js";
import { ReviewSidebar } from "./components/ReviewSidebar.js";
import { TimelinePanel } from "./components/TimelinePanel.js";
import { TranscriptPanel } from "./components/TranscriptPanel.js";
import { UiAccessGate } from "./components/UiAccessGate.js";
import {
  candidatePosition,
  isActionablePendingCandidate,
  isBatchAcceptableCandidate,
  isPendingCandidate,
  nextUnlabeledAlphaCandidateId,
  nextPendingCandidateId,
  selectRelativeCandidateId,
} from "./review-navigation.js";
import { useLoopPreview } from "./useLoopPreview.js";
import { useReviewKeyboard } from "./useReviewKeyboard.js";
import {
  candidateCutLoopWindow,
  sourceToTimeline,
  sourceToTimelineAnchor,
  timelineToSource,
} from "./preview-playback.js";
import {
  MutationOutcomeUnknownError,
  MutationRequestRegistry,
  runStableMutation,
} from "./mutation-requests.js";

export function App() {
  const [uiSession, setUiSession] = useState<UiSessionResponse>();
  const [pairingCode, setPairingCode] = useState("");
  const [uiAccessBusy, setUiAccessBusy] = useState(false);
  const [uiAccessError, setUiAccessError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    const fragmentToken = uiBootstrapFromValue(window.location.hash);
    if (fragmentToken) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    void (fragmentToken ? pairUiSession(fragmentToken) : fetchUiSession())
      .then((session) => {
        if (!cancelled) setUiSession(session);
      })
      .catch((caught) => {
        if (!cancelled) {
          setUiSession({ authenticated: false });
          setUiAccessError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => { cancelled = true; };
  }, []);

  const pairBrowser = async () => {
    const bootstrapToken = uiBootstrapFromValue(pairingCode);
    if (!bootstrapToken) {
      setUiAccessError("请输入 Studio 启动终端显示的完整配对链接或授权码。");
      return;
    }
    setUiAccessBusy(true);
    setUiAccessError(undefined);
    try {
      const session = await pairUiSession(bootstrapToken);
      setPairingCode("");
      setUiSession(session);
    } catch (caught) {
      setUiAccessError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setUiAccessBusy(false);
    }
  };

  if (uiSession?.authenticated !== true) {
    return (
      <UiAccessGate
        pairingCode={pairingCode}
        busy={uiAccessBusy}
        {...(uiAccessError ? { error: uiAccessError } : {})}
        checking={uiSession === undefined && uiAccessError === undefined}
        onPairingCodeChange={setPairingCode}
        onPair={() => void pairBrowser()}
      />
    );
  }
  return (
    <StudioWorkspace
      uiCredentialGeneration={uiSession.generation ?? 0}
      onRotateUiBootstrap={async (requestId) => {
        const session = await rotateUiBootstrap(requestId);
        setUiSession(session);
        return session;
      }}
      onUiSessionInvalid={() => setUiSession({ authenticated: false, reason: "expired" })}
    />
  );
}

function StudioWorkspace({
  uiCredentialGeneration,
  onRotateUiBootstrap,
  onUiSessionInvalid,
}: {
  uiCredentialGeneration: number;
  onRotateUiBootstrap: (requestId: string) => Promise<UiSessionResponse>;
  onUiSessionInvalid: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [activeWordId, setActiveWordId] = useState<string>();
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>();
  const [selectedSpeechGapId, setSelectedSpeechGapId] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [highRiskConfirmedCandidateId, setHighRiskConfirmedCandidateId] = useState<string>();
  const [keepRemainingConfirmationRevision, setKeepRemainingConfirmationRevision] = useState<number>();
  const [batchReviewMode, setBatchReviewMode] = useState(false);
  const [batchSelectedIds, setBatchSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [compactPanel, setCompactPanel] = useState<CompactPanel>("transcript");
  const [playbackTime, setPlaybackTime] = useState(0);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("rough-cut");
  const [previewSegmentIndex, setPreviewSegmentIndex] = useState(0);
  const [candidatePreview, setCandidatePreview] = useState<CandidatePreviewResponse>();
  const [candidatePreviewBusyId, setCandidatePreviewBusyId] = useState<string>();
  const [selectionPreview, setSelectionPreview] = useState<
    SelectionPreviewResponse | SpeechGapPreviewResponse
  >();
  const [selectionPreviewBusy, setSelectionPreviewBusy] = useState(false);
  const [editedLoopWindow, setEditedLoopWindow] = useState<{
    startSeconds: number;
    endSeconds: number;
  }>();
  const [exportJob, setExportJob] = useState<ExportJobResponse>();
  const [exportBusy, setExportBusy] = useState(false);
  const [auditBusy, setAuditBusy] = useState(false);
  const uiRotationRequestId = useRef<string | undefined>(undefined);
  const [mutationRequests] = useState(() => new MutationRequestRegistry());
  const virtualPreviewRequestGeneration = useRef(0);
  const { isLooping, startLoop, stopLoop } = useLoopPreview(videoRef);
  const { data, error, isLoading, mutate } = useSWR("/api/review", fetchReview, {
    revalidateOnFocus: false,
  });
  const {
    data: alphaEvidence,
    error: alphaEvidenceError,
    mutate: mutateAlphaEvidence,
  } = useSWR("/api/alpha-audit", fetchAlphaAudit, { revalidateOnFocus: false });
  const selectedCandidate = data?.review.candidates.find((candidate) =>
    candidate.candidateId === selectedCandidateId,
  ) ?? data?.review.candidates.find(isActionablePendingCandidate)
    ?? data?.review.candidates.find(isPendingCandidate)
    ?? data?.review.candidates[0];
  const resolvedSelectedCandidateId = selectedCandidate?.candidateId;
  const virtualPreview = candidatePreview ?? selectionPreview;
  const activePreview = virtualPreview && virtualPreview.baseRevision === data?.project.revision
    ? virtualPreview.preview
    : data?.preview;
  const canonicalTimelinePlaybackTime = (() => {
    if (!data?.preview?.segments.length) return playbackTime;
    if (previewMode === "rough-cut" && !virtualPreview) return playbackTime;
    const sourceTime = previewMode === "original"
      ? playbackTime
      : activePreview?.segments.length
        ? timelineToSource(activePreview.segments, playbackTime).sourceSeconds
        : playbackTime;
    return sourceToTimelineAnchor(data.preview.segments, sourceTime)?.timelineSeconds ?? 0;
  })();
  const alphaTrialEditingLocked = Boolean(alphaEvidence?.audit.project.alphaTrial)
    && alphaEvidence?.timing.state !== "running";
  const alphaTrialEditingLockReason = alphaTrialEditingLocked
    ? alphaEvidence?.timing.state === "finished"
      ? "正式 Alpha 样本计时已完成，初剪结果不可继续修改"
      : "正式 Alpha 样本必须先开始或继续计时"
    : undefined;

  useEffect(() => {
    mutationRequests.clearScope("project-write");
    mutationRequests.clearScope("export-create");
    setHighRiskConfirmedCandidateId(undefined);
    setKeepRemainingConfirmationRevision(undefined);
    setCandidatePreview(undefined);
    setSelectionPreview(undefined);
    setSelectedSpeechGapId(undefined);
    setEditedLoopWindow(undefined);
  }, [data?.project.revision, mutationRequests]);

  useEffect(() => {
    setBatchSelectedIds((selected) => selected.filter((candidateId) =>
      data?.review.candidates.some((candidate) =>
        candidate.candidateId === candidateId && isBatchAcceptableCandidate(candidate))));
    if (data && !data.review.candidates.some(isBatchAcceptableCandidate)) {
      setBatchReviewMode(false);
    }
  }, [data?.review.candidates]);

  useEffect(() => {
    if (data?.project.revision === undefined) return;
    void mutateAlphaEvidence();
  }, [data?.project.revision, mutateAlphaEvidence]);

  useEffect(() => {
    if (!alphaEvidence || alphaEvidence.timing.state !== "running"
      || !alphaEvidence.timing.activeSessionId) return;
    const sessionId = alphaEvidence.timing.activeSessionId;
    const binding = {
      baseRevision: alphaEvidence.audit.project.revision,
      sourceSha256: alphaEvidence.audit.project.sourceSha256,
    };
    let lastInteractionAt = Date.now();
    let inFlight = false;
    const markInteraction = () => { lastInteractionAt = Date.now(); };
    const sync = async (operation: () => Promise<AlphaAuditResponse>) => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await operation();
        await mutateAlphaEvidence(next, { revalidate: false });
      } catch (caught) {
        await mutateAlphaEvidence();
        if (caught instanceof MutationOutcomeUnknownError) {
          mutationRequests.clearScope(caught.scope);
        }
      } finally {
        inFlight = false;
      }
    };
    const pause = (reason: AlphaTimingPauseReason) => {
      const payload = { action: "pause-timing", ...binding, sessionId, reason };
      return sync(() => runStableMutation(
        mutationRequests,
        "alpha-timing-control",
        payload,
        (requestId) => pauseAlphaTiming({ requestId, ...binding, sessionId, reason }),
      ));
    };
    const onVisibilityChange = () => {
      if (document.hidden) void pause("page_hidden");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pointerdown", markInteraction, { passive: true });
    window.addEventListener("keydown", markInteraction);
    const timer = window.setInterval(() => {
      if (document.hidden) {
        void pause("page_hidden");
      } else if (Date.now() - lastInteractionAt >= 60_000) {
        void pause("idle");
      } else {
        void sync(() => heartbeatAlphaTiming({
          requestId: crypto.randomUUID(),
          ...binding,
          sessionId,
        }));
      }
    }, 15_000);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pointerdown", markInteraction);
      window.removeEventListener("keydown", markInteraction);
    };
  }, [
    alphaEvidence?.audit.project.revision,
    alphaEvidence?.audit.project.sourceSha256,
    alphaEvidence?.timing.activeSessionId,
    alphaEvidence?.timing.state,
    mutationRequests,
    mutateAlphaEvidence,
  ]);

  useEffect(() => {
    const latest = data?.exports?.at(-1);
    if (!latest) return;
    setExportJob((current) => {
      if (
        current?.jobId === latest.jobId
        && current.status === latest.status
        && current.progress === latest.progress
        && current.cancelRequested === latest.cancelRequested
        && current.canCancel === latest.canCancel
        && current.mediaUrl === latest.mediaUrl
        && current.captionUrl === latest.captionUrl
      ) return current;
      return latest;
    });
  }, [data?.exports]);

  useEffect(() => {
    if (!exportJob || (exportJob.status !== "pending" && exportJob.status !== "running")) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchExport(exportJob.jobId).then(async (next) => {
        if (cancelled) return;
        setExportJob(next);
        if (next.status === "succeeded") await mutate();
      }).catch((caught) => {
        if (!cancelled) setActionError(caught instanceof Error ? caught.message : String(caught));
      });
    }, 750);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [exportJob, mutate]);

  const stopVirtualPreview = () => {
    virtualPreviewRequestGeneration.current += 1;
    setCandidatePreview(undefined);
    setCandidatePreviewBusyId(undefined);
    setSelectionPreview(undefined);
    setSelectionPreviewBusy(false);
    setEditedLoopWindow(undefined);
    setPreviewMode("original");
    if (videoRef.current) setPlaybackTime(videoRef.current.currentTime);
  };

  const seekToken = (token: ReviewToken) => {
    const video = videoRef.current;
    if (!video) return;
    stopLoop();
    stopVirtualPreview();
    const sourceSeconds = seconds(token.sourceRange.start);
    const timelinePosition = data?.preview
      ? sourceToTimeline(data.preview.segments, sourceSeconds)
      : undefined;
    if (timelinePosition) {
      setPreviewMode("rough-cut");
      setPreviewSegmentIndex(timelinePosition.segmentIndex);
      video.currentTime = sourceSeconds;
      setPlaybackTime(timelinePosition.timelineSeconds);
    } else {
      setPreviewMode("original");
      video.currentTime = sourceSeconds;
      setPlaybackTime(sourceSeconds);
    }
    setActiveWordId(token.wordId);
    void video.play().catch(() => undefined);
  };

  const seekTimeline = (timeSeconds: number) => {
    stopVirtualPreview();
    seekEditedTimeline(data?.preview, timeSeconds);
  };

  const seekActiveTimeline = (timeSeconds: number) => {
    seekEditedTimeline(activePreview, timeSeconds);
  };

  const seekEditedTimeline = (
    preview: ReviewResponse["preview"],
    timeSeconds: number,
  ) => {
    const video = videoRef.current;
    if (!video) return;
    stopLoop();
    if (!preview?.segments.length) return;
    const source = timelineToSource(preview.segments, timeSeconds);
    setPreviewMode("rough-cut");
    setPreviewSegmentIndex(source.segmentIndex);
    video.currentTime = source.sourceSeconds;
    setPlaybackTime(timeSeconds);
  };

  const changePreviewMode = (mode: PreviewMode) => {
    const video = videoRef.current;
    setPreviewMode(mode);
    stopLoop();
    if (!video || mode === "original" || !activePreview?.segments.length) return;
    const retained = sourceToTimeline(activePreview.segments, video.currentTime);
    const target = retained ?? { segmentIndex: 0, timelineSeconds: 0 };
    const source = timelineToSource(activePreview.segments, target.timelineSeconds);
    setPreviewSegmentIndex(source.segmentIndex);
    setPlaybackTime(target.timelineSeconds);
    video.currentTime = source.sourceSeconds;
  };

  const previewCandidate = (candidate: CandidateSelection) => {
    stopVirtualPreview();
    setPreviewMode("original");
    startLoop(candidate.sourceRange);
  };

  const previewCandidateEvidence = (
    evidence: NonNullable<CandidateSelection["evidence"]>[number],
  ) => {
    stopVirtualPreview();
    setPreviewMode("original");
    setActiveWordId(evidence.wordIds[0]);
    startLoop(evidence.sourceRange);
  };

  const previewCandidateCut = async (candidate: CandidateSelection) => {
    if (!data) return;
    if (candidatePreview?.candidateId === candidate.candidateId) {
      stopVirtualPreview();
      return;
    }
    stopLoop();
    stopVirtualPreview();
    const requestGeneration = virtualPreviewRequestGeneration.current;
    setCandidatePreviewBusyId(candidate.candidateId);
    setActionError(undefined);
    try {
      const response = await fetchCandidatePreview(candidate.candidateId, data.project.revision);
      if (virtualPreviewRequestGeneration.current !== requestGeneration) return;
      const candidateEnd = seconds(candidate.sourceRange.start) + seconds(candidate.sourceRange.duration);
      const window = candidateCutLoopWindow(
        response.preview.segments,
        candidateEnd,
        response.preview.durationSeconds,
      );
      setCandidatePreview(response);
      setEditedLoopWindow(window);
      const source = timelineToSource(response.preview.segments, window.startSeconds);
      setPreviewMode("rough-cut");
      setPreviewSegmentIndex(source.segmentIndex);
      setPlaybackTime(window.startSeconds);
      if (videoRef.current) {
        videoRef.current.currentTime = source.sourceSeconds;
        void videoRef.current.play().catch(() => undefined);
      }
    } catch (caught) {
      if (virtualPreviewRequestGeneration.current !== requestGeneration) return;
      if (isUiSessionError(caught)) {
        onUiSessionInvalid();
      } else if (caught instanceof ReviewApiError && caught.code === "REVISION_CONFLICT") {
        await mutate();
        setNotice("工程已更新，删除效果试听已取消；请基于最新候选重新试听。");
      } else {
        setActionError(caught instanceof Error ? caught.message : String(caught));
      }
      stopVirtualPreview();
    } finally {
      if (virtualPreviewRequestGeneration.current === requestGeneration) {
        setCandidatePreviewBusyId(undefined);
      }
    }
  };

  const previewSelectionCut = async (wordIds: string[]) => {
    if (!data || wordIds.length === 0) return;
    stopLoop();
    stopVirtualPreview();
    const requestGeneration = virtualPreviewRequestGeneration.current;
    setSelectionPreviewBusy(true);
    setActionError(undefined);
    try {
      const response = await previewTranscriptSelection({
        wordIds,
        baseRevision: data.project.revision,
      });
      if (virtualPreviewRequestGeneration.current !== requestGeneration) return;
      const finalToken = [...data.review.tokens].reverse().find((token) =>
        wordIds.includes(token.wordId),
      );
      if (!finalToken) throw new Error("选中文字已不在当前 Transcript 中");
      const selectionEnd = seconds(finalToken.sourceRange.start)
        + seconds(finalToken.sourceRange.duration);
      const window = candidateCutLoopWindow(
        response.preview.segments,
        selectionEnd,
        response.preview.durationSeconds,
      );
      setSelectionPreview(response);
      setEditedLoopWindow(window);
      const source = timelineToSource(response.preview.segments, window.startSeconds);
      setPreviewMode("rough-cut");
      setPreviewSegmentIndex(source.segmentIndex);
      setPlaybackTime(window.startSeconds);
      if (videoRef.current) {
        videoRef.current.currentTime = source.sourceSeconds;
        void videoRef.current.play().catch(() => undefined);
      }
    } catch (caught) {
      if (virtualPreviewRequestGeneration.current !== requestGeneration) return;
      if (isUiSessionError(caught)) {
        onUiSessionInvalid();
      } else if (caught instanceof ReviewApiError && caught.code === "REVISION_CONFLICT") {
        await mutate();
        setNotice("工程已更新，文字删除效果试听已取消；请重新选择当前文字范围。");
      } else {
        setActionError(caught instanceof Error ? caught.message : String(caught));
      }
      stopVirtualPreview();
    } finally {
      if (virtualPreviewRequestGeneration.current === requestGeneration) {
        setSelectionPreviewBusy(false);
      }
    }
  };

  const previewSpeechGapCut = async (gap: SpeechGap) => {
    if (!data) return;
    stopLoop();
    stopVirtualPreview();
    const requestGeneration = virtualPreviewRequestGeneration.current;
    setSelectionPreviewBusy(true);
    setActionError(undefined);
    try {
      const response = await previewSpeechGap({
        gapId: gap.gapId,
        baseRevision: data.project.revision,
      });
      if (virtualPreviewRequestGeneration.current !== requestGeneration) return;
      const gapEnd = seconds(gap.sourceRange.start) + seconds(gap.sourceRange.duration);
      const window = candidateCutLoopWindow(
        response.preview.segments,
        gapEnd,
        response.preview.durationSeconds,
      );
      setSelectionPreview(response);
      setEditedLoopWindow(window);
      const source = timelineToSource(response.preview.segments, window.startSeconds);
      setPreviewMode("rough-cut");
      setPreviewSegmentIndex(source.segmentIndex);
      setPlaybackTime(window.startSeconds);
      if (videoRef.current) {
        videoRef.current.currentTime = source.sourceSeconds;
        void videoRef.current.play().catch(() => undefined);
      }
    } catch (caught) {
      if (virtualPreviewRequestGeneration.current !== requestGeneration) return;
      if (isUiSessionError(caught)) {
        onUiSessionInvalid();
      } else if (caught instanceof ReviewApiError && caught.code === "REVISION_CONFLICT") {
        await mutate();
        setNotice("工程已更新，无口播画面试听已取消；请基于当前时间线重新选择。");
      } else {
        setActionError(caught instanceof Error ? caught.message : String(caught));
      }
      stopVirtualPreview();
    } finally {
      if (virtualPreviewRequestGeneration.current === requestGeneration) {
        setSelectionPreviewBusy(false);
      }
    }
  };

  const recoverUnknownReviewMutation = async (caught: unknown): Promise<boolean> => {
    if (!(caught instanceof MutationOutcomeUnknownError)) return false;
    try {
      const refreshed = await mutate();
      mutationRequests.clearScope(caught.scope);
      setActionError(undefined);
      setNotice(
        `写入响应中断，已从 SQLite 重新读取${refreshed ? ` REV ${refreshed.project.revision}` : "当前工程"}；请按最新状态确认是否仍需操作。`,
      );
    } catch (refreshError) {
      if (isUiSessionError(refreshError)) onUiSessionInvalid();
      setActionError(caught.message);
    }
    return true;
  };

  const recoverUnknownAuditMutation = async (caught: unknown): Promise<boolean> => {
    if (!(caught instanceof MutationOutcomeUnknownError)) return false;
    try {
      await mutateAlphaEvidence();
      mutationRequests.clearScope(caught.scope);
      setActionError(undefined);
      setNotice("Alpha 写入响应中断，已从证据 SQLite 重新读取；请按最新标签或计时状态确认是否仍需操作。");
    } catch (refreshError) {
      if (isUiSessionError(refreshError)) onUiSessionInvalid();
      setActionError(caught.message);
    }
    return true;
  };

  const startExport = async (preset: ExportPreset) => {
    if (!data) return;
    setExportBusy(true);
    setActionError(undefined);
    setNotice(undefined);
    try {
      const payload = { action: "create-export", baseRevision: data.project.revision, preset };
      const job = await runStableMutation(
        mutationRequests,
        "export-create",
        payload,
        (requestId) => createExport({ requestId, baseRevision: data.project.revision, preset }),
      );
      setExportJob(job);
      setNotice(preset === "vertical-9-16"
        ? "9:16 竖屏导出已进入本地后台队列；竖屏为中心裁切近似取景，导出完成后请目检构图。"
        : "导出任务已进入本地后台队列；你可以继续查看工程状态。");
    } catch (caught) {
      if (await recoverUnknownReviewMutation(caught)) {
        // The refreshed review projection is authoritative for job state.
      } else if (isUiSessionError(caught)) {
        onUiSessionInvalid();
      } else {
        setActionError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setExportBusy(false);
    }
  };

  const stopExport = async () => {
    if (!exportJob) return;
    setExportBusy(true);
    setActionError(undefined);
    setNotice(undefined);
    try {
      const job = await runStableMutation(
        mutationRequests,
        `export-cancel:${exportJob.jobId}`,
        { action: "cancel-export", jobId: exportJob.jobId },
        (requestId) => cancelExport(exportJob.jobId, requestId),
      );
      setExportJob(job);
      setNotice(job.status === "cancelled"
        ? "导出已取消；没有发布或登记半成片。"
        : "已请求取消；正在等待本地渲染进程安全停止。若响应中断，可继续查询同一 job。"
      );
    } catch (caught) {
      if (await recoverUnknownReviewMutation(caught)) {
        // The refreshed review projection is authoritative for job state.
      } else if (isUiSessionError(caught)) onUiSessionInvalid();
      else setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExportBusy(false);
    }
  };

  const performMutation = async (
    operation: () => Promise<ReviewResponse>,
    successMessage: string,
  ): Promise<ReviewResponse | undefined> => {
    stopVirtualPreview();
    setBusy(true);
    setActionError(undefined);
    setNotice(undefined);
    setHighRiskConfirmedCandidateId(undefined);
    try {
      const next = await operation();
      await mutate(next, { revalidate: false });
      setNotice(successMessage);
      return next;
    } catch (caught) {
      if (await recoverUnknownReviewMutation(caught)) {
        // The refreshed review projection resolves the ambiguous write outcome.
      } else if (isUiSessionError(caught)) {
        onUiSessionInvalid();
      } else if (caught instanceof ReviewApiError && caught.code === "REVISION_CONFLICT") {
        const refreshed = await mutate();
        setNotice(`工程已更新到 REV ${refreshed?.project.revision ?? "?"}，请重新确认当前候选。`);
      } else {
        setActionError(caught instanceof Error ? caught.message : String(caught));
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const performAuditMutation = async (
    operation: () => Promise<AlphaAuditResponse>,
    successMessage: string,
  ): Promise<boolean> => {
    setAuditBusy(true);
    setActionError(undefined);
    setNotice(undefined);
    try {
      const next = await operation();
      await mutateAlphaEvidence(next, { revalidate: false });
      setNotice(successMessage);
      return true;
    } catch (caught) {
      if (await recoverUnknownAuditMutation(caught)) {
        // The refreshed evidence projection resolves the ambiguous write outcome.
      } else if (isUiSessionError(caught)) {
        onUiSessionInvalid();
      } else if (caught instanceof ReviewApiError
        && (caught.code === "REVISION_CONFLICT" || caught.code === "AUDIT_BINDING_CONFLICT")) {
        await mutateAlphaEvidence();
        setNotice("工程内容已经变化，Alpha 验收已切换到最新 revision，请重新试听标注。");
      } else {
        setActionError(caught instanceof Error ? caught.message : String(caught));
      }
      return false;
    } finally {
      setAuditBusy(false);
    }
  };

  const labelAuditCandidate = (
    candidateId: string,
    label: "true_positive" | "false_positive",
  ) => {
    if (!alphaEvidence) return;
    const payload = {
      action: "label-candidate",
      candidateId,
      baseRevision: alphaEvidence.audit.project.revision,
      sourceSha256: alphaEvidence.audit.project.sourceSha256,
      label,
    };
    void performAuditMutation(
      () => runStableMutation(
        mutationRequests,
        `alpha-candidate:${candidateId}`,
        payload,
        (requestId) => labelAlphaCandidate({ requestId, ...payload }),
      ),
      label === "true_positive" ? "已记录：该候选判断正确。" : "已记录：该候选是误报。",
    ).then((succeeded) => {
      if (!succeeded) return;
      const nextId = nextUnlabeledAlphaCandidateId(alphaEvidence.audit.candidates, candidateId);
      if (nextId) setSelectedCandidateId(nextId);
    });
  };

  const labelAuditBoundary = (
    boundaryId: string,
    usable: boolean,
    issueCodes: AlphaBoundaryIssueCode[],
  ) => {
    if (!alphaEvidence) return;
    const payload = {
      action: "label-boundary",
      boundaryId,
      baseRevision: alphaEvidence.audit.project.revision,
      sourceSha256: alphaEvidence.audit.project.sourceSha256,
      usable,
      issueCodes,
    };
    void performAuditMutation(
      () => runStableMutation(
        mutationRequests,
        `alpha-boundary:${boundaryId}`,
        payload,
        (requestId) => labelAlphaBoundary({ requestId, ...payload }),
      ),
      usable ? "已记录：该剪切边界可用。" : "已记录该边界问题，后续会进入边界修正样本。",
    );
  };

  const previewAuditBoundary = (boundary: AlphaAuditBoundary) => {
    stopLoop();
    const start = Math.max(0, boundary.timelineMicros / 1_000_000 - 1.2);
    seekTimeline(start);
    void videoRef.current?.play().catch(() => undefined);
  };

  const beginTiming = (
    manualBaselineSeconds: number,
    method: AlphaTimingBaselineMethod,
    operatorId: string,
    evidenceSha256: string,
  ) => {
    if (!alphaEvidence) return;
    const payload = {
      action: "begin-timing",
      baseRevision: alphaEvidence.audit.project.revision,
      sourceSha256: alphaEvidence.audit.project.sourceSha256,
      manualBaselineSeconds,
      method,
      operatorId,
      evidenceSha256,
    };
    void performAuditMutation(
      () => runStableMutation(
        mutationRequests,
        "alpha-timing-control",
        payload,
        (requestId) => beginAlphaTiming({
          requestId,
          baseRevision: payload.baseRevision,
          sourceSha256: payload.sourceSha256,
          manualBaselineSeconds: payload.manualBaselineSeconds,
          method: payload.method,
          operatorId: payload.operatorId,
          evidenceSha256: payload.evidenceSha256,
          sessionId: `studio-${requestId}`,
        }),
      ),
      "已原子记录手工对照，并开始采集 AgentCut 活跃用时。",
    );
  };

  const startTiming = () => {
    if (!alphaEvidence) return;
    const payload = {
      action: "start-timing",
      baseRevision: alphaEvidence.audit.project.revision,
      sourceSha256: alphaEvidence.audit.project.sourceSha256,
    };
    void performAuditMutation(
      () => runStableMutation(
        mutationRequests,
        "alpha-timing-control",
        payload,
        (requestId) => startAlphaTiming({
          requestId,
          baseRevision: payload.baseRevision,
          sourceSha256: payload.sourceSha256,
          sessionId: `studio-${requestId}`,
        }),
      ),
      "AgentCut 活跃用时采集已开始。",
    );
  };

  const pauseTiming = () => {
    if (!alphaEvidence?.timing.activeSessionId) return;
    const payload = {
      action: "pause-timing",
      baseRevision: alphaEvidence.audit.project.revision,
      sourceSha256: alphaEvidence.audit.project.sourceSha256,
      sessionId: alphaEvidence.timing.activeSessionId,
      reason: "user" as const,
    };
    void performAuditMutation(
      () => runStableMutation(
        mutationRequests,
        "alpha-timing-control",
        payload,
        (requestId) => pauseAlphaTiming({
          requestId,
          baseRevision: payload.baseRevision,
          sourceSha256: payload.sourceSha256,
          sessionId: payload.sessionId,
          reason: payload.reason,
        }),
      ),
      "计时已暂停；暂停期间不会累计活跃用时。",
    );
  };

  const finishTiming = () => {
    if (!alphaEvidence) return;
    const payload = {
      action: "finish-timing",
      baseRevision: alphaEvidence.audit.project.revision,
      sourceSha256: alphaEvidence.audit.project.sourceSha256,
    };
    void performAuditMutation(
      () => runStableMutation(
        mutationRequests,
        "alpha-timing-control",
        payload,
        (requestId) => finishAlphaTiming({
          requestId,
          baseRevision: payload.baseRevision,
          sourceSha256: payload.sourceSha256,
        }),
      ),
      "本项目的成对初剪用时证据已完成。",
    );
  };

  const restore = async (transactionId: string) => {
    if (!data) return;
    stopLoop();
    const payload = { action: "restore", transactionId, baseRevision: data.project.revision };
    await performMutation(
      () => runStableMutation(
        mutationRequests,
        "project-write",
        payload,
        (requestId) => restoreTransaction({ requestId, transactionId, baseRevision: data.project.revision }),
      ),
      "已恢复本次提交，源文件始终未被修改。",
    );
  };

  const undoLatestDeletion = () => {
    const target = data?.readiness?.undo;
    if (target) void restore(target.transactionId);
  };

  useEffect(() => {
    const undo = data?.readiness?.undo;
    if (!undo) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.shiftKey || busy || alphaTrialEditingLocked) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable
        || ["INPUT", "TEXTAREA", "SELECT", "VIDEO", "AUDIO"].includes(target.tagName))) return;
      event.preventDefault();
      void restore(undo.transactionId);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [data?.readiness?.undo, data?.project.revision, busy, alphaTrialEditingLocked]);

  const analyzeSemantic = async () => {
    if (!data) return;
    stopLoop();
    const payload = { action: "analyze-semantic", baseRevision: data.project.revision };
    await performMutation(
      () => runStableMutation(
        mutationRequests,
        "project-write",
        payload,
        (requestId) => analyzeSemanticReview({ requestId, baseRevision: data.project.revision }),
      ),
      "本地 AI 语义审阅完成；重复、改口和未完成表达已作为高风险候选加入待审队列。",
    );
  };

  const generateInitialRoughCut = async () => {
    if (!data) return;
    stopLoop();
    const payload = { action: "generate-rough-cut", baseRevision: data.project.revision };
    await performMutation(
      () => runStableMutation(
        mutationRequests,
        "project-write",
        payload,
        (requestId) => generateRoughCut({ requestId, baseRevision: data.project.revision }),
      ),
      "初剪已生成：明确的低风险停顿已提交，其余内容等待你试听确认。",
    );
  };

  const keepAllRemaining = async () => {
    if (!data) return;
    stopLoop();
    const payload = { action: "keep-remaining", baseRevision: data.project.revision };
    await performMutation(
      () => runStableMutation(
        mutationRequests,
        "project-write",
        payload,
        (requestId) => keepRemainingCandidates({ requestId, baseRevision: data.project.revision }),
      ),
      "所有剩余候选已锁定保留，初剪内容取舍已完成。",
    );
    setKeepRemainingConfirmationRevision(undefined);
  };

  const deleteSelection = async (wordIds: string[]) => {
    if (!data) return;
    stopLoop();
    const payload = { action: "delete-selection", baseRevision: data.project.revision, wordIds };
    await performMutation(
      () => runStableMutation(
        mutationRequests,
        "project-write",
        payload,
        (requestId) => deleteTranscriptSelection({
          requestId,
          baseRevision: data.project.revision,
          wordIds,
        }),
      ),
      `已手工删除 ${wordIds.length} 个连续词；本次修改可完整恢复。`,
    );
  };

  const deleteSelectedSpeechGap = async (gapId: string) => {
    if (!data) return;
    stopLoop();
    const payload = { action: "delete-speech-gap", baseRevision: data.project.revision, gapId };
    await performMutation(
      () => runStableMutation(
        mutationRequests,
        "project-write",
        payload,
        (requestId) => deleteSpeechGap({
          requestId,
          baseRevision: data.project.revision,
          gapId,
        }),
      ),
      "已删除选中的无口播画面并自动衔接前后内容；本次修改可完整恢复。",
    );
  };

  const accept = async (candidate: CandidateSelection) => {
    if (!data) return;
    if (candidate.overlapDecisionAnchorId
      && candidate.overlapDecisionAnchorId !== candidate.candidateId) {
      setNotice("该候选与更高风险主项重叠，请先决定冲突主项；当前操作没有写入时间线。");
      return;
    }
    const confirmHighRisk = candidate.risk === "high"
      && highRiskConfirmedCandidateId === candidate.candidateId;
    if (candidate.risk === "high" && !confirmHighRisk) {
      setNotice("高风险候选不会直接删除：请先循环试听，再勾选确认。未确认时快捷键 D 只会提示，不会写入时间线。");
      return;
    }
    stopLoop();
    const payload = {
      action: "accept-candidate",
      candidateId: candidate.candidateId,
      baseRevision: data.project.revision,
      confirmHighRisk,
    };
    const next = await performMutation(
      () => runStableMutation(
        mutationRequests,
        "project-write",
        payload,
        (requestId) => reviewCandidate({
          requestId,
          candidateId: candidate.candidateId,
          action: "accept",
          baseRevision: data.project.revision,
          ...(confirmHighRisk ? { confirmHighRisk: true } : {}),
        }),
      ),
      "已将候选作为可恢复事务提交。",
    );
    const nextCandidateId = next
      ? nextPendingCandidateId(next.review.candidates, candidate.candidateId)
      : undefined;
    if (nextCandidateId) setSelectedCandidateId(nextCandidateId);
  };

  const keep = async (candidate: CandidateSelection) => {
    if (!data) return;
    if (candidate.overlapDecisionAnchorId
      && candidate.overlapDecisionAnchorId !== candidate.candidateId) {
      setNotice("该候选与更高风险主项重叠，请先决定冲突主项；当前操作没有写入时间线。");
      return;
    }
    stopLoop();
    const payload = {
      action: "keep-candidate",
      candidateId: candidate.candidateId,
      baseRevision: data.project.revision,
    };
    const next = await performMutation(
      () => runStableMutation(
        mutationRequests,
        "project-write",
        payload,
        (requestId) => reviewCandidate({
          requestId,
          candidateId: candidate.candidateId,
          action: "keep",
          baseRevision: data.project.revision,
        }),
      ),
      "已保留并锁定对应原片范围，后续 Agent 不可覆盖。",
    );
    const nextCandidateId = next
      ? nextPendingCandidateId(next.review.candidates, candidate.candidateId)
      : undefined;
    if (nextCandidateId) setSelectedCandidateId(nextCandidateId);
  };

  const batchAcceptableCandidates = data?.review.candidates.filter(
    isBatchAcceptableCandidate,
  ) ?? [];

  const toggleBatchMode = () => {
    setBatchReviewMode((enabled) => !enabled);
    setBatchSelectedIds([]);
    stopLoop();
    stopVirtualPreview();
  };

  const toggleBatchCandidate = (candidateId: string) => {
    setBatchSelectedIds((selected) =>
      selected.includes(candidateId)
        ? selected.filter((id) => id !== candidateId)
        : [...selected, candidateId]);
  };

  const selectAllBatchCandidates = () => {
    setBatchSelectedIds(batchAcceptableCandidates.map((candidate) => candidate.candidateId));
  };

  const batchAccept = async () => {
    if (!data || batchSelectedIds.length === 0) return;
    stopLoop();
    const candidateIds = batchAcceptableCandidates
      .filter((candidate) => batchSelectedIds.includes(candidate.candidateId))
      .map((candidate) => candidate.candidateId);
    if (candidateIds.length === 0) return;
    const payload = {
      action: "batch-accept",
      candidateIds,
      baseRevision: data.project.revision,
    };
    const next = await performMutation(
      () => runStableMutation(
        mutationRequests,
        "project-write",
        payload,
        (requestId) => batchAcceptCandidates({
          requestId,
          candidateIds,
          baseRevision: data.project.revision,
        }),
      ),
      `已按一次可恢复事务批量删除 ${candidateIds.length} 个候选。`,
    );
    setBatchSelectedIds([]);
    const nextCandidateId = next
      ? nextPendingCandidateId(next.review.candidates, candidateIds[0]!)
      : undefined;
    if (nextCandidateId) setSelectedCandidateId(nextCandidateId);
  };

  const selectRelativeCandidate = (direction: -1 | 1) => {
    if (!data) return;
    const nextId = selectRelativeCandidateId(
      data.review.candidates,
      resolvedSelectedCandidateId,
      direction,
    );
    if (!nextId) return;
    stopLoop();
    stopVirtualPreview();
    setHighRiskConfirmedCandidateId(undefined);
    setSelectedCandidateId(nextId);
  };

  const undoCandidateDecision = (candidate: CandidateSelection) => {
    if (candidate.state === "committed_deleted" && candidate.transactionId) {
      void restore(candidate.transactionId);
    } else if (candidate.state === "reviewed_keep" && candidate.lockId) {
      void reconsider(candidate);
    }
  };

  useReviewKeyboard({
    candidate: selectedCandidate,
    busy: busy || candidatePreviewBusyId !== undefined,
    isLooping,
    cutPreviewActive: candidatePreview?.candidateId === resolvedSelectedCandidateId,
    onPrevious: () => selectRelativeCandidate(-1),
    onNext: () => selectRelativeCandidate(1),
    onPreview: previewCandidate,
    onStopPreview: stopLoop,
    onPreviewCut: (candidate) => void previewCandidateCut(candidate),
    onStopCutPreview: stopVirtualPreview,
    onAccept: (candidate) => void accept(candidate),
    onKeep: (candidate) => void keep(candidate),
    onUndo: undoCandidateDecision,
  });

  const reconsider = async (candidate: CandidateSelection) => {
    if (!data || !candidate.lockId) return;
    stopLoop();
    const payload = {
      action: "reconsider-candidate",
      lockId: candidate.lockId,
      baseRevision: data.project.revision,
    };
    await performMutation(
      () => runStableMutation(
        mutationRequests,
        "project-write",
        payload,
        (requestId) => reconsiderCandidate({
          requestId,
          lockId: candidate.lockId!,
          baseRevision: data.project.revision,
        }),
      ),
      "已解除保护，该候选回到待审阅状态。",
    );
  };

  const decideApproval = async (
    approval: ApprovalSummary,
    decision: "approve" | "deny",
  ) => {
    if (!data) return;
    stopLoop();
    const payload = {
      action: "resolve-approval",
      approvalId: approval.id,
      baseRevision: data.project.revision,
      decision,
    };
    await performMutation(
      () => runStableMutation(
        mutationRequests,
        `approval:${approval.id}`,
        payload,
        (requestId) => resolveApproval({ requestId, ...payload }),
      ),
      decision === "approve"
        ? "已批准精确候选范围；等待 Agent 使用一次性令牌应用。"
        : "已拒绝 Agent 的高风险删除请求。",
    );
  };

  const revokeSession = async (session: AgentSessionSummary) => {
    const payload = { action: "revoke-agent-session", sessionId: session.id };
    await performMutation(
      () => runStableMutation(
        mutationRequests,
        `agent-session:${session.id}`,
        payload,
        (requestId) => revokeAgentSession({ requestId, sessionId: session.id }),
      ),
      `已撤销 ${session.clientId} 的 Agent 会话；后续请求会被拒绝并写入访问审计。`,
    );
  };

  const rotateStudioAccess = async () => {
    setBusy(true);
    setActionError(undefined);
    const requestId = uiRotationRequestId.current ?? crypto.randomUUID();
    uiRotationRequestId.current = requestId;
    try {
      const session = await onRotateUiBootstrap(requestId);
      uiRotationRequestId.current = undefined;
      setNotice(`Studio 浏览器授权已轮换到第 ${session.generation ?? uiCredentialGeneration + 1} 代；其他浏览器需重新配对。`);
    } catch (caught) {
      if (isUiSessionError(caught)) onUiSessionInvalid();
      else setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <main className="status-screen">正在读取本地工程…</main>;
  if (error || !data) {
    return (
      <main className="status-screen error">
        <p>无法打开工程：{error?.message ?? "未知错误"}</p>
        <button
          type="button"
          className="retry-connection"
          onClick={() => void mutate()}
        >
          重试连接
        </button>
      </main>
    );
  }
  return (
    <main className="studio-shell">
      <ReviewHeader
        data={data}
        compactPanel={compactPanel}
        onCompactPanelChange={setCompactPanel}
        exportJob={exportJob}
        exportBusy={exportBusy}
        exportDisabledReason={alphaTrialEditingLockReason}
        onExport={startExport}
        onCancelExport={stopExport}
      />
      <section className={`workspace compact-${compactPanel}`} aria-label="AgentCut 通用剪辑工作区">
        <ReviewSidebar
          data={data}
          alphaEvidence={alphaEvidence}
          alphaEvidenceError={alphaEvidenceError instanceof Error ? alphaEvidenceError.message : undefined}
          auditBusy={auditBusy}
          candidate={selectedCandidate}
          candidatePosition={candidatePosition(data.review.candidates, resolvedSelectedCandidateId)}
          actionError={actionError}
          notice={notice}
          busy={busy}
          editingLocked={alphaTrialEditingLocked}
          isLooping={isLooping}
          cutPreviewActive={candidatePreview?.candidateId === resolvedSelectedCandidateId}
          cutPreviewBusy={candidatePreviewBusyId === resolvedSelectedCandidateId}
          highRiskConfirmed={highRiskConfirmedCandidateId === resolvedSelectedCandidateId}
          onAnalyzeSemantic={analyzeSemantic}
          onGenerateRoughCut={generateInitialRoughCut}
          onUndoLatest={undoLatestDeletion}
          keepRemainingConfirmation={keepRemainingConfirmationRevision === data.project.revision}
          onRequestKeepRemaining={() => setKeepRemainingConfirmationRevision(data.project.revision)}
          onCancelKeepRemaining={() => setKeepRemainingConfirmationRevision(undefined)}
          onKeepRemaining={keepAllRemaining}
          onSelectCandidate={(candidate) => {
            stopLoop();
            stopVirtualPreview();
            setHighRiskConfirmedCandidateId(undefined);
            setSelectedCandidateId(candidate.candidateId);
          }}
          onHighRiskConfirmedChange={(confirmed) => {
            setHighRiskConfirmedCandidateId(confirmed ? resolvedSelectedCandidateId : undefined);
          }}
          onPreviousCandidate={() => selectRelativeCandidate(-1)}
          onNextCandidate={() => selectRelativeCandidate(1)}
          onPreview={previewCandidate}
          onPreviewEvidence={previewCandidateEvidence}
          onStopPreview={stopLoop}
          onPreviewCut={(candidate) => void previewCandidateCut(candidate)}
          onStopCutPreview={stopVirtualPreview}
          onAccept={accept}
          onKeep={keep}
          onReconsider={reconsider}
          onRestore={restore}
          onResolveApproval={decideApproval}
          batchReviewMode={batchReviewMode}
          batchSelectedIds={batchSelectedIds}
          batchAcceptableCount={batchAcceptableCandidates.length}
          onToggleBatchMode={toggleBatchMode}
          onToggleBatchCandidate={toggleBatchCandidate}
          onSelectAllBatchCandidates={selectAllBatchCandidates}
          onClearBatchSelection={() => setBatchSelectedIds([])}
          onBatchAccept={() => void batchAccept()}
          onRevokeAgentSession={revokeSession}
          uiCredentialGeneration={uiCredentialGeneration}
          onRotateUiBootstrap={rotateStudioAccess}
          onLabelAuditCandidate={labelAuditCandidate}
          onPreviewAuditBoundary={previewAuditBoundary}
          onLabelAuditBoundary={labelAuditBoundary}
          onBeginTiming={beginTiming}
          onStartTiming={startTiming}
          onPauseTiming={pauseTiming}
          onFinishTiming={finishTiming}
        />
        <TranscriptPanel
          data={data}
          activeWordId={activeWordId}
          selectedCandidateId={selectedSpeechGapId ? undefined : resolvedSelectedCandidateId}
          onSeek={seekToken}
          onDeleteSelection={deleteSelection}
          selectedSpeechGapId={selectedSpeechGapId}
          onSelectSpeechGap={(gap) => {
            stopLoop();
            stopVirtualPreview();
            setSelectedSpeechGapId(gap?.gapId);
          }}
          onDeleteSpeechGap={deleteSelectedSpeechGap}
          onRestoreGap={(transactionId) => void restore(transactionId)}
          selectionPreviewActive={selectionPreview !== undefined}
          selectionPreviewBusy={selectionPreviewBusy}
          onPreviewSelection={(wordIds) => void previewSelectionCut(wordIds)}
          onPreviewSpeechGap={(gap) => void previewSpeechGapCut(gap)}
          onStopSelectionPreview={stopVirtualPreview}
          busy={busy}
          editingLocked={alphaTrialEditingLocked}
          onSelectCandidate={(candidate) => {
            stopLoop();
            stopVirtualPreview();
            setHighRiskConfirmedCandidateId(undefined);
            setSelectedSpeechGapId(undefined);
            setSelectedCandidateId(candidate.candidateId);
          }}
        />
        <PlayerPanel
          ref={videoRef}
          data={data}
          preview={activePreview}
          {...(candidatePreview
            ? { previewLabel: "待提交候选删除效果" }
            : selectionPreview
              ? { previewLabel: "gapId" in selectionPreview
                ? "待提交无口播画面删除效果"
                : "待提交文字删除效果" }
              : {})}
          {...(editedLoopWindow ? { editedLoopWindow } : {})}
          activeWordId={activeWordId}
          isLooping={isLooping}
          mode={previewMode}
          segmentIndex={previewSegmentIndex}
          playbackTimeSeconds={playbackTime}
          onModeChange={changePreviewMode}
          onSegmentChange={setPreviewSegmentIndex}
          onEditedSeek={seekActiveTimeline}
          onPlaybackTimeChange={setPlaybackTime}
        />
        <TimelinePanel
          data={data}
          selectedCandidateId={selectedSpeechGapId ? undefined : resolvedSelectedCandidateId}
          selectedSpeechGapId={selectedSpeechGapId}
          currentTimeSeconds={canonicalTimelinePlaybackTime}
          onSeek={seekTimeline}
          onSelectCandidate={(candidate) => {
            stopLoop();
            stopVirtualPreview();
            setHighRiskConfirmedCandidateId(undefined);
            setSelectedSpeechGapId(undefined);
            setSelectedCandidateId(candidate.candidateId);
          }}
          onSelectSpeechGap={(gap) => {
            stopLoop();
            stopVirtualPreview();
            setSelectedSpeechGapId(gap.gapId);
            setCompactPanel("transcript");
          }}
        />
      </section>
    </main>
  );
}

export function uiBootstrapFromValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const hashIndex = trimmed.indexOf("#");
  const fragment = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : trimmed.replace(/^#/, "");
  if (fragment.startsWith("ui-bootstrap=")) {
    const token = new URLSearchParams(fragment).get("ui-bootstrap")?.trim();
    return token && token.length >= 16 ? token : undefined;
  }
  return /^[A-Za-z0-9_-]{16,256}$/.test(trimmed) ? trimmed : undefined;
}

function isUiSessionError(value: unknown): value is ReviewApiError {
  return value instanceof ReviewApiError
    && (value.code === "UI_SESSION_REQUIRED" || value.code === "UI_SESSION_EXPIRED");
}
