import { getSandbox, parseSSEStream } from "@cloudflare/sandbox";
import { match, P } from "ts-pattern";
import type { CloudflareEnv } from "../../env.ts";
import { logger } from "../tag-logger.ts";

export interface RunConfigOptions {
  githubRepoUrl: string;
  githubToken: string;
  commitHash?: string;
  branch?: string;
  connectedRepoPath?: string;
  callbackUrl?: string;
  buildId?: string;
  estateId?: string;
}

export interface RunConfigResult {
  success: boolean;
  message: string;
  output: {
    stdout: string;
    stderr: string;
    exitCode: number;
  };
}

export interface RunConfigError {
  error: string;
  details?: string;
  commitHash?: string;
}

/**
 * Runs a configuration build in a sandboxed environment
 */

export async function runConfigInSandbox(
  env: CloudflareEnv,
  options: RunConfigOptions,
): Promise<RunConfigResult | RunConfigError> {
  try {
    return await runConfigInSandboxInternal(env, options);
  } catch (error) {
    logger.error("Error running config in sandbox:", error);
    return {
      error: "Internal server error during build",
      details: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function runConfigInSandboxInternal(
  env: CloudflareEnv,
  options: RunConfigOptions,
): Promise<RunConfigResult | RunConfigError> {
  const {
    githubRepoUrl,
    githubToken,
    commitHash,
    branch,
    connectedRepoPath,
    callbackUrl,
    estateId,
  } = options;

  // Retrieve the sandbox
  const sandboxId = `agent-sandbox-${estateId}`;
  const sandbox = getSandbox(env.SANDBOX, sandboxId);

  // Ensure that the session directory exists
  const sessionId = estateId;
  // IMPORTANT: Randomize the session dir so build always works with the clean repo
  const sessionDir = `/tmp/session-${estateId}-${Math.random().toString().slice(2)}`;
  await sandbox.mkdir(sessionDir, { recursive: true });

  // Create an isolated session
  let sandboxSession: ReturnType<typeof sandbox.createSession>;
  try {
    sandboxSession = await sandbox.createSession({
      id: sessionId,
      cwd: sessionDir,
      isolation: true,
    });
  } catch {
    // If the session creation fails, get existing session
    sandboxSession = await sandbox.getSession(sessionId!);
  }

  // Determine the checkout target and whether it's a commit hash
  const checkoutTarget = commitHash || branch || "main";
  const isCommitHash = Boolean(commitHash);

  // Prepare arguments as a JSON object
  const initArgs = {
    sessionDir,
    githubRepoUrl,
    githubToken,
    checkoutTarget,
    isCommitHash,
  };
  // Escape the JSON string for shell
  const initJsonArgs = JSON.stringify(initArgs).replace(/'/g, "'\\''");
  // Init the sandbox (ignore any errors)
  const nodePath = "/opt/node24/bin/node";

  const commandInit = `${nodePath} /tmp/sandbox-entry.ts init '${initJsonArgs}'`;
  const stream = await sandboxSession.execStream(commandInit, {
    timeout: 360 * 1000, // 360 seconds total timeout
  });
  let result: { exitCode: number } | undefined;
  for await (const event of parseSSEStream(stream)) {
    match(event)
      .with({ type: "stdout", data: P.any }, (ev) =>
        logger.info(ev.data, "sandbox_stdout", { sandboxId }),
      )
      .with({ type: "stderr", data: P.any }, (ev) =>
        logger.info(ev.data, "sandbox_stderr", { sandboxId }),
      )
      .with({ type: "complete", exitCode: P.number }, (ev) => {
        logger.info(ev.exitCode, "complete", { sandboxId });
        result = ev;
      })
      .with({ type: "error", error: P.any }, (ev) =>
        logger.error(`Sandbox ${sandboxId} error`, ev.error),
      );
  }
  if (result?.exitCode !== 0) {
    logger.error(
      JSON.stringify({
        message: `Error running \`${nodePath} /tmp/sandbox-entry.ts init <ARGS>\` in sandbox`,
        result,
      }),
    );
  }

  // Prepare arguments as a JSON object
  const buildArgs = {
    // Ensure we use a clean clone
    sessionDir,
    connectedRepoPath,
    callbackUrl: callbackUrl || "",
    buildId: options.buildId || "",
    estateId,
  };
  // Escape the JSON string for shell
  const buildJsonArgs = JSON.stringify(buildArgs).replace(/'/g, "'\\''");
  // Run the build in sandbox
  const commandBuild = `${nodePath} /tmp/sandbox-entry.ts build '${buildJsonArgs}'`;
  const resultBuild = await sandboxSession.exec(commandBuild, {
    timeout: 360 * 1000, // 360 seconds total timeout
  });

  if (!resultBuild.success) {
    logger.error(
      JSON.stringify({
        message: `Error running \`${nodePath} /tmp/sandbox-entry.ts build <ARGS>\` in sandbox`,
        result: resultBuild,
      }),
    );
  }

  // If callback URL is provided, the script will handle the callback
  // Otherwise, return the result directly
  if (callbackUrl) {
    // When using callback, we just return a simple acknowledgment
    return {
      success: true,
      message: "Build started, results will be sent to callback",
      output: {
        stdout: "Build process initiated",
        stderr: "",
        exitCode: 0,
      },
    };
  }

  // Return the result directly if no callback
  return {
    success: resultBuild.success,
    message: resultBuild.success ? "Build completed successfully" : "Build failed",
    output: {
      stdout: resultBuild.stdout,
      stderr: resultBuild.stderr,
      exitCode: resultBuild.exitCode,
    },
  };
}
