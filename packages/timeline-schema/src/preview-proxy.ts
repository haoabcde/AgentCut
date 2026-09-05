import type { AgentCutProjectDocument, Asset } from "./types.js";

export const PREVIEW_PROXY_METADATA_KEY = "agentcut.previewProxy";
export const BROWSER_PREVIEW_PROXY_PROFILE = "browser-h264-aac-1280-v1";

export interface PreviewProxyBinding {
  schemaVersion: "1.0";
  profile: typeof BROWSER_PREVIEW_PROXY_PROFILE;
  sourceAssetId: string;
  sourceContentHash: string;
}

export function createPreviewProxyBinding(source: Asset): PreviewProxyBinding {
  return {
    schemaVersion: "1.0",
    profile: BROWSER_PREVIEW_PROXY_PROFILE,
    sourceAssetId: source.id,
    sourceContentHash: source.contentHash,
  };
}

export function readPreviewProxyBinding(asset: Asset): PreviewProxyBinding | undefined {
  const value = asset.metadata?.[PREVIEW_PROXY_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const binding = value as Record<string, unknown>;
  if (binding.schemaVersion !== "1.0"
    || binding.profile !== BROWSER_PREVIEW_PROXY_PROFILE
    || typeof binding.sourceAssetId !== "string"
    || typeof binding.sourceContentHash !== "string") return undefined;
  return {
    schemaVersion: "1.0",
    profile: BROWSER_PREVIEW_PROXY_PROFILE,
    sourceAssetId: binding.sourceAssetId,
    sourceContentHash: binding.sourceContentHash,
  };
}

export function findPreviewProxyAsset(
  document: AgentCutProjectDocument,
  source: Asset,
): Asset | undefined {
  return document.assets.find((asset) => {
    const binding = readPreviewProxyBinding(asset);
    return asset.kind === "generated"
      && asset.availability === "online"
      && binding?.sourceAssetId === source.id
      && binding.sourceContentHash === source.contentHash;
  });
}
