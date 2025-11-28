import { spawn } from "node:child_process";
import path from "node:path";
import * as fs from "node:fs";

export type EnqueueFn = (stream: "stdout" | "stderr", message: string) => void;

export async function execCommand(
  command: string,
  args: string[],
  options: { cwd?: string; stdin?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      shell: false,
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    if (options.stdin !== undefined && proc.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    proc.on("error", (error) =>
      resolve({ stdout, stderr: stderr + "\n" + error.message, exitCode: 1 }),
    );
  });
}

export async function setupRepo(opts: {
  sessionDir: string;
  githubRepoUrl: string;
  githubToken: string;
  checkoutTarget: string;
  isCommitHash: boolean;
  workDir: string;
  enqueue?: EnqueueFn;
}) {
  const { sessionDir, githubRepoUrl, githubToken, checkoutTarget, isCommitHash, workDir } = opts;
  const enqueue = opts.enqueue ?? (() => {});
  const safeCwd = path.dirname(sessionDir);

  enqueue("stdout", `Configuring GitHub CLI (/usr/bin/gh)\n`);
  const auth = await execCommand("/usr/bin/gh", ["auth", "login", "--with-token"], {
    stdin: githubToken,
    cwd: safeCwd,
  });
  if (auth.exitCode !== 0) throw new Error(`Failed to auth gh: ${auth.stderr}`);
  await execCommand("/usr/bin/gh", ["auth", "setup-git"], { cwd: safeCwd });

  // Always fresh clone into sessionDir
  enqueue("stdout", `Cloning repository into ${sessionDir}\n`);
  const cloneArgs = ["repo", "clone", githubRepoUrl, sessionDir];
  if (!isCommitHash && checkoutTarget && checkoutTarget !== "main") {
    cloneArgs.push("--", "--depth", "1", "--branch", checkoutTarget);
  } else if (!isCommitHash) {
    cloneArgs.push("--", "--depth", "1");
  }
  const clone = await execCommand("/usr/bin/gh", cloneArgs, { cwd: safeCwd });
  if (clone.exitCode !== 0) throw new Error(`Clone failed: ${clone.stderr}`);
  if (isCommitHash) {
    const co = await execCommand("git", ["checkout", checkoutTarget], { cwd: sessionDir });
    if (co.exitCode !== 0) throw new Error(`Checkout failed: ${co.stderr}`);
  }

  const gitFilesOutput = await execCommand("git", ["ls-files"], { cwd: sessionDir });
  enqueue("stdout", `> git ls-files\n\n${gitFilesOutput.stdout}\n`);
  const files = await Promise.all(
    gitFilesOutput.stdout
      .trim()
      .split("\n")
      .map(async (file) => {
        const fullPath = path.join(sessionDir, file);
        const stat = await fs.promises.stat(fullPath);
        if (stat.isDirectory()) {
          return [];
        }
        const content = await fs.promises.readFile(fullPath, "utf8");
        return [{ path: file, content }];
      }),
  ).then((files) => files.flat());

  enqueue("stdout", "Installing dependencies\n");
  const install = await execCommand("pnpm", ["i", "--prefer-offline"], { cwd: workDir });
  if (install.exitCode !== 0)
    throw new Error(
      `Install failed (exit code ${install.exitCode}): ${install.stderr} / ${install.stdout}`,
    );
  return { files };
}
