import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateProjectDocument } from "./validate.js";

const fixtureUrl = new URL("../fixtures/minimal-project.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as unknown;

describe("timeline project schema", () => {
  it("accepts the executable V0.1 golden fixture", () => {
    expect(validateProjectDocument(fixture)).toEqual({ valid: true, errors: [] });
  });

  it("preserves correction as an auditable deletion reason", () => {
    const correction = structuredClone(fixture) as Record<string, any>;
    const candidateSet = correction.artifacts.find(
      (artifact: any) => artifact.kind === "deletionCandidateSet",
    );
    candidateSet.candidates[0].reasonCodes = ["correction"];
    expect(validateProjectDocument(correction)).toEqual({ valid: true, errors: [] });
  });

  it("validates retained comparison evidence against Transcript words and ordering", () => {
    const valid = structuredClone(fixture) as Record<string, any>;
    const candidateSet = valid.artifacts.find(
      (artifact: any) => artifact.kind === "deletionCandidateSet",
    );
    candidateSet.candidates[0].evidence = [{
      role: "retained_comparison",
      target: {
        kind: "words",
        wordIds: ["word_003"],
        sourceRange: {
          start: { value: 2_000, rate: { numerator: 1_000, denominator: 1 } },
          duration: { value: 400, rate: { numerator: 1_000, denominator: 1 } },
        },
      },
    }];
    expect(validateProjectDocument(valid)).toEqual({ valid: true, errors: [] });

    candidateSet.candidates[0].evidence[0].target.wordIds = ["word_missing"];
    candidateSet.candidates[0].evidence[0].target.sourceRange.start.value = 1_000;
    const invalid = validateProjectDocument(valid);
    expect(invalid.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "reference", instancePath: expect.stringContaining("evidence") }),
      expect.objectContaining({ keyword: "evidenceOrder", instancePath: expect.stringContaining("evidence") }),
    ]));
  });

  it("requires retained evidence for versioned repetition detectors without rejecting legacy sets", () => {
    const legacy = structuredClone(fixture) as Record<string, any>;
    const candidateSet = legacy.artifacts.find(
      (artifact: any) => artifact.kind === "deletionCandidateSet",
    );
    candidateSet.candidates[0].reasonCodes = ["repetition"];
    expect(validateProjectDocument(legacy)).toEqual({ valid: true, errors: [] });

    candidateSet.detectorVersion = "talking-head-mechanical/0.3.0";
    expect(validateProjectDocument(legacy).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "evidenceRequired", instancePath: expect.stringContaining("evidence") }),
    ]));
  });

  it("enforces a declared retained-comparison contract independently of detector naming", () => {
    const declared = structuredClone(fixture) as Record<string, any>;
    const candidateSet = declared.artifacts.find(
      (artifact: any) => artifact.kind === "deletionCandidateSet",
    );
    candidateSet.detectorVersion = "third-party-detector/custom-build";
    candidateSet.evidenceContracts = ["retained-comparison-v1"];
    candidateSet.candidates[0].reasonCodes = ["restatement"];

    expect(validateProjectDocument(declared).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "evidenceRequired", instancePath: expect.stringContaining("evidence") }),
    ]));
  });

  it("rejects fractional time values", () => {
    const invalid = structuredClone(fixture) as Record<string, any>;
    invalid.sequences[0].tracks[0].clips[0].timelineRange.start.value = 0.5;
    const result = validateProjectDocument(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.keyword === "type")).toBe(true);
  });

  it("rejects dangling references and revision drift", () => {
    const invalid = structuredClone(fixture) as Record<string, any>;
    invalid.sequences[0].tracks[0].clips[0].assetId = "missing_asset";
    invalid.history.headRevision = 4;
    const result = validateProjectDocument(invalid);
    expect(result.errors.map((error) => error.keyword)).toEqual(
      expect.arrayContaining(["reference", "revision"]),
    );
  });

  it("binds one generated preview proxy to the exact source bytes", () => {
    const valid = structuredClone(fixture) as Record<string, any>;
    const source = valid.assets[0];
    valid.assets.push({
      id: "asset_preview_source",
      kind: "generated",
      uri: "proxies/source-preview.mp4",
      contentHash: `sha256:${"b".repeat(64)}`,
      availability: "online",
      provenance: {
        createdBy: { kind: "workflow", id: "preview_proxy_v1" },
        createdAt: "2026-08-13T00:00:00.000Z",
        reason: "Browser-compatible local preview",
      },
      metadata: {
        "agentcut.previewProxy": {
          schemaVersion: "1.0",
          profile: "browser-h264-aac-1280-v1",
          sourceAssetId: source.id,
          sourceContentHash: source.contentHash,
        },
      },
    });
    expect(validateProjectDocument(valid)).toEqual({ valid: true, errors: [] });

    const drifted = structuredClone(valid) as Record<string, any>;
    drifted.assets[1].metadata["agentcut.previewProxy"].sourceContentHash = `sha256:${"c".repeat(64)}`;
    expect(validateProjectDocument(drifted).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "sourceBinding" }),
    ]));

    const duplicate = structuredClone(valid) as Record<string, any>;
    duplicate.assets.push({ ...structuredClone(duplicate.assets[1]), id: "asset_preview_duplicate" });
    expect(validateProjectDocument(duplicate).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "uniquePreviewProxy" }),
    ]));
  });

  it("rejects semantic locks pointing at missing objects", () => {
    const invalid = structuredClone(fixture) as Record<string, any>;
    invalid.sequences[0].locks.push({
      id: "lock_missing_clip",
      owner: "local_user",
      mode: "owner_only",
      scope: { kind: "clip", clipId: "missing_clip" },
      createdAt: "2026-07-17T08:00:00Z",
    });
    const result = validateProjectDocument(invalid);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "reference", instancePath: expect.stringContaining("clipId") }),
    ]));
  });

  it("rejects duplicate or overlapping transcript words", () => {
    const invalid = structuredClone(fixture) as Record<string, any>;
    const transcript = invalid.artifacts.find((artifact: any) => artifact.kind === "transcript");
    transcript.words[1].id = transcript.words[0].id;
    transcript.words[1].sourceRange.start.value = 1500;
    const result = validateProjectDocument(invalid);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "uniqueWordId" }),
      expect.objectContaining({ keyword: "wordOrder" }),
    ]));
  });

  it("rejects deletion targets with missing words or uncovered ranges", () => {
    const invalid = structuredClone(fixture) as Record<string, any>;
    const candidateSet = invalid.artifacts.find(
      (artifact: any) => artifact.kind === "deletionCandidateSet",
    );
    candidateSet.candidates[0].target.wordIds.push("word_missing");
    candidateSet.candidates[0].target.sourceRange.duration.value = 100;
    const result = validateProjectDocument(invalid);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "reference", instancePath: expect.stringContaining("wordIds") }),
      expect.objectContaining({ keyword: "rangeCoverage" }),
    ]));
  });

  it("rejects gap candidates that overlap their anchor words", () => {
    const invalid = structuredClone(fixture) as Record<string, any>;
    const candidateSet = invalid.artifacts.find(
      (artifact: any) => artifact.kind === "deletionCandidateSet",
    );
    candidateSet.candidates[1].target.sourceRange.start.value = 1500;
    candidateSet.candidates[1].target.sourceRange.duration.value = 300;
    const result = validateProjectDocument(invalid);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "gapBoundary" }),
    ]));
  });

  it("rejects stale proposal bindings and missing candidate references", () => {
    const invalid = structuredClone(fixture) as Record<string, any>;
    const proposal = invalid.artifacts.find((artifact: any) => artifact.kind === "editProposal");
    proposal.projectRevision = 1;
    proposal.selectedCandidateIds = ["candidate_missing"];
    const result = validateProjectDocument(invalid);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "revision" }),
      expect.objectContaining({ keyword: "revisionBinding" }),
      expect.objectContaining({ keyword: "reference", instancePath: expect.stringContaining("selectedCandidateIds") }),
    ]));
  });

  it("rejects provenance pointing at a missing artifact", () => {
    const invalid = structuredClone(fixture) as Record<string, any>;
    invalid.artifacts[0].provenance.sourceArtifactIds = ["artifact_missing"];
    const result = validateProjectDocument(invalid);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "reference", instancePath: expect.stringContaining("sourceArtifactIds") }),
    ]));
  });

  it("rejects candidate sets bound to a missing sequence or clip", () => {
    const invalid = structuredClone(fixture) as Record<string, any>;
    const candidateSet = invalid.artifacts.find(
      (artifact: any) => artifact.kind === "deletionCandidateSet",
    );
    candidateSet.sequenceId = "sequence_missing";
    candidateSet.clipId = "clip_missing";
    const result = validateProjectDocument(invalid);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "reference", instancePath: expect.stringContaining("sequenceId") }),
      expect.objectContaining({ keyword: "reference", instancePath: expect.stringContaining("clipId") }),
    ]));
  });

  it("rejects candidate ranges outside the bound source clip", () => {
    const invalid = structuredClone(fixture) as Record<string, any>;
    const candidateSet = invalid.artifacts.find(
      (artifact: any) => artifact.kind === "deletionCandidateSet",
    );
    candidateSet.candidates[0].target.sourceRange.start.value = 20_000;
    const result = validateProjectDocument(invalid);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "sourceBinding" }),
    ]));
  });

  it("binds normalized transcripts to the same raw ASR asset and stream", () => {
    const valid = structuredClone(fixture) as Record<string, any>;
    const transcript = valid.artifacts.find((artifact: any) => artifact.kind === "transcript");
    const provider = {
      id: "asr_provider_fixture",
      kind: "asrProviderResult",
      assetId: transcript.assetId,
      audioStreamIndex: transcript.audioStreamIndex,
      provider: "mlx-whisper",
      model: "mlx-community/whisper-large-v3-turbo",
      providerVersion: "0.4.3",
      payloadHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      uri: "artifacts/raw-asr.json",
      provenance: {
        createdBy: { kind: "workflow", id: "asr_job" },
        createdAt: "2026-07-17T08:00:00Z",
        reason: "Preserve provider output",
      },
    };
    valid.artifacts.unshift(provider);
    transcript.providerArtifactId = provider.id;
    transcript.provenance.sourceArtifactIds = [provider.id];
    expect(validateProjectDocument(valid)).toEqual({ valid: true, errors: [] });

    provider.audioStreamIndex += 1;
    const invalid = validateProjectDocument(valid);
    expect(invalid.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "sourceBinding" }),
    ]));
  });

  it("validates caption documents and render reports as revision-bound artifacts", () => {
    const valid = structuredClone(fixture) as Record<string, any>;
    const transcript = valid.artifacts.find((artifact: any) => artifact.kind === "transcript");
    const outputAsset = {
      id: "asset_render_fixture",
      kind: "generated",
      uri: "renders/fixture.mp4",
      contentHash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      availability: "online",
      provenance: {
        createdBy: { kind: "workflow", id: "render_job" },
        createdAt: "2026-07-18T10:00:00Z",
        reason: "Render fixture",
      },
    };
    const captions = {
      id: "captions_fixture",
      kind: "captionDocument",
      transcriptArtifactId: transcript.id,
      sequenceId: "sequence_main",
      projectRevision: 0,
      language: "zh",
      format: "srt",
      uri: "renders/fixture.srt",
      contentHash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      cues: [{
        id: "caption_cue_fixture",
        text: "大家好",
        wordIds: ["word_001"],
        timelineRange: {
          start: { value: 0, rate: { numerator: 1_000, denominator: 1 } },
          duration: { value: 600, rate: { numerator: 1_000, denominator: 1 } },
        },
      }],
      provenance: {
        createdBy: { kind: "workflow", id: "caption_job" },
        createdAt: "2026-07-18T10:00:00Z",
        reason: "Caption fixture",
        sourceArtifactIds: [transcript.id],
      },
    };
    const render = {
      id: "render_fixture",
      kind: "renderReport",
      sequenceId: "sequence_main",
      projectRevision: 0,
      outputAssetId: outputAsset.id,
      captionArtifactId: captions.id,
      renderer: "ffmpeg",
      rendererVersion: "ffmpeg fixture",
      planHash: "sha256:abababababababababababababababababababababababababababababababab",
      duration: { value: 10_010, rate: { numerator: 1_000, denominator: 1 } },
      fileSizeBytes: 1_024,
      videoCodec: "h264",
      audioCodec: "aac",
      quality: {
        timelineDuration: { value: 10_010, rate: { numerator: 1_000, denominator: 1 } },
        outputDuration: { value: 10_010, rate: { numerator: 1_000, denominator: 1 } },
        durationDeltaMillis: 0,
        width: 1080,
        height: 1920,
        hasAudio: true,
        subtitleCueCount: 1,
        passed: true,
      },
      warnings: [],
      provenance: {
        createdBy: { kind: "workflow", id: "render_job" },
        createdAt: "2026-07-18T10:00:00Z",
        reason: "Render fixture",
        sourceArtifactIds: [transcript.id, captions.id],
      },
    };
    valid.assets.push(outputAsset);
    valid.artifacts.push(captions, render);
    expect(validateProjectDocument(valid)).toEqual({ valid: true, errors: [] });

    render.quality.subtitleCueCount = 2;
    render.outputAssetId = "asset_missing";
    const invalid = validateProjectDocument(valid);
    expect(invalid.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "captionCount" }),
      expect.objectContaining({ keyword: "reference", instancePath: expect.stringContaining("outputAssetId") }),
    ]));
  });
});
