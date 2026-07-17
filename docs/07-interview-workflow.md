# 中文访谈切片工作流

> 计划版本：V0.3。本文先冻结数据和验收边界，V0.1 不承诺完整实现。

## 1. 目标

从长访谈/播客中生成多个可独立传播、上下文完整、可人工审查的短视频候选。核心不是找“情绪最强的 30 秒”，而是找最小完整论证单元并为其补足必要上下文。

输出不是一个黑箱 viral score，而是候选集合：source ranges、transcript、speaker/话题、Hook 建议、上下文依赖、传播价值维度、风险和一条独立 sequence proposal。

## 2. 阶段图

```mermaid
flowchart LR
  I["Ingest"] --> T["ASR + Diarization"] --> S["Speaker resolution"]
  S --> TOP["Topic / discourse segmentation"]
  TOP --> M["Claims / stories / conflict / quotes"]
  M --> C["Candidate assembly"]
  C --> X["Context and coreference check"]
  X --> R["Rank + diversity"]
  R --> H["Human shortlist"]
  H --> E["Create sequences"] --> V["Reframe/captions/labels"] --> Q["QC/export"]
```

## 3. 标准阶段

| 阶段 | 输入 | 输出 | 模型/算法 | 人工确认 | 失败处理 | 缓存 | 成本/回退 |
|---|---|---|---|---|---|---|---|
| 0. Preflight/Ingest | 多视频/音频、机位说明 | Asset graph、sync hints | ffprobe、hash | 机位/主持人信息可选 | 时间码缺失允许音频对齐 | asset hash | 本地 |
| 1. 音频对齐 | 多机位 audio | common source clock、offset/confidence | fingerprint/cross-correlation | 低置信 offset 需确认 | 无公共音频则用户 marker | audio hash | 本地 |
| 2. ASR/VAD | 主混音/各路音频 | word transcript | FunASR/云 ASR/WhisperX | 云上传确认 | 分块、回退 provider | audio+provider | 本地或计费 |
| 3. Diarization | audio + VAD | anonymous speaker turns、overlap | pyannote/FunASR/云 diarization | 否 | 失败则只做单 speaker/人工标签 | audio+model | GPU/云；可推迟 |
| 4. Speaker resolution | turns、可选姓名/样本、画面 face tracks | speaker aliases、host/guest roles、confidence | clustering + face/audio association | 姓名映射必须用户确认 | 只保留 Speaker A/B，不猜姓名 | turn/model hash | 本地/可选 VLM |
| 5. Topic segmentation | transcript、turns | hierarchical topic segments | embedding change point + LLM discourse | 否 | 规则按长停顿/问题边界降级 | transcript/model | 优先本地 embedding |
| 6. Semantic extraction | topics | claims、quotes、stories、conflicts、questions | LLM structured extraction + quote grounding | 否，仅候选 | 所有 quote 必须逐字 grounded；否则丢弃 | topic text+model | 可只对高信息段调用 LLM |
| 7. Candidate assembly | grounded units、platform target | candidate ranges + context dependencies | interval planner、question/answer graph | 否 | 缺上下文则扩展边界或拒绝 | artifact versions | 本地 |
| 8. Context/coreference | candidate transcript + 前后文 | self-contained score、unresolved refs、required lead-in | coreference/NLI/LLM reviewer | 低分候选需确认 | reviewer 不可用时保守扩大/人工 | candidate+reviewer | 高风险才用云 LLM |
| 9. Rank/diversify | candidates | Pareto shortlist | 多维评分 + MMR/diversity，不单一 viral score | 用户选择候选 | 不足数量时不凑数 | candidate set+policy | 本地 |
| 10. Hook proposal | candidate + source evidence | source hook / generated text hook / no hook | LLM + grounded claims | 生成 Hook 必须确认 | 禁止生成原访谈未支持的事实 | candidate hash | 低成本文本 |
| 11. Create sequences | selected candidates、revision | 一候选一 sequence transaction | source range mapper | 应用前确认 | revision conflict 重建 mapping | revision-bound | 本地 |
| 12. Visual edit | sequences、机位、face tracks | camera cuts、reframe、speaker labels、captions | active speaker + shot quality + rules | 导演模式确认机位策略 | 单机位/追踪失败则固定 crop | assets+timeline | 本地 |
| 13. QC/export | sequence revision | reports、multi-platform renders | semantic/media/render checks | 最终导出确认 | 单个候选失败不阻断其他候选 | version+preset | 本地/可并行 |

## 4. 候选数据模型

```ts
interface InterviewClipCandidate {
  id: string;
  sourceRanges: Array<{ assetId: string; range: TimeRange }>;
  primaryTopicId: string;
  speakerIds: string[];
  transcriptSegmentIds: string[];
  opening: {
    type: "source_question" | "source_statement" | "generated_text" | "none";
    text: string;
    groundedEvidenceIds: string[];
  };
  requiredContextSegmentIds: string[];
  unresolvedReferences: Array<{ text: string; wordIds: string[]; severity: "warn" | "block" }>;
  scores: {
    semanticCompleteness: number;
    standaloneClarity: number;
    insightNovelty: number;
    emotionalArc: number;
    sourceGrounding: number;
    visualFeasibility: number;
    durationFit: number;
  };
  risks: string[];
  explanationZh: string;
}
```

不提供一个不可解释的总分作为 truth。排序策略可以计算内部 utility，但 UI 必须展示多维分数、证据和 trade-off。

## 5. 语义完整性规则

候选至少满足：

- 开头能理解“谁在谈什么”，或包含必要主持人问题。
- 代词“他/这个/那件事/后来”有可推断先行词。
- 观点包含最小理由、例子或结论，而不只是挑衅句。
- 故事包含触发、变化和结果中的必要部分。
- 引用不通过拼接改变原意；跨段拼接必须在 UI 标明。
- 不以删除停顿为由删掉对方尚未说完的转折。
- 主持人问题可缩短，但不能让回答语义失真。
- 对健康、金融、法律等高风险内容保留限定词和免责声明。

硬阻断：

- 未解决的关键指代。
- 断章取义会反转立场。
- Hook 含原文未支持的事实。
- 不同时间的句子拼接成虚假的连续发言。

## 6. 多候选生成

避免只生成同一观点的不同长度：

1. 按 topic/claim/story 单元生成 raw candidates。
2. 对每个 raw candidate 产生 conservative/compact 两个边界版本。
3. 先过滤硬阻断，再按多维质量形成 Pareto frontier。
4. 用语义相似度去重，限制同一 speaker/topic 占比。
5. 每个候选说明“为什么值得独立传播”和“牺牲了什么上下文”。

如果没有足够好候选，应返回实际数量和原因，不为满足“生成 10 条”而凑数。

## 7. 主持人问题与 Hook

优先级：

1. 原始回答本身有自包含开头：直接使用。
2. 主持人问题简洁且必要：保留问题。
3. 问题冗长：在不改变语义时保留关键子句，必须可回听原音。
4. 文本 Hook：只作为前置标题/字幕，不伪造成受访者说过的话。
5. AI 旁白 Hook：属于生成素材，需用户确认并明确 provenance。

## 8. 多机位与单机位

### 多机位

- 机位通过公共音频时间轴映射；不可把 timeline time 当各资产 source time。
- active speaker 是切换建议，不是唯一规则；避免每次说话人变化都切镜头。
- 优先使用清晰、无眨眼/大动作异常、构图稳定的 shot。
- reaction shot 必须来自同一真实时间范围，不得挪用反应制造虚假含义。

### 单机位

- 9:16 分段人物跟踪；屏幕/双人画面可用 split layout。
- jump cut 后可交替轻微 scale，但设置频率上限。
- B-roll 只在支持语义和掩盖合理剪切时使用，不用廉价生成素材填满。

## 9. 说话人标签

- 默认 `Speaker A/B`；用户确认后才写真实姓名。
- 名称、职位和组织是独立 metadata，有来源和确认状态。
- 标签首次出现或 speaker 变化时展示，避免持续遮挡。
- 同时说话的 overlap 不能强行归给单一 speaker。

## 10. 质量检查

### 内容

- source transcript 与成片逐段对齐；所有 generated Hook 有显式标记。
- 关键代词、否定、数字、限定词、问题/回答关系检查。
- 每个候选由独立 reviewer 尝试证明“断章取义”。

### 说话人与画面

- diarization error spot-check；speaker 标签不误名。
- active speaker crop 不追错人，双人同框时不频繁摆动。
- 多机位 audio 不重复/缺失，reaction shot 时间真实。

### 传播

- 开头 3 秒可理解，但不把“情绪强”当唯一标准。
- 候选时长符合目标平台且仍保留完整论证。
- shortlist 有话题/人物/情绪多样性。

## 11. Benchmark

数据集需覆盖：双人/多人、主持人长问题、重叠说话、远场噪声、单/多机位、中文夹英文、代词密集、故事型/观点型/冲突型访谈。

指标：

- DER/JER 与 speaker naming accuracy（分开）。
- topic boundary WindowDiff/Pk。
- 候选语义完整度、指代清晰度、事实忠实度的盲评。
- 候选 diversity 与用户 shortlist 接受率。
- 人工从候选到发布版本所需时间。
- 多机位同步误差、错误 reaction shot 数。

## 12. V0.3 验收场景

1. 60 分钟双人中文访谈生成 5–10 个非重复候选；若合格不足，返回实际数量。
2. 包含“这件事/后来/他”的回答能自动补足问题或被阻断，不直接从代词开始。
3. 主持人问题被保留或缩短时不改变回答含义。
4. 双机位时间轴切换音频连续、误差 ≤ 40 ms；reaction shot 来自同一时刻。
5. 用户改动一个候选后，其余候选 sequence 不受影响；Agent 可继续修改未锁部分。
6. 每个短片都能回溯到 source ranges、speaker turns、topic/claim 和生成 Hook provenance。

## 13. 回退方案

- 无 diarization：用户选择 speaker turns 或按单人内容处理。
- 无 VLM/face tracking：只做 transcript 候选，不自动机位/构图。
- 无 LLM：按话题 embedding、问题/回答和关键词生成候选，全部需人工审查。
- 多机位对齐失败：只使用主机位，保留其他素材待人工。
- 语义完整性低：输出长候选或不输出，不能靠生成文案掩盖缺失上下文。
