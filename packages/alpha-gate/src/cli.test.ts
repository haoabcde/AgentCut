import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAlphaGateCli } from "./cli.js";
import { alphaAuthorizationEvidenceSha256 } from "./authorization.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Alpha Gate CLI", () => {
  it("returns a non-zero JSON report when the manifest has insufficient evidence", async () => {
    const manifestPath = writeManifest(JSON.stringify(incompleteManifest()));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runAlphaGateCli([manifestPath, "--json"], {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toEqual(expect.objectContaining({
      status: "insufficient_evidence",
      metrics: expect.objectContaining({
        authorizedProjects: { value: 1, required: 20, status: "insufficient_evidence" },
      }),
    }));
  });

  it("renders the human-readable project and metric shortfall", async () => {
    const manifestPath = writeManifest(JSON.stringify(incompleteManifest()));
    const stdout: string[] = [];

    const exitCode = await runAlphaGateCli([manifestPath], {
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toContain("AgentCut Alpha Gate: INSUFFICIENT EVIDENCE");
    expect(stdout.join("")).toContain("Authorized projects: 1/20");
    expect(stdout.join("")).toContain("Distinct timing operators: 0/5");
    expect(stdout.join("")).toContain("DEFINITE_REMOVE_LABELS_MISSING");
  });

  it("returns exit code two for a malformed manifest", async () => {
    const manifestPath = writeManifest("{not-json");
    const stderr: string[] = [];

    const exitCode = await runAlphaGateCli([manifestPath], {
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("Alpha Gate input error:");
  });
});

function writeManifest(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), "agentcut-alpha-gate-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "manifest.json");
  mkdirSync(join(directory, "docs"), { recursive: true });
  writeFileSync(
    join(directory, "docs", "authorization.md"),
    `Authorized fixture.\n<!-- agentcut-alpha-authorization: project-real-001 sha256:${"a".repeat(64)} -->\n`,
    "utf8",
  );
  writeFileSync(path, content, "utf8");
  return path;
}

function incompleteManifest(): unknown {
  const authorizationContent = `Authorized fixture.\n<!-- agentcut-alpha-authorization: project-real-001 sha256:${"a".repeat(64)} -->\n`;
  return {
    schemaVersion: "1.0",
    projects: [{
      projectId: "project-real-001",
      sourceSha256: `sha256:${"a".repeat(64)}`,
      authorization: {
        confirmed: true,
        basis: "user_supplied_for_testing",
        evidence: "docs/authorization.md",
        sha256: alphaAuthorizationEvidenceSha256(authorizationContent),
      },
      reviewCompleted: true,
      export: {
        succeeded: true,
        artifactSha256: `sha256:${"b".repeat(64)}`,
        qualityReport: "records/project-real-001/render-report.json",
      },
      candidates: {
        definiteRemovePredicted: 2,
        highRiskAutoDeleted: 0,
      },
      boundaries: { evaluated: 0 },
      correctness: {
        undo: { evaluated: 0, passed: 0 },
        restart: { evaluated: 0, passed: 0 },
        idempotency: { evaluated: 0, passed: 0 },
        revisionConflict: { evaluated: 0, passed: 0 },
      },
    }],
  };
}
