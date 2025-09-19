import { getSandbox } from "@cloudflare/sandbox";
import { typeid } from "typeid-js";
import type { CloudflareEnv } from "../../env.ts";

export interface RunConfigOptions {
  githubRepoUrl: string;
  githubToken: string;
  commitHash?: string;
  branch?: string;
  workingDirectory?: string;
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
  const { githubRepoUrl, githubToken, commitHash, branch, workingDirectory } = options;

  // Get sandbox instance
  const sandboxId = typeid("build").toString();
  const sandbox = getSandbox(env.SANDBOX, sandboxId);

  // Clone the repository using the provided token
  const cloneCommand = `git clone https://${githubToken}@${githubRepoUrl.replace("https://", "")} /tmp/repo`;
  const cloneResult = await sandbox.exec(cloneCommand);

  if (cloneResult.exitCode !== 0) {
    return {
      error: "Failed to clone repository",
      details: cloneResult.stderr,
    };
  }

  // Checkout specific branch or commit
  if (branch) {
    // Checkout the branch
    const checkoutCommand = `cd /tmp/repo && git checkout ${branch}`;
    const checkoutResult = await sandbox.exec(checkoutCommand);

    if (checkoutResult.exitCode !== 0) {
      return {
        error: "Failed to checkout branch",
        details: checkoutResult.stderr,
        commitHash: branch,
      };
    }

    // If a specific commit hash is also provided, checkout that commit on the branch
    if (commitHash) {
      const checkoutCommitCommand = `cd /tmp/repo && git checkout ${commitHash}`;
      const checkoutCommitResult = await sandbox.exec(checkoutCommitCommand);

      if (checkoutCommitResult.exitCode !== 0) {
        return {
          error: "Failed to checkout commit",
          details: checkoutCommitResult.stderr,
          commitHash,
        };
      }
    }
  } else if (commitHash) {
    // Only checkout commit if no branch specified
    const checkoutCommand = `cd /tmp/repo && git checkout ${commitHash}`;
    const checkoutResult = await sandbox.exec(checkoutCommand);

    if (checkoutResult.exitCode !== 0) {
      return {
        error: "Failed to checkout commit",
        details: checkoutResult.stderr,
        commitHash,
      };
    }
  }

  // Determine the actual working directory
  const repoPath = workingDirectory ? `/tmp/repo/${workingDirectory}` : "/tmp/repo";

  // Verify the working directory exists
  const checkDirCommand = `test -d ${repoPath}`;
  const checkDirResult = await sandbox.exec(checkDirCommand);

  if (checkDirResult.exitCode !== 0) {
    return {
      error: "Working directory not found",
      details: `Directory ${workingDirectory} does not exist in the repository`,
    };
  }

  // Install dependencies first (suppress output)
  const installCommand = `cd ${repoPath} && pnpm i --silent`;
  const installResult = await sandbox.exec(installCommand);

  if (installResult.exitCode !== 0) {
    return {
      error: "Failed to install dependencies",
      details: installResult.stderr,
    };
  }

  // Run pnpm iterate (will use Node 24 by default)
  const iterateCommand = `cd ${repoPath} && pnpm iterate`;
  const iterateResult = await sandbox.exec(iterateCommand);

  return {
    success: true,
    message: "Build completed successfully",
    output: {
      stdout: iterateResult.stdout,
      stderr: iterateResult.stderr,
      exitCode: iterateResult.exitCode,
    },
  };
}
