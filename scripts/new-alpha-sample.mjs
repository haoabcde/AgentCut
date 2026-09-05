import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * 新 Alpha 正式样本建项辅助：
 *
 *   node scripts/new-alpha-sample.mjs <视频> --cohort-id <id> --name "正式样本 NN" \
 *     [--coverage-classes <逗号分隔>] [--project <目录>] [--dry-run]
 *
 * 职责（只做机器可验证的部分，不做授权判断）：
 * 1. 流式计算源视频 SHA-256，检查与现有 manifest 登记无重复素材/cohort 冲突；
 * 2. 生成授权记录文件的精确 cohort 标记行与内容模板（打印，不代写授权文件）；
 * 3. 用 `--alpha-trial` 建项并打印后续 runbook 顺序（--dry-run 跳过建项）。
 *
 * 授权边界：授权记录（docs/alpha-authorizations/<cohort-id>.md）必须由用户本人确认
 * 来源、授权范围与确认方式后落盘；本脚本只打印模板。collect 前该文件必须存在且包含
 * 独占一行 `<!-- agentcut-alpha-authorization: <cohort-id> <source-sha256> -->`。
 */

const ALLOWED_COVERAGE_CLASSES = [
  "mandarin",
  "accent",
  "code-switch",
  "proper-noun-number",
  "fast-speech",
  "background-music",
  "vfr",
  "screen-recording",
];

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(repositoryRoot, "benchmarks/alpha-gate/manifest.json");

function parseArguments(arguments_) {
  const positionals = [];
  let cohortId;
  let name;
  let projectRoot;
  let coverageRaw;
  let dryRun = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument.startsWith("--")) {
      const value = arguments_[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--cohort-id") cohortId = value;
      else if (argument === "--name") name = value;
      else if (argument === "--project") projectRoot = value;
      else if (argument === "--coverage-classes") coverageRaw = value;
      else throw new Error(`Unknown option ${argument}`);
    } else {
      positionals.push(argument);
    }
  }
  if (positionals.length !== 1) throw new Error("requires exactly one source video");
  if (!cohortId) throw new Error("requires --cohort-id <snake_case_id>");
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(cohortId)) {
    throw new Error("--cohort-id must use 1-100 lowercase letters, numbers, dots, underscores or hyphens");
  }
  const coverageClasses = coverageRaw === undefined ? [] : (() => {
    const classes = coverageRaw.split(",").map((item) => item.trim()).filter(Boolean);
    if (classes.length === 0) throw new Error("--coverage-classes must list at least one class");
    const unknown = classes.filter((item) => !ALLOWED_COVERAGE_CLASSES.includes(item));
    if (unknown.length > 0) {
      throw new Error(`--coverage-classes has unknown classes: ${unknown.join(", ")} (allowed: ${ALLOWED_COVERAGE_CLASSES.join(", ")})`);
    }
    return [...new Set(classes)].sort();
  })();
  return {
    sourcePath: resolve(positionals[0]),
    cohortId,
    name,
    projectRoot: projectRoot
      ? resolve(projectRoot)
      : resolve(repositoryRoot, ".agentcut", "dogfood", cohortId),
    coverageClasses,
    dryRun,
  };
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolveRead, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolveRead);
  });
  return `sha256:${hash.digest("hex")}`;
}

function registeredCohorts() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.projects)) throw new Error("Alpha manifest has no projects");
  return manifest.projects;
}

function checkRegistrationConflicts(sourceSha256, cohortId) {
  const duplicate = registeredCohorts().find((project) =>
    project.sourceSha256.toLowerCase() === sourceSha256.toLowerCase()
    && project.projectId !== cohortId,
  );
  if (duplicate) {
    throw new Error(
      `该素材已登记为 ${duplicate.projectId}；同一素材不能进入第二个 cohort`,
    );
  }
  const existing = registeredCohorts().find((project) => project.projectId === cohortId);
  if (existing && existing.sourceSha256.toLowerCase() !== sourceSha256.toLowerCase()) {
    throw new Error(`cohort ${cohortId} 已绑定另一素材 ${existing.sourceSha256}；请换用新的 --cohort-id`);
  }
  if (existing) {
    console.warn(`注意：${cohortId} 已在 manifest 中登记（同一素材续跑会按 resumed 处理）。`);
  }
}

const authorizationFilePath = (cohortId) =>
  resolve(repositoryRoot, "docs", "alpha-authorizations", `${cohortId}.md`);

function printAuthorizationTemplate({ cohortId, sourceSha256, sourceName, coverageClasses }) {
  const path = authorizationFilePath(cohortId);
  const coverageLine = coverageClasses.length > 0
    ? coverageClasses.join(", ")
    : `<${ALLOWED_COVERAGE_CLASSES.join(",")} 中如实选择>`;
  const template = [
    `# ${cohortId} 素材授权登记`,
    "",
    "- 素材来源：<用户本人 / 设计伙伴代号>",
    `- 素材文件：\`${sourceName}\``,
    "- 授权范围：Alpha 本地测试与评估（不上传媒体，不产生公开分发）",
    "- 确认方式：<聊天/邮件/口头+记录人>（必须属实）",
    `- 覆盖类别：${coverageLine}`,
    "",
    `<!-- agentcut-alpha-authorization: ${cohortId} ${sourceSha256} -->`,
    "",
  ].join("\n");
  if (existsSync(path)) {
    console.log(`授权记录文件已存在，请人工核对其中 cohort 标记行与素材 hash 一致：${path}`);
  } else {
    console.log(`授权记录文件尚未创建（需你本人确认后落盘），模板：${path}\n`);
    console.log(template);
  }
  console.log([
    "collect 固定顺序（内容取舍全部完成、初剪导出 quality passed、计时 finish 之后）：",
    `  pnpm alpha:collect .agentcut/dogfood/${cohortId} \\`,
    "    --manifest benchmarks/alpha-gate/manifest.json \\",
    `    --cohort-id ${cohortId} \\`,
    "    --authorization-basis user_supplied_for_testing \\",
    `    --authorization-evidence ../../docs/alpha-authorizations/${cohortId}.md \\`,
    ...(coverageClasses.length > 0
      ? [`    --coverage-classes ${coverageClasses.join(",")}`]
      : []),
  ].join("\n"));
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  if (!existsSync(input.sourcePath) || !statSync(input.sourcePath).isFile()) {
    throw new Error(`source video not found: ${input.sourcePath}`);
  }
  console.log(`计算源素材 SHA-256：${basename(input.sourcePath)}`);
  const sourceSha256 = await sha256File(input.sourcePath);
  console.log(`  ${sourceSha256}`);
  checkRegistrationConflicts(sourceSha256, input.cohortId);
  if (!input.dryRun) {
    console.log(`建项：${input.projectRoot}（--alpha-trial，同一素材重复运行按 resumed 处理）`);
    const result = spawnSync(
      process.execPath,
      [
        resolve(repositoryRoot, "scripts", "roughcut.mjs"),
        input.sourcePath,
        "--project",
        input.projectRoot,
        "--alpha-trial",
        ...(input.name ? ["--name", input.name] : []),
      ],
      {
        stdio: "inherit",
        env: process.env,
        cwd: repositoryRoot,
      },
    );
    if (result.status !== 0) {
      throw new Error(`roughcut exited with status ${result.status}`);
    }
    console.log(`\n下一步：pnpm studio -- ${input.projectRoot}`);
  } else {
    console.log(`（dry-run）将执行：node scripts/roughcut.mjs ${basename(input.sourcePath)} --project ${input.projectRoot} --alpha-trial${input.name ? ` --name "${input.name}"` : ""}`);
  }
  console.log("runbook 顺序：登记对照并开始计时 → 内容取舍 → 导出 quality passed → 暂停并完成计时 → 最终候选/边界标注 → alpha:collect\n");
  printAuthorizationTemplate({
    cohortId: input.cohortId,
    sourceSha256,
    sourceName: basename(input.sourcePath),
    coverageClasses: input.coverageClasses,
  });
}

main().catch((error) => {
  console.error(`new-alpha-sample input error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
