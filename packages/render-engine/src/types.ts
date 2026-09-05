import type {
  CaptionCue,
  Rate,
  Time,
} from "@agentcut/timeline-schema";

/**
 * Alpha 导出画面适配：`contain`（默认）整幅缩放到画布内加黑边；
 * `cover` 等比放大填满画布并从中心裁掉多余部分（当前仅中心裁切，无人物跟踪）。
 */
export type RenderFitMode = "contain" | "cover";

export interface RenderSegment {
  clipId: string;
  assetId: string;
  inputPath: string;
  inputIndex: number;
  videoStreamOrdinal: number;
  audioStreamOrdinal: number;
  sourceStartMicros: number;
  durationMicros: number;
  timelineStartMicros: number;
  /** 源的显示宽高（旋转/SAR 调整后）；用于 fit 前的非方形像素归一化。 */
  sourceDisplayWidth: number;
  sourceDisplayHeight: number;
  /** 源的色彩传递特性（如 smpte2084=PQ、arib-std-b67=HLG）；未标记时缺省。 */
  sourceColorTransfer?: string;
  /**
   * 该段实际可用的源时长上界（微秒）：段尾超出源媒体尾部的部分（口播末句被
   * ASR 词边界微超、录屏末尾音频流短于容器）在源里不存在，滤镜图按视频流
   * 尾部拉伸凑齐会让最终段长溢出，必须把 trim 时长钳到真实可用媒体。
   */
  availableSourceMicros: number;
}

export interface RenderPlan {
  planHash: string;
  projectId: string;
  sourceRevision: number;
  sequenceId: string;
  transcriptArtifactId: string;
  width: number;
  height: number;
  frameRate: Rate;
  fitMode: RenderFitMode;
  timelineDuration: Time;
  /**
   * 渲染端实际可交付的时长（微秒）：各段钳到源可用媒体后的总和。末段越尾
   * （末句词边界微超、末尾音频短于容器）时小于 timelineDuration；质量门对
   * 它（而非理想时间线时长）保持 40ms 容差。
   */
  expectedOutputMicros: number;
  inputPaths: string[];
  segments: RenderSegment[];
  cues: CaptionCue[];
  removedWordIds: string[];
  partialWordIds: string[];
  warnings: string[];
  /** 任一输入源携带 HDR 传递特性（PQ/HLG）时为 true；当前管线不色调映射，输出为近似 SDR。 */
  sourceHdr?: boolean;
}

export interface PreviewSegment {
  clipId: string;
  assetId: string;
  timelineStartSeconds: number;
  sourceStartSeconds: number;
  durationSeconds: number;
}

export interface PreviewPlan {
  revision: number;
  planHash: string;
  durationSeconds: number;
  segments: PreviewSegment[];
}

export type RenderErrorCode =
  | "INVALID_CONFIGURATION"
  | "UNSUPPORTED_TIMELINE"
  | "UNSUPPORTED_FIT_MODE"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_INTEGRITY_FAILED"
  | "RENDER_CANCELLED"
  | "RENDER_FAILED"
  | "PROBE_FAILED"
  | "QUALITY_FAILED"
  | "OUTPUT_EXISTS"
  | "REVISION_CONFLICT";

export class RenderError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RenderError";
  }
}
