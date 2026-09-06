import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "@agentcut/project-store";
import { afterEach, describe, expect, it } from "vitest";
import { createReferenceHost, REFERENCE_PROTOCOL_VERSION } from "./server.js";
import type { AddressInfo } from "node:net";

const fixtureUrl = new URL("../../../packages/timeline-schema/fixtures/minimal-project.json", import.meta.url);

interface Harness {
  url: string;
  close: () => void;
  cleanup: () => void;
}

const harnesses: Harness[] = [];

async function startHost(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "agentcut-reference-host-"));
  const databasePath = join(directory, "agentcut.sqlite");
  const document = JSON.parse(readFileSync(fixtureUrl, "utf8")) as unknown;
  ProjectStore.create(databasePath, document as never);
  const server = createReferenceHost({
    databasePath,
    agentBootstrapToken: "ref-bootstrap-test",
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const { port } = server.address() as AddressInfo;
  const harness: Harness = {
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    harness.close();
    harness.cleanup();
  }
});

async function json(request: Promise<Response>): Promise<{ status: number; body: any }> {
  const response = await request;
  return { status: response.status, body: await response.json() as any };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function createSession(url: string, capabilities: string[], requestId: string) {
  return json(fetch(`${url}/api/agent/sessions`, {
    method: "POST",
    headers: bearer("ref-bootstrap-test"),
    body: JSON.stringify({ requestId, clientId: "vitest-agent", capabilities, ttlSeconds: 3600 }),
  }));
}

const ALL_CAPABILITIES = [
  "project:read",
  "transcript:read",
  "analysis:local",
  "analysis:propose",
  "timeline:write:low_risk_only",
  "approval:request",
  "timeline:write:approved",
  "export:write",
];

describe("reference host core protocol", () => {
  it("reports health without credentials", async () => {
    const host = await startHost();
    const { status, body } = await json(fetch(`${host.url}/api/health`));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, protocolVersion: REFERENCE_PROTOCOL_VERSION });
  });

  it("issues capability sessions with idempotent replay and rejects bad bootstrap", async () => {
    const host = await startHost();
    const missing = await json(fetch(`${host.url}/api/agent/sessions`, { method: "POST" }));
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe("AGENT_SESSION_NOT_FOUND");

    const denied = await json(fetch(`${host.url}/api/agent/sessions`, {
      method: "POST",
      headers: bearer("wrong-bootstrap"),
      body: "{}",
    }));
    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe("AGENT_BOOTSTRAP_DENIED");

    const created = await createSession(host.url, ALL_CAPABILITIES, "req-session-001");
    expect(created.status).toBe(201);
    expect(created.body.session.capabilities).toEqual([...ALL_CAPABILITIES].sort());
    expect(created.body.accessToken).toMatch(/^agc_/);

    const replay = await createSession(host.url, ALL_CAPABILITIES, "req-session-001");
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.session.id).toBe(created.body.session.id);
  });

  it("serves core reads: project summary, transcript paging, empty diff", async () => {
    const host = await startHost();
    const session = await createSession(host.url, ALL_CAPABILITIES, "req-reads-001");
    const token = session.body.accessToken as string;

    const denied = await json(fetch(`${host.url}/api/agent/project`));
    expect(denied.status).toBe(401);

    const project = await json(fetch(`${host.url}/api/agent/project`, { headers: bearer(token) }));
    expect(project.status).toBe(200);
    expect(project.body.project).toMatchObject({
      id: "project_demo_001",
      name: "中文口播技术验证",
      revision: 0,
      activeSequenceId: "sequence_main",
    });
    expect(project.body.capabilities.extensions).toEqual([]);
    expect(project.body.facts).toMatchObject({ transcriptArtifacts: 1, clipCount: 1 });

    const transcript = await json(fetch(`${host.url}/api/agent/transcript?limit=2`, { headers: bearer(token) }));
    expect(transcript.status).toBe(200);
    expect(transcript.body.transcript).toMatchObject({
      id: "transcript_main_001",
      language: "zh-CN",
      totalWords: 4,
      offset: 0,
      limit: 2,
      nextOffset: 2,
    });
    expect(transcript.body.transcript.words[0]).toMatchObject({
      wordId: "word_001",
      text: "大家好",
      // 1000 ticks @ rate 1000/1 → 1 s；时间换算语义见 docs/04（seconds = value·denominator/numerator）。
      startMicros: 1_000_000,
      durationMicros: 600_000,
    });

    const diff = await json(fetch(`${host.url}/api/agent/project/diff?fromRevision=0`, { headers: bearer(token) }));
    expect(diff.status).toBe(200);
    expect(diff.body).toMatchObject({ projectId: "project_demo_001", headRevision: 0, changes: [] });
  });

  it("applies arbitrary validated transactions with idempotency, conflict and capability gating", async () => {
    const host = await startHost();
    const full = await createSession(host.url, ALL_CAPABILITIES, "req-write-full-001");
    const writeToken = full.body.accessToken as string;

    const transaction = {
      protocolVersion: REFERENCE_PROTOCOL_VERSION,
      transactionId: "tx_refhost_disable_clip",
      idempotencyKey: "refhost:disable-clip:001",
      projectId: "project_demo_001",
      sequenceId: "sequence_main",
      baseRevision: 0,
      actor: { kind: "agent", id: "vitest-agent" },
      reason: "Disable first take while re-planning",
      preconditions: [],
      operations: [{ type: "clip.update", clipId: "clip_take_1", patch: { enabled: false } }],
    };

    const applied = await json(fetch(`${host.url}/api/agent/timeline/transactions`, {
      method: "POST",
      headers: bearer(writeToken),
      body: JSON.stringify(transaction),
    }));
    expect(applied.status).toBe(201);
    expect(applied.body).toMatchObject({
      revision: 1,
      idempotentReplay: false,
      record: { transactionId: "tx_refhost_disable_clip", committedRevision: 1 },
    });

    const replay = await json(fetch(`${host.url}/api/agent/timeline/transactions`, {
      method: "POST",
      headers: bearer(writeToken),
      body: JSON.stringify(transaction),
    }));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ revision: 1, idempotentReplay: true });

    const stale = await json(fetch(`${host.url}/api/agent/timeline/transactions`, {
      method: "POST",
      headers: bearer(writeToken),
      body: JSON.stringify({ ...transaction, transactionId: "tx_refhost_stale", idempotencyKey: "refhost:stale:001" }),
    }));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("REVISION_CONFLICT");

    const diff = await json(fetch(`${host.url}/api/agent/project/diff?fromRevision=0`, { headers: bearer(writeToken) }));
    expect(diff.body.changes).toHaveLength(1);
    expect(diff.body.changes[0]).toMatchObject({
      transactionId: "tx_refhost_disable_clip",
      operationTypes: ["clip.update"],
      objectIds: ["clip_take_1"],
    });

    const readOnly = await createSession(host.url, ["project:read"], "req-write-readonly-001");
    const readOnlyToken = readOnly.body.accessToken as string;
    const forbidden = await json(fetch(`${host.url}/api/agent/timeline/transactions`, {
      method: "POST",
      headers: bearer(readOnlyToken),
      body: JSON.stringify({
        ...transaction,
        transactionId: "tx_refhost_forbidden",
        idempotencyKey: "refhost:forbidden:001",
      }),
    }));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("CAPABILITY_DENIED");
  });

  it("keeps unknown extension data opaque and rejects transactions referencing missing objects", async () => {
    const host = await startHost();
    const session = await createSession(host.url, ALL_CAPABILITIES, "req-invalid-001");
    const token = session.body.accessToken as string;

    const invalid = await json(fetch(`${host.url}/api/agent/timeline/transactions`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({
        protocolVersion: REFERENCE_PROTOCOL_VERSION,
        transactionId: "tx_refhost_invalid",
        idempotencyKey: "refhost:invalid:001",
        projectId: "project_demo_001",
        sequenceId: "sequence_main",
        baseRevision: 0,
        actor: { kind: "agent", id: "vitest-agent" },
        reason: "Break the document",
        preconditions: [],
        operations: [{ type: "clip.update", clipId: "clip_missing", patch: { enabled: false } }],
      }),
    }));
    expect(invalid.status).toBe(404);
    expect(invalid.body.error.code).toBe("OBJECT_NOT_FOUND");
  });
});
