import { spawn } from "node:child_process";

/** Spawn a command, optionally feed it stdin, and collect its result. */
export function run(command: string, args: string[], stdin?: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    // A signal-killed child reports a null code; surface that as a failure, not 0.
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}
