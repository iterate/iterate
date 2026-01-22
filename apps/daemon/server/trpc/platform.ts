import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { simpleGit } from "simple-git";
import { quote } from "shell-quote";
import { x } from "tinyexec";
import { getTmuxSocketPath } from "../tmux-control.ts";
import { pub } from "./init.ts";

// Store for platform-injected env vars
const platformEnvVars: Record<string, string> = {};

// Store for cloned repos status
const clonedReposStatus: Map<
  string,
  {
    status: "pending" | "cloning" | "cloned" | "error";
    error?: string;
  }
> = new Map();

/**
 * Apply environment variables to the daemon process and tmux sessions.
 * This function:
 * 1. Replaces vars in memory and process.env (removes stale keys)
 * 2. Writes them to ~/.iterate/.env file
 * 3. Sources the file in all active tmux sessions
 */
export async function applyEnvVars(vars: Record<string, string>): Promise<{
  injectedCount: number;
  removedCount: number;
  envFilePath: string;
}> {
  const envFilePath = join(homedir(), ".iterate/.env");

  // Find keys to remove (were in platformEnvVars but not in new vars)
  const keysToRemove = Object.keys(platformEnvVars).filter((key) => !(key in vars));

  // Remove stale keys from process.env and platformEnvVars
  for (const key of keysToRemove) {
    delete process.env[key];
    delete platformEnvVars[key];
  }

  // Clear platformEnvVars and replace with new vars
  for (const key of Object.keys(platformEnvVars)) {
    delete platformEnvVars[key];
  }
  Object.assign(platformEnvVars, vars);
  Object.assign(process.env, vars);

  console.log(
    `[platform] Applied ${Object.keys(vars).length} env vars, removed ${keysToRemove.length} stale`,
  );

  // Write env vars to a file that tmux sessions can source
  const envFileContent = Object.entries(platformEnvVars)
    .map(([key, value]) => `export ${key}=${quote([value])}`)
    .join("\n");
  mkdirSync(dirname(envFilePath), { recursive: true });
  writeFileSync(envFilePath, envFileContent, { mode: 0o600 });

  // Refresh tmux sessions with new env vars (using the daemon's tmux socket)
  const tmuxSocket = getTmuxSocketPath();
  const listResult = await x("tmux", ["-S", tmuxSocket, "list-sessions", "-F", "#{session_name}"]);
  const sessions = listResult.stdout.trim().split("\n").filter(Boolean);

  if (sessions.length > 0) {
    // Send source command to each session in parallel
    await Promise.all(
      sessions.map((session) =>
        x(
          "tmux",
          ["-S", tmuxSocket, "send-keys", "-t", session, `source ${envFilePath}`, "Enter"],
          {
            throwOnError: true,
          },
        ),
      ),
    );
    console.log(`[platform] Refreshed env vars in ${sessions.length} tmux sessions`);
  }

  return {
    injectedCount: Object.keys(vars).length,
    removedCount: keysToRemove.length,
    envFilePath,
  };
}

/**
 * Clear any existing GitHub URL rewrites from git config and logout from gh CLI.
 * Called when GitHub is disconnected or before setting a new token.
 */
export async function clearGitHubCredentials(): Promise<void> {
  const git = simpleGit();

  try {
    const config = await git.listConfig("global");
    const githubUrlKeys = Object.keys(config.all).filter(
      (key) => key.startsWith("url.https://x-access-token:") && key.includes("github.com"),
    );
    for (const key of githubUrlKeys) {
      // Remove the .insteadOf suffix to get the section name for --unset
      const sectionKey = key.replace(/\.insteadof$/i, ".insteadOf");
      await git.raw(["config", "--global", "--unset", sectionKey]).catch(() => {
        // Ignore errors if key doesn't exist
      });
    }
    if (githubUrlKeys.length > 0) {
      console.log(
        `[platform] Cleared ${githubUrlKeys.length} stale GitHub credentials from git config`,
      );
    }
  } catch {
    // Ignore errors reading config
  }

  // Logout from gh CLI (best-effort - don't fail credential setup if logout fails)
  try {
    await x("gh", ["auth", "logout", "-h", "github.com", "--yes"], { throwOnError: true });
    console.log("[platform] Logged out of gh CLI");
  } catch (err) {
    console.warn("[platform] gh auth logout failed (may not be logged in):", err);
  }
}

/**
 * Configure git to use a GitHub access token for authentication.
 * Uses URL rewrite so all https://github.com/ URLs automatically use the token.
 * Also authenticates the `gh` CLI with the same token.
 * Clears any previous tokens to avoid accumulating stale entries.
 */
export async function configureGitHubCredential(token: string): Promise<void> {
  const git = simpleGit();

  // Clear any existing GitHub URL rewrites (tokens rotate hourly)
  await clearGitHubCredentials();

  // Set new URL rewrite: https://github.com/ -> https://x-access-token:TOKEN@github.com/
  await git.addConfig(
    `url.https://x-access-token:${token}@github.com/.insteadOf`,
    "https://github.com/",
    false, // not append
    "global",
  );
  console.log("[platform] Configured git credential helper for GitHub");

  // Authenticate gh CLI with the same token
  const proc = x("gh", ["auth", "login", "--with-token"], { throwOnError: true });
  if (!proc.process?.stdin) {
    throw new Error("Failed to get stdin for gh auth login process");
  }
  proc.process.stdin.write(token);
  proc.process.stdin.end();
  await proc;
  console.log("[platform] Authenticated gh CLI with GitHub token");
}

export type RepoInfo = {
  url: string;
  branch: string;
  path: string;
  owner: string;
  name: string;
};

/**
 * Clone repositories. Called directly by bootstrap-refresh.ts.
 * Cloning happens asynchronously in the background.
 */
export function cloneRepos(repos: RepoInfo[]): void {
  for (const repo of repos) {
    const repoKey = `${repo.owner}/${repo.name}`;
    const expandedPath = repo.path.replace("~", homedir());
    const existing = clonedReposStatus.get(repoKey);

    // Skip if already cloning to prevent concurrent git operations
    if (existing?.status === "cloning") {
      console.log(`[platform] Skipping ${repoKey} - already cloning`);
      continue;
    }

    clonedReposStatus.set(repoKey, { status: "cloning" });

    // Clone in background
    cloneRepo(repo.url, expandedPath, repo.branch)
      .then(() => {
        clonedReposStatus.set(repoKey, { status: "cloned" });
        console.log(`[platform] Cloned ${repoKey} to ${expandedPath}`);
      })
      .catch((err) => {
        clonedReposStatus.set(repoKey, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        console.error(`[platform] Failed to clone ${repoKey}:`, err);
      });
  }
}

/**
 * Clone a repository to the specified path.
 * Uses simple-git to avoid shell injection vulnerabilities.
 */
async function cloneRepo(url: string, targetPath: string, branch: string): Promise<void> {
  // Create parent directory if needed
  const parentDir = dirname(targetPath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  // If directory exists and has .git, update remote URL (fresh token) then fetch + reset
  if (existsSync(join(targetPath, ".git"))) {
    console.log(`[platform] Repo already exists at ${targetPath}, updating...`);
    const git = simpleGit(targetPath);
    // Update remote URL to use fresh token (GitHub tokens expire after 1 hour)
    await git.remote(["set-url", "origin", url]);
    await git.fetch("origin", branch);
    await git.reset(["--hard", `origin/${branch}`]);
    return;
  }

  // If directory exists but isn't a git repo, remove it
  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true });
  }

  // Clone the repo - try with branch first, fall back to default branch for empty repos
  const git = simpleGit();
  try {
    await git.clone(url, targetPath, ["--branch", branch, "--single-branch"]);
  } catch {
    // Clean up any partial clone before retry
    if (existsSync(targetPath)) {
      rmSync(targetPath, { recursive: true, force: true });
    }

    // If branch clone failed, try without --branch (handles empty repos or missing branches)
    console.log(`[platform] Branch clone failed, trying without --branch flag...`);
    try {
      await git.clone(url, targetPath);
    } catch (fallbackErr) {
      // Clean up partial state from failed fallback clone to prevent corrupt retry state
      if (existsSync(targetPath)) {
        rmSync(targetPath, { recursive: true, force: true });
      }
      throw fallbackErr;
    }
  }
}

export const platformRouter = {
  /**
   * Trigger an immediate refresh of bootstrap data from the control plane.
   * Called by the control plane after events like Slack OAuth to notify the daemon
   * that new env vars or tokens are available.
   */
  refreshEnv: pub.handler(async () => {
    // Import dynamically to avoid circular dependencies
    const { fetchBootstrapData } = await import("../bootstrap-refresh.ts");
    try {
      await fetchBootstrapData();
      return { success: true };
    } catch (err) {
      console.error("[platform] Failed to refresh env:", err);
      return { success: false };
    }
  }),
};

export type PlatformRouter = typeof platformRouter;
