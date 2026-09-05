import { describe, expect, it } from "vitest";
import {
  MutationOutcomeUnknownError,
  MutationRequestRegistry,
  runStableMutation,
} from "./mutation-requests.js";

describe("Studio stable mutation requests", () => {
  it("reuses one request ID after an ambiguous failure and clears it after success", async () => {
    let sequence = 0;
    const registry = new MutationRequestRegistry(() => `request-${++sequence}`);
    const seen: string[] = [];
    await expect(runStableMutation(
      registry,
      "project-write",
      { action: "accept", candidateId: "candidate_01", revision: 4 },
      async (requestId) => {
        seen.push(requestId);
        throw new TypeError("Failed to fetch");
      },
    )).rejects.toBeInstanceOf(MutationOutcomeUnknownError);

    await expect(runStableMutation(
      registry,
      "project-write",
      { revision: 4, candidateId: "candidate_01", action: "accept" },
      async (requestId) => {
        seen.push(requestId);
        return "replayed";
      },
    )).resolves.toBe("replayed");
    expect(seen).toEqual(["request-1", "request-1"]);

    await expect(runStableMutation(
      registry,
      "project-write",
      { action: "accept", candidateId: "candidate_02", revision: 5 },
      async (requestId) => requestId,
    )).resolves.toBe("request-2");
  });

  it("blocks a contradictory payload while the first write outcome is unknown", async () => {
    const registry = new MutationRequestRegistry(() => "request-accept");
    await expect(runStableMutation(
      registry,
      "candidate:candidate_01",
      { action: "accept", revision: 4 },
      async () => { throw new Error("connection reset"); },
    )).rejects.toBeInstanceOf(MutationOutcomeUnknownError);

    await expect(runStableMutation(
      registry,
      "candidate:candidate_01",
      { action: "keep", revision: 4 },
      async () => "must not run",
    )).rejects.toThrow("不能在同一对象上提交不同操作");
  });

  it("releases an authoritative 4xx rejection but retains an ambiguous 5xx", async () => {
    let sequence = 0;
    const registry = new MutationRequestRegistry(() => `request-${++sequence}`);
    await expect(runStableMutation(
      registry,
      "alpha-boundary:b1",
      { usable: false, issueCodes: ["clipped_syllable"] },
      async () => { throw Object.assign(new Error("conflict"), { status: 409 }); },
    )).rejects.toMatchObject({ status: 409 });
    expect(registry.pendingRequestId("alpha-boundary:b1")).toBeUndefined();

    await expect(runStableMutation(
      registry,
      "alpha-boundary:b1",
      { usable: false, issueCodes: ["clipped_syllable"] },
      async () => { throw Object.assign(new Error("gateway"), { status: 502 }); },
    )).rejects.toBeInstanceOf(MutationOutcomeUnknownError);
    expect(registry.pendingRequestId("alpha-boundary:b1")).toBe("request-2");
  });

  it("allows an authoritative refresh to clear an unresolved scope", async () => {
    const registry = new MutationRequestRegistry(() => "request-1");
    await expect(runStableMutation(
      registry,
      "export-create",
      { revision: 8, preset: "source" },
      async () => { throw new Error("socket closed"); },
    )).rejects.toBeInstanceOf(MutationOutcomeUnknownError);
    registry.clearScope("export-create");
    expect(registry.pendingRequestId("export-create")).toBeUndefined();
  });
});
