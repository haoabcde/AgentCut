import { createHash } from "node:crypto";
import { computeEditProposalPayloadHash } from "@agentcut/edit-commands";
import { addTime, compareTime, convertTime, rangeEnd, subtractTime } from "@agentcut/timeline-engine";
import type {
  Actor,
  AgentCutProjectDocument,
  CandidateSetArtifact,
  DeletionCandidate,
  EditProposalArtifact,
  TimeRange,
  TranscriptArtifact,
  TranscriptWord,
} from "@agentcut/timeline-schema";
import { CandidateDetectionError } from "./silence.js";

export interface CandidateGenerationOptions {
  document: AgentCutProjectDocument;
  transcriptArtifactId: string;
  sequenceId: string;
  clipId: string;
  silences: TimeRange[];
  actor: Actor;
  createdAt: string;
  detectorVersion?: string;
  silenceHandleMicros?: number;
  minimumRemovableSilenceMicros?: number;
  maximumRepetitionTokens?: number;
  minimumRepetitionCharacters?: number;
}

export interface CandidateGenerationReport {
  silenceIntervals: number;
  silenceCandidates: number;
  fillerCandidates: number;
  repetitionCandidates: number;
  definiteRemove: number;
  suggestRemove: number;
  suggestKeep: number;
  skippedBoundarySilences: number;
  skippedShortSilences: number;
}

export interface GeneratedCandidates {
  candidateSet: CandidateSetArtifact;
  report: CandidateGenerationReport;
}

const DEFINITE_FILLERS = new Set(["嗯", "呃", "额"]);
const CONTEXTUAL_FILLERS = new Set(["啊"]);

export function generateTalkingHeadCandidates(
  options: CandidateGenerationOptions,
): GeneratedCandidates {
  const transcript = findTranscript(options.document, options.transcriptArtifactId);
  const handle = options.silenceHandleMicros ?? 150_000;
  const minimumRemovable = options.minimumRemovableSilenceMicros ?? 350_000;
  const maximumRepetitionTokens = options.maximumRepetitionTokens ?? 8;
  const minimumRepetitionCharacters = options.minimumRepetitionCharacters ?? 2;
  if (!Number.isSafeInteger(handle) || handle < 0
    || !Number.isSafeInteger(minimumRemovable) || minimumRemovable < 1
    || !Number.isSafeInteger(maximumRepetitionTokens) || maximumRepetitionTokens < 1
    || !Number.isSafeInteger(minimumRepetitionCharacters) || minimumRepetitionCharacters < 1) {
    throw new RangeError("Candidate timing thresholds must be non-negative safe integers");
  }
  const report: CandidateGenerationReport = {
    silenceIntervals: options.silences.length,
    silenceCandidates: 0,
    fillerCandidates: 0,
    repetitionCandidates: 0,
    definiteRemove: 0,
    suggestRemove: 0,
    suggestKeep: 0,
    skippedBoundarySilences: 0,
    skippedShortSilences: 0,
  };
  const candidates: DeletionCandidate[] = [];

  transcript.words.forEach((word) => {
    const normalized = normalizeToken(word.text);
    if (!DEFINITE_FILLERS.has(normalized) && !CONTEXTUAL_FILLERS.has(normalized)) return;
    const definite = DEFINITE_FILLERS.has(normalized)
      && word.confidence >= 0.85
      && toMicros(word.sourceRange.duration) <= 800_000;
    candidates.push({
      id: candidateId("filler", transcript.id, word.id, word.sourceRange),
      target: {
        kind: "words",
        wordIds: [word.id],
        sourceRange: structuredClone(word.sourceRange),
      },
      reasonCodes: ["filler"],
      decision: definite ? "definite_remove" : "suggest_remove",
      risk: definite ? "low" : "medium",
      confidence: word.confidence,
      explanationZh: definite
        ? `独立语气词“${word.text.trim()}”，识别置信度较高。`
        : `“${word.text.trim()}”可能是语气词，也可能承担语气，建议试听后决定。`,
    });
    report.fillerCandidates += 1;
  });

  for (const repetition of findImmediateExactRepetitions(
    transcript.words,
    maximumRepetitionTokens,
    minimumRepetitionCharacters,
  )) {
    const sourceRange = rangeForWords(repetition.removeWords);
    const duplicateConfidence = Math.min(
      ...repetition.removeWords.map((word) => word.confidence),
      ...repetition.keepWords.map((word) => word.confidence),
    );
    const lowAsrConfidence = duplicateConfidence < 0.6;
    candidates.push({
      id: candidateId(
        "repetition",
        transcript.id,
        repetition.removeWords.map((word) => word.id).join(":"),
        sourceRange,
      ),
      target: {
        kind: "words",
        wordIds: repetition.removeWords.map((word) => word.id),
        sourceRange,
      },
      reasonCodes: ["repetition"],
      decision: "suggest_remove",
      risk: lowAsrConfidence ? "high" : "medium",
      confidence: Math.min(0.95, duplicateConfidence),
      explanationZh: lowAsrConfidence
        ? `检测到连续完全重复“${repetition.text}”，但相关文字识别置信度较低，必须试听确认，不能自动删除。`
        : `检测到连续完全重复“${repetition.text}”，可能是口头重复，也可能是有意强调，建议试听后决定。`,
      evidence: [{
        role: "retained_comparison",
        target: {
          kind: "words",
          wordIds: repetition.keepWords.map((word) => word.id),
          sourceRange: rangeForWords(repetition.keepWords),
        },
      }],
    });
    report.repetitionCandidates += 1;
  }

  for (const silence of options.silences) {
    const previous = findPreviousWord(transcript.words, silence.start);
    const silenceEnd = rangeEnd(silence, silence.start.rate);
    const next = findNextWord(transcript.words, silenceEnd);
    if (!previous || !next) {
      report.skippedBoundarySilences += 1;
      continue;
    }
    const start = addTime(
      silence.start,
      micros(handle),
      { numerator: 1_000_000, denominator: 1 },
      "nearest",
    );
    const end = subtractTime(
      silenceEnd,
      micros(handle),
      { numerator: 1_000_000, denominator: 1 },
      "nearest",
    );
    const boundedStart = compareTime(start, rangeEnd(previous.sourceRange)) < 0
      ? convertTime(rangeEnd(previous.sourceRange), start.rate, "ceil")
      : start;
    const boundedEnd = compareTime(end, next.sourceRange.start) > 0
      ? convertTime(next.sourceRange.start, end.rate, "floor")
      : end;
    if (compareTime(boundedEnd, boundedStart) <= 0) {
      report.skippedShortSilences += 1;
      continue;
    }
    const duration = subtractTime(
      boundedEnd,
      boundedStart,
      { numerator: 1_000_000, denominator: 1 },
      "nearest",
    );
    if (duration.value < minimumRemovable) {
      report.skippedShortSilences += 1;
      continue;
    }
    // 停顿（无论长短）一律 suggest_remove + medium，绝不 definite：长停顿是否该删
    // 取决于语义（思考停顿 vs 废话），且 Gate precision 证据只统计 definite_remove，
    // 自动删停顿不可审计。自动删除仅限高置信填充词（见 DEFINITE_FILLERS）。
    const targetRange = { start: boundedStart, duration };
    candidates.push({
      id: candidateId("silence", transcript.id, `${previous.id}:${next.id}`, targetRange),
      target: {
        kind: "gap",
        sourceRange: targetRange,
        previousWordId: previous.id,
        nextWordId: next.id,
      },
      reasonCodes: ["silence"],
      decision: "suggest_remove",
      risk: "medium",
      confidence: 0.85,
      explanationZh: `检测到停顿，已在两侧各保留 ${handle / 1_000}ms 呼吸余量；是否删除请试听后决定。`,
    });
    report.silenceCandidates += 1;
  }

  candidates.sort((left, right) => compareTime(
    left.target.sourceRange.start,
    right.target.sourceRange.start,
  ));
  for (const candidate of candidates) {
    if (candidate.decision === "definite_remove") report.definiteRemove += 1;
    else if (candidate.decision === "suggest_remove") report.suggestRemove += 1;
    else report.suggestKeep += 1;
  }
  const detectorVersion = options.detectorVersion ?? "talking-head-mechanical/0.3.0";
  const evidenceContracts = ["retained-comparison-v1"] as const;
  const idSeed = [
    transcript.id,
    options.document.project.revision,
    detectorVersion,
    ...evidenceContracts,
    JSON.stringify(candidates),
  ].join(":");
  return {
    candidateSet: {
      id: `candidates_${createHash("sha256").update(idSeed).digest("hex").slice(0, 24)}`,
      kind: "deletionCandidateSet",
      transcriptArtifactId: transcript.id,
      sequenceId: options.sequenceId,
      clipId: options.clipId,
      projectRevision: options.document.project.revision,
      detectorVersion,
      evidenceContracts: [...evidenceContracts],
      candidates,
      provenance: {
        createdBy: structuredClone(options.actor),
        createdAt: options.createdAt,
        reason: "Generate conservative talking-head silence, filler, and exact repetition candidates",
        sourceArtifactIds: [transcript.id],
      },
    },
    report,
  };
}

interface ExactRepetition {
  text: string;
  removeWords: TranscriptWord[];
  keepWords: TranscriptWord[];
}

function findImmediateExactRepetitions(
  words: TranscriptWord[],
  maximumTokens: number,
  minimumCharacters: number,
): ExactRepetition[] {
  const normalized = words.map((word) => normalizeToken(word.text));
  const repetitions: ExactRepetition[] = [];
  const seenTargets = new Set<string>();
  for (let boundary = 1; boundary < words.length; boundary += 1) {
    const limit = Math.min(maximumTokens, boundary, words.length - boundary);
    for (let size = 1; size <= limit; size += 1) {
      const left = normalized.slice(boundary - size, boundary);
      const right = normalized.slice(boundary, boundary + size);
      if (left.some((token) => token.length === 0) || right.some((token) => token.length === 0)) {
        continue;
      }
      const text = left.join("");
      if (text.length < minimumCharacters || text !== right.join("")) continue;
      const removeWords = words.slice(boundary - size, boundary);
      const targetKey = removeWords.map((word) => word.id).join(":");
      if (!seenTargets.has(targetKey)) {
        seenTargets.add(targetKey);
        repetitions.push({
          text,
          removeWords,
          keepWords: words.slice(boundary, boundary + size),
        });
      }
      break;
    }
  }
  return repetitions;
}

function rangeForWords(words: TranscriptWord[]): TimeRange {
  const first = words[0];
  const last = words.at(-1);
  if (!first || !last) throw new TypeError("Repetition range requires at least one word");
  const start = convertTime(first.sourceRange.start, { numerator: 1_000_000, denominator: 1 }, "nearest");
  const end = convertTime(
    rangeEnd(last.sourceRange),
    { numerator: 1_000_000, denominator: 1 },
    "nearest",
  );
  return {
    start,
    duration: micros(end.value - start.value),
  };
}

export function createLowRiskProposal(
  candidateSet: CandidateSetArtifact,
  options: { actor: Actor; createdAt: string; reason?: string },
): EditProposalArtifact {
  const selected = candidateSet.candidates.filter((candidate) =>
    candidate.decision === "definite_remove" && candidate.risk === "low",
  );
  if (selected.length === 0) {
    throw new CandidateDetectionError("NO_CANDIDATES", "No definite low-risk candidates are available");
  }
  const selectedCandidateIds = selected.map((candidate) => candidate.id);
  const totalMicros = selected.reduce(
    (total, candidate) => total + toMicros(candidate.target.sourceRange.duration),
    0,
  );
  const proposal: EditProposalArtifact = {
    id: `proposal_${createHash("sha256")
      .update(`${candidateSet.id}:${selectedCandidateIds.join(":")}`)
      .digest("hex").slice(0, 24)}`,
    kind: "editProposal",
    candidateSetArtifactId: candidateSet.id,
    projectRevision: candidateSet.projectRevision,
    selectedCandidateIds,
    estimatedRemovedDuration: micros(totalMicros),
    payloadHash: "",
    provenance: {
      createdBy: structuredClone(options.actor),
      createdAt: options.createdAt,
      reason: options.reason ?? "Apply definite low-risk talking-head cleanup",
      sourceArtifactIds: [candidateSet.id],
    },
  };
  proposal.payloadHash = computeEditProposalPayloadHash(proposal);
  return proposal;
}

function findTranscript(document: AgentCutProjectDocument, id: string): TranscriptArtifact {
  const artifact = document.artifacts.find((candidate) => candidate.id === id);
  if (!artifact || artifact.kind !== "transcript") {
    throw new CandidateDetectionError("NO_CANDIDATES", `Transcript ${id} does not exist`);
  }
  return artifact;
}

function findPreviousWord(words: TranscriptWord[], time: TranscriptWord["sourceRange"]["start"]): TranscriptWord | undefined {
  let previous: TranscriptWord | undefined;
  for (const word of words) {
    if (compareTime(rangeEnd(word.sourceRange), time) <= 0) previous = word;
    else break;
  }
  return previous;
}

function findNextWord(words: TranscriptWord[], time: TranscriptWord["sourceRange"]["start"]): TranscriptWord | undefined {
  return words.find((word) => compareTime(word.sourceRange.start, time) >= 0);
}

function normalizeToken(text: string): string {
  return text.trim().replace(/[，。！？、,.!?]/g, "");
}

function candidateId(kind: string, transcriptId: string, anchor: string, range: TimeRange): string {
  const seed = `${kind}:${transcriptId}:${anchor}:${toMicros(range.start)}:${toMicros(range.duration)}`;
  return `candidate_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

function micros(value: number): { value: number; rate: { numerator: 1_000_000; denominator: 1 } } {
  return { value, rate: { numerator: 1_000_000, denominator: 1 } };
}

function toMicros(time: TranscriptWord["sourceRange"]["start"]): number {
  return convertTime(time, { numerator: 1_000_000, denominator: 1 }, "nearest").value;
}
