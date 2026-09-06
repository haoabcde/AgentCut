import { randomUUID } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ProjectStore } from "@agentcut/project-store";
import { TALKING_HEAD_EXTENSION_VALIDATORS } from "@agentcut/host-extensions";
import { createAlphaAuditDraft } from "./audit.js";
import {
  alphaEvidenceBundleFileSha256,
  createAlphaEvidenceBundle,
  serializeAlphaEvidenceBundle,
} from "./bundle.js";
import { AlphaEvidenceStore } from "./evidence.js";

export interface AlphaEvidenceCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export async function runAlphaEvidenceCli(arguments_: string[], io: AlphaEvidenceCliIo): Promise<number> {
  let temporaryPath: string | undefined;
  try {
    const parsed = parseArguments(arguments_);
    const projectRoot = resolve(parsed.projectRoot);
    const outputPath = resolve(parsed.outputPath);
    const projectStore = ProjectStore.open(join(projectRoot, "agentcut.sqlite"),
      { extensionValidators: TALKING_HEAD_EXTENSION_VALIDATORS });
    let draft;
    try {
      draft = createAlphaAuditDraft(projectStore.snapshot(), projectStore.listRecords());
    } finally {
      projectStore.close();
    }
    const evidenceStore = AlphaEvidenceStore.open(join(projectRoot, "alpha-evidence.sqlite"));
    let bundle;
    try {
      bundle = createAlphaEvidenceBundle(evidenceStore.apply(draft));
    } finally {
      evidenceStore.close();
    }
    const serialized = serializeAlphaEvidenceBundle(bundle);
    const fileSha256 = alphaEvidenceBundleFileSha256(serialized);
    await mkdir(dirname(outputPath), { recursive: true });
    temporaryPath = join(dirname(outputPath), `.${randomUUID()}.alpha-evidence.tmp`);
    await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
    try {
      await link(temporaryPath, outputPath);
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) {
        throw new Error(`Refusing to overwrite existing Alpha evidence bundle: ${outputPath}`);
      }
      throw error;
    }
    await unlink(temporaryPath);
    temporaryPath = undefined;
    io.stdout(
      `Wrote Alpha evidence bundle for ${bundle.project.id} revision ${bundle.project.revision} `
      + `to ${outputPath} (file ${fileSha256})\n`,
    );
    return 0;
  } catch (error) {
    if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
    io.stderr(`Alpha evidence input error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function parseArguments(arguments_: string[]): { projectRoot: string; outputPath: string } {
  const positionals: string[] = [];
  let outputPath: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--") continue;
    if (argument === "--output") {
      const value = arguments_[++index];
      if (!value || value.startsWith("--")) throw new Error("--output requires a file path");
      outputPath = value;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown alpha:evidence option: ${argument}`);
    } else {
      positionals.push(argument);
    }
  }
  if (positionals.length !== 1) throw new Error("alpha:evidence requires exactly one project directory");
  if (!outputPath) throw new Error("alpha:evidence requires --output <bundle-file.json>");
  return { projectRoot: positionals[0]!, outputPath };
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
