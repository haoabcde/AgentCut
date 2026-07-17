import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import formatsModule, { type FormatsPlugin } from "ajv-formats";
import projectSchema from "../schema/timeline-project-0.1.schema.json" with { type: "json" };
import type { AgentCutProjectDocument } from "./types.js";

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
    });
  });

  if (!sequenceIds.has(document.project.activeSequenceId)) {
    issues.push(issue("/project/activeSequenceId", "reference", "references a missing sequence"));
  }
  if (document.history.headRevision !== document.project.revision) {
    issues.push(issue("/history/headRevision", "revision", "must equal project.revision"));
  }
  return issues;
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
