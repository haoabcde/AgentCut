import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashProjectState } from "@agentcut/edit-commands";
import { ProjectStore } from "@agentcut/project-store";
import { assertProjectDocument, type AgentCutProjectDocument } from "@agentcut/timeline-schema";
import { afterEach, describe, expect, it } from "vitest";
import { parseAlphaEvidenceBundle } from "./bundle.js";
import { AlphaEvidenceStore } from "./evidence.js";
import { runAlphaCollectCli } from "./collect-cli.js";
import { alphaAuthorizationEvidenceSha256 } from "./authorization.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Alpha cohort collection CLI", () => {
  it("records correctness and registers one content-addressed bundle idempotently without changing Timeline IR", async () => {
    const fixture = createFixture();
    const before = ProjectStore.open(fixture.databasePath);
    const beforeRevision = before.snapshot().project.revision;
    const beforeStateHash = hashProjectState(before.snapshot());
    before.close();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const arguments_ = collectionArguments(fixture, "cohort-real-001");

    const first = await runAlphaCollectCli(arguments_, io(stdout, stderr));
    const firstManifestBytes = readFileSync(fixture.manifestPath, "utf8");
    const replay = await runAlphaCollectCli(arguments_, io(stdout, stderr));

    expect({ first, replay, stderr }).toEqual({ first: 0, replay: 0, stderr: [] });
    expect(readFileSync(fixture.manifestPath, "utf8")).toBe(firstManifestBytes);
    const manifest = JSON.parse(firstManifestBytes) as {
      projects: Array<{
        projectId: string;
        sourceSha256: string;
        authorization: { confirmed: boolean; basis: string; evidence: string; sha256: string };
        evidenceBundle: { path: string; sha256: string; canonicalProjectId: string; projectRevision: number };
      }>;
    };
    expect(manifest.projects).toEqual([expect.objectContaining({
      projectId: "cohort-real-001",
      sourceSha256: `sha256:${"a".repeat(64)}`,
      authorization: {
        confirmed: true,
        basis: "user_supplied_for_testing",
        evidence: "authorization.md",
        sha256: alphaAuthorizationEvidenceSha256(authorizationFixtureContent()),
      },
      evidenceBundle: expect.objectContaining({
        path: expect.stringMatching(/^bundles\/cohort-real-001-r0-[a-f0-9]{12}\.evidence\.json$/),
        sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        canonicalProjectId: "project_demo_001",
        projectRevision: 0,
      }),
    })]);
    const bundlePath = join(fixture.benchmarkRoot, manifest.projects[0]!.evidenceBundle.path);
    expect(existsSync(bundlePath)).toBe(true);
    expect(readdirSync(join(fixture.benchmarkRoot, "bundles"))).toHaveLength(1);
    const bundle = parseAlphaEvidenceBundle(readFileSync(bundlePath, "utf8"));
    expect(bundle.events.filter((event) => event.targetType === "correctness")).toHaveLength(1);

    const after = ProjectStore.open(fixture.databasePath);
    expect(after.snapshot().project.revision).toBe(beforeRevision);
    expect(hashProjectState(after.snapshot())).toBe(beforeStateHash);
    const draft = (await import("./audit.js")).createAlphaAuditDraft(after.snapshot(), after.listRecords());
    after.close();
    const evidence = AlphaEvidenceStore.open(join(fixture.projectRoot, "alpha-evidence.sqlite"));
    expect(evidence.apply(draft).events.filter((event) => event.targetType === "correctness"))
      .toHaveLength(1);
    evidence.close();
    expect(stdout.join("")).toContain("Registered cohort-real-001 revision 0");
  });

  it("rejects duplicate source registration before writing project evidence", async () => {
    const fixture = createFixture();
    writeFileSync(fixture.manifestPath, `${JSON.stringify({
      schemaVersion: "1.0",
      projects: [projectEvidence("cohort-existing", `sha256:${"a".repeat(64)}`)],
    }, null, 2)}\n`, "utf8");
    const before = readFileSync(fixture.manifestPath, "utf8");
    const stderr: string[] = [];

    const exitCode = await runAlphaCollectCli(
      collectionArguments(fixture, "cohort-duplicate"),
      io([], stderr),
    );

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("is already registered as cohort-existing");
    expect(readFileSync(fixture.manifestPath, "utf8")).toBe(before);
    expect(existsSync(join(fixture.projectRoot, "alpha-evidence.sqlite"))).toBe(false);
    expect(existsSync(join(fixture.benchmarkRoot, "bundles"))).toBe(false);
  });

  it("rejects silent authorization replacement before writing project evidence", async () => {
    const fixture = createFixture();
    const existing = projectEvidence("cohort-real-001", `sha256:${"a".repeat(64)}`);
    existing.authorization = {
      confirmed: true,
      basis: "partner_authorized",
      evidence: "partner-authorization.md",
      sha256: alphaAuthorizationEvidenceSha256(
        `Partner approval\n<!-- agentcut-alpha-authorization: cohort-real-001 sha256:${"a".repeat(64)} -->\n`,
      ),
    };
    writeFileSync(
      join(fixture.benchmarkRoot, "partner-authorization.md"),
      `Partner approval\n<!-- agentcut-alpha-authorization: cohort-real-001 sha256:${"a".repeat(64)} -->\n`,
      "utf8",
    );
    writeFileSync(fixture.manifestPath, `${JSON.stringify({
      schemaVersion: "1.0",
      projects: [existing],
    }, null, 2)}\n`, "utf8");
    const stderr: string[] = [];

    const exitCode = await runAlphaCollectCli(
      collectionArguments(fixture, "cohort-real-001"),
      io([], stderr),
    );

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("different authorization evidence");
    expect(existsSync(join(fixture.projectRoot, "alpha-evidence.sqlite"))).toBe(false);
  });

  it("rejects a cohort ID already bound to another source before writing project evidence", async () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.benchmarkRoot, "authorization.md"),
      [
        `<!-- agentcut-alpha-authorization: cohort-real-001 sha256:${"a".repeat(64)} -->`,
        `<!-- agentcut-alpha-authorization: cohort-real-001 sha256:${"b".repeat(64)} -->`,
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(fixture.manifestPath, `${JSON.stringify({
      schemaVersion: "1.0",
      projects: [{
        ...projectEvidence("cohort-real-001", `sha256:${"b".repeat(64)}`),
        authorization: {
          ...projectEvidence("cohort-real-001", `sha256:${"b".repeat(64)}`).authorization,
          sha256: alphaAuthorizationEvidenceSha256([
            `<!-- agentcut-alpha-authorization: cohort-real-001 sha256:${"a".repeat(64)} -->`,
            `<!-- agentcut-alpha-authorization: cohort-real-001 sha256:${"b".repeat(64)} -->`,
            "",
          ].join("\n")),
        },
      }],
    }, null, 2)}\n`, "utf8");
    const stderr: string[] = [];

    const exitCode = await runAlphaCollectCli(
      collectionArguments(fixture, "cohort-real-001"),
      io([], stderr),
    );

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("already bound to another source hash");
    expect(existsSync(join(fixture.projectRoot, "alpha-evidence.sqlite"))).toBe(false);
  });

  it("preserves a concurrently changed manifest instead of overwriting it", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentcut-alpha-collect-concurrency-"));
    temporaryDirectories.push(root);
    const manifestPath = join(root, "manifest.json");
    const initial = "{\"schemaVersion\":\"1.0\",\"projects\":[]}\n";
    const concurrent = "{\"schemaVersion\":\"1.0\",\"projects\":[],\"owner\":\"other-process\"}\n";
    const intended = "{\"schemaVersion\":\"1.0\",\"projects\":[],\"owner\":\"collector\"}\n";
    writeFileSync(manifestPath, concurrent, "utf8");
    const collector = await import("./collect-cli.js") as typeof import("./collect-cli.js") & {
      commitAlphaManifestIfUnchanged?: (
        path: string,
        initialBytes: string,
        nextBytes: string,
      ) => Promise<void>;
    };

    const outcome = collector.commitAlphaManifestIfUnchanged
      ? await collector.commitAlphaManifestIfUnchanged(manifestPath, initial, intended)
        .then(() => "committed", (error: unknown) => error instanceof Error ? error.message : String(error))
      : "missing atomic manifest commit";

    expect(outcome).toContain("changed during collection");
    expect(readFileSync(manifestPath, "utf8")).toBe(concurrent);
    expect(readdirSync(root).sort()).toEqual(["manifest.json"]);
  });

  it("cleans temporary bundle bytes when content-addressed publication fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentcut-alpha-collect-publication-"));
    temporaryDirectories.push(root);
    const occupiedPath = join(root, "occupied.evidence.json");
    mkdirSync(occupiedPath);
    const collector = await import("./collect-cli.js") as typeof import("./collect-cli.js") & {
      publishAlphaContentAddressedFile?: (path: string, content: string) => Promise<void>;
    };

    const outcome = collector.publishAlphaContentAddressedFile
      ? await collector.publishAlphaContentAddressedFile(occupiedPath, "bundle bytes")
        .then(() => "published", (error: unknown) => error instanceof Error ? error.message : String(error))
      : "missing content-addressed publisher";

    expect(outcome).not.toBe("published");
    expect(outcome).not.toBe("missing content-addressed publisher");
    expect(readdirSync(root).sort()).toEqual(["occupied.evidence.json"]);
  });

  it("records coverage classes on first registration and preserves them on idempotent re-collect", async () => {
    const fixture = createFixture();
    const first = await runAlphaCollectCli(
      collectionArguments(fixture, "cohort-real-001").concat([
        "--coverage-classes", "mandarin, fast-speech, proper-noun-number",
      ]),
      io([], []),
    );
    const manifestAfterFirst = JSON.parse(readFileSync(fixture.manifestPath, "utf8")) as {
      projects: Array<{ projectId: string; coverageClasses?: string[] }>;
    };
    expect(first).toBe(0);
    expect(manifestAfterFirst.projects[0]?.coverageClasses).toEqual(["fast-speech", "mandarin", "proper-noun-number"]);

    // 幂等重放：省略 --coverage-classes 不得清空既有登记（upsert 保留旧 coverage）。
    const replay = await runAlphaCollectCli(
      collectionArguments(fixture, "cohort-real-001"),
      io([], []),
    );
    expect(replay).toBe(0);
    const manifestAfterReplay = JSON.parse(readFileSync(fixture.manifestPath, "utf8")) as {
      projects: Array<{ projectId: string; coverageClasses?: string[] }>;
    };
    expect(manifestAfterReplay.projects[0]?.coverageClasses).toEqual(["fast-speech", "mandarin", "proper-noun-number"]);
  });

  it("rejects coverage classes outside the allowed set before writing project evidence", async () => {
    const fixture = createFixture();
    const stderr: string[] = [];

    const exitCode = await runAlphaCollectCli(
      collectionArguments(fixture, "cohort-real-001").concat(["--coverage-classes", "mandarin,holographic-8k"]),
      io([], stderr),
    );

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("holographic-8k");
    expect(existsSync(join(fixture.projectRoot, "alpha-evidence.sqlite"))).toBe(false);
    expect(readdirSync(fixture.benchmarkRoot)).toEqual(["authorization.md", "manifest.json"]);
  });

  it("rejects an empty authorization evidence placeholder before project evidence is written", async () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.benchmarkRoot, "authorization.md"), "", "utf8");
    const stderr: string[] = [];

    const exitCode = await runAlphaCollectCli(
      collectionArguments(fixture, "cohort-real-001"),
      io([], stderr),
    );

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("authorization evidence is missing, empty or not a regular file");
    expect(existsSync(join(fixture.projectRoot, "alpha-evidence.sqlite"))).toBe(false);
  });

  it("rejects an authorization file that does not bind the requested cohort", async () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.benchmarkRoot, "authorization.md"),
      `<!-- agentcut-alpha-authorization: another-cohort sha256:${"a".repeat(64)} -->\n`,
      "utf8",
    );
    const stderr: string[] = [];

    const exitCode = await runAlphaCollectCli(
      collectionArguments(fixture, "cohort-real-001"),
      io([], stderr),
    );

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain(
      `does not contain the exact marker <!-- agentcut-alpha-authorization: cohort-real-001 sha256:${"a".repeat(64)} -->`,
    );
    expect(existsSync(join(fixture.projectRoot, "alpha-evidence.sqlite"))).toBe(false);
    expect(existsSync(join(fixture.benchmarkRoot, "bundles"))).toBe(false);
  });

  it("rejects an authorization file that binds the cohort to a different source", async () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.benchmarkRoot, "authorization.md"),
      `<!-- agentcut-alpha-authorization: cohort-real-001 sha256:${"b".repeat(64)} -->\n`,
      "utf8",
    );
    const stderr: string[] = [];

    const exitCode = await runAlphaCollectCli(
      collectionArguments(fixture, "cohort-real-001"),
      io([], stderr),
    );

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain(
      `does not contain the exact marker <!-- agentcut-alpha-authorization: cohort-real-001 sha256:${"a".repeat(64)} -->`,
    );
    expect(existsSync(join(fixture.projectRoot, "alpha-evidence.sqlite"))).toBe(false);
    expect(existsSync(join(fixture.benchmarkRoot, "bundles"))).toBe(false);
  });
});

function io(stdout: string[], stderr: string[]) {
  return {
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
  };
}

function collectionArguments(
  fixture: { projectRoot: string; manifestPath: string },
  cohortId: string,
): string[] {
  return [
    fixture.projectRoot,
    "--manifest", fixture.manifestPath,
    "--cohort-id", cohortId,
    "--authorization-basis", "user_supplied_for_testing",
    "--authorization-evidence", "authorization.md",
  ];
}

function projectEvidence(projectId: string, sourceSha256: string) {
  return {
    projectId,
    sourceSha256,
    authorization: {
      confirmed: true,
      basis: "user_supplied_for_testing",
      evidence: "authorization.md",
      sha256: alphaAuthorizationEvidenceSha256(authorizationFixtureContent()),
    },
    reviewCompleted: false,
    export: { succeeded: false },
    candidates: { definiteRemovePredicted: 0, highRiskAutoDeleted: 0 },
    boundaries: { evaluated: 0 },
    correctness: {
      undo: { evaluated: 0, passed: 0 },
      restart: { evaluated: 0, passed: 0 },
      idempotency: { evaluated: 0, passed: 0 },
      revisionConflict: { evaluated: 0, passed: 0 },
    },
  };
}

function createFixture(): {
  projectRoot: string;
  databasePath: string;
  benchmarkRoot: string;
  manifestPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "agentcut-alpha-collect-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "project");
  const benchmarkRoot = join(root, "benchmark");
  const databasePath = join(projectRoot, "agentcut.sqlite");
  const manifestPath = join(benchmarkRoot, "manifest.json");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(benchmarkRoot, { recursive: true });
  ProjectStore.create(databasePath, fixture()).close();
  writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: "1.0", projects: [] }, null, 2)}\n`, "utf8");
  writeFileSync(
    join(benchmarkRoot, "authorization.md"),
    authorizationFixtureContent(),
    "utf8",
  );
  return { projectRoot, databasePath, benchmarkRoot, manifestPath };
}

function authorizationFixtureContent(): string {
  return [
    "Authorized fixture",
    `<!-- agentcut-alpha-authorization: cohort-real-001 sha256:${"a".repeat(64)} -->`,
    `<!-- agentcut-alpha-authorization: cohort-duplicate sha256:${"a".repeat(64)} -->`,
    `<!-- agentcut-alpha-authorization: cohort-existing sha256:${"a".repeat(64)} -->`,
    "",
  ].join("\n");
}

function fixture(): AgentCutProjectDocument {
  const url = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(url, "utf8"));
  assertProjectDocument(value);
  return structuredClone(value);
}
