import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExportPlan, NormalizedTimeline } from "./types.js";

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../tools");
const OTIO_INSTALL_HINT =
  "opentimelineio (official library) is not installed for the resolved Python. " +
  "Run: python3 -m pip install --user opentimelineio — or point AGENTCUT_OTIO_PYTHON at an interpreter that has it";

let cachedOtioVersion: string | null | undefined;

/** OTIO 官方库绑定的解释器：默认 PATH 上的 python3；多 Python 机器（如 otio 装在非 PATH 首个解释器）用 AGENTCUT_OTIO_PYTHON 显式指定。进程级缓存：环境变量须在进程启动前设置。 */
export function resolvePython(): string {
  return process.env.AGENTCUT_OTIO_PYTHON ?? "python3";
}

/** 官方 OTIO 库是否可用；不可用时集成测试应显式 skip（与 ffmpeg 矩阵同一模式）。 */
export function otioAvailability(): { available: boolean; version: string | null } {
  if (cachedOtioVersion !== undefined) {
    return { available: cachedOtioVersion !== null, version: cachedOtioVersion };
  }
  try {
    cachedOtioVersion = execFileSync(
      resolvePython(),
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
    execFileSync(resolvePython(), [join(TOOLS_DIR, "otio_write.py"), planPath, outPath], {
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
    const output = execFileSync(resolvePython(), [join(TOOLS_DIR, "otio_read.py"), otioPath], {
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
