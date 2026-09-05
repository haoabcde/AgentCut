import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { RawAsrResult } from "./normalize.js";

export interface MlxWhisperRunOptions {
  pythonPath: string;
  workerScriptPath: string;
  inputPath: string;
  outputPath: string;
  model: string;
  language?: string;
  initialPrompt?: string;
  signal?: AbortSignal;
}

export interface MlxWhisperRunResult {
  rawResult: RawAsrResult;
  stderr: string;
}

export class AsrRunnerError extends Error {
  constructor(
    readonly code: "PROCESS_FAILED" | "CANCELLED" | "INVALID_OUTPUT",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AsrRunnerError";
  }
}

export async function runMlxWhisper(options: MlxWhisperRunOptions): Promise<MlxWhisperRunResult> {
  const args = [
    options.workerScriptPath,
    "--input", options.inputPath,
    "--output", options.outputPath,
    "--model", options.model,
    "--language", options.language ?? "zh",
  ];
  if (options.initialPrompt) args.push("--initial-prompt", options.initialPrompt);
  const result = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(options.pythonPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 1_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
    options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  }).catch((error: unknown) => {
    throw new AsrRunnerError("PROCESS_FAILED", "Could not start MLX Whisper worker", {
      cause: error instanceof Error ? error.message : String(error),
    });
  });
  if (options.signal?.aborted) throw new AsrRunnerError("CANCELLED", "ASR job was cancelled");
  if (result.status !== 0) {
    throw new AsrRunnerError("PROCESS_FAILED", `MLX Whisper exited with status ${result.status}`, {
      stderr: result.stderr,
    });
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(options.outputPath, "utf8"));
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as RawAsrResult).segments)) {
      throw new TypeError("segments must be an array");
    }
    return { rawResult: raw as RawAsrResult, stderr: result.stderr };
  } catch (error) {
    throw new AsrRunnerError("INVALID_OUTPUT", "MLX Whisper produced invalid JSON", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
