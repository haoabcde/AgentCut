import type { AgentCutProjectDocument } from "@agentcut/timeline-schema";
import { comparePlanToReadback } from "./compare.js";
import { buildExportPlan, type BuildPlanOptions } from "./plan.js";
import { readOtioFile, writeOtioFile } from "./python.js";
import type { LossReport } from "./types.js";

export const ADAPTER_VERSION = "0.1.0";

export interface ExportTimelineOptions extends BuildPlanOptions {
  outPath: string;
  /** 报告时间戳（测试可注入固定值）。 */
  clock?: (() => string) | undefined;
}

export interface ExportTimelineResult {
  otioPath: string;
  lossReport: LossReport;
  lossReportMarkdown: string;
}

/**
 * IR document → OTIO 文件 + loss report + 官方库 round-trip 验证。
 * 首版只导出（docs/19 P4）；导入作为第二优先级。
 */
export function exportTimeline(
  document: AgentCutProjectDocument,
  options: ExportTimelineOptions,
): ExportTimelineResult {
  const { plan, losses } = buildExportPlan(document, options);
  const otioVersion = writeOtioFile(plan, options.outPath);
  const readback = readOtioFile(options.outPath);
  const verification = comparePlanToReadback(plan, readback);
  const lossReport: LossReport = {
    adapter: "@agentcut/otio-interop",
    adapterVersion: ADAPTER_VERSION,
    otioVersion,
    exportedAt: (options.clock ?? (() => new Date().toISOString()))(),
    project: {
      id: document.project.id,
      revision: document.project.revision,
      sequenceId: plan.metadata.sequenceId as string,
    },
    losses,
    verification,
  };
  return {
    otioPath: options.outPath,
    lossReport,
    lossReportMarkdown: renderLossReportMarkdown(lossReport),
  };
}

export function renderLossReportMarkdown(report: LossReport): string {
  const lines = [
    `# OTIO export loss report — ${report.project.id} (rev ${report.project.revision})`,
    "",
    `- adapter: ${report.adapter}@${report.adapterVersion}`,
    `- OTIO (official library): ${report.otioVersion}`,
    `- exportedAt: ${report.exportedAt}`,
    `- round-trip (via official parser): **${report.verification.status}**`,
    "",
  ];
  if (report.losses.length === 0) {
    lines.push("No losses: every exported element round-trips; nothing unmapped was dropped.", "");
  } else {
    lines.push("| Category | Severity | Count | Detail |", "|---|---|---:|---|");
    for (const loss of report.losses) {
      lines.push(`| ${loss.category} | ${loss.severity} | ${loss.count} | ${loss.detail} |`);
    }
    lines.push("");
  }
  if (report.verification.status === "diverged") {
    lines.push("## Round-trip divergences", "");
    for (const divergence of report.verification.divergences) {
      lines.push(`- \`${divergence.path}\`: plan=${JSON.stringify(divergence.plan)} readback=${JSON.stringify(divergence.readback)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
