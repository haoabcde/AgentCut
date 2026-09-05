import type { AgentCutProjectDocument } from "./types.js";

export const ALPHA_TRIAL_EXTENSION_KEY = "agentcut.alphaTrial";

export interface AlphaTrialEnrollment {
  schemaVersion: "1.0";
  mode: "formal";
  enrolledAt: string;
}

export function createAlphaTrialEnrollment(enrolledAt: string): AlphaTrialEnrollment {
  if (!Number.isFinite(Date.parse(enrolledAt))) {
    throw new TypeError("Alpha trial enrolledAt must be an ISO date-time");
  }
  return { schemaVersion: "1.0", mode: "formal", enrolledAt };
}

export function readAlphaTrialEnrollment(
  document: Pick<AgentCutProjectDocument, "extensions">,
): AlphaTrialEnrollment | null {
  const value = document.extensions?.[ALPHA_TRIAL_EXTENSION_KEY];
  if (value === undefined) return null;
  if (!isRecord(value)
    || value.schemaVersion !== "1.0"
    || value.mode !== "formal"
    || typeof value.enrolledAt !== "string"
    || !Number.isFinite(Date.parse(value.enrolledAt))) {
    throw new TypeError(`Invalid ${ALPHA_TRIAL_EXTENSION_KEY} extension`);
  }
  return {
    schemaVersion: "1.0",
    mode: "formal",
    enrolledAt: value.enrolledAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
