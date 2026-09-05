import { runAlphaEvidenceCli } from "../packages/alpha-gate/dist/index.js";

process.exitCode = await runAlphaEvidenceCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
