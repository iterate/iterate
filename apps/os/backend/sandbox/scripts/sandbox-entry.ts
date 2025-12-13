#!/opt/node24/bin/node
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

interface SharedArgs {
  sessionDir: string;
}

interface InitArgs extends SharedArgs {
  githubRepoUrl: string;
  githubToken: string;
  checkoutTarget: string;
  isCommitHash: boolean;
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
 * Ensure pnpm is installed, installing it if necessary
 */
async function ensurePnpmInstalled(): Promise<void> {
  console.error("=== Checking for pnpm ===");
  const pnpmResult = await execCommand("pnpm", ["--version"]);
  if (pnpmResult.exitCode !== 0) {
    console.error("=== Installing pnpm ===");
    const installResult = await execCommand("npm", ["install", "-g", "corepack@latest"]);
    if (installResult.exitCode !== 0) {
      console.error("=== Failed to install pnpm ===");
      process.exit(1);
    }
    const corepackResult = await execCommand("corepack", ["enable", "pnpm"]);
    if (corepackResult.exitCode !== 0) {
      console.error("=== Failed to enable pnpm ===");
      process.exit(1);
    }
  }
}

/**
 * Main entry
 */
async function main() {
  const subCommand = process.argv[2];
  if (subCommand === "init") {
    const args = parseInitArgs();
    return subcommandInit(args);
  }

  if (subCommand === "install-dependencies") {
    await ensurePnpmInstalled();
    const args = parseInstallDependenciesArgs();
    return subcommandInstallDependencies(args);
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

// Run the main function
main().catch((error) => {
  const errorMsg = error instanceof Error ? error.message : "Unknown error";
  console.error(`FATAL ERROR: ${errorMsg}`);
  process.exit(1);
});
