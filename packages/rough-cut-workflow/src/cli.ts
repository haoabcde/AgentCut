export interface RoughCutCliArguments {
  sourcePath: string;
  projectRoot: string;
  name?: string;
  alphaTrial: boolean;
}

export function parseRoughCutCliArguments(args: readonly string[]): RoughCutCliArguments {
  const sources: string[] = [];
  let projectRoot: string | undefined;
  let name: string | undefined;
  let alphaTrial = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--" && index === 0) {
      continue;
    } else if (argument === "--project") {
      projectRoot = requiredValue(args, ++index, "--project");
    } else if (argument === "--name") {
      name = requiredValue(args, ++index, "--name");
    } else if (argument === "--alpha-trial") {
      alphaTrial = true;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown roughcut option ${argument}`);
    } else {
      sources.push(argument);
    }
  }
  if (sources.length !== 1) {
    throw new Error("roughcut requires exactly one source video");
  }
  if (!projectRoot) {
    throw new Error("roughcut requires --project <project-directory>");
  }
  return {
    sourcePath: sources[0]!,
    projectRoot,
    alphaTrial,
    ...(name ? { name } : {}),
  };
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
