import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AlphaGateInputError, evaluateAlphaGate, type AlphaGateReport } from "./gate.js";
import { materializeAlphaGateManifest } from "./manifest-evidence.js";

export interface AlphaGateCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export async function runAlphaGateCli(arguments_: string[], io: AlphaGateCliIo): Promise<number> {
  try {
    const unknownOption = arguments_.find((argument) => argument.startsWith("--") && argument !== "--json");
    if (unknownOption) {
      throw new AlphaGateInputError("UNKNOWN_OPTION", `Unknown option: ${unknownOption}`);
    }
    const manifestPath = arguments_.find((argument) => !argument.startsWith("--"))
      ?? "benchmarks/alpha-gate/manifest.json";
    const resolvedManifestPath = resolve(manifestPath);
    const source = await readFile(resolvedManifestPath, "utf8");
    const manifest = await materializeAlphaGateManifest(JSON.parse(source) as unknown, {
      baseDirectory: dirname(resolvedManifestPath),
    });
    const report = evaluateAlphaGate(manifest);
    io.stdout(arguments_.includes("--json")
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderAlphaGateReport(report));
    return report.status === "passed" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Alpha Gate input error: ${message}\n`);
    return 2;
  }
}

export function renderAlphaGateReport(report: AlphaGateReport): string {
  const metric = report.metrics;
  const lines = [
    `AgentCut Alpha Gate: ${report.status.replaceAll("_", " ").toUpperCase()}`,
    `Authorized projects: ${metric.authorizedProjects.value}/${metric.authorizedProjects.required}`,
    `Reviewed and exported: ${metric.reviewedAndExportedProjects.value}/${metric.reviewedAndExportedProjects.required}`,
    `High-risk auto-deletes: ${metric.highRiskAutoDeleted.value}`,
    `definite_remove precision: ${formatRatio(metric.definiteRemovePrecision.value)}`,
    `Boundary usability: ${formatRatio(metric.boundaryUsability.value)}`,
    `Paired timing projects: ${metric.medianTimeReduction.pairedProjects}/${metric.authorizedProjects.required}`,
    `Distinct timing operators: ${metric.operatorCoverage.distinctOperators}/${metric.operatorCoverage.required}`,
    `Median active-time reduction: ${formatRatio(metric.medianTimeReduction.value)}`,
  ];
  for (const [kind, correctness] of Object.entries(metric.correctness)) {
    lines.push(
      `${kind} correctness: ${correctness.passed}/${correctness.evaluated} `
      + `across ${correctness.coveredProjects}/${metric.authorizedProjects.value} projects`,
    );
  }
  if (report.issues.length > 0) {
    lines.push("", "Open issues:");
    for (const candidate of report.issues) {
      lines.push(`- [${candidate.status}] ${candidate.code}: ${candidate.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatRatio(value: number | undefined): string {
  return value === undefined ? "not measured" : `${(value * 100).toFixed(2)}%`;
}
