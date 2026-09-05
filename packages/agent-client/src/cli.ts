#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { AgentCutClient, AgentCutClientError } from "./client.js";
import {
  writeAgentHandoffCredentialFile,
} from "../../../scripts/agentcut-credentials.mjs";
import type {
  AgentCapability,
  AgentSemanticFinding,
  AgentSessionCredential,
  ExportJobResponse,
  ExportPreset,
} from "./types.js";

export type AgentCliInvocation =
  | {
      command: "handoff-create";
      url: string;
      clientId: string;
      capabilities: AgentCapability[];
      ttlSeconds: number;
      requestId: string;
      outputPath: string;
    }
  | { command: "status"; url: string }
  | { command: "candidates"; url: string }
  | { command: "transcript-get"; url: string; offset?: number; limit?: number }
  | { command: "project-diff"; url: string; fromRevision: number; toRevision?: number }
  | { command: "approval-get"; url: string; approvalId: string }
  | { command: "approval-request"; url: string; candidateId: string; baseRevision: number; requestId: string }
  | { command: "approval-apply"; url: string; approvalId: string; approvalToken: string; baseRevision: number; requestId: string }
  | { command: "rough-cut-generate"; url: string; baseRevision: number; requestId: string }
  | { command: "semantic-analyze"; url: string; baseRevision: number; requestId: string }
  | { command: "semantic-propose"; url: string; baseRevision: number; requestId: string; findingsPath: string }
  | { command: "export-start"; url: string; baseRevision: number; requestId: string; preset?: ExportPreset }
  | { command: "export-cancel"; url: string; jobId: string; requestId: string }
  | { command: "export-get"; url: string; jobId: string };

export class AgentCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCliUsageError";
  }
}

export function parseAgentCliArgs(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
): AgentCliInvocation {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalizedArgv[0] === "handoff" && normalizedArgv[1] === "create") {
    return parseHandoffCreate(normalizedArgv.slice(2), environment);
  }
  const { values, remaining } = extractOptions(normalizedArgv, new Set(["--url", "--approval-token"]));
  const url = values.get("--url") ?? environment.AGENTCUT_DAEMON_URL ?? "http://127.0.0.1:4317";
  const approvalToken = values.get("--approval-token");
  const [first, second, third, ...extra] = remaining;
  if (first === "status" && second === undefined && approvalToken === undefined) return { command: "status", url };
  if (first === "candidates" && second === undefined && approvalToken === undefined) return { command: "candidates", url };
  if (first === "transcript" && second === "get" && approvalToken === undefined) {
    const { values: transcriptValues, remaining: transcriptPositionals } = extractOptions(
      remaining.slice(2),
      new Set(["--offset", "--limit"]),
    );
    if (transcriptPositionals.length > 0) throw new AgentCliUsageError(usage());
    const offset = parseBoundedIntegerOption(transcriptValues, "--offset", 0, 10_000_000);
    const limit = parseBoundedIntegerOption(transcriptValues, "--limit", 1, 500);
    return {
      command: "transcript-get",
      url,
      ...(offset !== undefined ? { offset } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }
  if (first === "project" && second === "diff") {
    if (approvalToken !== undefined) throw new AgentCliUsageError(usage());
    const { values: diffValues, remaining: diffPositionals } = extractOptions(
      remaining.slice(2),
      new Set(["--from-revision", "--to-revision"]),
    );
    if (diffPositionals.length > 0) throw new AgentCliUsageError(usage());
    const fromRevision = parseRevisionOption(diffValues, "--from-revision", true);
    const toRevision = parseRevisionOption(diffValues, "--to-revision", false);
    return {
      command: "project-diff",
      url,
      fromRevision: fromRevision!,
      ...(toRevision !== undefined ? { toRevision } : {}),
    };
  }
  if (first === "export" && second === "get" && third && extra.length === 0
    && approvalToken === undefined) {
    return { command: "export-get", url, jobId: third };
  }
  if (first === "export" && second === "cancel" && third && approvalToken === undefined) {
    const { values: cancelValues, remaining: cancelPositionals } = extractOptions(
      remaining.slice(3),
      new Set(["--request-id"]),
    );
    if (cancelPositionals.length > 0) throw new AgentCliUsageError(usage());
    return {
      command: "export-cancel",
      url,
      jobId: third,
      requestId: requiredRequestId(cancelValues, "export cancel"),
    };
  }
  if (first === "approval" && second === "get" && third && extra.length === 0
    && approvalToken === undefined) {
    return { command: "approval-get", url, approvalId: third };
  }
  if (first === "semantic" && second === "propose" && approvalToken === undefined) {
    const { values: proposalValues, remaining: proposalPositionals } = extractOptions(
      remaining.slice(2),
      new Set(["--base-revision", "--request-id", "--findings-file"]),
    );
    if (proposalPositionals.length > 0) throw new AgentCliUsageError(usage());
    const findingsPath = proposalValues.get("--findings-file");
    if (!findingsPath?.trim() || findingsPath !== findingsPath.trim()) {
      throw new AgentCliUsageError("semantic propose requires --findings-file <JSON file>");
    }
    return {
      command: "semantic-propose",
      url,
      baseRevision: parseRevisionOption(proposalValues, "--base-revision", true)!,
      requestId: requiredRequestId(proposalValues, "semantic propose"),
      findingsPath,
    };
  }
  if (first === "export" && second === "start" && approvalToken === undefined) {
    const { values: exportValues, remaining: exportPositionals } = extractOptions(
      remaining.slice(2),
      new Set(["--base-revision", "--request-id", "--preset"]),
    );
    if (exportPositionals.length > 0) throw new AgentCliUsageError(usage());
    const preset = parseExportPresetOption(exportValues);
    return {
      command: "export-start",
      url,
      baseRevision: parseRevisionOption(exportValues, "--base-revision", true)!,
      requestId: requiredRequestId(exportValues, "export start"),
      ...(preset !== undefined ? { preset } : {}),
    };
  }
  const write = parseWriteBinding(remaining);
  if (write.positionals[0] === "approval" && write.positionals[1] === "request"
    && write.positionals[2] && write.positionals.length === 3 && approvalToken === undefined) {
    return {
      command: "approval-request",
      url,
      candidateId: write.positionals[2],
      ...write.binding,
    };
  }
  if (write.positionals[0] === "approval" && write.positionals[1] === "apply"
    && write.positionals[2] && write.positionals.length === 3
    && approvalToken?.trim() && approvalToken === approvalToken.trim()) {
    return {
      command: "approval-apply",
      url,
      approvalId: write.positionals[2],
      approvalToken,
      ...write.binding,
    };
  }
  if (write.positionals[0] === "rough-cut" && write.positionals[1] === "generate"
    && write.positionals.length === 2 && approvalToken === undefined) {
    return { command: "rough-cut-generate", url, ...write.binding };
  }
  if (write.positionals[0] === "semantic" && write.positionals[1] === "analyze"
    && write.positionals.length === 2 && approvalToken === undefined) {
    return { command: "semantic-analyze", url, ...write.binding };
  }
  throw new AgentCliUsageError(usage());
}

export async function executeAgentInvocation(
  invocation: AgentCliInvocation,
  client = new AgentCutClient({ baseUrl: invocation.url }),
): Promise<unknown> {
  switch (invocation.command) {
    case "handoff-create": {
      const credential = await client.session();
      const written = writeAgentHandoffCredentialFile(invocation.outputPath, {
        daemonUrl: invocation.url,
        credential,
      });
      return {
        handoff: {
          credentialPath: written.credentialPath,
          daemonUrl: written.credential.daemonUrl,
          projectId: written.credential.projectId,
          sessionId: written.credential.session.id,
          clientId: written.credential.session.clientId,
          capabilities: written.credential.session.capabilities,
          createdAt: written.credential.session.createdAt,
          expiresAt: written.credential.session.expiresAt,
          accessTokenFingerprint: written.credential.accessTokenFingerprint,
          idempotentReplay: written.idempotentReplay,
        },
      };
    }
    case "status": return client.status();
    case "candidates": return client.candidates();
    case "transcript-get": return client.transcript(invocation);
    case "project-diff": return client.projectDiff(invocation);
    case "approval-get": return client.approvalStatus(invocation.approvalId);
    case "approval-request": return client.requestCandidateApproval(invocation);
    case "approval-apply": return client.applyApproval(invocation);
    case "rough-cut-generate": return client.generateRoughCut(invocation);
    case "semantic-analyze": return client.analyzeSemantic(invocation);
    case "semantic-propose": return client.proposeSemanticFindings({
      baseRevision: invocation.baseRevision,
      requestId: invocation.requestId,
      findings: readSemanticFindingsFile(invocation.findingsPath),
    });
    case "export-start": return client.startExport({
      baseRevision: invocation.baseRevision,
      requestId: invocation.requestId,
      ...(invocation.preset !== undefined ? { preset: invocation.preset } : {}),
    });
    case "export-cancel": return client.cancelExport(invocation);
    case "export-get": return client.exportStatus(invocation.jobId);
  }
}

export async function runAgentCli(
  argv: string[],
  options: {
    environment?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch;
    session?: AgentSessionCredential;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const invocation = parseAgentCliArgs(argv, options.environment ?? process.env);
    const environment = options.environment ?? process.env;
    if (invocation.command === "handoff-create" && options.session) {
      throw new AgentCutClientError(
        403,
        "CAPABILITY_DENIED",
        "Creating a delegated handoff requires the project bootstrap credential",
      );
    }
    const result = await executeAgentInvocation(
      invocation,
      new AgentCutClient({
        baseUrl: invocation.url,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        ...(options.session ? { session: options.session } : {}),
        ...(environment.AGENTCUT_AGENT_BOOTSTRAP_TOKEN
          ? { bootstrapToken: environment.AGENTCUT_AGENT_BOOTSTRAP_TOKEN }
          : {}),
        clientId: invocation.command === "handoff-create" ? invocation.clientId : "agentcut-cli",
        ...(invocation.command === "handoff-create" ? {
          sessionRequestId: invocation.requestId,
          requestedCapabilities: invocation.capabilities,
          sessionTtlSeconds: invocation.ttlSeconds,
        } : {}),
      }),
    );
    if (invocation.command === "export-get" && isFailedExport(result)) {
      stderr(JSON.stringify({
        error: result.error ?? {
          code: "EXPORT_JOB_FAILED",
          message: `Export job ${result.jobId} ended as ${result.status}`,
        },
      }));
      return 6;
    }
    stdout(JSON.stringify(result));
    return 0;
  } catch (error) {
    const normalized = cliError(error);
    stderr(JSON.stringify({ error: normalized.body }));
    return normalized.exitCode;
  }
}

function parseHandoffCreate(
  argv: string[],
  environment: NodeJS.ProcessEnv,
): Extract<AgentCliInvocation, { command: "handoff-create" }> {
  const values = new Map<string, string>();
  const capabilities: AgentCapability[] = [];
  const supported = new Set([
    "--url",
    "--client-id",
    "--capability",
    "--ttl-seconds",
    "--request-id",
    "--out",
  ]);
  const allowedCapabilities = new Set<AgentCapability>([
    "project:read",
    "transcript:read",
    "analysis:local",
    "analysis:propose",
    "timeline:write:low_risk_only",
    "approval:request",
    "timeline:write:approved",
    "export:write",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (!supported.has(option)) throw new AgentCliUsageError(usage());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new AgentCliUsageError(`${option} requires a value`);
    if (option === "--capability") {
      if (!allowedCapabilities.has(value as AgentCapability)) {
        throw new AgentCliUsageError(`Unsupported Agent capability: ${value}`);
      }
      capabilities.push(value as AgentCapability);
    } else {
      if (values.has(option)) throw new AgentCliUsageError(`${option} cannot be repeated`);
      values.set(option, value);
    }
    index += 1;
  }
  if (capabilities.length === 0 || new Set(capabilities).size !== capabilities.length) {
    throw new AgentCliUsageError("handoff create requires one or more unique --capability values");
  }
  const clientId = requiredStableOption(values, "--client-id", "handoff create");
  const requestId = requiredStableOption(values, "--request-id", "handoff create");
  const outputPath = values.get("--out");
  if (!outputPath?.trim() || outputPath !== outputPath.trim()) {
    throw new AgentCliUsageError("handoff create requires --out <credential file path>");
  }
  const ttlText = values.get("--ttl-seconds") ?? "3600";
  const ttlSeconds = Number(ttlText);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400
    || String(ttlSeconds) !== ttlText) {
    throw new AgentCliUsageError("--ttl-seconds must be a canonical integer between 60 and 86400");
  }
  return {
    command: "handoff-create",
    url: values.get("--url") ?? environment.AGENTCUT_DAEMON_URL ?? "http://127.0.0.1:4317",
    clientId,
    capabilities: [...capabilities].sort(),
    ttlSeconds,
    requestId,
    outputPath,
  };
}

function requiredStableOption(
  values: Map<string, string>,
  option: string,
  command: string,
): string {
  const value = values.get(option);
  if (!value?.trim() || value !== value.trim() || value.length > 128) {
    throw new AgentCliUsageError(`${command} requires ${option} <stable value>`);
  }
  return value;
}

function parseWriteBinding(argv: string[]): {
  positionals: string[];
  binding: { baseRevision: number; requestId: string };
} {
  const { values, remaining: positionals } = extractOptions(
    argv,
    new Set(["--base-revision", "--request-id"]),
  );
  const revisionText = values.get("--base-revision");
  const requestId = values.get("--request-id");
  const baseRevision = revisionText === undefined ? Number.NaN : Number(revisionText);
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw new AgentCliUsageError("Write commands require --base-revision <non-negative integer>");
  }
  if (!requestId?.trim() || requestId !== requestId.trim() || requestId.length > 128) {
    throw new AgentCliUsageError(
      "Write commands require --request-id <stable idempotency key without surrounding whitespace>",
    );
  }
  return { positionals, binding: { baseRevision, requestId } };
}

function parseExportPresetOption(values: Map<string, string>): ExportPreset | undefined {
  const raw = values.get("--preset");
  if (raw === undefined) return undefined;
  if (raw === "source" || raw === "vertical-9-16") return raw;
  throw new AgentCliUsageError("--preset must be one of: source, vertical-9-16");
}

function requiredRequestId(values: Map<string, string>, command: string): string {  const requestId = values.get("--request-id");
  if (!requestId?.trim() || requestId !== requestId.trim() || requestId.length > 128) {
    throw new AgentCliUsageError(
      `${command} requires --request-id <stable idempotency key without surrounding whitespace>`,
    );
  }
  return requestId;
}

function parseRevisionOption(
  values: Map<string, string>,
  name: string,
  required: boolean,
): number | undefined {
  const raw = values.get(name);
  if (raw === undefined) {
    if (required) throw new AgentCliUsageError(`${name} <non-negative integer> is required`);
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== raw) {
    throw new AgentCliUsageError(`${name} must be a canonical non-negative integer`);
  }
  return value;
}

function parseBoundedIntegerOption(
  values: Map<string, string>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum || String(value) !== raw) {
    throw new AgentCliUsageError(`${name} must be a canonical integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function readSemanticFindingsFile(path: string): AgentSemanticFinding[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new AgentCliUsageError(
      `Cannot read semantic findings JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Array.isArray((value as { findings?: unknown }).findings)) {
    throw new AgentCliUsageError("Semantic findings file must contain {\"findings\": [...]}");
  }
  return (value as { findings: AgentSemanticFinding[] }).findings;
}

function extractOptions(argv: string[], supported: Set<string>): {
  values: Map<string, string>;
  remaining: string[];
} {
  const values = new Map<string, string>();
  const remaining: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      remaining.push(value);
      continue;
    }
    if (!supported.has(value)) {
      remaining.push(value);
      continue;
    }
    const optionValue = argv[index + 1];
    if (!optionValue || optionValue.startsWith("--")) {
      throw new AgentCliUsageError(`${value} requires a value`);
    }
    if (values.has(value)) throw new AgentCliUsageError(`${value} cannot be repeated`);
    values.set(value, optionValue);
    index += 1;
  }
  return { values, remaining };
}

function cliError(error: unknown): {
  exitCode: number;
  body: { code: string; message: string; details?: Record<string, unknown> };
} {
  if (error instanceof AgentCliUsageError) {
    return { exitCode: 2, body: { code: "INVALID_ARGUMENTS", message: error.message } };
  }
  if (error instanceof AgentCutClientError) {
    const exitCode = error.code === "REVISION_CONFLICT" ? 3
      : error.code.includes("APPROVAL") || error.code === "HIGH_RISK_CONFIRMATION_REQUIRED" ? 4
        : error.code.includes("CAPABILITY") || error.code.includes("CREDENTIAL")
          || error.code.includes("AGENT_SESSION") || error.code === "AGENT_ACCESS_UNAVAILABLE"
          || error.code === "RENDER_CAPABILITY_MISSING"
          || error.code === "SEMANTIC_REVIEW_UNAVAILABLE"
          || error.code === "PROVIDER_UNAVAILABLE" ? 5
          : error.code.includes("JOB") || error.code.includes("RENDER") || error.code === "QUALITY_FAILED" ? 6
            : 7;
    return {
      exitCode,
      body: {
        code: error.code,
        message: error.message,
        ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
      },
    };
  }
  if (error && typeof error === "object" && "code" in error
    && typeof error.code === "string" && error.code.startsWith("AGENT_HANDOFF_")) {
    return {
      exitCode: error.code === "AGENT_HANDOFF_INVALID" || error.code === "AGENT_HANDOFF_PERMISSIONS"
        ? 5
        : 2,
      body: {
        code: error.code,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  return {
    exitCode: 7,
    body: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) },
  };
}

function isFailedExport(value: unknown): value is ExportJobResponse & {
  status: "failed" | "cancelled" | "outcome_unknown";
} {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("status" in value)) return false;
  return value.status === "failed" || value.status === "cancelled" || value.status === "outcome_unknown";
}

function usage(): string {
  return [
    "Usage:",
    "  agentcut-agent handoff create --client-id ID --capability CAPABILITY [--capability CAPABILITY] --request-id ID --out FILE [--ttl-seconds N] [--url URL]",
    "  agentcut-agent status [--url URL]",
    "  agentcut-agent candidates [--url URL]",
    "  agentcut-agent transcript get [--offset N] [--limit N] [--url URL]",
    "  agentcut-agent project diff --from-revision N [--to-revision N] [--url URL]",
    "  agentcut-agent approval request CANDIDATE_ID --base-revision N --request-id ID [--url URL]",
    "  agentcut-agent approval get APPROVAL_ID [--url URL]",
    "  agentcut-agent approval apply APPROVAL_ID --approval-token TOKEN --base-revision N --request-id ID [--url URL]",
    "  agentcut-agent rough-cut generate --base-revision N --request-id ID [--url URL]",
    "  agentcut-agent semantic analyze --base-revision N --request-id ID [--url URL]",
    "  agentcut-agent semantic propose --findings-file FILE --base-revision N --request-id ID [--url URL]",
    "  agentcut-agent export start --base-revision N --request-id ID [--preset source|vertical-9-16] [--url URL]",
    "  agentcut-agent export cancel JOB_ID --request-id ID [--url URL]",
    "  agentcut-agent export get JOB_ID [--url URL]",
  ].join("\n");
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await runAgentCli(process.argv.slice(2));
}
