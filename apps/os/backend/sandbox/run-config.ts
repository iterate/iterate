import { getSandbox } from "@cloudflare/sandbox";
import type { CloudflareEnv } from "../../env.ts";
import { logger as console } from "../tag-logger.ts";

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
    console.error("Error running config in sandbox:", error);
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

  // Compute IDs
  const sandboxId = `agent-sandbox-${estateId}`;
  const sessionId = estateId;
  const sessionDir = `/tmp/session-${estateId}`;

  // Retrieve the sandbox
  const sandbox = getSandbox(env.SANDBOX, sandboxId);

  // Ensure that the session directory exists
  await sandbox.mkdir(sessionDir, { recursive: true });

  // Create an isolated session
  const sandboxSession = await sandbox.createSession({
    id: sessionId,
    cwd: sessionDir,
    isolation: true,
  });

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
  const commandInit = `node /tmp/sandbox-entry.ts init '${initJsonArgs}'`;
  await sandboxSession.exec(commandInit, {
    timeout: 360 * 1000, // 360 seconds total timeout
  });

  // Prepare arguments as a JSON object
  const buildArgs = {
    sessionDir,
    connectedRepoPath,
    callbackUrl: callbackUrl || "",
    buildId: options.buildId || "",
    estateId,
  };
  // Escape the JSON string for shell
  const buildJsonArgs = JSON.stringify(buildArgs).replace(/'/g, "'\\''");
  // Run the build in sandbox
  const commandBuild = `node /tmp/sandbox-entry.ts build '${buildJsonArgs}'`;
  const resultBuild = await sandboxSession.exec(commandBuild, {
    timeout: 360 * 1000, // 360 seconds total timeout
  });

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
    success: resultBuild.exitCode === 0,
    message: resultBuild.exitCode === 0 ? "Build completed successfully" : "Build failed",
    output: {
      stdout: resultBuild.stdout,
      stderr: resultBuild.stderr,
      exitCode: resultBuild.exitCode,
    },
  };
}
