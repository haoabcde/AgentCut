import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  compileEditProposal,
  computeEditProposalPayloadHash,
  EditError,
  type EditOperation,
  type EditTransaction,
} from "@agentcut/edit-commands";
import {
  assertProjectDocument,
  type Actor,
  type AgentCutProjectDocument,
} from "@agentcut/timeline-schema";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore, ProjectStoreError, type FailurePoint } from "./project-store.js";

const user: Actor = { kind: "user", id: "local_user" };
const fixedClock = () => "2026-07-18T03:30:00Z";
const temporaryDirectories: string[] = [];

function fixture(): AgentCutProjectDocument {
  const fixtureUrl = new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url);
  const value: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  assertProjectDocument(value);
  return structuredClone(value);
}

function tenMinuteFixture(): AgentCutProjectDocument {
  const document = fixture();
  const clip = document.sequences[0]?.tracks[0]?.clips[0];
  const transcript = document.artifacts.find((artifact) => artifact.kind === "transcript");
  const candidateSet = document.artifacts.find(
    (artifact) => artifact.kind === "deletionCandidateSet",
  );
  const proposal = document.artifacts.find((artifact) => artifact.kind === "editProposal");
  if (!clip || !transcript || transcript.kind !== "transcript"
    || !candidateSet || candidateSet.kind !== "deletionCandidateSet"
    || !proposal || proposal.kind !== "editProposal") {
    throw new Error("Scale fixture source is incomplete");
  }
  const tenMinuteFrames = 17_982;
  clip.timelineRange.duration.value = tenMinuteFrames;
  if (!clip.sourceRange) throw new Error("Scale fixture clip needs a source range");
  clip.sourceRange.start.value = 0;
  clip.sourceRange.duration.value = tenMinuteFrames;

  transcript.words = Array.from({ length: 1_798 }, (_, index) => ({
    id: `scale_word_${index}`,
    text: index % 50 === 0 ? "嗯" : `词${index}`,
    sourceRange: {
      start: { value: index * 333, rate: { numerator: 1_000, denominator: 1 } },
      duration: { value: 200, rate: { numerator: 1_000, denominator: 1 } },
    },
    confidence: 0.99,
  }));
  candidateSet.candidates = transcript.words
    .filter((_, index) => index % 20 === 0)
    .map((word, index) => ({
      id: `scale_candidate_${index}`,
      target: {
        kind: "words" as const,
        wordIds: [word.id],
        sourceRange: structuredClone(word.sourceRange),
      },
      reasonCodes: ["filler" as const],
      decision: "suggest_remove" as const,
      risk: "low" as const,
      confidence: 0.99,
      explanationZh: "十分钟规模验证候选。",
    }));
  proposal.selectedCandidateIds = candidateSet.candidates.map((candidate) => candidate.id);
  proposal.estimatedRemovedDuration = {
    value: proposal.selectedCandidateIds.length * 200,
    rate: { numerator: 1_000, denominator: 1 },
  };
  proposal.payloadHash = computeEditProposalPayloadHash(proposal);
  assertProjectDocument(document);
  return document;
}

function tempPath(name = "project.sqlite"): string {
  const directory = mkdtempSync(join(tmpdir(), "agentcut-project-store-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

function transaction(
  baseRevision: number,
  operations?: EditOperation[],
  overrides: Partial<EditTransaction> = {},
): EditTransaction {
  return {
    protocolVersion: "0.1.0",
    transactionId: `tx_${baseRevision}`,
    idempotencyKey: `key_${baseRevision}`,
    projectId: "project_demo_001",
    sequenceId: "sequence_main",
    baseRevision,
    actor: user,
    reason: "project store technical validation",
    preconditions: [],
    operations: operations ?? [{
      type: "clip.update",
      clipId: "clip_take_1",
      patch: { enabled: false },
    }],
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("project store", () => {
  it("uses WAL and persists command, inverse, checkpoint, and state across restart", () => {
    const path = tempPath();
    const store = ProjectStore.create(path, fixture(), {
      clock: fixedClock,
      checkpointInterval: 1,
    });
    expect(store.journalMode()).toBe("wal");
    const request = transaction(0, undefined, {
      transactionId: "tx_persisted",
      idempotencyKey: "persisted",
    });
    const first = store.commit(request);
    expect(first.document.project.revision).toBe(1);
    expect(first.record.inverseOperations).toHaveLength(1);
    store.close();

    const reopened = ProjectStore.open(path, { clock: fixedClock, checkpointInterval: 1 });
    expect(reopened.snapshot().project.revision).toBe(1);
    expect(reopened.getRecord("tx_persisted")?.inverseOperations).toHaveLength(1);
    expect(reopened.listCheckpoints().map(({ revision }) => revision)).toEqual([0, 1]);
    const replay = reopened.commit(request);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.document.project.revision).toBe(1);
    const undone = reopened.undo("tx_persisted", user, "tx_undo_persisted");
    expect(undone.document.project.revision).toBe(2);
    expect(undone.document.sequences[0]?.tracks[0]?.clips[0]?.enabled).toBe(true);
    expect(reopened.verify()).toEqual(expect.objectContaining({
      integrity: "ok",
      headRevision: 2,
      replayedCommands: 2,
    }));
    reopened.close();
  });

  it("serializes two writers and rejects a stale revision without partial writes", () => {
    const path = tempPath();
    ProjectStore.create(path, fixture(), { clock: fixedClock }).close();
    const first = ProjectStore.open(path, { clock: fixedClock });
    const second = ProjectStore.open(path, { clock: fixedClock });
    first.commit(transaction(0, undefined, {
      transactionId: "tx_writer_a",
      idempotencyKey: "writer-a",
    }));
    expect(() => second.commit(transaction(0, undefined, {
      transactionId: "tx_writer_b",
      idempotencyKey: "writer-b",
    }))).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
    expect(second.snapshot().project.revision).toBe(1);
    expect(second.listRecords()).toHaveLength(1);
    first.close();
    second.close();
  });

  it("rejects reuse of an idempotency key with a different payload after restart", () => {
    const path = tempPath();
    const store = ProjectStore.create(path, fixture(), { clock: fixedClock });
    store.commit(transaction(0, undefined, {
      transactionId: "tx_original",
      idempotencyKey: "shared-key",
    }));
    store.close();
    const reopened = ProjectStore.open(path, { clock: fixedClock });
    expect(() => reopened.commit(transaction(0, [{
      type: "clip.update",
      clipId: "clip_take_1",
      patch: { content: { text: "different payload" } },
    }], {
      transactionId: "tx_other",
      idempotencyKey: "shared-key",
    }))).toThrowError(EditError);
    expect(reopened.snapshot().project.revision).toBe(1);
    reopened.close();
  });

  it("rolls back every database write when an injected pre-commit failure throws", () => {
    const path = tempPath();
    ProjectStore.create(path, fixture(), { clock: fixedClock }).close();
    const store = ProjectStore.open(path, {
      clock: fixedClock,
      checkpointInterval: 1,
      failureInjector(point) {
        if (point === "after_state_update") throw new Error("injected failure");
      },
    });
    expect(() => store.commit(transaction(0))).toThrow("injected failure");
    expect(store.snapshot().project.revision).toBe(0);
    expect(store.listRecords()).toHaveLength(0);
    expect(store.listCheckpoints()).toHaveLength(1);
    store.close();
  });

  it("recovers from real process death at each transaction boundary", () => {
    const preCommitPoints: FailurePoint[] = [
      "after_begin",
      "after_apply",
      "after_command_insert",
      "after_state_update",
      "after_checkpoint",
      "before_commit",
    ];
    const workerPath = fileURLToPath(new URL("../test-fixtures/crash-worker.mjs", import.meta.url));

    for (const point of preCommitPoints) {
      const path = tempPath(`${point}.sqlite`);
      ProjectStore.create(path, fixture(), { clock: fixedClock, checkpointInterval: 1 }).close();
      const transactionPath = join(dirname(path), `${point}.json`);
      writeFileSync(transactionPath, JSON.stringify(transaction(0, undefined, {
        transactionId: `tx_${point}`,
        idempotencyKey: `key_${point}`,
      })));
      const child = spawnSync(process.execPath, [workerPath, path, transactionPath, point]);
      expect(child.status === null || child.status !== 0).toBe(true);
      const recovered = ProjectStore.open(path, { clock: fixedClock, checkpointInterval: 1 });
      expect(recovered.snapshot().project.revision, point).toBe(0);
      expect(recovered.listRecords(), point).toHaveLength(0);
      expect(recovered.verify().headRevision, point).toBe(0);
      recovered.close();
    }

    const committedPath = tempPath("after_commit.sqlite");
    ProjectStore.create(committedPath, fixture(), {
      clock: fixedClock,
      checkpointInterval: 1,
    }).close();
    const committedTransactionPath = join(dirname(committedPath), "after_commit.json");
    writeFileSync(committedTransactionPath, JSON.stringify(transaction(0, undefined, {
      transactionId: "tx_after_commit",
      idempotencyKey: "key_after_commit",
    })));
    const child = spawnSync(process.execPath, [
      workerPath,
      committedPath,
      committedTransactionPath,
      "after_commit",
    ]);
    expect(child.status === null || child.status !== 0).toBe(true);
    const recovered = ProjectStore.open(committedPath, {
      clock: fixedClock,
      checkpointInterval: 1,
    });
    expect(recovered.snapshot().project.revision).toBe(1);
    expect(recovered.getRecord("tx_after_commit")).toBeDefined();
    expect(recovered.verify().headRevision).toBe(1);
    recovered.close();
  });

  it("replays a mixed sequence covering every 0.1 edit operation after restart", () => {
    const path = tempPath("mixed-replay.sqlite");
    const store = ProjectStore.create(path, fixture(), {
      clock: fixedClock,
      checkpointInterval: 4,
    });
    const commits: EditOperation[][] = [
      [{
        type: "clip.split",
        clipId: "clip_take_1",
        at: { value: 150, rate: { numerator: 30_000, denominator: 1_001 } },
        rightClipId: "clip_take_1_right",
      }],
      [{
        type: "range.deleteRipple",
        range: {
          start: { value: 50, rate: { numerator: 30_000, denominator: 1_001 } },
          duration: { value: 50, rate: { numerator: 30_000, denominator: 1_001 } },
        },
        trackIds: ["track_v1"],
        rightClipIds: { clip_take_1: "clip_take_1_after_ripple" },
      }],
      [{ type: "clip.update", clipId: "clip_take_1_after_ripple", patch: { enabled: false } }],
      [{
        type: "lock.add",
        lock: {
          id: "lock_mixed",
          owner: "local_user",
          mode: "owner_only",
          scope: { kind: "clip", clipId: "clip_take_1_after_ripple" },
          createdAt: fixedClock(),
        },
      }],
      [{ type: "lock.remove", lockId: "lock_mixed" }],
      [{
        type: "track.add",
        track: {
          id: "track_a1",
          kind: "audio",
          name: "补充音轨",
          order: 1,
          locked: false,
          enabled: true,
          clips: [],
          transitions: [],
        },
      }],
      [{
        type: "clip.insert",
        trackId: "track_a1",
        clip: {
          id: "gap_a1",
          kind: "gap",
          timelineRange: {
            start: { value: 0, rate: { numerator: 30_000, denominator: 1_001 } },
            duration: { value: 30, rate: { numerator: 30_000, denominator: 1_001 } },
          },
          enabled: true,
          provenance: {
            createdBy: user,
            createdAt: fixedClock(),
            reason: "mixed replay gap",
          },
        },
      }],
      [{
        type: "clip.move",
        clipId: "gap_a1",
        start: { value: 10, rate: { numerator: 30_000, denominator: 1_001 } },
      }],
      [{
        type: "clip.trim",
        clipId: "gap_a1",
        timelineRange: {
          start: { value: 10, rate: { numerator: 30_000, denominator: 1_001 } },
          duration: { value: 20, rate: { numerator: 30_000, denominator: 1_001 } },
        },
      }],
      [{
        type: "clip.replace",
        clipId: "gap_a1",
        clip: {
          id: "gap_a1",
          kind: "gap",
          timelineRange: {
            start: { value: 12, rate: { numerator: 30_000, denominator: 1_001 } },
            duration: { value: 18, rate: { numerator: 30_000, denominator: 1_001 } },
          },
          enabled: true,
          provenance: {
            createdBy: user,
            createdAt: fixedClock(),
            reason: "mixed replay replacement",
          },
        },
      }],
      [{ type: "clip.remove", clipId: "gap_a1" }],
      [{ type: "track.remove", trackId: "track_a1" }],
      [{
        type: "artifact.put",
        artifact: {
          id: "transcript_mixed_replay",
          kind: "transcript",
          assetId: "asset_camera_a",
          language: "zh-CN",
          audioStreamIndex: 0,
          words: [{
            id: "word_mixed_replay",
            text: "重放",
            sourceRange: {
              start: { value: 4_000, rate: { numerator: 1_000, denominator: 1 } },
              duration: { value: 300, rate: { numerator: 1_000, denominator: 1 } },
            },
            confidence: 1,
          }],
          provenance: {
            createdBy: user,
            createdAt: fixedClock(),
            reason: "mixed replay artifact",
          },
        },
      }],
      [{ type: "artifact.remove", artifactId: "transcript_mixed_replay" }],
    ];

    commits.forEach((operations, revision) => {
      store.commit(transaction(revision, operations, {
        transactionId: `tx_mixed_${revision}`,
        idempotencyKey: `mixed-${revision}`,
      }));
    });
    const expected = store.snapshot();
    expect(store.verify()).toEqual(expect.objectContaining({
      integrity: "ok",
      headRevision: commits.length,
      replayedCommands: commits.length,
    }));
    store.close();

    const reopened = ProjectStore.open(path, { clock: fixedClock, checkpointInterval: 4 });
    expect(reopened.snapshot()).toEqual(expected);
    expect(reopened.verify()).toEqual(expect.objectContaining({
      integrity: "ok",
      headRevision: commits.length,
      replayedCommands: commits.length,
    }));
    reopened.close();
  });

  it("compiles, commits, and replays a ten-minute transcript proposal", () => {
    const path = tempPath("ten-minute-replay.sqlite");
    const document = tenMinuteFixture();
    const proposal = document.artifacts.find((artifact) => artifact.kind === "editProposal");
    if (!proposal || proposal.kind !== "editProposal") throw new Error("Scale proposal is missing");
    const store = ProjectStore.create(path, document, { clock: fixedClock, checkpointInterval: 1 });
    const request = compileEditProposal(document, proposal, {
      transactionId: "tx_ten_minute_proposal",
      idempotencyKey: "ten-minute-proposal",
      actor: user,
    });
    expect(request.operations).toHaveLength(90);
    const result = store.commit(request);
    expect(result.document.project.revision).toBe(1);
    expect(result.document.sequences[0]?.tracks[0]?.clips.length).toBe(90);
    const expected = result.document;
    store.close();

    const reopened = ProjectStore.open(path, { clock: fixedClock, checkpointInterval: 1 });
    expect(reopened.snapshot()).toEqual(expected);
    expect(reopened.verify()).toEqual(expect.objectContaining({
      integrity: "ok",
      headRevision: 1,
      replayedCommands: 1,
    }));
    reopened.close();
  });

  it("rejects malformed or hash-divergent database copies at open", () => {
    const malformedPath = tempPath("malformed.sqlite");
    ProjectStore.create(malformedPath, fixture(), { clock: fixedClock }).close();
    const malformedDb = new DatabaseSync(malformedPath);
    malformedDb.prepare("UPDATE current_state SET document_json = ? WHERE singleton = 1")
      .run("{not-json");
    malformedDb.close();
    expect(() => ProjectStore.open(malformedPath)).toThrowError(
      expect.objectContaining({ code: "STORE_CORRUPT" }),
    );

    const divergentPath = tempPath("divergent.sqlite");
    ProjectStore.create(divergentPath, fixture(), { clock: fixedClock }).close();
    const divergentDb = new DatabaseSync(divergentPath);
    divergentDb.prepare("UPDATE current_state SET state_hash = ? WHERE singleton = 1")
      .run("sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    divergentDb.close();
    expect(() => ProjectStore.open(divergentPath)).toThrowError(ProjectStoreError);
  });

  it("rolls back a transaction when SQLite reports storage capacity exhaustion", () => {
    const path = tempPath("capacity.sqlite");
    ProjectStore.create(path, fixture(), { clock: fixedClock }).close();
    const limiter = new DatabaseSync(path);
    const pageRow = limiter.prepare("PRAGMA page_count").get() as Record<string, unknown> | undefined;
    const pageCount = pageRow?.page_count;
    if (typeof pageCount !== "number") throw new Error("SQLite page_count is unavailable");
    limiter.close();

    const store = ProjectStore.open(path, {
      clock: fixedClock,
      maximumDatabasePages: pageCount,
    });
    expect(() => store.commit(transaction(0, [{
      type: "clip.update",
      clipId: "clip_take_1",
      patch: { metadata: { capacityProbe: "x".repeat(2_000_000) } },
    }], {
      transactionId: "tx_capacity_exhaustion",
      idempotencyKey: "capacity-exhaustion",
    }))).toThrowError(expect.objectContaining({ code: "STORE_CAPACITY" }));
    expect(store.snapshot().project.revision).toBe(0);
    expect(store.listRecords()).toHaveLength(0);
    store.close();

    const recovered = ProjectStore.open(path, { clock: fixedClock });
    expect(recovered.verify()).toEqual(expect.objectContaining({
      integrity: "ok",
      headRevision: 0,
      replayedCommands: 0,
    }));
    recovered.close();
  });

  it("persists idempotent capability sessions and audits allowed and denied Agent access", () => {
    const path = tempPath("agent-access.sqlite");
    const store = ProjectStore.create(path, fixture(), { clock: fixedClock });
    const input = {
      id: "session_codex_001",
      requestId: "session-create-001",
      clientId: "codex",
      capabilities: ["timeline:write:low_risk_only", "project:read"] as const,
      ttlSeconds: 3_600,
      tokenHash: `sha256:${"a".repeat(64)}`,
    };
    const created = store.createAgentSession({
      ...input,
      capabilities: [...input.capabilities],
    });
    expect(created).toEqual({
      session: {
        id: "session_codex_001",
        projectId: "project_demo_001",
        clientId: "codex",
        capabilities: ["project:read", "timeline:write:low_risk_only"],
        createdAt: fixedClock(),
        expiresAt: "2026-07-18T04:30:00.000Z",
      },
      idempotentReplay: false,
    });
    expect(store.createAgentSession({
      ...input,
      capabilities: [...input.capabilities],
    }).idempotentReplay).toBe(true);
    expect(store.snapshot().project.revision).toBe(0);
    store.close();

    const reopened = ProjectStore.open(path, { clock: fixedClock });
    expect(reopened.authorizeAgentSession({
      tokenHash: input.tokenHash,
      capability: "project:read",
      method: "GET",
      path: "/api/agent/status",
    })).toEqual(created.session);
    expect(() => reopened.authorizeAgentSession({
      tokenHash: input.tokenHash,
      capability: "export:write",
      method: "POST",
      path: "/api/agent/exports",
      requestId: "export-denied-001",
    })).toThrowError(expect.objectContaining({ code: "CAPABILITY_DENIED" }));
    expect(() => reopened.authorizeAgentSession({
      tokenHash: `sha256:${"b".repeat(64)}`,
      capability: "project:read",
      method: "GET",
      path: "/api/agent/status",
    })).toThrowError(expect.objectContaining({ code: "AGENT_SESSION_NOT_FOUND" }));
    expect(reopened.listAgentAccessEvents()).toEqual([
      expect.objectContaining({ allowed: true, reason: "allowed", sessionId: "session_codex_001" }),
      expect.objectContaining({
        allowed: false,
        reason: "capability_denied",
        requestId: "export-denied-001",
      }),
      expect.objectContaining({ allowed: false, reason: "unknown_token" }),
    ]);
    expect(reopened.snapshot().project.revision).toBe(0);
    reopened.close();
  });

  it("rejects session request reuse, changed signing keys, and expired credentials", () => {
    const path = tempPath("agent-session-expiry.sqlite");
    const store = ProjectStore.create(path, fixture(), { clock: fixedClock });
    const base = {
      id: "session_expiring",
      requestId: "session-expiring-001",
      clientId: "codex",
      capabilities: ["project:read"] as const,
      ttlSeconds: 60,
      tokenHash: `sha256:${"c".repeat(64)}`,
    };
    store.createAgentSession({ ...base, capabilities: [...base.capabilities] });
    expect(() => store.createAgentSession({
      ...base,
      capabilities: ["project:read", "analysis:local"],
    })).toThrowError(expect.objectContaining({ code: "AGENT_SESSION_INVALID" }));
    expect(() => store.createAgentSession({
      ...base,
      capabilities: [...base.capabilities],
      tokenHash: `sha256:${"d".repeat(64)}`,
    })).toThrowError(expect.objectContaining({ code: "AGENT_SESSION_INVALID" }));
    store.close();

    const expired = ProjectStore.open(path, { clock: () => "2026-07-18T03:31:01Z" });
    expect(() => expired.authorizeAgentSession({
      tokenHash: base.tokenHash,
      capability: "project:read",
      method: "GET",
      path: "/api/agent/status",
    })).toThrowError(expect.objectContaining({
      code: "AGENT_SESSION_INVALID",
      details: expect.objectContaining({ reason: "expired" }),
    }));
    expect(expired.listAgentAccessEvents()).toEqual([
      expect.objectContaining({ allowed: false, reason: "expired" }),
    ]);
    expired.close();
  });

  it("persists auditable idempotent Agent session revocation without changing Timeline revision", () => {
    const path = tempPath("agent-session-revoke.sqlite");
    let now = "2026-07-18T03:30:00.000Z";
    const store = ProjectStore.create(path, fixture(), { clock: () => now });
    const first = {
      id: "session_revoke_first",
      requestId: "session-create-revoke-first",
      clientId: "codex-first",
      capabilities: ["project:read"] as const,
      ttlSeconds: 3_600,
      tokenHash: `sha256:${"1".repeat(64)}`,
    };
    const second = {
      id: "session_revoke_second",
      requestId: "session-create-revoke-second",
      clientId: "codex-second",
      capabilities: ["project:read"] as const,
      ttlSeconds: 3_600,
      tokenHash: `sha256:${"2".repeat(64)}`,
    };
    store.createAgentSession({ ...first, capabilities: [...first.capabilities] });
    store.createAgentSession({ ...second, capabilities: [...second.capabilities] });
    expect(store.listAgentSessions().map((session) => session.id)).toEqual([
      "session_revoke_first",
      "session_revoke_second",
    ]);

    now = "2026-07-18T03:31:00.000Z";
    const revoked = store.revokeAgentSession({
      sessionId: first.id,
      requestId: "revoke-first-001",
      revokedBy: "local_user",
    });
    expect(revoked).toEqual({
      session: expect.objectContaining({ id: first.id, revokedAt: now }),
      idempotentReplay: false,
      alreadyRevoked: false,
    });
    expect(store.revokeAgentSession({
      sessionId: first.id,
      requestId: "revoke-first-001",
      revokedBy: "local_user",
    })).toEqual({ ...revoked, idempotentReplay: true });
    expect(() => store.revokeAgentSession({
      sessionId: second.id,
      requestId: "revoke-first-001",
      revokedBy: "local_user",
    })).toThrowError(expect.objectContaining({ code: "AGENT_SESSION_INVALID" }));

    now = "2026-07-18T03:32:00.000Z";
    expect(store.revokeAgentSession({
      sessionId: first.id,
      requestId: "revoke-first-again-002",
      revokedBy: "local_user",
    })).toEqual({
      session: expect.objectContaining({ id: first.id, revokedAt: "2026-07-18T03:31:00.000Z" }),
      idempotentReplay: false,
      alreadyRevoked: true,
    });
    expect(store.listAgentSessionRevocations(first.id)).toEqual([
      expect.objectContaining({ requestId: "revoke-first-001", changed: true }),
      expect.objectContaining({ requestId: "revoke-first-again-002", changed: false }),
    ]);
    expect(store.snapshot().project.revision).toBe(0);
    store.close();

    const reopened = ProjectStore.open(path, { clock: () => now });
    expect(() => reopened.authorizeAgentSession({
      tokenHash: first.tokenHash,
      capability: "project:read",
      method: "GET",
      path: "/api/agent/status",
    })).toThrowError(expect.objectContaining({
      code: "AGENT_SESSION_INVALID",
      details: expect.objectContaining({ reason: "revoked" }),
    }));
    expect(reopened.listAgentAccessEvents(first.id)).toEqual([
      expect.objectContaining({ allowed: false, reason: "revoked" }),
    ]);
    expect(reopened.listAgentSessions().find((session) => session.id === first.id))
      .toEqual(expect.objectContaining({ revokedAt: "2026-07-18T03:31:00.000Z" }));
    expect(reopened.snapshot().project.revision).toBe(0);
    reopened.close();
  });

  it("persists UI pairing and write-authorization audit without changing Timeline revision", () => {
    const path = tempPath("ui-access-audit.sqlite");
    let now = "2026-08-10T01:00:00.000Z";
    const store = ProjectStore.create(path, fixture(), { clock: () => now });
    expect(store.recordUiAccessEvent({
      method: "POST",
      path: "/api/ui/session",
      allowed: true,
      reason: "paired",
    })).toEqual(expect.objectContaining({ sequence: 1, allowed: true, reason: "paired" }));
    now = "2026-08-10T01:01:00.000Z";
    store.recordUiAccessEvent({
      method: "POST",
      path: "/api/candidates/candidate_001/keep",
      allowed: false,
      reason: "missing",
    });
    expect(store.snapshot().project.revision).toBe(0);
    store.close();

    const reopened = ProjectStore.open(path, { clock: () => now });
    expect(reopened.listUiAccessEvents()).toEqual([
      expect.objectContaining({
        projectId: "project_demo_001",
        path: "/api/ui/session",
        allowed: true,
        reason: "paired",
      }),
      expect.objectContaining({
        path: "/api/candidates/candidate_001/keep",
        allowed: false,
        reason: "missing",
      }),
    ]);
    expect(reopened.snapshot().project.revision).toBe(0);
    reopened.close();
  });

  it("records UI credential rotation idempotently across reopen without changing revision", () => {
    const path = tempPath("ui-credential-rotation.sqlite");
    const store = ProjectStore.create(path, fixture());
    const rotation = {
      requestId: "ui-rotate-request-001",
      previousFingerprint: "1".repeat(64),
      currentFingerprint: "2".repeat(64),
      generation: 1,
      rotatedBy: "local_user" as const,
      createdAt: "2026-08-10T03:30:00.000Z",
    };
    expect(store.recordUiCredentialRotation(rotation)).toEqual({
      event: expect.objectContaining({ generation: 1, rotatedBy: "local_user" }),
      idempotentReplay: false,
    });
    expect(store.recordUiCredentialRotation(rotation).idempotentReplay).toBe(true);
    expect(() => store.recordUiCredentialRotation({
      ...rotation,
      currentFingerprint: "3".repeat(64),
    })).toThrowError(expect.objectContaining({ code: "UI_CREDENTIAL_ROTATION_INVALID" }));
    expect(store.snapshot().project.revision).toBe(0);
    store.close();

    const reopened = ProjectStore.open(path);
    expect(reopened.getUiCredentialRotation(rotation.requestId)).toEqual(expect.objectContaining({
      requestId: rotation.requestId,
      previousFingerprint: "1".repeat(64),
      currentFingerprint: "2".repeat(64),
      generation: 1,
    }));
    expect(reopened.listUiCredentialRotations()).toHaveLength(1);
    expect(reopened.snapshot().project.revision).toBe(0);
    reopened.close();
  });

  it("persists revision-bound approvals and consumes each approved payload once", () => {
    const path = tempPath("approvals.sqlite");
    let now = "2026-07-18T03:30:00.000Z";
    const store = ProjectStore.create(path, fixture(), { clock: () => now });
    store.createAgentSession({
      id: "session_approval_requester",
      requestId: "session-approval-requester",
      clientId: "codex",
      capabilities: ["approval:request", "timeline:write:approved", "project:read"],
      ttlSeconds: 3_600,
      tokenHash: `sha256:${"e".repeat(64)}`,
    });
    const approvalInput = {
      id: "approval_candidate_high",
      requestId: "approval-request-001",
      kind: "content_high_risk_delete" as const,
      targetId: "candidate_high",
      baseRevision: 0,
      payloadHash: `sha256:${"1".repeat(64)}`,
      requestedBySessionId: "session_approval_requester",
      ttlSeconds: 900,
    };
    const created = store.createApproval(approvalInput);
    expect(created).toEqual({
      approval: expect.objectContaining({
        id: "approval_candidate_high",
        state: "pending",
        baseRevision: 0,
        expiresAt: "2026-07-18T03:45:00.000Z",
      }),
      idempotentReplay: false,
    });
    expect(store.createApproval(approvalInput).idempotentReplay).toBe(true);
    expect(() => store.createApproval({ ...approvalInput, targetId: "candidate_other" }))
      .toThrowError(expect.objectContaining({ code: "APPROVAL_INVALID" }));

    now = "2026-07-18T03:31:00.000Z";
    const tokenHash = `sha256:${"2".repeat(64)}`;
    const resolved = store.resolveApproval({
      approvalId: approvalInput.id,
      requestId: "approval-resolve-001",
      decision: "approve",
      resolvedBy: "local_user",
      tokenHash,
    });
    expect(resolved).toEqual({
      approval: expect.objectContaining({
        id: approvalInput.id,
        state: "approved",
        resolvedBy: "local_user",
      }),
      idempotentReplay: false,
    });
    expect(store.resolveApproval({
      approvalId: approvalInput.id,
      requestId: "approval-resolve-001",
      decision: "approve",
      resolvedBy: "local_user",
      tokenHash,
    }).idempotentReplay).toBe(true);
    expect(() => store.consumeApproval({
      approvalId: approvalInput.id,
      tokenHash: `sha256:${"3".repeat(64)}`,
      consumedBySessionId: "session_approval_requester",
      transactionId: "tx_approved_candidate",
    })).toThrowError(expect.objectContaining({ code: "APPROVAL_STATE_INVALID" }));

    now = "2026-07-18T03:32:00.000Z";
    const consumed = store.consumeApproval({
      approvalId: approvalInput.id,
      tokenHash,
      consumedBySessionId: "session_approval_requester",
      transactionId: "tx_approved_candidate",
    });
    expect(consumed).toEqual(expect.objectContaining({
      state: "consumed",
      transactionId: "tx_approved_candidate",
      consumedBySessionId: "session_approval_requester",
    }));
    expect(store.consumeApproval({
      approvalId: approvalInput.id,
      tokenHash,
      consumedBySessionId: "session_approval_requester",
      transactionId: "tx_approved_candidate",
    })).toEqual(consumed);
    expect(store.snapshot().project.revision).toBe(0);
    store.close();

    const reopened = ProjectStore.open(path, { clock: () => now });
    expect(reopened.getApproval(approvalInput.id)).toEqual(consumed);
    expect(reopened.listApprovals()).toEqual([consumed]);
    expect(reopened.snapshot().project.revision).toBe(0);
    reopened.close();
  });

  it("persists retryable job state, progress, attempts, outputs, and events across restart", () => {
    const path = tempPath("jobs.sqlite");
    const store = ProjectStore.create(path, fixture(), { clock: fixedClock });
    expect(store.createJob({
      id: "job_asr_retry",
      type: "asr.transcribe",
      payload: { assetId: "asset_camera_a", model: "mlx-whisper" },
      maxAttempts: 2,
    })).toEqual(expect.objectContaining({ status: "pending", attempt: 0 }));
    store.startJob("job_asr_retry");
    store.updateJobProgress("job_asr_retry", 0.4, { frames: 4_000 });
    const failed = store.failJob(
      "job_asr_retry",
      { code: "WORKER_EXIT", message: "worker exited" },
      { retryable: true },
    );
    expect(failed).toEqual(expect.objectContaining({ status: "failed", retryable: true, attempt: 1 }));
    store.retryJob("job_asr_retry");
    store.startJob("job_asr_retry");
    const succeeded = store.succeedJob("job_asr_retry", ["asr_raw_1", "transcript_1"]);
    expect(succeeded).toEqual(expect.objectContaining({
      status: "succeeded",
      progress: 1,
      attempt: 2,
      outputArtifactIds: ["asr_raw_1", "transcript_1"],
    }));
    expect(store.listJobEvents("job_asr_retry").map((event) => event.type)).toEqual([
      "created",
      "started",
      "progress",
      "failed",
      "retry_scheduled",
      "started",
      "succeeded",
    ]);
    store.close();

    const reopened = ProjectStore.open(path, { clock: fixedClock });
    expect(reopened.getJob("job_asr_retry")).toEqual(succeeded);
    expect(reopened.listJobEvents("job_asr_retry")).toHaveLength(7);
    reopened.close();
  });

  it("distinguishes cancellable local jobs from non-retryable unknown provider outcomes", () => {
    const path = tempPath("job-cancel.sqlite");
    const store = ProjectStore.create(path, fixture(), { clock: fixedClock });
    store.createJob({ id: "job_pending_cancel", type: "proxy", payload: {} });
    expect(store.requestJobCancellation("job_pending_cancel", {
      requestId: "cancel-pending-001",
      requestedBy: "local_user",
    }).status).toBe("cancelled");
    expect(store.requestJobCancellation("job_pending_cancel", {
      requestId: "cancel-pending-001",
      requestedBy: "local_user",
    }).status).toBe("cancelled");
    expect(() => store.requestJobCancellation("job_running_cancel", {
      requestId: "cancel-pending-001",
      requestedBy: "local_user",
    })).toThrowError(expect.objectContaining({ code: "JOB_NOT_FOUND" }));

    store.createJob({ id: "job_running_cancel", type: "asr", payload: {} });
    store.startJob("job_running_cancel");
    expect(() => store.requestJobCancellation("job_running_cancel", {
      requestId: "cancel-pending-001",
      requestedBy: "local_user",
    })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_STATE" }));
    expect(store.requestJobCancellation("job_running_cancel", {
      requestId: "cancel-running-001",
      requestedBy: "agent:session_001",
    })).toEqual(expect.objectContaining({
      status: "running",
      cancelRequested: true,
    }));
    expect(store.markJobCancelled("job_running_cancel").status).toBe("cancelled");

    store.createJob({ id: "job_unknown", type: "paid-provider", payload: {}, maxAttempts: 3 });
    store.startJob("job_unknown");
    expect(store.failJob(
      "job_unknown",
      { code: "PROVIDER_TIMEOUT", message: "billing outcome is unknown" },
      { retryable: true, outcomeUnknown: true },
    )).toEqual(expect.objectContaining({ status: "outcome_unknown", retryable: false }));
    expect(() => store.retryJob("job_unknown")).toThrowError(
      expect.objectContaining({ code: "INVALID_JOB_STATE" }),
    );
    expect(store.requestJobCancellation("job_unknown", {
      requestId: "cancel-terminal-001",
      requestedBy: "local_user",
    }).status).toBe("outcome_unknown");
    expect(store.listJobCancellationRequests()).toEqual([
      expect.objectContaining({
        jobId: "job_pending_cancel",
        requestId: "cancel-pending-001",
        observedStatus: "pending",
        changed: true,
      }),
      expect.objectContaining({
        jobId: "job_running_cancel",
        requestId: "cancel-running-001",
        observedStatus: "running",
        changed: true,
      }),
      expect.objectContaining({
        jobId: "job_unknown",
        requestId: "cancel-terminal-001",
        observedStatus: "outcome_unknown",
        changed: false,
      }),
    ]);
    expect(store.snapshot().project.revision).toBe(0);
    store.close();

    const reopened = ProjectStore.open(path);
    expect(reopened.listJobCancellationRequests("job_running_cancel"))
      .toEqual([expect.objectContaining({ requestId: "cancel-running-001" })]);
    expect(reopened.snapshot().project.revision).toBe(0);
    reopened.close();
  });

  it("lists persisted jobs by creation order and optional type", () => {
    const store = ProjectStore.create(tempPath("job-list.sqlite"), fixture(), { clock: fixedClock });
    store.createJob({ id: "job_asr", type: "asr.transcribe", payload: {} });
    store.createJob({ id: "job_export", type: "export.render", payload: {} });

    expect(store.listJobs().map((job) => job.id)).toEqual(["job_asr", "job_export"]);
    expect(store.listJobs("export.render").map((job) => job.id)).toEqual(["job_export"]);
    store.close();
  });
});
