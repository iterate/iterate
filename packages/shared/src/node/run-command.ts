import { spawn } from "node:child_process";

const POST_EXIT_OUTPUT_QUIET_MS = 250;
const POST_EXIT_OUTPUT_MAX_MS = 1_000;

type RunCommandResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

export async function runCommand(params: {
  args: string[];
  command: string;
  echoOutput?: boolean;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  workingDirectory: string;
}) {
  return await new Promise<RunCommandResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let exitCode: number | null = null;
    let exited = false;
    let settled = false;
    let quietTimer: NodeJS.Timeout | undefined;
    let maximumDrainTimer: NodeJS.Timeout | undefined;
    const child = spawn(params.command, params.args, {
      cwd: params.workingDirectory,
      env: params.environment,
      signal: params.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const clearDrainTimers = () => {
      clearTimeout(quietTimer);
      clearTimeout(maximumDrainTimer);
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearDrainTimers();
      resolve({
        exitCode: code,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      });
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearDrainTimers();
      reject(error);
    };
    const finishAfterOutputDrain = () => {
      child.stdout.destroy();
      child.stderr.destroy();
      finish(exitCode);
    };
    const resetQuietTimer = () => {
      if (!exited) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finishAfterOutputDrain, POST_EXIT_OUTPUT_QUIET_MS);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(Buffer.from(chunk));
      if (params.echoOutput !== false) process.stdout.write(chunk);
      resetQuietTimer();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(Buffer.from(chunk));
      if (params.echoOutput !== false) process.stderr.write(chunk);
      resetQuietTimer();
    });
    child.on("error", fail);
    child.on("exit", (code) => {
      exitCode = code;
      exited = true;

      // A detached descendant can inherit these pipes after the command we
      // launched has exited. Node's `close` event then waits for that unrelated
      // process, making a completed command appear to run indefinitely. Drain
      // ordinary buffered tail output, but bound how long inherited writers can
      // delay the result.
      resetQuietTimer();
      maximumDrainTimer = setTimeout(finishAfterOutputDrain, POST_EXIT_OUTPUT_MAX_MS);
    });
    child.on("close", (exitCode) => {
      finish(exitCode);
    });
  });
}
