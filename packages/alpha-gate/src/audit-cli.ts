import { randomUUID } from "node:crypto";
import { mkdir, link, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ProjectStore } from "@agentcut/project-store";
import { createAlphaAuditDraft } from "./audit.js";

export interface AlphaAuditCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export async function runAlphaAuditCli(arguments_: string[], io: AlphaAuditCliIo): Promise<number> {
  let temporaryPath: string | undefined;
  try {
    const parsed = parseArguments(arguments_);
    const projectRoot = resolve(parsed.projectRoot);
    const outputPath = resolve(parsed.outputPath);
    const store = ProjectStore.open(join(projectRoot, "agentcut.sqlite"));
    let draft;
    try {
      draft = createAlphaAuditDraft(store.snapshot(), store.listRecords());
    } finally {
      store.close();
    }
    await mkdir(dirname(outputPath), { recursive: true });
    temporaryPath = join(dirname(outputPath), `.${randomUUID()}.alpha-audit.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(draft, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await link(temporaryPath, outputPath);
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) {
        throw new Error(`Refusing to overwrite existing audit evidence: ${outputPath}`);
      }
      throw error;
    }
    await unlink(temporaryPath);
    temporaryPath = undefined;
    io.stdout(
      `Wrote Alpha audit draft for ${draft.project.id} revision ${draft.project.revision} to ${outputPath}\n`,
    );
    return 0;
  } catch (error) {
    if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Alpha audit input error: ${message}\n`);
    return 2;
  }
}

function parseArguments(arguments_: string[]): { projectRoot: string; outputPath: string } {
  const positionals: string[] = [];
  let outputPath: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--") {
      continue;
    } else if (argument === "--output") {
      const value = arguments_[++index];
      if (!value || value.startsWith("--")) throw new Error("--output requires a file path");
      outputPath = value;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown alpha:audit option: ${argument}`);
    } else {
      positionals.push(argument);
    }
  }
  if (positionals.length !== 1) throw new Error("alpha:audit requires exactly one project directory");
  if (!outputPath) throw new Error("alpha:audit requires --output <audit-file.json>");
  return { projectRoot: positionals[0]!, outputPath };
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
