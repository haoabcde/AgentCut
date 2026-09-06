import type { AgentCutProjectDocument, ValidationIssue } from "@agentcut/timeline-schema";
import { PREVIEW_PROXY_METADATA_KEY, readPreviewProxyBinding } from "./preview-proxy.js";

export type ExtensionValidator = (document: AgentCutProjectDocument) => ValidationIssue[];

export function validatePreviewProxyBindings(
  document: AgentCutProjectDocument,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
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
  return issues;
}

function issue(instancePath: string, keyword: string, message: string): ValidationIssue {
  return { instancePath, keyword, message };
}

/** 口播宿主（TalkCut 系）声明的扩展语义校验器；通用宿主可不注册。 */
export const TALKING_HEAD_EXTENSION_VALIDATORS: readonly ExtensionValidator[] = [
  validatePreviewProxyBindings,
];
