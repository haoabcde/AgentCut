import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "@agentcut/project-store";
import { createReferenceHost } from "@agentcut/reference-host";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseConformanceArgs } from "./cli.js";
import { runConformance } from "./runner.js";
import type { HostController } from "./types.js";

const fixtureUrl = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);

interface ReferenceHarness {
  baseUrl: string;
  controller: HostController;
  cleanup: () => void;
}

const harnesses: ReferenceHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()!.cleanup();
});

/** 进程内拉起 reference-host；controller 通过关停+重建实现真实重启（同一数据库）。 */
async function startReferenceHost(): Promise<ReferenceHarness> {
  const directory = mkdtempSync(join(tmpdir(), "agentcut-conformance-ref-"));
  const databasePath = join(directory, "agentcut.sqlite");
  ProjectStore.create(
    databasePath,
    JSON.parse(readFileSync(fixtureUrl, "utf8")) as never,
  ).close();

  let server: Server | undefined;
  const bootstrapToken = "conformance-reference-bootstrap";
  const start = async (): Promise<string> => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
    }
    const next = createReferenceHost({ databasePath, agentBootstrapToken: bootstrapToken });
    await new Promise<void>((resolveListen, rejectListen) => {
      next.once("error", rejectListen);
      next.listen(0, "127.0.0.1", () => resolveListen());
    });
    server = next;
    const { port } = next.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };
  const baseUrl = await start();
  const harness: ReferenceHarness = {
    baseUrl,
    controller: { label: "reference-host", restart: start },
    cleanup: () => {
      server?.closeAllConnections();
      server?.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

describe("@agentcut/conformance", () => {
  it("certifies the reference host end to end, including crash recovery", { timeout: 60_000 }, async () => {
    const harness = await startReferenceHost();
    const report = await runConformance({
      baseUrl: harness.baseUrl,
      bootstrapToken: "conformance-reference-bootstrap",
      hostLabel: "reference-host",
      controller: harness.controller,
    });
    const failed = report.checks.filter((check) => check.status === "fail");
    if (failed.length > 0) {
      throw new Error(`unexpected failures: ${JSON.stringify(failed, null, 2)}`);
    }
    expect(report.verdict).toBe("pass");
    expect(report.host.reportedProtocolVersion).toBe("0.1.0");
    expect(report.summary.failed).toBe(0);
    expect(report.summary.skipped).toBe(0);
    expect(report.checks.map((check) => check.id)).toContain("crash.recovery-state");
    const crash = report.checks.find((check) => check.id === "crash.recovery-state");
    expect(crash?.status).toBe("pass");
  });

  it("fails with machine-readable per-check results against a nonconformant host", { timeout: 30_000 }, async () => {
    // 一个只回答 health 的假宿主：其余检查必须逐条 fail，报告给出可指向的失败证据。
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = url.pathname === "/api/health"
        ? { ok: true, protocolVersion: "0.1.0" }
        : { error: { code: "NOT_IMPLEMENTED", message: "fake host" } };
      response.writeHead(url.pathname === "/api/health" ? 200 : 401,
        { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const report = await runConformance({
        baseUrl: `http://127.0.0.1:${port}`,
        bootstrapToken: "irrelevant",
        hostLabel: "fake-host",
      });
      expect(report.verdict).toBe("fail");
      expect(report.summary.failed).toBeGreaterThan(0);
      const sessionCheck = report.checks.find((check) => check.id === "core.sessions.create-replay");
      expect(sessionCheck?.status).toBe("fail");
      expect(sessionCheck?.detail).toContain("expected HTTP 201");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("parses CLI arguments deterministically", () => {
    const parsed = parseConformanceArgs([
      "--url", "http://127.0.0.1:4318",
      "--token", "secret-bootstrap",
      "--host-label", "reference-host",
      "--report", "/tmp/report.json",
      "--allow-skip", "core.transactions.apply",
      "--pretty",
    ]);
    expect(parsed.url).toBe("http://127.0.0.1:4318");
    expect(parsed.token).toBe("secret-bootstrap");
    expect(parsed.hostLabel).toBe("reference-host");
    expect(parsed.reportPath).toBe("/tmp/report.json");
    expect(parsed.allowedSkips).toEqual(["core.transactions.apply"]);
    expect(parsed.pretty).toBe(true);
    expect(() => parseConformanceArgs(["--bogus"])).toThrow(/Unknown argument/);
  });
});
