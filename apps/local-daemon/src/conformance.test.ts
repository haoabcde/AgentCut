import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "@agentcut/project-store";
import { runConformance } from "@agentcut/conformance";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentCutServer } from "./server.js";

const fixtureUrl = new URL(
  "../../../packages/timeline-schema/fixtures/minimal-project.json",
  import.meta.url,
);

interface DaemonHarness {
  baseUrl: string;
  restart: () => Promise<string>;
  cleanup: () => void;
}

const harnesses: DaemonHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()!.cleanup();
});

/**
 * Gate P3：daemon 以第三方宿主的身份消费 @agentcut/conformance。
 * 套件与产品代码零耦合——TalkCut CI 迁移时按同一模式接入。
 */
async function startDaemonHarness(): Promise<DaemonHarness> {
  const directory = mkdtempSync(join(tmpdir(), "agentcut-conformance-daemon-"));
  const databasePath = join(directory, "agentcut.sqlite");
  const bootstrapToken = "conformance-daemon-bootstrap-token";
  ProjectStore.create(
    databasePath,
    JSON.parse(readFileSync(fixtureUrl, "utf8")) as never,
  ).close();

  let server: Server | undefined;
  const start = async (): Promise<string> => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
    }
    const next = createAgentCutServer({
      databasePath,
      projectRoot: directory,
      agentBootstrapToken: bootstrapToken,
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      next.once("error", rejectListen);
      next.listen(0, "127.0.0.1", () => resolveListen());
    });
    server = next;
    const { port } = next.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };
  const baseUrl = await start();
  const harness: DaemonHarness = {
    baseUrl,
    restart: start,
    cleanup: () => {
      server?.closeAllConnections();
      server?.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

describe("local daemon passes the AgentCut protocol conformance suite", () => {
  it("certifies every core check including crash recovery", { timeout: 60_000 }, async () => {
    const harness = await startDaemonHarness();
    const report = await runConformance({
      baseUrl: harness.baseUrl,
      bootstrapToken: "conformance-daemon-bootstrap-token",
      hostLabel: "local-daemon",
      controller: { label: "local-daemon", restart: harness.restart },
    });
    const failed = report.checks.filter((check) => check.status === "fail");
    if (failed.length > 0) {
      throw new Error(`unexpected failures: ${JSON.stringify(failed, null, 2)}`);
    }
    expect(report.verdict).toBe("pass");
    expect(report.summary.skipped).toBe(0);
    expect(report.checks.find((check) => check.id === "crash.recovery-state")?.status).toBe("pass");
  });
});
