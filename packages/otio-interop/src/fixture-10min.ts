import type { AgentCutProjectDocument, Clip, Track } from "@agentcut/timeline-schema";

const RATE_30 = { numerator: 30, denominator: 1 };
const FILM = { numerator: 24, denominator: 1 };

function irTime(seconds: number, rate: { numerator: number; denominator: number } = RATE_30) {
  // 以“整帧数”表示秒数：value = round(seconds × rate.numerator / rate.denominator)，
  // 保持 IR 的有理数语义（seconds = value·denominator/numerator）。
  // 夹具统一用 30fps：每个 clip 的起止独立取整，在 NTSC（30000/1001）下累积漂移
  // 会让名义上相邻的 clip 产生亚帧重叠；30fps 下秒边界逐位对齐，round-trip 断言确定。
  return { value: Math.round(seconds * rate.numerator / rate.denominator), rate };
}

const provenance = (id: string) => ({
  createdBy: { kind: "workflow" as const, id },
  createdAt: "2026-09-06T00:00:00.000Z",
  reason: "OTIO round-trip synthetic fixture",
});

/**
 * Gate P4 的 10 分钟规模合成工程：2 轨（video+audio）、10 个 clip（9 media + 1 非 media）、
 * 含 gap/禁用 clip/锁定轨/元数据/marker/非 media clip/不可映射 marker，
 * 覆盖 round-trip 等价与 loss report 两类路径。
 */
export function buildTenMinuteProject(): AgentCutProjectDocument {
  const assets = [
    {
      id: "asset_a", kind: "video" as const, uri: "media/a.mp4",
      contentHash: `sha256:${"a".repeat(64)}`, availability: "online" as const,
      provenance: provenance("fixture"),
    },
    {
      id: "asset_b", kind: "video" as const, uri: "media/b.mp4",
      contentHash: `sha256:${"b".repeat(64)}`, availability: "online" as const,
      provenance: provenance("fixture"),
    },
    {
      id: "asset_voice", kind: "audio" as const, uri: "media/voice.wav",
      contentHash: `sha256:${"c".repeat(64)}`, availability: "online" as const,
      provenance: provenance("fixture"),
    },
  ];

  const mediaClip = (
    id: string,
    assetId: string,
    startSeconds: number,
    durationSeconds: number,
    extra: Partial<Clip> = {},
  ): Clip => ({
    id,
    kind: "media",
    assetId,
    streamIndex: 0,
    timelineRange: { start: irTime(startSeconds), duration: irTime(durationSeconds) },
    sourceRange: { start: irTime(startSeconds / 2), duration: irTime(durationSeconds) },
    enabled: true,
    provenance: provenance("fixture"),
    ...extra,
  });

  const videoClips: Clip[] = [
    mediaClip("clip_v_001", "asset_a", 0, 45),
    mediaClip("clip_v_002", "asset_a", 45, 30, { metadata: { "agentcut.note": "含口误待审" } }),
    // 45+30=75 → 下一个从 90 开始：插入 15s gap（验证 gap 映射）。
    mediaClip("clip_v_003", "asset_b", 90, 60, { enabled: false }),
    mediaClip("clip_v_004", "asset_b", 150, 90),
    mediaClip("clip_v_005", "asset_a", 240, 120),
    // 非 media clip（kind=shape）：导出为 gap + loss 记账。
    {
      id: "clip_v_shape",
      kind: "shape" as Clip["kind"],
      timelineRange: { start: irTime(360), duration: irTime(20) },
      enabled: true,
      provenance: provenance("fixture"),
    },
    mediaClip("clip_v_006", "asset_b", 380, 220),
  ];
  const audioClips: Clip[] = [
    mediaClip("clip_a_001", "asset_voice", 0, 300, { streamIndex: 1 }),
    mediaClip("clip_a_002", "asset_voice", 300, 180, { streamIndex: 1 }),
    mediaClip("clip_a_003", "asset_voice", 480, 120, { streamIndex: 1, enabled: false }),
  ];

  const videoTrack: Track = {
    id: "track_v1", kind: "video", name: "主画面", order: 0,
    locked: false, enabled: true, clips: videoClips, transitions: [],
  };
  const audioTrack: Track = {
    id: "track_a1", kind: "audio", name: "人声", order: 1,
    locked: true, enabled: true, clips: audioClips, transitions: [],
  };
  // 总时长 600s（10 分钟）：600-380-220 = 0 → 末尾恰好对齐。
  const document: AgentCutProjectDocument = {
    schemaVersion: "0.1.0",
    project: {
      id: "project_otio_roundtrip_10min",
      name: "OTIO round-trip 10min synthetic",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
      activeSequenceId: "sequence_main",
      revision: 0,
    },
    assets,
    sequences: [{
      id: "sequence_main",
      name: "主时间线",
      canvas: { width: 1920, height: 1080, background: "#000000" },
      frameRate: RATE_30,
      tracks: [videoTrack, audioTrack],
      locks: [{
        id: "lock_audio_track",
        owner: "local_user",
        mode: "deny_agent",
        scope: { kind: "track", trackId: "track_a1" },
        createdAt: "2026-09-06T00:00:00.000Z",
      }],
      markers: [
        { name: "开场口误", start: irTime(48), duration: irTime(2, FILM) },
        { name: "章节二", start: irTime(150) },
        // 不可映射 marker（缺 name/start 形状）→ loss 记账。
        { freeform: true, note: "非结构化标注" },
      ],
    }],
    styleSpecs: [],
    artifacts: [],
    exportPresets: [],
    versions: [],
    history: { headRevision: 0, records: [] },
  };
  return document;
}
