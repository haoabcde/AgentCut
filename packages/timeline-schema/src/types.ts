export type ID = string;

export interface Rate {
  numerator: number;
  denominator: number;
}

export interface Time {
  value: number;
  rate: Rate;
}

export interface TimeRange {
  start: Time;
  duration: Time;
}

export interface Actor {
  kind: "user" | "agent" | "workflow";
  id: string;
}

export interface Provenance {
  createdBy: Actor;
  createdAt: string;
  reason: string;
  sourceArtifactIds?: ID[];
}

export interface Asset {
  id: ID;
  kind: "video" | "audio" | "image" | "font" | "generated";
  uri: string;
  contentHash: string;
  availability: "online" | "offline" | "missing";
  provenance: Provenance;
  metadata?: Record<string, unknown>;
}

export type ClipKind =
  | "media"
  | "caption"
  | "text"
  | "image"
  | "sticker"
  | "shape"
  | "nestedSequence"
  | "gap";

export interface Clip {
  id: ID;
  kind: ClipKind;
  assetId?: ID;
  sequenceId?: ID;
  streamIndex?: number;
  timelineRange: TimeRange;
  sourceRange?: TimeRange;
  enabled: boolean;
  transform?: Record<string, unknown>;
  audio?: Record<string, unknown>;
  content?: Record<string, unknown>;
  animations?: Array<Record<string, unknown>>;
  effects?: Array<Record<string, unknown>>;
  provenance: Provenance;
  metadata?: Record<string, unknown>;
}

export type TrackKind = "video" | "audio" | "caption" | "graphic";

export interface Track {
  id: ID;
  kind: TrackKind;
  name: string;
  order: number;
  locked: boolean;
  enabled: boolean;
  muted?: boolean;
  clips: Clip[];
  transitions: Array<Record<string, unknown>>;
}

export type LockScope =
  | { kind: "clip"; clipId: ID }
  | { kind: "track"; trackId: ID }
  | { kind: "range"; range: TimeRange; trackIds?: ID[] }
  | { kind: "source_range"; assetId: ID; range: TimeRange }
  | { kind: "property"; objectId: ID; path: string };

export interface LockRegion {
  id: ID;
  owner: string;
  mode: "deny_agent" | "owner_only";
  scope: LockScope;
  createdAt: string;
  note?: string;
}

export interface Sequence {
  id: ID;
  name: string;
  canvas: {
    width: number;
    height: number;
    background: string;
    pixelAspect?: Rate;
  };
  frameRate: Rate;
  tracks: Track[];
  locks: LockRegion[];
  markers: Array<Record<string, unknown>>;
  styleSpecId?: ID;
  exportPresetId?: ID;
}

export interface Project {
  id: ID;
  name: string;
  createdAt: string;
  updatedAt: string;
  activeSequenceId: ID;
  revision: number;
  defaultStyleSpecId?: ID;
}

export interface HistoryRecord {
  transactionId: ID;
  baseRevision: number;
  committedRevision: number;
  actor: string;
  reason: string;
  beforeHash: string;
  afterHash: string;
  committedAt: string;
  commandUri?: string;
}

export interface TranscriptWord {
  id: ID;
  text: string;
  normalizedText?: string;
  sourceRange: TimeRange;
  confidence: number;
  speakerId?: ID;
}

export interface TranscriptArtifact {
  id: ID;
  kind: "transcript";
  assetId: ID;
  language: string;
  audioStreamIndex: number;
  providerArtifactId?: ID;
  words: TranscriptWord[];
  provenance: Provenance;
}

export interface AsrProviderArtifact {
  id: ID;
  kind: "asrProviderResult";
  assetId: ID;
  audioStreamIndex: number;
  provider: string;
  model: string;
  providerVersion: string;
  payloadHash: string;
  uri: string;
  provenance: Provenance;
}

export type DeletionReasonCode =
  | "silence"
  | "filler"
  | "stutter"
  | "repetition"
  | "false_start"
  | "restatement"
  | "correction"
  | "incomplete"
  | "manual";

export type DeletionTarget =
  | {
      kind: "words";
      wordIds: ID[];
      sourceRange: TimeRange;
    }
  | {
      kind: "gap";
      sourceRange: TimeRange;
      previousWordId?: ID;
      nextWordId?: ID;
    };

export interface DeletionEvidence {
  role: "retained_comparison";
  target: Extract<DeletionTarget, { kind: "words" }>;
}

export interface DeletionCandidate {
  id: ID;
  target: DeletionTarget;
  reasonCodes: DeletionReasonCode[];
  decision: "definite_remove" | "suggest_remove" | "suggest_keep";
  risk: "low" | "medium" | "high";
  confidence: number;
  explanationZh: string;
  evidence?: DeletionEvidence[];
  alternatives?: Array<{
    label: string;
    target: DeletionTarget;
  }>;
}

export interface CandidateSetArtifact {
  id: ID;
  kind: "deletionCandidateSet";
  transcriptArtifactId: ID;
  sequenceId: ID;
  clipId: ID;
  projectRevision: number;
  detectorVersion: string;
  evidenceContracts?: Array<"retained-comparison-v1">;
  candidates: DeletionCandidate[];
  provenance: Provenance;
}

export interface EditProposalArtifact {
  id: ID;
  kind: "editProposal";
  candidateSetArtifactId: ID;
  projectRevision: number;
  selectedCandidateIds: ID[];
  estimatedRemovedDuration: Time;
  payloadHash: string;
  provenance: Provenance;
}

export interface CaptionCue {
  id: ID;
  text: string;
  wordIds: ID[];
  timelineRange: TimeRange;
}

export interface CaptionDocumentArtifact {
  id: ID;
  kind: "captionDocument";
  transcriptArtifactId: ID;
  sequenceId: ID;
  projectRevision: number;
  language: string;
  format: "srt";
  uri: string;
  contentHash: string;
  cues: CaptionCue[];
  provenance: Provenance;
}

export interface RenderReportArtifact {
  id: ID;
  kind: "renderReport";
  sequenceId: ID;
  projectRevision: number;
  outputAssetId: ID;
  captionArtifactId?: ID;
  renderer: "ffmpeg";
  rendererVersion: string;
  planHash: string;
  duration: Time;
  fileSizeBytes: number;
  videoCodec: string;
  audioCodec: string;
  quality: {
    timelineDuration: Time;
    outputDuration: Time;
    /**
     * 末段越尾时渲染端承诺的钳后输出时长（微秒）；存在时 durationDeltaMillis
     * 相对它计算（源里不存在的媒体无法导出，差值由 warnings 披露）。
     */
    expectedOutputMicros?: number;
    durationDeltaMillis: number;
    width: number;
    height: number;
    hasAudio: boolean;
    subtitleCueCount: number;
    passed: boolean;
    /**
     * 画面适配模式：`contain` 为默认整幅加黑边；`cover` 为竖屏等预设的中心裁切填满。
     * 缺省视为 `contain`，保持 0.1 既有导出语义不变。
     */
    fitMode?: "contain" | "cover";
    /**
     * Alpha 诚实性标记：`cover` 目前只支持中心裁切，没有人物跟踪，
     * 必须为 true；`contain` 导出可以省略或为 false。
     */
    fitModeApproximate?: boolean;
    /**
     * HDR 源诚实性标记：任一输入携带 PQ/HLG 传递特性时为 true；
     * 当前管线不色调映射，输出为近似 SDR。
     */
    colorApproximate?: boolean;
  };
  warnings: string[];
  provenance: Provenance;
}

export type ProjectArtifact =
  | AsrProviderArtifact
  | TranscriptArtifact
  | CandidateSetArtifact
  | EditProposalArtifact
  | CaptionDocumentArtifact
  | RenderReportArtifact;

export interface AgentCutProjectDocument {
  schemaVersion: "0.1.0";
  project: Project;
  assets: Asset[];
  sequences: Sequence[];
  styleSpecs: Array<Record<string, unknown>>;
  artifacts: ProjectArtifact[];
  exportPresets: Array<Record<string, unknown>>;
  versions: Array<Record<string, unknown>>;
  history: {
    headRevision: number;
    records: HistoryRecord[];
  };
  extensions?: Record<string, unknown>;
}
