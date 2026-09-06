import { pathToFileURL } from "node:url";
import type { AgentCutProjectDocument, Asset, Clip, Track } from "@agentcut/timeline-schema";
import type {
  ExportPlan,
  LossEntry,
  PlanClip,
  PlanItem,
  PlanMarker,
  PlanTime,
} from "./types.js";

export interface BuildPlanOptions {
  /** 源媒体相对路径的解析根（asset.uri 多为工程相对路径）。缺省时按原样导出相对路径。 */
  projectRoot?: string | undefined;
  /** 导出哪个 sequence；缺省为 activeSequenceId。 */
  sequenceId?: string | undefined;
}

export interface BuildPlanResult {
  plan: ExportPlan;
  losses: LossEntry[];
}

interface IrTime {
  value: number;
  rate: { numerator: number; denominator: number };
}

function toPlanTime(time: IrTime): PlanTime {
  // IR 语义 seconds = value·denominator/numerator；OTIO RationalTime seconds = value/rate。
  return { value: time.value, rate: time.rate.numerator / time.rate.denominator };
}

function recordLoss(
  losses: Map<string, LossEntry>,
  category: string,
  severity: LossEntry["severity"],
  detail: string,
): void {
  const existing = losses.get(category);
  if (existing) {
    existing.count += 1;
    existing.detail += `; ${detail}`;
    return;
  }
  losses.set(category, { category, count: 1, severity, detail });
}

function isIrTime(value: unknown): value is IrTime {
  if (!value || typeof value !== "object") return false;
  const time = value as { value?: unknown; rate?: { numerator?: unknown; denominator?: unknown } };
  return typeof time.value === "number"
    && typeof time.rate?.numerator === "number"
    && typeof time.rate?.denominator === "number"
    && time.rate.denominator !== 0;
}

function clipDisplayName(clip: Clip, asset: Asset | undefined): string {
  if (asset) {
    const basename = asset.uri.split("/").filter(Boolean).pop();
    if (basename) return basename;
  }
  return clip.id;
}

/**
 * IR document → OTIO export plan。全部 IR→OTIO 语义决策都在这里完成：
 * gap 插入（IR 按位置摆放、OTIO stack 顺序排列）、不可映射项归类（loss）、
 * metadata 编码（enabled/locked/muted/irMetadata → agentcut.*）。
 * Python 端只做官方库对象构造，不再做任何语义判断。
 */
export function buildExportPlan(
  document: AgentCutProjectDocument,
  options: BuildPlanOptions = {},
): BuildPlanResult {
  const sequenceId = options.sequenceId ?? document.project.activeSequenceId;
  const sequence = document.sequences.find((candidate) => candidate.id === sequenceId);
  if (!sequence) throw new Error(`Sequence ${sequenceId} does not exist in this document`);
  const losses = new Map<string, LossEntry>();
  const resolveAssetUrl = (asset: Asset): string => {
    // 已是绝对 URI（file:///…、http(s)://…）则原样导出；工程相对路径按 projectRoot 解析为 file URL。
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(asset.uri)) return asset.uri;
    if (!options.projectRoot) return asset.uri;
    return pathToFileURL(`${options.projectRoot.replace(/\/+$/, "")}/${asset.uri}`).href;
  };

  const tracks = [...sequence.tracks].sort((left, right) => left.order - right.order);
  const planTracks = tracks.flatMap((track) => {
    if (track.kind !== "video" && track.kind !== "audio") {
      recordLoss(losses, "unexported-track-kind", "dropped",
        `track ${track.id} (${track.kind}): OTIO tracks only model Video/Audio`);
      return [];
    }
    const metadata: Record<string, unknown> = {
      locked: track.locked,
      enabled: track.enabled,
      order: track.order,
      ...(track.muted !== undefined ? { muted: track.muted } : {}),
    };
    if (track.locked || !track.enabled || track.muted !== undefined) {
      recordLoss(losses, "track-flags-metadata", "metadata-encoded",
        `track ${track.id}: locked/enabled/muted are AgentCut semantics, encoded as metadata`);
    }
    if (track.transitions.length > 0) {
      recordLoss(losses, "track-transitions", "dropped",
        `track ${track.id}: ${track.transitions.length} transition record(s) have no OTIO equivalent`);
    }
    return [{
      name: track.name,
      kind: track.kind === "video" ? "Video" as const : "Audio" as const,
      metadata,
      items: buildTrackItems(track, document, losses, resolveAssetUrl),
    }];
  });

  const markers: PlanMarker[] = [];
  for (const marker of sequence.markers) {
    const name = (marker as { name?: unknown }).name;
    const start = (marker as { start?: unknown }).start;
    const duration = (marker as { duration?: unknown }).duration;
    if (typeof name === "string" && isIrTime(start)) {
      markers.push({
        name,
        markedRange: {
          start: toPlanTime(start),
          duration: isIrTime(duration) ? toPlanTime(duration) : toPlanTime(startZero(start)),
        },
      });
    } else {
      recordLoss(losses, "unmappable-marker", "dropped",
        "marker without {name: string, start: IR time} shape has no OTIO equivalent");
    }
  }

  if (sequence.locks.length > 0) {
    recordLoss(losses, "sequence-locks", "dropped",
      `${sequence.locks.length} lock region(s) are AgentCut access-control semantics, not timeline content`);
  }
  const artifactsByKind = new Map<string, number>();
  for (const artifact of document.artifacts) {
    artifactsByKind.set(artifact.kind, (artifactsByKind.get(artifact.kind) ?? 0) + 1);
  }
  for (const [kind, count] of artifactsByKind) {
    recordLoss(losses, `artifact:${kind}`, "dropped",
      `${count} ${kind} artifact(s) are AgentCut workspace data, not timeline content`);
  }
  recordLoss(losses, "provenance-and-history", "dropped",
    "provenance, versions and history belong to the AgentCut audit domain, not to an interchange file");
  if (document.styleSpecs.length > 0 || document.exportPresets.length > 0) {
    recordLoss(losses, "style-and-export-presets", "dropped",
      "styleSpecs/exportPresets are host rendering configuration");
  }
  if (document.sequences.length > 1) {
    recordLoss(losses, "additional-sequences", "dropped",
      `${document.sequences.length - 1} non-active sequence(s); export covers the active sequence only`);
  }

  return {
    plan: {
      name: sequence.name,
      metadata: {
        projectId: document.project.id,
        revision: document.project.revision,
        sequenceId: sequence.id,
        canvas: sequence.canvas,
        frameRate: sequence.frameRate,
      },
      tracks: planTracks,
      markers,
    },
    losses: [...losses.values()].sort((left, right) => left.category.localeCompare(right.category)),
  };
}

function startZero(time: IrTime): IrTime {
  return { value: 0, rate: time.rate };
}

function buildTrackItems(
  track: Track,
  document: AgentCutProjectDocument,
  losses: Map<string, LossEntry>,
  resolveAssetUrl: (asset: Asset) => string,
): PlanItem[] {
  const clips = [...track.clips].sort((left, right) =>
    toMicros(left.timelineRange.start) - toMicros(right.timelineRange.start)
  );
  const items: PlanItem[] = [];
  let cursor: PlanTime | null = null;
  for (const clip of clips) {
    const start = toPlanTime(clip.timelineRange.start);
    const duration = toPlanTime(clip.timelineRange.duration);
    if (cursor !== null && start.value / start.rate < cursor.value / cursor.rate - 1e-9) {
      recordLoss(losses, "overlapping-clip", "dropped",
        `clip ${clip.id}: overlaps a previous clip; OTIO stacks cannot express overlap`);
      continue;
    }
    if (cursor === null && (start.value / start.rate) > 1e-9) {
      items.push({ type: "gap", duration: { value: start.value, rate: start.rate } });
    } else if (cursor !== null && (start.value / start.rate) - (cursor.value / cursor.rate) > 1e-9) {
      const gapSeconds = start.value / start.rate - cursor.value / cursor.rate;
      items.push({ type: "gap", duration: { value: gapSeconds, rate: 1 } });
    }
    items.push(buildClipItem(clip, document, losses, resolveAssetUrl));
    cursor = {
      value: start.value / start.rate + duration.value / duration.rate,
      rate: 1,
    };
  }
  return items;
}

function buildClipItem(
  clip: Clip,
  document: AgentCutProjectDocument,
  losses: Map<string, LossEntry>,
  resolveAssetUrl: (asset: Asset) => string,
): PlanItem {
  const asset = clip.assetId
    ? document.assets.find((candidate) => candidate.id === clip.assetId)
    : undefined;
  if (clip.kind !== "media" || !asset) {
    recordLoss(losses, "non-media-clip", "dropped",
      `clip ${clip.id} (${clip.kind}${clip.assetId ? ", asset missing" : ""}): exported as gap to preserve timing`);
    return { type: "gap", duration: toPlanTime(clip.timelineRange.duration) };
  }
  const metadata: Record<string, unknown> = {
    clipId: clip.id,
    enabled: clip.enabled,
    ...(clip.streamIndex !== undefined ? { streamIndex: clip.streamIndex } : {}),
    ...(clip.metadata && Object.keys(clip.metadata).length > 0 ? { irMetadata: clip.metadata } : {}),
  };
  if (!clip.enabled) {
    recordLoss(losses, "disabled-clip", "metadata-encoded",
      `clip ${clip.id}: OTIO has no enabled flag; encoded as metadata, invisible to NLEs`);
  }
  if (clip.streamIndex !== undefined && clip.streamIndex !== 0) {
    recordLoss(losses, "clip-stream-index", "metadata-encoded",
      `clip ${clip.id}: OTIO media references carry no stream index; encoded as metadata`);
  }
  const renderProperties = (["transform", "audio", "content", "animations", "effects"] as const)
    .filter((key) => clip[key] !== undefined);
  if (renderProperties.length > 0) {
    recordLoss(losses, "clip-render-properties", "dropped",
      `clip ${clip.id}: ${renderProperties.join("/")} are host rendering semantics with no OTIO equivalent`);
  }
  const planClip: PlanClip = {
    type: "clip",
    name: clipDisplayName(clip, asset),
    clipId: clip.id,
    sourceRange: clip.sourceRange
      ? { start: toPlanTime(clip.sourceRange.start), duration: toPlanTime(clip.sourceRange.duration) }
      : {
        // IR 允许缺省 sourceRange（整段素材）；导出时确定性推导为与 timelineRange 等长。
        start: { value: 0, rate: 1 },
        duration: toPlanTime(clip.timelineRange.duration),
      },
    mediaReference: { targetUrl: resolveAssetUrl(asset) },
    metadata,
  };
  return planClip;
}

function toMicros(time: IrTime): number {
  return Math.round(time.value * time.rate.denominator / time.rate.numerator * 1_000_000);
}
