import type {
  ExportPlan,
  NormalizedTimeline,
  PlanTime,
  RoundTripDivergence,
  RoundTripVerification,
} from "./types.js";

const RATE_EPSILON = 1e-9;

function timesEqual(plan: PlanTime, readback: PlanTime): boolean {
  if (plan.value !== readback.value) {
    // gap 时长等以秒推导的值允许浮点误差；有理数映射值要求逐位一致。
    return Math.abs(plan.value / plan.rate - readback.value / readback.rate) < 1e-6;
  }
  return Math.abs(plan.rate - readback.rate) <= Math.max(plan.rate, readback.rate) * RATE_EPSILON;
}

function canonicalize(value: unknown): unknown {
  // metadata 经 OTIO C++ 核心序列化后 key 顺序不保证保持（std::map 语义）；
  // 等价判定关心语义内容而非序列化顺序，递归排序后再比较。
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

/**
 * 对比 export plan 与官方库读回的归一化结构。
 * 只比较"已导出"的内容——不可映射项在 loss report 中单独记账，不参与等价判定。
 */
export function comparePlanToReadback(
  plan: ExportPlan,
  readback: NormalizedTimeline,
): RoundTripVerification {
  const divergences: RoundTripDivergence[] = [];
  const diverge = (path: string, expected: unknown, actual: unknown) => {
    divergences.push({ path, plan: expected, readback: actual });
  };

  if (plan.name !== readback.name) diverge("name", plan.name, readback.name);
  if (plan.tracks.length !== readback.tracks.length) {
    diverge("tracks.length", plan.tracks.length, readback.tracks.length);
  }
  const trackCount = Math.min(plan.tracks.length, readback.tracks.length);
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    const planTrack = plan.tracks[trackIndex]!;
    const readbackTrack = readback.tracks[trackIndex]!;
    const prefix = `tracks[${trackIndex}]`;
    if (planTrack.name !== readbackTrack.name) diverge(`${prefix}.name`, planTrack.name, readbackTrack.name);
    if (planTrack.kind !== readbackTrack.kind) diverge(`${prefix}.kind`, planTrack.kind, readbackTrack.kind);
    if (!jsonEqual(planTrack.metadata, readbackTrack.metadata)) {
      diverge(`${prefix}.metadata`, planTrack.metadata, readbackTrack.metadata);
    }
    if (planTrack.items.length !== readbackTrack.items.length) {
      diverge(`${prefix}.items.length`, planTrack.items.length, readbackTrack.items.length);
    }
    const itemCount = Math.min(planTrack.items.length, readbackTrack.items.length);
    for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
      const planItem = planTrack.items[itemIndex]!;
      const readbackItem = readbackTrack.items[itemIndex]!;
      const itemPath = `${prefix}.items[${itemIndex}]`;
      if (planItem.type !== readbackItem.type) {
        diverge(`${itemPath}.type`, planItem.type, readbackItem.type);
        continue;
      }
      if (planItem.type === "gap" && readbackItem.type === "gap") {
        if (!timesEqual(planItem.duration, readbackItem.duration)) {
          diverge(`${itemPath}.duration`, planItem.duration, readbackItem.duration);
        }
        continue;
      }
      if (planItem.type === "clip" && readbackItem.type === "clip") {
        if (planItem.name !== readbackItem.name) diverge(`${itemPath}.name`, planItem.name, readbackItem.name);
        if (!timesEqual(planItem.sourceRange.start, readbackItem.sourceRange.start)) {
          diverge(`${itemPath}.sourceRange.start`, planItem.sourceRange.start, readbackItem.sourceRange.start);
        }
        if (!timesEqual(planItem.sourceRange.duration, readbackItem.sourceRange.duration)) {
          diverge(`${itemPath}.sourceRange.duration`, planItem.sourceRange.duration, readbackItem.sourceRange.duration);
        }
        if (planItem.mediaReference.targetUrl !== readbackItem.mediaReference.targetUrl) {
          diverge(`${itemPath}.mediaReference.targetUrl`,
            planItem.mediaReference.targetUrl, readbackItem.mediaReference.targetUrl);
        }
        if (!jsonEqual(planItem.metadata, readbackItem.metadata)) {
          diverge(`${itemPath}.metadata`, planItem.metadata, readbackItem.metadata);
        }
      }
    }
  }
  if (plan.markers.length !== readback.markers.length) {
    diverge("markers.length", plan.markers.length, readback.markers.length);
  }
  const markerCount = Math.min(plan.markers.length, readback.markers.length);
  for (let index = 0; index < markerCount; index += 1) {
    const planMarker = plan.markers[index]!;
    const readbackMarker = readback.markers[index]!;
    if (planMarker.name !== readbackMarker.name) {
      diverge(`markers[${index}].name`, planMarker.name, readbackMarker.name);
    }
    if (!timesEqual(planMarker.markedRange.start, readbackMarker.markedRange.start)) {
      diverge(`markers[${index}].start`, planMarker.markedRange.start, readbackMarker.markedRange.start);
    }
  }

  return { status: divergences.length === 0 ? "equivalent" : "diverged", divergences };
}
