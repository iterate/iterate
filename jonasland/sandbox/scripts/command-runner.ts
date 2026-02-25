import { execFileSync } from "node:child_process";

type CommandRunOptions = {
  cwd: string;
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
};

export function runCommand(command: string, args: string[], options: CommandRunOptions): string {
  if (options.quiet) {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf-8",
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  return "";
}

export function createCommandRunner(cwd: string) {
  const run = (command: string, args: string[], options?: Omit<CommandRunOptions, "cwd">): string =>
    runCommand(command, args, { cwd, ...options });

  const runQuiet = (command: string, args: string[]): string => run(command, args, { quiet: true });

  const runJson = <T>(command: string, args: string[]): T => {
    const out = run(command, args, { quiet: true });
    return JSON.parse(out) as T;
  };

  return { run, runQuiet, runJson };
}
