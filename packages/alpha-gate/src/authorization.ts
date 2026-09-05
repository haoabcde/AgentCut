import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

const MARKER_PREFIX = "agentcut-alpha-authorization";

export class AlphaAuthorizationEvidenceError extends Error {
  readonly code = "AUTHORIZATION_EVIDENCE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "AlphaAuthorizationEvidenceError";
  }
}

export function alphaAuthorizationMarker(cohortId: string, sourceSha256: string): string {
  return `<!-- ${MARKER_PREFIX}: ${cohortId} ${sourceSha256.toLowerCase()} -->`;
}

export function alphaAuthorizationEvidenceSha256(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export async function assertAlphaAuthorizationEvidence(input: {
  cohortId: string;
  sourceSha256: string;
  path: string;
  reference: string;
}): Promise<string> {
  let file: Awaited<ReturnType<typeof stat>>;
  let bytes: Buffer;
  let content: string;
  try {
    file = await stat(input.path);
    if (!file.isFile() || file.size === 0) throw new Error("not a non-empty regular file");
    bytes = await readFile(input.path);
    content = bytes.toString("utf8");
  } catch {
    throw new AlphaAuthorizationEvidenceError(
      `Project ${input.cohortId} authorization evidence is missing, empty or not a regular file: ${input.reference}`,
    );
  }

  const marker = alphaAuthorizationMarker(input.cohortId, input.sourceSha256);
  if (!content.split(/\r?\n/u).some((line) => line.trim() === marker)) {
    throw new AlphaAuthorizationEvidenceError(
      `Project ${input.cohortId} authorization evidence does not contain the exact marker ${marker}: ${input.reference}`,
    );
  }
  return alphaAuthorizationEvidenceSha256(bytes);
}
