import { spawnSync } from "node:child_process";
import { join } from "node:path";

export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
): CommandResult {
  const result = spawnSync(command, args, {
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  const status = result.status ?? 1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (!options.allowFailure && status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        `status=${status}`,
        stdout.length > 0 ? `stdout:\n${stdout}` : "",
        stderr.length > 0 ? `stderr:\n${stderr}` : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    );
  }
  return { status, stdout, stderr };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function urlEncodedForm(data: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) params.set(key, value);
  return params.toString().replaceAll("'", "%27");
}

export function nowTag(): string {
  const date = new Date();
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

export function findFlyDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith("/fly-test")) return cwd;
  return join(cwd, "fly-test");
}
