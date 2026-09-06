/** OTIO 互操作的类型：export plan、loss report 与官方库读回的归一化结构。 */

/** OTIO RationalTime 的直线映射：seconds = value / rate（IR 语义 seconds = value·denominator/numerator 的等价表达）。 */
export interface PlanTime {
  value: number;
  rate: number;
}

export interface PlanTimeRange {
  start: PlanTime;
  duration: PlanTime;
}

export interface PlanGap {
  type: "gap";
  duration: PlanTime;
}

export interface PlanClip {
  type: "clip";
  name: string;
  /** 导出对应的 IR clip id（只进 loss/trace，不进 OTIO 文档本体）。 */
  clipId: string;
  sourceRange: PlanTimeRange;
  mediaReference: {
    targetUrl: string;
    availableRange?: PlanTimeRange;
  };
  /** `agentcut.*` 元数据（enabled/locked/muted/irMetadata），NLE 不识别但 round-trip 可恢复。 */
  metadata: Record<string, unknown>;
}

export type PlanItem = PlanGap | PlanClip;

export interface PlanTrack {
  name: string;
  kind: "Video" | "Audio";
  metadata: Record<string, unknown>;
  items: PlanItem[];
}

export interface PlanMarker {
  name: string;
  markedRange: PlanTimeRange;
}

export interface ExportPlan {
  name: string;
  /** 文档级 agentcut 元数据（projectId、revision、adapter 版本等）。 */
  metadata: Record<string, unknown>;
  tracks: PlanTrack[];
  markers: PlanMarker[];
}

export type LossSeverity =
  /** 无法映射，从导出中丢弃（loss report 逐项列出）。 */
  | "dropped"
  /** 以 metadata 编码保留，round-trip 可恢复但 NLE 不识别。 */
  | "metadata-encoded";

export interface LossEntry {
  category: string;
  count: number;
  severity: LossSeverity;
  detail: string;
}

export interface RoundTripDivergence {
  path: string;
  plan: unknown;
  readback: unknown;
}

export interface RoundTripVerification {
  status: "equivalent" | "diverged";
  divergences: RoundTripDivergence[];
}

export interface LossReport {
  adapter: "@agentcut/otio-interop";
  adapterVersion: string;
  otioVersion: string;
  exportedAt: string;
  project: { id: string; revision: number; sequenceId: string };
  losses: LossEntry[];
  verification: RoundTripVerification;
}

/** otio_read.py 输出的归一化结构（与 ExportPlan 同构的子集 + 读回路径）。 */
export interface NormalizedTimeline {
  name: string;
  metadata: Record<string, unknown>;
  tracks: Array<{
    name: string;
    kind: string;
    metadata: Record<string, unknown>;
    items: Array<
      | { type: "gap"; duration: PlanTime }
      | {
        type: "clip";
        name: string;
        sourceRange: PlanTimeRange;
        mediaReference: { targetUrl: string | null; availableRange?: PlanTimeRange };
        metadata: Record<string, unknown>;
      }
    >;
  }>;
  markers: PlanMarker[];
}
