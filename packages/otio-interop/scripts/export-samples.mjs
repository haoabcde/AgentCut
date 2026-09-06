#!/usr/bin/env node
// Regenerates the reviewable sample exports in packages/otio-interop/samples/.
// Run after `pnpm build` — the script imports the compiled dist on purpose so the
// samples always reflect what consumers of the package actually get.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportTimeline } from "../dist/export.js";
import { buildTenMinuteProject } from "../dist/fixture-10min.js";
import { otioAvailability } from "../dist/python.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(packageRoot, "samples");

const { available, version } = otioAvailability();
if (!available) {
  console.error("opentimelineio is not installed. Run: python3 -m pip install --user opentimelineio");
  process.exit(3);
}

mkdirSync(outDir, { recursive: true });
const minimal = JSON.parse(readFileSync(
  new URL("../../timeline-schema/fixtures/minimal-project.json", import.meta.url),
  "utf8",
));

const documents = [
  ["minimal-project", minimal],
  ["ten-minute", buildTenMinuteProject()],
];

for (const [label, document] of documents) {
  const result = exportTimeline(document, { outPath: join(outDir, `${label}.otio`) });
  writeFileSync(join(outDir, `${label}.loss-report.md`), result.lossReportMarkdown);
  writeFileSync(join(outDir, `${label}.loss-report.json`), `${JSON.stringify(result.lossReport, null, 2)}\n`);
  console.info(
    `${label}: round-trip ${result.lossReport.verification.status}, `
    + `${result.lossReport.losses.length} loss categories -> ${result.otioPath}`,
  );
}
console.info(`OTIO official library: ${version}`);
