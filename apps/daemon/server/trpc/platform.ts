import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { z } from "zod/v4";
import { simpleGit } from "simple-git";
import { quote } from "shell-quote";
import { x } from "tinyexec";
import { createTRPCRouter, publicProcedure } from "./init.ts";

// Store for platform-injected env vars
const platformEnvVars: Record<string, string> = {};

// Store for cloned repos status
const clonedRepos: Array<{
  owner: string;
  name: string;
  path: string;
  branch: string;
  status: "pending" | "cloning" | "cloned" | "error";
  error?: string;
}> = [];

export const platformRouter = createTRPCRouter({
  /**
   * Inject environment variables from the platform.
   * These are stored and can be retrieved via GET.
   */
  setEnvVars: publicProcedure
    .input(
      z.object({
        vars: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
      }),
    )
    .mutation(async ({ input }) => {
      const envFilePath = join(homedir(), ".iterate/.env");
      const { vars } = input;

      Object.assign(platformEnvVars, vars);
      Object.assign(process.env, vars);

      console.log(`[platform] Injected ${Object.keys(vars).length} env vars to ${envFilePath}`);

      // Write env vars to a file that tmux sessions can source
      const envFileContent = Object.entries(platformEnvVars)
        .map(([key, value]) => `export ${key}=${quote([value])}`)
        .join("\n");
      mkdirSync(dirname(envFilePath), { recursive: true });
      writeFileSync(envFilePath, envFileContent, { mode: 0o600 });

      // Refresh tmux sessions with new env vars
      const listResult = await x("tmux", ["list-sessions", "-F", "#{session_name}"]);
      const sessions = listResult.stdout.trim().split("\n").filter(Boolean);

      if (sessions.length > 0) {
        // Send source command to each session in parallel
        await Promise.all(
          sessions.map((session) =>
            x("tmux", ["send-keys", "-t", session, `source ${envFilePath}`, "Enter"], {
              throwOnError: true,
            }),
          ),
        );
        console.log(`[platform] Refreshed env vars in ${sessions.length} tmux sessions`);
      }

      return {
        success: true,
        injectedCount: Object.keys(vars).length,
        envFilePath,
      };
    }),

  /**
   * Clone repositories from the platform.
   * Cloning happens asynchronously.
   */
  cloneRepos: publicProcedure
    .input(
      z.object({
        repos: z.array(
          z.object({
            url: z.string(),
            branch: z.string(),
            path: z.string(),
            owner: z.string(),
            name: z.string(),
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      const { repos } = input;

      // Add repos to tracking (skip if already cloning to prevent concurrent operations)
      for (const repo of repos) {
        const expandedPath = repo.path.replace("~", homedir());
        const existing = clonedRepos.find((r) => r.owner === repo.owner && r.name === repo.name);
        if (existing) {
          // Skip if already cloning to prevent concurrent git operations
          if (existing.status === "cloning") {
            console.log(`[platform] Skipping ${repo.owner}/${repo.name} - already cloning`);
            continue;
          }
          existing.status = "pending";
          existing.path = expandedPath;
          existing.branch = repo.branch;
          existing.error = undefined;
        } else {
          clonedRepos.push({
            owner: repo.owner,
            name: repo.name,
            path: expandedPath,
            branch: repo.branch,
            status: "pending",
          });
        }
      }

      // Clone repos asynchronously
      for (const repo of repos) {
        const expandedPath = repo.path.replace("~", homedir());
        const repoEntry = clonedRepos.find((r) => r.owner === repo.owner && r.name === repo.name);
        // Skip if not found or already cloning (status wasn't set to pending above)
        if (!repoEntry || repoEntry.status === "cloning") continue;

        repoEntry.status = "cloning";

        // Clone in background
        cloneRepo(repo.url, expandedPath, repo.branch)
          .then(() => {
            repoEntry.status = "cloned";
            console.log(`[platform] Cloned ${repo.owner}/${repo.name} to ${expandedPath}`);
          })
          .catch((err) => {
            repoEntry.status = "error";
            repoEntry.error = err instanceof Error ? err.message : String(err);
            console.error(`[platform] Failed to clone ${repo.owner}/${repo.name}:`, err);
          });
      }

      return {
        success: true,
        repos: clonedRepos.map((r) => ({
          owner: r.owner,
          name: r.name,
          status: r.status,
        })),
      };
    }),
});

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

export type PlatformRouter = typeof platformRouter;
