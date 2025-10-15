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
import path from "path";

interface SharedArgs {
  sessionDir: string;
}

interface InitArgs extends SharedArgs {
  githubRepoUrl: string;
  githubToken: string;
  checkoutTarget: string;
  isCommitHash: boolean;
}

interface BuildArgs extends SharedArgs {
  connectedRepoPath?: string;
  callbackUrl: string;
  buildId: string;
  estateId: string;
}

interface BuildCallbackPayload {
  buildId: string;
  estateId: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Parse command line arguments, expects JSON string containing args as the second argument
 */
function parseInitArgs(): InitArgs {
  const jsonArg = process.argv[3];
  if (!jsonArg) {
    throw new Error("Missing JSON arguments");
  }
  try {
    const parsed = JSON.parse(jsonArg) as InitArgs;
    const args = {
      sessionDir: parsed.sessionDir || "",
      githubRepoUrl: parsed.githubRepoUrl || "",
      githubToken: parsed.githubToken || "",
      checkoutTarget: parsed.checkoutTarget || "main",
      isCommitHash: parsed.isCommitHash || false,
    };
    return args;
  } catch (error) {
    throw new Error(
      `Failed to parse JSON arguments: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

function parseInstallDependenciesArgs(): { sessionDir: string } {
  const jsonArg = process.argv[3];
  if (!jsonArg) {
    throw new Error("Missing JSON arguments");
  }
  try {
    const parsed = JSON.parse(jsonArg) as { sessionDir: string };
    return parsed;
  } catch (error) {
    throw new Error(
      `Failed to parse JSON arguments: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Parse command line arguments, expects JSON string containing args as the second argument
 */
function parseBuildArgs(): BuildArgs {
  const jsonArg = process.argv[3];
  if (!jsonArg) {
    throw new Error("Missing JSON arguments");
  }
  try {
    const parsed = JSON.parse(jsonArg) as BuildArgs;
    const args = {
      sessionDir: parsed.sessionDir || "",
      connectedRepoPath: parsed.connectedRepoPath || "",
      callbackUrl: parsed.callbackUrl || "",
      buildId: parsed.buildId || "",
      estateId: parsed.estateId || "",
    };
    return args;
  } catch (error) {
    throw new Error(
      `Failed to parse JSON arguments: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Send callback to the specified URL using built-in fetch
 */
async function sendBuildCallback(
  args: BuildArgs,
  success: boolean,
  stdout: string,
  stderr: string,
  exitCode: number,
): Promise<void> {
  if (!args.callbackUrl) {
    return;
  }

  const payload: BuildCallbackPayload = {
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
  options: { cwd?: string; stdin?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      shell: false, // Don't use shell to avoid deprecation warning
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });

    if (options.stdin !== undefined && proc.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }

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
  const subCommand = process.argv[2];
  if (subCommand === "init") {
    const args = parseInitArgs();
    return subcommandInit(args);
  }
  if (subCommand === "install-dependencies") {
    const args = parseInstallDependenciesArgs();
    return subcommandInstallDependencies(args);
  }
  if (subCommand === "build") {
    const args = parseBuildArgs();
    return subcommandBuild(args);
  }
}

async function subcommandInit(args: InitArgs) {
  if (!args.sessionDir) {
    const errorMsg = "sessionDir is missing";
    console.error(`ERROR: ${errorMsg}`);
    process.exit(1);
  }

  const repoDir = args.sessionDir;

  console.error("=== Starting sandbox init ===");
  console.error(`Repository: ${args.githubRepoUrl}`);
  console.error(`Checkout target: ${args.checkoutTarget}`);
  console.error(`Repo directory: ${repoDir}`);
  console.error("");

  try {
    // Configure GitHub CLI authentication
    console.error("=== Configuring GitHub CLI ===");
    const authResult = await execCommand("gh", ["auth", "login", "--with-token"], {
      stdin: args.githubToken,
    });

    if (authResult.exitCode !== 0) {
      const errorMsg = "Failed to authenticate GitHub CLI";
      console.error(`ERROR: ${errorMsg}`);
      console.error(authResult.stderr);
      process.exit(1);
    }

    // Configure git with the credential from gh
    await execCommand("gh", ["auth", "setup-git"]);

    // Check if repo directory already exists and is not empty
    let shouldClone = true;
    if (await directoryExists(repoDir)) {
      const lsResult = await execCommand("ls", ["-A", repoDir]);
      if (lsResult.stdout.trim()) {
        shouldClone = false;
      }
    }

    if (!shouldClone) {
      // Clone the repository using gh (optimized: combine clone + checkout when possible)
      console.error("=== Repository already present ===");
    } else {
      // Clone the repository using gh (optimized: combine clone + checkout when possible)
      console.error("=== Cloning repository ===");

      // Build clone arguments with optimizations
      const cloneArgs = ["repo", "clone", args.githubRepoUrl, repoDir];

      // For branches/tags, use shallow clone and combine with checkout
      // For commit hashes, we need full history (or at least more depth)
      if (!args.isCommitHash && args.checkoutTarget && args.checkoutTarget !== "main") {
        cloneArgs.push("--", "--depth", "1", "--branch", args.checkoutTarget);
        console.error(`Cloning and checking out ${args.checkoutTarget} in single operation`);
      } else if (!args.isCommitHash) {
        // Default branch with shallow clone
        cloneArgs.push("--", "--depth", "1");
      }
      // For commit hashes, clone without depth restriction

      const cloneResult = await execCommand("gh", cloneArgs);

      if (cloneResult.exitCode !== 0) {
        const errorMsg = "Failed to clone repository";
        console.error(`ERROR: ${errorMsg}`);
        console.error(cloneResult.stderr);
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
          process.exit(1);
        }
      }
    }
  } catch (error) {
    // Catch any unexpected errors
    const errorMsg = error instanceof Error ? error.message : "Unknown error occurred";
    console.error(`ERROR: ${errorMsg}`);
    process.exit(1);
  }
}
async function subcommandInstallDependencies({ sessionDir }: { sessionDir: string }) {
  // Install dependencies (optimized: prefer offline cache for speed)
  console.error("=== Installing dependencies ===");
  const installResult = await execCommand("pnpm", ["i", "--prefer-offline"], {
    cwd: sessionDir,
  });

  if (installResult.exitCode !== 0) {
    const errorMsg = "Failed to install dependencies";
    const fullError = [installResult.stdout, installResult.stderr].filter(Boolean).join("\n");
    console.error(`ERROR: ${errorMsg}`);
    console.error(fullError);
    process.exit(installResult.exitCode);
  }
}

async function subcommandBuild(args: BuildArgs) {
  if (!args.sessionDir) {
    const errorMsg = "sessionDir is missing";
    console.error(`ERROR: ${errorMsg}`);
    await sendBuildCallback(args, false, "", errorMsg, 1);
    process.exit(1);
  }

  const repoDir = args.sessionDir;
  const workDir = args.connectedRepoPath
    ? path.join(args.sessionDir, args.connectedRepoPath)
    : args.sessionDir;

  console.error("=== Starting building process ===");
  console.error(`Repo directory: ${repoDir}`);
  console.error(`Work directory: ${workDir}`);
  if (args.callbackUrl) {
    console.error(`Callback URL: ${args.callbackUrl}`);
  }
  console.error("");

  try {
    // Verify work directory exists (provides better error messages)
    if (!(await directoryExists(workDir))) {
      const errorMsg = `Work directory ${workDir} does not exist`;
      console.error(`ERROR: ${errorMsg}`);
      await sendBuildCallback(args, false, "", errorMsg, 1);
      process.exit(1);
    }

    // Install dependencies (optimized: prefer offline cache for speed)
    console.error("=== Installing dependencies ===");
    const installResult = await execCommand("pnpm", ["i", "--prefer-offline"], {
      cwd: workDir,
    });

    if (installResult.exitCode !== 0) {
      const errorMsg = "Failed to install dependencies";
      const fullError = [installResult.stdout, installResult.stderr].filter(Boolean).join("\n");
      console.error(`ERROR: ${errorMsg}`);
      console.error(fullError);
      await sendBuildCallback(args, false, "", errorMsg + "\n" + fullError, installResult.exitCode);
      process.exit(installResult.exitCode);
    }

    // Run pnpm iterate
    console.error("=== Running pnpm iterate ===");
    const iterateResult = await execCommand("pnpm", ["iterate"], { cwd: workDir });

    if (iterateResult.exitCode === 0) {
      // Success
      console.log(iterateResult.stdout);
      await sendBuildCallback(args, true, iterateResult.stdout, "", 0);
      process.exit(0);
    } else {
      // Failure
      const errorMsg = `pnpm iterate failed with exit code ${iterateResult.exitCode}`;
      console.error(`ERROR: ${errorMsg}`);
      console.error(iterateResult.stderr);
      await sendBuildCallback(args, false, "", iterateResult.stderr, iterateResult.exitCode);
      process.exit(iterateResult.exitCode);
    }
  } catch (error) {
    // Catch any unexpected errors
    const errorMsg = error instanceof Error ? error.message : "Unknown error occurred";
    console.error(`ERROR: ${errorMsg}`);
    await sendBuildCallback(args, false, "", errorMsg, 1);
    process.exit(1);
  }
}

// Ensure callback is sent even if the process is killed
process.on("SIGINT", async () => {
  const subCommand = process.argv[2];
  if (subCommand === "build") {
    const args = parseBuildArgs();
    await sendBuildCallback(args, false, "", "Process interrupted (SIGINT)", 130);
  }
  process.exit(130);
});

process.on("SIGTERM", async () => {
  const subCommand = process.argv[2];
  if (subCommand === "build") {
    const args = parseBuildArgs();
    await sendBuildCallback(args, false, "", "Process terminated (SIGTERM)", 143);
  }
  process.exit(143);
});

process.on("uncaughtException", async (error) => {
  const subCommand = process.argv[2];
  if (subCommand === "build") {
    const args = parseBuildArgs();
    await sendBuildCallback(args, false, "", `Uncaught exception: ${error.message}`, 1);
  }
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const subCommand = process.argv[2];
  if (subCommand === "build") {
    const args = parseBuildArgs();
    const errorMsg = reason instanceof Error ? reason.message : String(reason);
    await sendBuildCallback(args, false, "", `Unhandled rejection: ${errorMsg}`, 1);
  }
  process.exit(1);
});

// Run the main function
main().catch(async (error) => {
  const subCommand = process.argv[2];
  const errorMsg = error instanceof Error ? error.message : "Unknown error";
  console.error(`FATAL ERROR: ${errorMsg}`);
  if (subCommand === "build") {
    const args = parseBuildArgs();
    await sendBuildCallback(args, false, "", errorMsg, 1);
  }
  process.exit(1);
});
