import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateProjectDocument, type AgentCutProjectDocument } from "@agentcut/timeline-schema";
import {
  ALPHA_TRIAL_EXTENSION_KEY,
  createAlphaTrialEnrollment,
  readAlphaTrialEnrollment,
} from "./alpha-trial.js";
import { validatePreviewProxyBindings } from "./validators.js";

const fixtureUrl = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as unknown;

describe("formal Alpha trial extension", () => {
  it("round-trips a versioned formal enrollment", () => {
    const enrollment = createAlphaTrialEnrollment("2026-08-10T00:00:00.000Z");
    expect(readAlphaTrialEnrollment({
      extensions: { [ALPHA_TRIAL_EXTENSION_KEY]: enrollment },
    })).toEqual(enrollment);
  });

  it("treats absence as an ordinary project and rejects malformed enrollment", () => {
    expect(readAlphaTrialEnrollment({})).toBeNull();
    expect(() => readAlphaTrialEnrollment({
      extensions: { [ALPHA_TRIAL_EXTENSION_KEY]: { mode: "formal" } },
    })).toThrow(`Invalid ${ALPHA_TRIAL_EXTENSION_KEY} extension`);
  });
});

describe("preview proxy extension validator", () => {
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
    expect(validatePreviewProxyBindings(valid as unknown as AgentCutProjectDocument)).toEqual([]);

    const drifted = structuredClone(valid) as Record<string, any>;
    drifted.assets[1].metadata["agentcut.previewProxy"].sourceContentHash = `sha256:${"c".repeat(64)}`;
    expect(validatePreviewProxyBindings(drifted as unknown as AgentCutProjectDocument)).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "sourceBinding" }),
    ]));

    const duplicate = structuredClone(valid) as Record<string, any>;
    duplicate.assets.push({ ...structuredClone(duplicate.assets[1]), id: "asset_preview_duplicate" });
    expect(validatePreviewProxyBindings(duplicate as unknown as AgentCutProjectDocument)).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "uniquePreviewProxy" }),
    ]));
  });

  it("rejects unsupported bindings and non-generated carriers through the project validator hook", () => {
    const withBadBinding = structuredClone(fixture) as Record<string, any>;
    withBadBinding.assets[0].metadata = {
      "agentcut.previewProxy": { profile: "browser-h264-aac-1280-v1" },
    };
    const issues = validatePreviewProxyBindings(withBadBinding as unknown as AgentCutProjectDocument);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "previewProxyBinding" }),
    ]));

    const withExtensionHook = structuredClone(withBadBinding) as Record<string, any>;
    const result = validateProjectDocument(withExtensionHook, {
      extensionValidators: [validatePreviewProxyBindings],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "previewProxyBinding" }),
    ]));
  });

  it("keeps host extension metadata opaque to core validation", () => {
    const withUnknownNamespace = structuredClone(fixture) as Record<string, any>;
    withUnknownNamespace.extensions = {
      "vendor.customRule": { anything: true },
    };
    expect(validateProjectDocument(withUnknownNamespace)).toEqual({ valid: true, errors: [] });
  });
});
