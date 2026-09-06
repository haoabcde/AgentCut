import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExportPlan, NormalizedTimeline } from "./types.js";

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../tools");
const OTIO_INSTALL_HINT =
  "opentimelineio (official library) is not installed. Run: python3 -m pip install --user opentimelineio";

let cachedOtioVersion: string | null | undefined;

/** 官方 OTIO 库是否可用；不可用时集成测试应显式 skip（与 ffmpeg 矩阵同一模式）。 */
export function otioAvailability(): { available: boolean; version: string | null } {
  if (cachedOtioVersion !== undefined) {
    return { available: cachedOtioVersion !== null, version: cachedOtioVersion };
  }
  try {
    cachedOtioVersion = execFileSync(
      "python3",
      ["-c", "import opentimelineio as otio; print(otio.__version__)"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    cachedOtioVersion = null;
  }
  return { available: cachedOtioVersion !== null, version: cachedOtioVersion };
}

/** 用官方库把 export plan 序列化为 .otio 文件；返回官方库版本号。 */
export function writeOtioFile(plan: ExportPlan, outPath: string): string {
  const { available, version } = otioAvailability();
  if (!available || !version) throw new Error(OTIO_INSTALL_HINT);
  const directory = mkdtempSync(join(tmpdir(), "agentcut-otio-plan-"));
  try {
    const planPath = join(directory, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan));
    execFileSync("python3", [join(TOOLS_DIR, "otio_write.py"), planPath, outPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return version;
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    throw new Error(`OTIO write failed: ${stderr ? String(stderr).trim() : String(error)}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** 用官方库读回 .otio 文件并归一化（round-trip 验证的输入）。 */
export function readOtioFile(otioPath: string): NormalizedTimeline {
  const { available } = otioAvailability();
  if (!available) throw new Error(OTIO_INSTALL_HINT);
  try {
    const output = execFileSync("python3", [join(TOOLS_DIR, "otio_read.py"), otioPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(output) as NormalizedTimeline;
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    throw new Error(`OTIO read failed: ${stderr ? String(stderr).trim() : String(error)}`);
  }
}
