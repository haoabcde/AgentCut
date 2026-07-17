import type {
  Actor,
  AgentCutProjectDocument,
  Clip,
  ID,
  LockRegion,
  Time,
  TimeRange,
  Track,
} from "@agentcut/timeline-schema";

export type Precondition =
  | { type: "object_exists"; objectId: ID }
  | { type: "range_unlocked"; range: TimeRange; trackIds?: ID[] }
  | { type: "asset_online"; assetId: ID };

export type EditOperation =
  | { type: "track.add"; track: Track; index?: number }
  | { type: "track.remove"; trackId: ID }
  | { type: "clip.insert"; trackId: ID; clip: Clip; index?: number }
  | { type: "clip.remove"; clipId: ID }
  | { type: "clip.move"; clipId: ID; toTrackId?: ID; toIndex?: number; start: Time }
  | { type: "clip.trim"; clipId: ID; timelineRange: TimeRange; sourceRange?: TimeRange }
  | { type: "clip.replace"; clipId: ID; clip: Clip }
  | {
    type: "clip.update";
    clipId: ID;
    patch: Partial<Pick<Clip, "enabled" | "transform" | "audio" | "content" | "animations" | "effects" | "metadata">>;
  }
  | { type: "lock.add"; lock: LockRegion; index?: number }
  | { type: "lock.remove"; lockId: ID };

export interface EditTransaction {
  protocolVersion: "0.1.0";
  transactionId: ID;
  idempotencyKey: string;
  projectId: ID;
  sequenceId: ID;
  baseRevision: number;
  actor: Actor;
  reason: string;
  preconditions: Precondition[];
  operations: EditOperation[];
}

export interface CommandRecord {
  transactionId: ID;
  projectId: ID;
  baseRevision: number;
  committedRevision: number;
  request: EditTransaction;
  inverseOperations: EditOperation[];
  beforeHash: string;
  afterHash: string;
  committedAt: string;
}

export interface CommitResult {
  document: AgentCutProjectDocument;
  record: CommandRecord;
  idempotentReplay: boolean;
}
