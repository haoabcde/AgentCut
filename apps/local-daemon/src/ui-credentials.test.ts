import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureUiCredentialFile,
  readUiCredentialFile,
  rotateUiCredentialFile,
} from "../../../scripts/agentcut-credentials.mjs";

const temporaryRoots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentcut-ui-credential-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("UI credential rotation", () => {
  it("atomically replaces the bootstrap, preserves mode, and replays the same request", () => {
    const root = projectRoot();
    const initial = ensureUiCredentialFile(root);
    const rotated = rotateUiCredentialFile(initial.credentialPath, root, {
      requestId: "rotate-request-001",
      clock: () => "2026-08-10T03:20:00.000Z",
      tokenFactory: () => "replacement-ui-bootstrap-token-000000000001",
    });

    expect(rotated.idempotentReplay).toBe(false);
    expect(rotated.credential.bootstrapToken).not.toBe(initial.bootstrapToken);
    expect(rotated.credential.generation).toBe(1);
    expect(rotated.rotation.previousFingerprint).toBe(initial.bootstrapFingerprint);
    expect(rotated.rotation.currentFingerprint).toBe(rotated.credential.bootstrapFingerprint);
    expect(statSync(initial.credentialPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(initial.credentialPath, "utf8"))).not.toHaveProperty(
      "previousBootstrapToken",
    );

    const replay = rotateUiCredentialFile(initial.credentialPath, root, {
      requestId: "rotate-request-001",
      tokenFactory: () => "must-not-be-used-replacement-token-0000002",
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.credential.bootstrapToken).toBe(rotated.credential.bootstrapToken);
    expect(replay.credential.generation).toBe(1);
  });

  it("leaves a recoverable canonical marker when failure occurs after publish", () => {
    const root = projectRoot();
    const initial = ensureUiCredentialFile(root);

    expect(() => rotateUiCredentialFile(initial.credentialPath, root, {
      requestId: "rotate-crash-window-001",
      clock: () => "2026-08-10T03:21:00.000Z",
      tokenFactory: () => "replacement-ui-bootstrap-token-crash-00001",
      afterPublish: () => {
        throw new Error("injected after credential publish");
      },
    })).toThrow("injected after credential publish");

    const recovered = readUiCredentialFile(initial.credentialPath, root);
    expect(recovered.bootstrapToken).not.toBe(initial.bootstrapToken);
    expect(recovered.generation).toBe(1);
    expect(recovered.lastRotation).toMatchObject({
      requestId: "rotate-crash-window-001",
      rotatedAt: "2026-08-10T03:21:00.000Z",
    });
  });
});
