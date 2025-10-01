import { getSandbox } from "@cloudflare/sandbox";
import { typeid } from "typeid-js";
import type { CloudflareEnv } from "../../env.ts";
import { logger as console } from "../tag-logger.ts";

export interface RunConfigOptions {
  githubRepoUrl: string;
  githubToken: string;
  commitHash?: string;
  branch?: string;
  workingDirectory?: string;
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
  const { githubRepoUrl, githubToken, commitHash, branch, workingDirectory, callbackUrl } = options;

  // Get sandbox instance
  const sandboxId = typeid("build").toString();
  const sandbox = getSandbox(env.SANDBOX, sandboxId);

  // Determine the checkout target and whether it's a commit hash
  const checkoutTarget = commitHash || branch || "main";
  const isCommitHash = Boolean(commitHash);

  // Prepare arguments as a JSON object
  const buildArgs = {
    githubRepoUrl,
    githubToken,
    checkoutTarget,
    isCommitHash,
    workingDir: workingDirectory || "",
    callbackUrl: callbackUrl || "",
    buildId: options.buildId || "",
    estateId: options.estateId || "",
  };

  // Escape the JSON string for shell
  const jsonArgs = JSON.stringify(buildArgs).replace(/'/g, "'\\''");

  // Run the Node.js script with JSON arguments
  const command = `node /tmp/build-script.ts '${jsonArgs}'`;

  // Execute the script
  const result = await sandbox.exec(command, {
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
    success: result.exitCode === 0,
    message: result.exitCode === 0 ? "Build completed successfully" : "Build failed",
    output: {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    },
  };
}
