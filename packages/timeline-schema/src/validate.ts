import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import formatsModule, { type FormatsPlugin } from "ajv-formats";
import projectSchema from "../schema/timeline-project-0.1.schema.json" with { type: "json" };
import type {
  AgentCutProjectDocument,
  AsrProviderArtifact,
  CaptionDocumentArtifact,
  CandidateSetArtifact,
  EditProposalArtifact,
  RenderReportArtifact,
  Time,
  TimeRange,
  TranscriptArtifact,
} from "./types.js";
import {
  PREVIEW_PROXY_METADATA_KEY,
  readPreviewProxyBinding,
} from "./preview-proxy.js";

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const addFormats = formatsModule as unknown as FormatsPlugin;
addFormats(ajv);

const validateProject = ajv.compile<AgentCutProjectDocument>(projectSchema);

export interface ValidationIssue {
  instancePath: string;
  keyword: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
}

export function validateProjectDocument(value: unknown): ValidationResult {
  const structurallyValid = validateProject(value);
  const structuralErrors = structurallyValid
    ? []
    : (validateProject.errors ?? []).map((error: ErrorObject) => ({
      instancePath: error.instancePath,
      keyword: error.keyword,
      message: error.message ?? "is invalid",
    }));
  const semanticErrors = structurallyValid
    ? validateSemantics(value as AgentCutProjectDocument)
    : [];
  return {
    valid: structuralErrors.length === 0 && semanticErrors.length === 0,
    errors: [...structuralErrors, ...semanticErrors],
  };
}

export function assertProjectDocument(value: unknown): asserts value is AgentCutProjectDocument {
  const result = validateProjectDocument(value);
  if (!result.valid) {
    const details = result.errors
      .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
      .join("; ");
    throw new TypeError(`Invalid AgentCut project document: ${details}`);
  }
}

function validateSemantics(document: AgentCutProjectDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenIds = new Map<string, string>();
  const assetIds = new Set(document.assets.map((asset) => asset.id));
  const sequenceIds = new Set(document.sequences.map((sequence) => sequence.id));
  const trackIds = new Set(document.sequences.flatMap((sequence) => sequence.tracks.map((track) => track.id)));
  const clipIds = new Set(document.sequences.flatMap((sequence) =>
    sequence.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  ));
  const artifactIds = new Set(document.artifacts.map((artifact) => artifact.id));

  const recordId = (id: string, path: string): void => {
    const previousPath = seenIds.get(id);
    if (previousPath) {
      issues.push(issue(path, "uniqueId", `duplicates ID from ${previousPath}`));
    } else {
      seenIds.set(id, path);
    }
  };

  recordId(document.project.id, "/project/id");
  document.assets.forEach((asset, assetIndex) => recordId(asset.id, `/assets/${assetIndex}/id`));
  const previewProxyKeys = new Set<string>();
  document.assets.forEach((asset, assetIndex) => {
    const path = `/assets/${assetIndex}/metadata/${PREVIEW_PROXY_METADATA_KEY}`;
    const hasBinding = asset.metadata !== undefined
      && Object.prototype.hasOwnProperty.call(asset.metadata, PREVIEW_PROXY_METADATA_KEY);
    if (!hasBinding) return;
    const binding = readPreviewProxyBinding(asset);
    if (!binding) {
      issues.push(issue(path, "previewProxyBinding", "must contain a supported preview proxy binding"));
      return;
    }
    const source = document.assets.find((candidate) => candidate.id === binding.sourceAssetId);
    if (asset.kind !== "generated") {
      issues.push(issue(path, "previewProxyBinding", "must belong to a generated asset"));
    }
    if (!source || source.id === asset.id) {
      issues.push(issue(`${path}/sourceAssetId`, "reference", "must reference another source asset"));
    } else if (source.contentHash !== binding.sourceContentHash) {
      issues.push(issue(`${path}/sourceContentHash`, "sourceBinding", "must match the source asset content hash"));
    }
    const key = `${binding.sourceAssetId}:${binding.profile}`;
    if (previewProxyKeys.has(key)) {
      issues.push(issue(path, "uniquePreviewProxy", "duplicates the source/profile preview proxy"));
    } else {
      previewProxyKeys.add(key);
    }
  });
  document.artifacts.forEach((artifact, artifactIndex) => {
    recordId(artifact.id, `/artifacts/${artifactIndex}/id`);
  });
  document.sequences.forEach((sequence, sequenceIndex) => {
    recordId(sequence.id, `/sequences/${sequenceIndex}/id`);
    sequence.tracks.forEach((track, trackIndex) => {
      recordId(track.id, `/sequences/${sequenceIndex}/tracks/${trackIndex}/id`);
      track.clips.forEach((clip, clipIndex) => {
        const path = `/sequences/${sequenceIndex}/tracks/${trackIndex}/clips/${clipIndex}`;
        recordId(clip.id, `${path}/id`);
        if (clip.timelineRange.duration.value === 0) {
          issues.push(issue(`${path}/timelineRange/duration/value`, "positiveDuration", "must be greater than zero"));
        }
        if (clip.assetId && !assetIds.has(clip.assetId)) {
          issues.push(issue(`${path}/assetId`, "reference", "references a missing asset"));
        }
        if (clip.sequenceId && !sequenceIds.has(clip.sequenceId)) {
          issues.push(issue(`${path}/sequenceId`, "reference", "references a missing sequence"));
        }
        if (!isClipAllowedOnTrack(clip.kind, track.kind)) {
          issues.push(issue(`${path}/kind`, "trackCompatibility", `${clip.kind} is not allowed on a ${track.kind} track`));
        }
      });
    });
    sequence.locks.forEach((lock, lockIndex) => {
      const path = `/sequences/${sequenceIndex}/locks/${lockIndex}`;
      recordId(lock.id, `${path}/id`);
      if (lock.scope.kind === "track" && !trackIds.has(lock.scope.trackId)) {
        issues.push(issue(`${path}/scope/trackId`, "reference", "references a missing track"));
      }
      if (lock.scope.kind === "clip" && !clipIds.has(lock.scope.clipId)) {
        issues.push(issue(`${path}/scope/clipId`, "reference", "references a missing clip"));
      }
      if (lock.scope.kind === "property"
        && !trackIds.has(lock.scope.objectId)
        && !clipIds.has(lock.scope.objectId)) {
        issues.push(issue(`${path}/scope/objectId`, "reference", "references a missing track or clip"));
      }
      if (lock.scope.kind === "range") {
        lock.scope.trackIds?.forEach((trackId, trackIndex) => {
          if (!trackIds.has(trackId)) {
            issues.push(issue(`${path}/scope/trackIds/${trackIndex}`, "reference", "references a missing track"));
          }
        });
      }
      if (lock.scope.kind === "source_range" && !assetIds.has(lock.scope.assetId)) {
        issues.push(issue(`${path}/scope/assetId`, "reference", "references a missing asset"));
      }
    });
  });

  if (!sequenceIds.has(document.project.activeSequenceId)) {
    issues.push(issue("/project/activeSequenceId", "reference", "references a missing sequence"));
  }
  if (document.history.headRevision !== document.project.revision) {
    issues.push(issue("/history/headRevision", "revision", "must equal project.revision"));
  }
  validateArtifacts(document, artifactIds, assetIds, issues);
  return issues;
}

function validateArtifacts(
  document: AgentCutProjectDocument,
  artifactIds: Set<string>,
  assetIds: Set<string>,
  issues: ValidationIssue[],
): void {
  const transcripts = new Map<string, TranscriptArtifact>();
  const candidateSets = new Map<string, CandidateSetArtifact>();
  const providerArtifacts = new Map<string, AsrProviderArtifact>();
  const captionDocuments = new Map<string, CaptionDocumentArtifact>();

  document.artifacts.forEach((artifact, artifactIndex) => {
    const path = `/artifacts/${artifactIndex}`;
    for (const [sourceIndex, sourceArtifactId] of (artifact.provenance.sourceArtifactIds ?? []).entries()) {
      if (!artifactIds.has(sourceArtifactId)) {
        issues.push(issue(
          `${path}/provenance/sourceArtifactIds/${sourceIndex}`,
          "reference",
          "references a missing artifact",
        ));
      }
    }
    if (artifact.kind === "asrProviderResult") {
      if (!assetIds.has(artifact.assetId)) {
        issues.push(issue(`${path}/assetId`, "reference", "references a missing asset"));
      }
      providerArtifacts.set(artifact.id, artifact);
    } else if (artifact.kind === "transcript") {
      validateTranscript(artifact, path, assetIds, issues);
      transcripts.set(artifact.id, artifact);
    } else if (artifact.kind === "deletionCandidateSet") {
      candidateSets.set(artifact.id, artifact);
    } else if (artifact.kind === "captionDocument") {
      captionDocuments.set(artifact.id, artifact);
    }
  });

  document.artifacts.forEach((artifact, artifactIndex) => {
    const path = `/artifacts/${artifactIndex}`;
    if (artifact.kind === "transcript" && artifact.providerArtifactId) {
      const provider = providerArtifacts.get(artifact.providerArtifactId);
      if (!provider) {
        issues.push(issue(
          `${path}/providerArtifactId`,
          "reference",
          "references a missing ASR provider artifact",
        ));
      } else if (
        provider.assetId !== artifact.assetId
        || provider.audioStreamIndex !== artifact.audioStreamIndex
      ) {
        issues.push(issue(
          `${path}/providerArtifactId`,
          "sourceBinding",
          "must reference the same asset and audio stream",
        ));
      }
    } else if (artifact.kind === "deletionCandidateSet") {
      validateCandidateSet(artifact, path, transcripts, document, issues);
    } else if (artifact.kind === "editProposal") {
      validateEditProposal(artifact, path, candidateSets, document.project.revision, issues);
    } else if (artifact.kind === "captionDocument") {
      validateCaptionDocument(artifact, path, transcripts, document, issues);
    } else if (artifact.kind === "renderReport") {
      validateRenderReport(artifact, path, captionDocuments, document, issues);
    }
  });
}

function validateCaptionDocument(
  caption: CaptionDocumentArtifact,
  path: string,
  transcripts: Map<string, TranscriptArtifact>,
  document: AgentCutProjectDocument,
  issues: ValidationIssue[],
): void {
  const transcript = transcripts.get(caption.transcriptArtifactId);
  if (!transcript) {
    issues.push(issue(`${path}/transcriptArtifactId`, "reference", "references a missing transcript artifact"));
    return;
  }
  if (!document.sequences.some((sequence) => sequence.id === caption.sequenceId)) {
    issues.push(issue(`${path}/sequenceId`, "reference", "references a missing sequence"));
  }
  if (caption.projectRevision > document.project.revision) {
    issues.push(issue(`${path}/projectRevision`, "revision", "cannot be newer than project.revision"));
  }
  const transcriptWordIds = new Set(transcript.words.map((word) => word.id));
  const cueIds = new Set<string>();
  let previousRange: TimeRange | undefined;
  caption.cues.forEach((cue, cueIndex) => {
    const cuePath = `${path}/cues/${cueIndex}`;
    if (cueIds.has(cue.id)) {
      issues.push(issue(`${cuePath}/id`, "uniqueCueId", "duplicates a caption cue ID"));
    }
    cueIds.add(cue.id);
    if (cue.timelineRange.duration.value === 0) {
      issues.push(issue(`${cuePath}/timelineRange/duration/value`, "positiveDuration", "must be greater than zero"));
    }
    if (previousRange
      && compareFractions(rangeEnd(previousRange), timeFraction(cue.timelineRange.start)) > 0) {
      issues.push(issue(`${cuePath}/timelineRange/start`, "cueOrder", "must not overlap the previous cue"));
    }
    previousRange = cue.timelineRange;
    cue.wordIds.forEach((wordId, wordIndex) => {
      if (!transcriptWordIds.has(wordId)) {
        issues.push(issue(`${cuePath}/wordIds/${wordIndex}`, "reference", "references a missing transcript word"));
      }
    });
  });
}

function validateRenderReport(
  report: RenderReportArtifact,
  path: string,
  captionDocuments: Map<string, CaptionDocumentArtifact>,
  document: AgentCutProjectDocument,
  issues: ValidationIssue[],
): void {
  if (!document.sequences.some((sequence) => sequence.id === report.sequenceId)) {
    issues.push(issue(`${path}/sequenceId`, "reference", "references a missing sequence"));
  }
  if (report.projectRevision > document.project.revision) {
    issues.push(issue(`${path}/projectRevision`, "revision", "cannot be newer than project.revision"));
  }
  const output = document.assets.find((asset) => asset.id === report.outputAssetId);
  if (!output) {
    issues.push(issue(`${path}/outputAssetId`, "reference", "references a missing output asset"));
  } else if (output.kind !== "generated") {
    issues.push(issue(`${path}/outputAssetId`, "assetBinding", "must reference a generated asset"));
  }
  if (report.captionArtifactId) {
    const caption = captionDocuments.get(report.captionArtifactId);
    if (!caption) {
      issues.push(issue(`${path}/captionArtifactId`, "reference", "references a missing caption document"));
    } else {
      if (caption.sequenceId !== report.sequenceId) {
        issues.push(issue(`${path}/captionArtifactId`, "sequenceBinding", "must reference the rendered sequence"));
      }
      if (report.quality.subtitleCueCount !== caption.cues.length) {
        issues.push(issue(
          `${path}/quality/subtitleCueCount`,
          "captionCount",
          "must equal the referenced caption cue count",
        ));
      }
    }
  } else if (report.quality.subtitleCueCount !== 0) {
    issues.push(issue(
      `${path}/quality/subtitleCueCount`,
      "captionCount",
      "must be zero when no caption artifact is referenced",
    ));
  }
}

function validateTranscript(
  transcript: TranscriptArtifact,
  path: string,
  assetIds: Set<string>,
  issues: ValidationIssue[],
): void {
  if (!assetIds.has(transcript.assetId)) {
    issues.push(issue(`${path}/assetId`, "reference", "references a missing asset"));
  }
  const wordIds = new Set<string>();
  let previousRange: TimeRange | undefined;
  transcript.words.forEach((word, wordIndex) => {
    const wordPath = `${path}/words/${wordIndex}`;
    if (wordIds.has(word.id)) {
      issues.push(issue(`${wordPath}/id`, "uniqueWordId", "duplicates a word ID in this transcript"));
    }
    wordIds.add(word.id);
    if (word.sourceRange.duration.value === 0) {
      issues.push(issue(`${wordPath}/sourceRange/duration/value`, "positiveDuration", "must be greater than zero"));
    }
    if (previousRange && compareFractions(rangeEnd(previousRange), timeFraction(word.sourceRange.start)) > 0) {
      issues.push(issue(`${wordPath}/sourceRange/start`, "wordOrder", "must not overlap the previous word"));
    }
    previousRange = word.sourceRange;
  });
}

function validateCandidateSet(
  candidateSet: CandidateSetArtifact,
  path: string,
  transcripts: Map<string, TranscriptArtifact>,
  document: AgentCutProjectDocument,
  issues: ValidationIssue[],
): void {
  const transcript = transcripts.get(candidateSet.transcriptArtifactId);
  if (!transcript) {
    issues.push(issue(`${path}/transcriptArtifactId`, "reference", "references a missing transcript artifact"));
    return;
  }
  if (candidateSet.projectRevision > document.project.revision) {
    issues.push(issue(`${path}/projectRevision`, "revision", "cannot be newer than project.revision"));
  }
  const isCurrent = candidateSet.projectRevision === document.project.revision;
  const sequence = isCurrent
    ? document.sequences.find((candidate) => candidate.id === candidateSet.sequenceId)
    : undefined;
  if (isCurrent && !sequence) {
    issues.push(issue(`${path}/sequenceId`, "reference", "references a missing sequence"));
  }
  const clip = sequence?.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === candidateSet.clipId);
  if (isCurrent && !clip) {
    issues.push(issue(`${path}/clipId`, "reference", "references a missing clip in the bound sequence"));
  } else if (clip) {
    if (clip.assetId !== transcript.assetId) {
      issues.push(issue(`${path}/clipId`, "assetBinding", "must reference a clip using the transcript asset"));
    }
    if (!clip.sourceRange) {
      issues.push(issue(`${path}/clipId`, "sourceBinding", "must reference a clip with a source range"));
    }
  }
  const words = new Map(transcript.words.map((word) => [word.id, word]));
  const candidateIds = new Set<string>();
  const declaresStructuredComparison = candidateSet.evidenceContracts
    ?.includes("retained-comparison-v1") === true;
  // These two releases shipped the evidence guarantee immediately before the
  // explicit contract marker existed. Keep them strict without forcing a
  // migration of already persisted artifacts; all new generators declare the
  // capability on the CandidateSet itself.
  const hasImplicitLegacyComparisonContract = candidateSet.detectorVersion
    === "talking-head-mechanical/0.3.0"
    || candidateSet.detectorVersion.startsWith("semantic-review/0.2/");
  const requiresStructuredComparison = declaresStructuredComparison
    || hasImplicitLegacyComparisonContract;
  candidateSet.candidates.forEach((candidate, candidateIndex) => {
    const candidatePath = `${path}/candidates/${candidateIndex}`;
    if (candidateIds.has(candidate.id)) {
      issues.push(issue(`${candidatePath}/id`, "uniqueCandidateId", "duplicates a candidate ID in this set"));
    }
    candidateIds.add(candidate.id);
    if (candidate.target.sourceRange.duration.value === 0) {
      issues.push(issue(
        `${candidatePath}/target/sourceRange/duration/value`,
        "positiveDuration",
        "must be greater than zero",
      ));
    }
    validateDeletionTarget(candidate.target, `${candidatePath}/target`, words, issues);
    if (clip?.sourceRange && !rangeContains(clip.sourceRange, candidate.target.sourceRange)) {
      issues.push(issue(
        `${candidatePath}/target/sourceRange`,
        "sourceBinding",
        `falls outside bound clip ${clip.id}`,
      ));
    }
    candidate.evidence?.forEach((evidence, evidenceIndex) => {
      const evidencePath = `${candidatePath}/evidence/${evidenceIndex}`;
      validateDeletionTarget(evidence.target, `${evidencePath}/target`, words, issues);
      if (clip?.sourceRange && !rangeContains(clip.sourceRange, evidence.target.sourceRange)) {
        issues.push(issue(
          `${evidencePath}/target/sourceRange`,
          "sourceBinding",
          `falls outside bound clip ${clip.id}`,
        ));
      }
      if (evidence.role === "retained_comparison"
        && compareFractions(
          timeFraction(evidence.target.sourceRange.start),
          rangeEnd(candidate.target.sourceRange),
        ) < 0) {
        issues.push(issue(
          `${evidencePath}/target/sourceRange/start`,
          "evidenceOrder",
          "retained comparison must start after the deletion target ends",
        ));
      }
    });
    if (requiresStructuredComparison
      && candidate.reasonCodes.some((reason) =>
        reason === "repetition" || reason === "restatement" || reason === "correction",
      )
      && !candidate.evidence?.some((evidence) => evidence.role === "retained_comparison")) {
      issues.push(issue(
        `${candidatePath}/evidence`,
        "evidenceRequired",
        `detector ${candidateSet.detectorVersion} must preserve retained comparison evidence`,
      ));
    }
    candidate.alternatives?.forEach((alternative, alternativeIndex) => {
      validateDeletionTarget(
        alternative.target,
        `${candidatePath}/alternatives/${alternativeIndex}/target`,
        words,
        issues,
      );
      if (clip?.sourceRange && !rangeContains(clip.sourceRange, alternative.target.sourceRange)) {
        issues.push(issue(
          `${candidatePath}/alternatives/${alternativeIndex}/target/sourceRange`,
          "sourceBinding",
          `falls outside bound clip ${clip.id}`,
        ));
      }
    });
  });
}

function validateDeletionTarget(
  target: CandidateSetArtifact["candidates"][number]["target"],
  path: string,
  words: Map<string, TranscriptArtifact["words"][number]>,
  issues: ValidationIssue[],
): void {
  if (target.kind === "words") {
    target.wordIds.forEach((wordId, wordIndex) => {
      const word = words.get(wordId);
      if (!word) {
        issues.push(issue(`${path}/wordIds/${wordIndex}`, "reference", "references a missing transcript word"));
      } else if (!rangeContains(target.sourceRange, word.sourceRange)) {
        issues.push(issue(
          `${path}/sourceRange`,
          "rangeCoverage",
          `does not contain referenced word ${wordId}`,
        ));
      }
    });
    return;
  }

  const previous = target.previousWordId ? words.get(target.previousWordId) : undefined;
  const next = target.nextWordId ? words.get(target.nextWordId) : undefined;
  if (target.previousWordId && !previous) {
    issues.push(issue(`${path}/previousWordId`, "reference", "references a missing transcript word"));
  }
  if (target.nextWordId && !next) {
    issues.push(issue(`${path}/nextWordId`, "reference", "references a missing transcript word"));
  }
  if (previous && compareFractions(timeFraction(target.sourceRange.start), rangeEnd(previous.sourceRange)) < 0) {
    issues.push(issue(`${path}/sourceRange/start`, "gapBoundary", "starts before the previous word ends"));
  }
  if (next && compareFractions(rangeEnd(target.sourceRange), timeFraction(next.sourceRange.start)) > 0) {
    issues.push(issue(`${path}/sourceRange`, "gapBoundary", "ends after the next word starts"));
  }
}

function validateEditProposal(
  proposal: EditProposalArtifact,
  path: string,
  candidateSets: Map<string, CandidateSetArtifact>,
  headRevision: number,
  issues: ValidationIssue[],
): void {
  const candidateSet = candidateSets.get(proposal.candidateSetArtifactId);
  if (!candidateSet) {
    issues.push(issue(`${path}/candidateSetArtifactId`, "reference", "references a missing candidate set artifact"));
    return;
  }
  if (proposal.projectRevision > headRevision) {
    issues.push(issue(`${path}/projectRevision`, "revision", "cannot be newer than project.revision"));
  }
  if (proposal.projectRevision !== candidateSet.projectRevision) {
    issues.push(issue(`${path}/projectRevision`, "revisionBinding", "must equal candidate set projectRevision"));
  }
  const candidateIds = new Set(candidateSet.candidates.map((candidate) => candidate.id));
  proposal.selectedCandidateIds.forEach((candidateId, candidateIndex) => {
    if (!candidateIds.has(candidateId)) {
      issues.push(issue(
        `${path}/selectedCandidateIds/${candidateIndex}`,
        "reference",
        "references a missing candidate in the bound set",
      ));
    }
  });
  if (proposal.estimatedRemovedDuration.value === 0) {
    issues.push(issue(
      `${path}/estimatedRemovedDuration/value`,
      "positiveDuration",
      "must be greater than zero",
    ));
  }
}

interface Fraction {
  numerator: bigint;
  denominator: bigint;
}

function timeFraction(time: Time): Fraction {
  return {
    numerator: BigInt(time.value) * BigInt(time.rate.denominator),
    denominator: BigInt(time.rate.numerator),
  };
}

function rangeEnd(range: TimeRange): Fraction {
  const start = timeFraction(range.start);
  const duration = timeFraction(range.duration);
  return {
    numerator: start.numerator * duration.denominator + duration.numerator * start.denominator,
    denominator: start.denominator * duration.denominator,
  };
}

function compareFractions(left: Fraction, right: Fraction): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function rangeContains(container: TimeRange, child: TimeRange): boolean {
  return compareFractions(timeFraction(container.start), timeFraction(child.start)) <= 0
    && compareFractions(rangeEnd(container), rangeEnd(child)) >= 0;
}

function isClipAllowedOnTrack(clipKind: string, trackKind: string): boolean {
  if (trackKind === "caption") return clipKind === "caption";
  if (trackKind === "audio") return clipKind === "media" || clipKind === "gap";
  if (trackKind === "graphic") return ["text", "image", "sticker", "shape", "gap"].includes(clipKind);
  return ["media", "image", "nestedSequence", "gap"].includes(clipKind);
}

function issue(instancePath: string, keyword: string, message: string): ValidationIssue {
  return { instancePath, keyword, message };
}
