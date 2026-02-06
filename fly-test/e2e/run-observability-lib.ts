import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export function proxyHostForIp(ip: string): string {
  if (ip.includes(":")) return `[${ip}]`;
  return ip;
}

export function hostFromUrl(url: string): string {
  const parsed = new URL(url);
  return parsed.host;
}

export function urlEncodedForm(data: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) params.set(key, value);
  return params.toString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

export function readFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export async function fetchWithDnsFallback(
  run: (
    command: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv; allowFailure?: boolean },
  ) => CommandResult,
  url: string,
  outputPath: string,
  stderrPath: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const result = run("curl", ["-fsS", "--max-time", "25", url], { allowFailure: true });
    if (result.status === 0) {
      writeFileSync(outputPath, result.stdout);
      writeFileSync(stderrPath, result.stderr);
      return;
    }
    await sleep(1000);
  }

  const host = hostFromUrl(url).split(":")[0];
  const dns = run("dig", ["+short", host, "@1.1.1.1"], { allowFailure: true });
  const ip = dns.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!ip) throw new Error(`DNS lookup failed for ${host}`);

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const result = run(
      "curl",
      ["-fsS", "--max-time", "25", "--resolve", `${host}:443:${ip}`, url],
      { allowFailure: true },
    );
    if (result.status === 0) {
      writeFileSync(outputPath, result.stdout);
      writeFileSync(stderrPath, result.stderr);
      return;
    }
    await sleep(1000);
  }
  throw new Error(`unable to fetch URL: ${url}`);
}

export async function postFormWithDnsFallback(
  run: (
    command: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv; allowFailure?: boolean },
  ) => CommandResult,
  url: string,
  body: string,
  outputPath: string,
  stderrPath: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const result = run("curl", ["-sS", "--max-time", "75", "--data", body, url], {
      allowFailure: true,
    });
    if (result.status === 0) {
      writeFileSync(outputPath, result.stdout);
      writeFileSync(stderrPath, result.stderr);
      return;
    }
    await sleep(1000);
  }

  const host = hostFromUrl(url).split(":")[0];
  const dns = run("dig", ["+short", host, "@1.1.1.1"], { allowFailure: true });
  const ip = dns.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!ip) throw new Error(`DNS lookup failed for ${host}`);

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const result = run(
      "curl",
      ["-sS", "--max-time", "75", "--resolve", `${host}:443:${ip}`, "--data", body, url],
      { allowFailure: true },
    );
    if (result.status === 0) {
      writeFileSync(outputPath, result.stdout);
      writeFileSync(stderrPath, result.stderr);
      return;
    }
    await sleep(1000);
  }
  throw new Error(`unable to post form: ${url}`);
}
