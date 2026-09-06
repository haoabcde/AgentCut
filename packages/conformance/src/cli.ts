import { writeFileSync } from "node:fs";
import { runConformance } from "./runner.js";
import { CONFORMANCE_SUITE_VERSION, type ConformanceReport } from "./types.js";

function printUsageAndExit(): never {
  process.stdout.write(`agentcut-conformance — AgentCut protocol conformance suite (v${CONFORMANCE_SUITE_VERSION})

Usage:
  agentcut-conformance --url http://127.0.0.1:4318 --token <bootstrap> [options]

Options:
  --url <baseUrl>          Host base URL (env AGENTCUT_CONFORMANCE_URL)
  --token <bootstrap>      Host bootstrap token (env AGENTCUT_BOOTSTRAP_TOKEN)
  --host-label <label>     Host label written into the report
  --report <path>          Write the machine-readable JSON report to a file
  --allow-skip <checkId>   Permit a skip (repeatable); unpermitted skips fail the run
  --pretty                 Pretty-print the report
`);
  process.exit(0);
}

export interface ParsedConformanceArgs {
  url: string;
  token: string;
  hostLabel: string | undefined;
  reportPath: string | undefined;
  allowedSkips: string[];
  pretty: boolean;
}

export function parseConformanceArgs(argv: readonly string[]): ParsedConformanceArgs {
  const args: ParsedConformanceArgs = {
    url: process.env.AGENTCUT_CONFORMANCE_URL ?? "",
    token: process.env.AGENTCUT_BOOTSTRAP_TOKEN ?? "",
    hostLabel: process.env.AGENTCUT_CONFORMANCE_HOST_LABEL,
    reportPath: undefined,
    allowedSkips: [],
    pretty: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = argv[index + 1];
    if (arg === "--url" && next) { args.url = next; index += 1; continue; }
    if (arg === "--token" && next) { args.token = next; index += 1; continue; }
    if (arg === "--host-label" && next) { args.hostLabel = next; index += 1; continue; }
    if (arg === "--report" && next) { args.reportPath = next; index += 1; continue; }
    if (arg === "--allow-skip" && next) { args.allowedSkips.push(next); index += 1; continue; }
    if (arg === "--pretty") { args.pretty = true; continue; }
    if (arg === "--help" || arg === "-h") printUsageAndExit();
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.url) throw new Error("--url is required (or set AGENTCUT_CONFORMANCE_URL)");
  if (!args.token) throw new Error("--token is required (or set AGENTCUT_BOOTSTRAP_TOKEN)");
  return args;
}

export async function runConformanceCli(argv: readonly string[], stdout = process.stdout): Promise<number> {
  const args = parseConformanceArgs(argv);
  const report: ConformanceReport = await runConformance({
    baseUrl: args.url,
    bootstrapToken: args.token,
    ...(args.hostLabel === undefined ? {} : { hostLabel: args.hostLabel }),
    ...(args.allowedSkips.length ? { allowedSkips: args.allowedSkips } : {}),
  });
  const json = JSON.stringify(report, null, args.pretty ? 2 : undefined);
  if (args.reportPath) {
    writeFileSync(args.reportPath, json + "\n");
  }
  for (const check of report.checks) {
    stdout.write(`[${check.status.toUpperCase().padEnd(4)}] ${check.id} (${check.specClause}) — ${check.detail}\n`);
  }
  stdout.write(
    `\nverdict: ${report.verdict} (${report.summary.passed} passed, ${report.summary.failed} failed,`
    + ` ${report.summary.skipped} skipped)\n`,
  );
  return report.verdict === "pass" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(await runConformanceCli(process.argv.slice(2)));
}
