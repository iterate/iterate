#!/usr/bin/env node
/* eslint-disable no-console -- Console statements are required for script output to stdout/stderr */
/**
 * Build script that clones a GitHub repository, installs dependencies,
 * runs pnpm iterate, and sends a callback with the results.
 *
 * This script uses only Node.js built-in modules (no external dependencies). If we add those we need to add a bundling step.
 * It ALWAYS calls the callback, even on error.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import { access, constants } from "fs/promises";

interface BuildArgs {
  githubRepoUrl: string;
  githubToken: string;
  checkoutTarget: string;
  isCommitHash: boolean;
  workingDir: string;
  callbackUrl: string;
  buildId: string;
  estateId: string;
}

interface CallbackPayload {
  buildId: string;
  estateId: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Parse command line arguments, expects:
 *   - subCommand as the first argument
 *   - JSON string containing args as the second argument
 */
function parseArgs(): [string, BuildArgs] {
  const subCommand = process.argv[2];
  const jsonArg = process.argv[3];

  if (!jsonArg) {
    throw new Error("Missing JSON arguments");
  }

  try {
    const parsed = JSON.parse(jsonArg) as BuildArgs;
    const args = {
      githubRepoUrl: parsed.githubRepoUrl || "",
      githubToken: parsed.githubToken || "",
      checkoutTarget: parsed.checkoutTarget || "main",
      isCommitHash: parsed.isCommitHash || false,
      workingDir: parsed.workingDir || "",
      callbackUrl: parsed.callbackUrl || "",
      buildId: parsed.buildId || "",
      estateId: parsed.estateId || "",
    };
    return [subCommand, args];
  } catch (error) {
    throw new Error(
      `Failed to parse JSON arguments: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Send callback to the specified URL using built-in fetch
 */
async function sendCallback(
  args: BuildArgs,
  success: boolean,
  stdout: string,
  stderr: string,
  exitCode: number,
): Promise<void> {
  if (!args.callbackUrl) {
    return;
  }

  const payload: CallbackPayload = {
    buildId: args.buildId,
    estateId: args.estateId,
    success,
    stdout,
    stderr,
    exitCode,
  };

  console.error(`=== Sending callback to: ${args.callbackUrl} ===`);
  console.error("=== Sending callback request ===");

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(args.callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const responseText = await response.text();
    console.error(`[CALLBACK_RESPONSE]: ${responseText}`);
    console.error(`[HTTP_STATUS]: ${response.status}`);
    console.error("=== Callback completed ===");
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        console.error("[CALLBACK_ERROR]: Request timeout");
      } else {
        console.error(`[CALLBACK_ERROR]: ${error.message}`);
      }
    } else {
      console.error(`[CALLBACK_ERROR]: Unknown error`);
    }
    console.error("=== Callback failed but continuing ===");
  }
}

/**
 * Execute a command and return output (without shell to avoid deprecation warnings)
 */
function execCommand(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      shell: false, // Don't use shell to avoid deprecation warning
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (error) => {
      resolve({
        stdout,
        stderr: stderr + "\n" + error.message,
        exitCode: 1,
      });
    });
  });
}

/**
 * Check if a directory exists
 */
async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Main build process
 */
async function main() {
  const [subCommand, args] = parseArgs();
  if (subCommand === "init") {
    return subcommandInit(args);
  }
  if (subCommand === "build") {
    return subcommandBuild(args);
  }
  if (subCommand === "commit-and-push") {
    return subcommandCommitAndPush(args);
  }
}

async function subcommandInit(args: BuildArgs) {
  if (!args.workingDir) {
    const errorMsg = "workingDir is missing";
    console.error(`ERROR: ${errorMsg}`);
    await sendCallback(args, false, "", errorMsg, 1);
    process.exit(1);
  }

  const workingDir = args.workingDir;
  const repoDir = `${workingDir}/repo`;

  console.error("=== Starting sandbox init ===");
  console.error(`Repository: ${args.githubRepoUrl}`);
  console.error(`Checkout target: ${args.checkoutTarget}`);
  console.error(`Working directory: ${workingDir}`);
  if (args.callbackUrl) {
    console.error(`Callback URL: ${args.callbackUrl}`);
  }
  console.error("");

  try {
    // Clone the repository (optimized: combine clone + checkout when possible)
    console.error("=== Cloning repository ===");
    const repoPathFromUrl = args.githubRepoUrl.replace(/^https:\/\//, "");
    const cloneUrl = `https://x-access-token:${args.githubToken}@${repoPathFromUrl}`;

    // Build clone arguments with optimizations
    const cloneArgs = ["clone"];

    // For branches/tags, use shallow clone and combine with checkout
    // For commit hashes, we need full history (or at least more depth)
    if (!args.isCommitHash && args.checkoutTarget && args.checkoutTarget !== "main") {
      cloneArgs.push("--depth", "1");
      cloneArgs.push("--branch", args.checkoutTarget);
      console.error(`Cloning and checking out ${args.checkoutTarget} in single operation`);
    } else if (!args.isCommitHash) {
      // Default branch with shallow clone
      cloneArgs.push("--depth", "1");
    }
    // For commit hashes, clone without depth restriction

    cloneArgs.push(cloneUrl, repoDir);

    const cloneResult = await execCommand("git", cloneArgs);

    if (cloneResult.exitCode !== 0) {
      const errorMsg = "Failed to clone repository";
      console.error(`ERROR: ${errorMsg}`);
      console.error(cloneResult.stderr);
      await sendCallback(args, false, "", errorMsg + "\n" + cloneResult.stderr, 1);
      process.exit(1);
    }

    // If checkout target is a commit hash, checkout after cloning
    if (args.isCommitHash) {
      console.error(`=== Checking out commit ${args.checkoutTarget} ===`);
      const checkoutResult = await execCommand("git", ["checkout", args.checkoutTarget], {
        cwd: repoDir,
      });

      if (checkoutResult.exitCode !== 0) {
        const errorMsg = `Failed to checkout commit ${args.checkoutTarget}`;
        console.error(`ERROR: ${errorMsg}`);
        console.error(checkoutResult.stderr);
        await sendCallback(args, false, "", errorMsg + "\n" + checkoutResult.stderr, 1);
        process.exit(1);
      }
    }
  } catch (error) {
    // Catch any unexpected errors
    const errorMsg = error instanceof Error ? error.message : "Unknown error occurred";
    console.error(`ERROR: ${errorMsg}`);
    await sendCallback(args, false, "", errorMsg, 1);
    process.exit(1);
  }
}

async function subcommandBuild(args: BuildArgs) {
  if (!args.workingDir) {
    const errorMsg = "workingDir is missing";
    console.error(`ERROR: ${errorMsg}`);
    await sendCallback(args, false, "", errorMsg, 1);
    process.exit(1);
  }

  const workingDir = args.workingDir;
  const repoDir = `${workingDir}/repo`;

  console.error("=== Starting build process ===");
  console.error(`Repository: ${args.githubRepoUrl}`);
  console.error(`Checkout target: ${args.checkoutTarget}`);
  console.error(`Working directory: ${workingDir}`);
  if (args.callbackUrl) {
    console.error(`Callback URL: ${args.callbackUrl}`);
  }
  console.error("");

  try {
    // Verify working directory exists (provides better error messages)
    if (!(await directoryExists(repoDir))) {
      const errorMsg = `Repo directory ${repoDir} does not exist`;
      console.error(`ERROR: ${errorMsg}`);
      await sendCallback(args, false, "", errorMsg, 1);
      process.exit(1);
    }

    // Install dependencies (optimized: prefer offline cache for speed)
    console.error("=== Installing dependencies ===");
    const installResult = await execCommand("pnpm", ["i", "--prefer-offline"], {
      cwd: repoDir,
    });

    if (installResult.exitCode !== 0) {
      const errorMsg = "Failed to install dependencies";
      const fullError = [installResult.stdout, installResult.stderr].filter(Boolean).join("\n");
      console.error(`ERROR: ${errorMsg}`);
      console.error(fullError);
      await sendCallback(args, false, "", errorMsg + "\n" + fullError, installResult.exitCode);
      process.exit(installResult.exitCode);
    }

    // Run pnpm iterate
    console.error("=== Running pnpm iterate ===");
    const iterateResult = await execCommand("pnpm", ["iterate"], { cwd: repoDir });

    if (iterateResult.exitCode === 0) {
      // Success
      console.log(iterateResult.stdout);
      await sendCallback(args, true, iterateResult.stdout, "", 0);
      process.exit(0);
    } else {
      // Failure
      const errorMsg = `pnpm iterate failed with exit code ${iterateResult.exitCode}`;
      console.error(`ERROR: ${errorMsg}`);
      console.error(iterateResult.stderr);
      await sendCallback(args, false, "", iterateResult.stderr, iterateResult.exitCode);
      process.exit(iterateResult.exitCode);
    }
  } catch (error) {
    // Catch any unexpected errors
    const errorMsg = error instanceof Error ? error.message : "Unknown error occurred";
    console.error(`ERROR: ${errorMsg}`);
    await sendCallback(args, false, "", errorMsg, 1);
    process.exit(1);
  }
}

async function subcommandCommitAndPush(args: BuildArgs) {
  if (!args.workingDir) {
    const errorMsg = "workingDir is missing";
    console.error(`ERROR: ${errorMsg}`);
    await sendCallback(args, false, "", errorMsg, 1);
    process.exit(1);
  }

  const workingDir = args.workingDir;
  const repoDir = `${workingDir}/repo`;

  console.error("=== Starting commit and push process ===");
  console.error(`Working directory: ${workingDir}`);
  console.error("");

  try {
    // Verify working directory exists
    if (!(await directoryExists(repoDir))) {
      const errorMsg = `Repo directory ${repoDir} does not exist`;
      console.error(`ERROR: ${errorMsg}`);
      await sendCallback(args, false, "", errorMsg, 1);
      process.exit(1);
    }

    // Check for changes using git status
    console.error("=== Checking for changes ===");
    const statusResult = await execCommand("git", ["status", "--porcelain"], {
      cwd: repoDir,
    });

    if (statusResult.exitCode !== 0) {
      const errorMsg = "Failed to check git status";
      console.error(`ERROR: ${errorMsg}`);
      console.error(statusResult.stderr);
      await sendCallback(
        args,
        false,
        "",
        errorMsg + "\n" + statusResult.stderr,
        statusResult.exitCode,
      );
      process.exit(statusResult.exitCode);
    }

    // If no changes, exit successfully
    if (!statusResult.stdout.trim()) {
      const msg = "No changes to commit";
      console.error(msg);
      console.log(msg);
      await sendCallback(args, true, msg, "", 0);
      process.exit(0);
    }

    console.error("Changes detected:");
    console.error(statusResult.stdout);

    // Add all changes
    console.error("=== Adding changes ===");
    const addResult = await execCommand("git", ["add", "."], {
      cwd: repoDir,
    });

    if (addResult.exitCode !== 0) {
      const errorMsg = "Failed to add changes";
      console.error(`ERROR: ${errorMsg}`);
      console.error(addResult.stderr);
      await sendCallback(args, false, "", errorMsg + "\n" + addResult.stderr, addResult.exitCode);
      process.exit(addResult.exitCode);
    }

    // Commit changes
    console.error("=== Committing changes ===");
    const commitResult = await execCommand(
      "git",
      ["commit", "-m", "Automated commit from sandbox"],
      {
        cwd: repoDir,
      },
    );

    if (commitResult.exitCode !== 0) {
      const errorMsg = "Failed to commit changes";
      console.error(`ERROR: ${errorMsg}`);
      console.error(commitResult.stderr);
      await sendCallback(
        args,
        false,
        "",
        errorMsg + "\n" + commitResult.stderr,
        commitResult.exitCode,
      );
      process.exit(commitResult.exitCode);
    }

    console.error("Commit successful");

    // Push changes
    console.error("=== Pushing changes ===");
    const pushResult = await execCommand("git", ["push"], {
      cwd: repoDir,
    });

    if (pushResult.exitCode === 0) {
      const successMsg = "Successfully committed and pushed changes";
      console.error(successMsg);
      console.log(successMsg);
      await sendCallback(args, true, successMsg, "", 0);
      process.exit(0);
    } else {
      const errorMsg = "Failed to push changes";
      console.error(`ERROR: ${errorMsg}`);
      console.error(pushResult.stderr);
      await sendCallback(args, false, "", errorMsg + "\n" + pushResult.stderr, pushResult.exitCode);
      process.exit(pushResult.exitCode);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error occurred";
    console.error(`ERROR: ${errorMsg}`);
    await sendCallback(args, false, "", errorMsg, 1);
    process.exit(1);
  }
}

// Ensure callback is sent even if the process is killed
process.on("SIGINT", async () => {
  const [_subCommand, args] = parseArgs();
  await sendCallback(args, false, "", "Process interrupted (SIGINT)", 130);
  process.exit(130);
});

process.on("SIGTERM", async () => {
  const [_subCommand, args] = parseArgs();
  await sendCallback(args, false, "", "Process terminated (SIGTERM)", 143);
  process.exit(143);
});

process.on("uncaughtException", async (error) => {
  const [_subCommand, args] = parseArgs();
  await sendCallback(args, false, "", `Uncaught exception: ${error.message}`, 1);
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const [_subCommand, args] = parseArgs();
  const errorMsg = reason instanceof Error ? reason.message : String(reason);
  await sendCallback(args, false, "", `Unhandled rejection: ${errorMsg}`, 1);
  process.exit(1);
});

// Run the main function
main().catch(async (error) => {
  const [_subCommand, args] = parseArgs();
  const errorMsg = error instanceof Error ? error.message : "Unknown error";
  console.error(`FATAL ERROR: ${errorMsg}`);
  await sendCallback(args, false, "", errorMsg, 1);
  process.exit(1);
});
