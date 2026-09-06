import { join, resolve } from "node:path";
import { ProjectStore } from "@agentcut/project-store";
import { TALKING_HEAD_EXTENSION_VALIDATORS } from "@agentcut/host-extensions";
import { createAlphaAuditDraft } from "./audit.js";
import { verifyAlphaProjectCorrectness } from "./correctness.js";
import { AlphaEvidenceStore } from "./evidence.js";

export interface AlphaCorrectnessCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export async function runAlphaCorrectnessCli(arguments_: string[], io: AlphaCorrectnessCliIo): Promise<number> {
  try {
    const parsed = parseArguments(arguments_);
    const projectRoot = resolve(parsed.projectRoot);
    const databasePath = join(projectRoot, "agentcut.sqlite");
    const before = readAudit(databasePath);
    const run = await verifyAlphaProjectCorrectness({
      databasePath,
      requestId: parsed.requestId,
      projectId: before.project.id,
      projectRevision: before.project.revision,
      sourceSha256: before.project.sourceSha256,
    });
    const after = readAudit(databasePath);
    if (after.project.id !== before.project.id
      || after.project.revision !== before.project.revision
      || after.project.sourceSha256 !== before.project.sourceSha256) {
      throw new Error("Project changed while correctness verification was running; evidence was not recorded");
    }
    const evidence = AlphaEvidenceStore.open(join(projectRoot, "alpha-evidence.sqlite"));
    try {
      evidence.recordCorrectnessRun(after, run);
    } finally {
      evidence.close();
    }
    io.stdout(
      `Recorded Alpha correctness ${run.runId} for ${run.projectId} revision ${run.projectRevision}: `
      + `undo=${status(run.checks.undo.passed)} restart=${status(run.checks.restart.passed)} `
      + `idempotency=${status(run.checks.idempotency.passed)} `
      + `revisionConflict=${status(run.checks.revisionConflict.passed)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr(`Alpha correctness input error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function readAudit(databasePath: string) {
  const store = ProjectStore.open(databasePath,
    { extensionValidators: TALKING_HEAD_EXTENSION_VALIDATORS });
  try {
    return createAlphaAuditDraft(store.snapshot(), store.listRecords());
  } finally {
    store.close();
  }
}

function parseArguments(arguments_: string[]): { projectRoot: string; requestId: string } {
  const positionals: string[] = [];
  let requestId: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--") continue;
    if (argument === "--request-id") {
      const value = arguments_[++index];
      if (!value || value.startsWith("--")) throw new Error("--request-id requires a value");
      requestId = value;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown alpha:verify option: ${argument}`);
    } else {
      positionals.push(argument);
    }
  }
  if (positionals.length !== 1) throw new Error("alpha:verify requires exactly one project directory");
  if (!requestId?.trim()) throw new Error("alpha:verify requires --request-id <id>");
  return { projectRoot: positionals[0]!, requestId: requestId.trim() };
}

function status(passed: boolean): string {
  return passed ? "passed" : "failed";
}
