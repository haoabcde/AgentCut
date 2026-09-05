import { describe, expect, it } from "vitest";
import { parseRoughCutCliArguments } from "./cli.js";

describe("roughcut CLI arguments", () => {
  it("parses source, project, and optional name", () => {
    expect(parseRoughCutCliArguments([
      "/tmp/source.mp4",
      "--project", "/tmp/project",
      "--name", "产品口播",
      "--alpha-trial",
    ])).toEqual({
      sourcePath: "/tmp/source.mp4",
      projectRoot: "/tmp/project",
      name: "产品口播",
      alphaTrial: true,
    });
  });

  it("keeps ordinary projects outside formal Alpha mode by default", () => {
    expect(parseRoughCutCliArguments([
      "source.mp4", "--project", "project",
    ])).toEqual({
      sourcePath: "source.mp4",
      projectRoot: "project",
      alphaTrial: false,
    });
  });

  it("accepts the pnpm argument separator used by the documented command", () => {
    expect(parseRoughCutCliArguments([
      "--", "source.mp4", "--project", "project", "--alpha-trial",
    ])).toEqual({
      sourcePath: "source.mp4",
      projectRoot: "project",
      alphaTrial: true,
    });
  });

  it("requires exactly one source and a project directory", () => {
    expect(() => parseRoughCutCliArguments(["source.mp4"]))
      .toThrow("--project");
    expect(() => parseRoughCutCliArguments([
      "source-a.mp4", "source-b.mp4", "--project", "project",
    ])).toThrow("one source video");
  });
});
