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

export interface AgentCutProjectDocument {
  schemaVersion: "0.1.0";
  project: Project;
  assets: Asset[];
  sequences: Sequence[];
  styleSpecs: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  exportPresets: Array<Record<string, unknown>>;
  versions: Array<Record<string, unknown>>;
  history: {
    headRevision: number;
    records: HistoryRecord[];
  };
  extensions?: Record<string, unknown>;
}
