import { afterEach, describe, expect, it } from "vitest";
import { resolvePython } from "./python.js";

describe("resolvePython", () => {
  afterEach(() => {
    delete process.env.AGENTCUT_OTIO_PYTHON;
  });

  it("defaults to python3 from PATH", () => {
    delete process.env.AGENTCUT_OTIO_PYTHON;
    expect(resolvePython()).toBe("python3");
  });

  it("honors AGENTCUT_OTIO_PYTHON for multi-interpreter machines", () => {
    process.env.AGENTCUT_OTIO_PYTHON = "/usr/bin/python3";
    expect(resolvePython()).toBe("/usr/bin/python3");
  });
});
