import { describe, expect, it, vi } from "vitest";
import { sha256File } from "./file-sha256.js";

describe("sha256File", () => {
  it("hashes a local Blob incrementally and reports byte progress", async () => {
    const progress: Array<[number, number]> = [];

    const digest = await sha256File(new Blob(["abc"]), {
      chunkSize: 1,
      onProgress: (processed, total) => progress.push([processed, total]),
    });

    expect(digest).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it("does not use network APIs while hashing", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(sha256File(new Blob(["private evidence"]))).resolves.toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("rejects empty evidence and an aborted read", async () => {
    await expect(sha256File(new Blob([]))).rejects.toThrow("must not be empty");

    const controller = new AbortController();
    controller.abort();
    await expect(sha256File(new Blob(["abc"]), { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
