import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { exec } from "tinyexec";
import { loadConfig } from "../config-loader.ts";
import { createWorkerClient } from "../orpc/client.ts";
import { publicProcedure } from "../orpc/init.ts";
import { reconcilePidnapProcesses } from "../pidnap/reconcile.ts";

const DEFAULT_CONFIG_DIR = path.join(
  homedir(),
  "src",
  "github.com",
  "iterate",
  "iterate",
  "repo-templates",
  "default",
);

type ConfigRepo = Awaited<
  ReturnType<ReturnType<typeof createWorkerClient>["machines"]["getConfigRepo"]>
>["configRepo"];

function getRepoPath(repo: NonNullable<ConfigRepo>): string {
  return path.join(homedir(), "src", "github.com", repo.owner, repo.name);
}

async function runGit(args: string[], options?: { cwd?: string }): Promise<void> {
  await exec("git", args, {
    nodeOptions: {
      cwd: options?.cwd,
      timeout: 120_000,
      env: process.env,
    },
  });
}

async function installConfigRepoDependencies(repoPath: string): Promise<void> {
  await exec("pnpm", ["install"], {
    nodeOptions: {
      cwd: repoPath,
      timeout: 300_000,
      env: process.env,
    },
  });
}

async function cloneOrPullConfigRepo(configRepo: NonNullable<ConfigRepo>): Promise<string> {
  const repoPath = getRepoPath(configRepo);
  await mkdir(path.dirname(repoPath), { recursive: true });
  const gitDir = path.join(repoPath, ".git");

  if (!existsSync(gitDir)) {
    await runGit([
      "clone",
      "--branch",
      configRepo.branch,
      "--single-branch",
      configRepo.cloneUrl,
      repoPath,
    ]);
    return repoPath;
  }

  await runGit(["remote", "set-url", "origin", configRepo.cloneUrl], {
    cwd: repoPath,
  });
  await runGit(["fetch", "origin", configRepo.branch], {
    cwd: repoPath,
  });
  await runGit(["checkout", configRepo.branch], { cwd: repoPath });
  await runGit(["reset", "--hard", `origin/${configRepo.branch}`], {
    cwd: repoPath,
  });

  return repoPath;
}

async function loadAndReconcileConfig(configPath: string): Promise<void> {
  await loadConfig(configPath, { forceReload: true });
  await reconcilePidnapProcesses({ configCwd: configPath });
}

export async function reloadConfigRepo(): Promise<{
  usedConfigRepo: boolean;
  configPath: string;
}> {
  const machineId = process.env.ITERATE_MACHINE_ID;
  if (!machineId || !process.env.ITERATE_OS_BASE_URL || !process.env.ITERATE_OS_API_KEY) {
    await loadAndReconcileConfig(DEFAULT_CONFIG_DIR);
    return {
      usedConfigRepo: false,
      configPath: DEFAULT_CONFIG_DIR,
    };
  }

  const workerClient = createWorkerClient();
  const response = await workerClient.machines.getConfigRepo({ machineId });

  if (!response.configRepo) {
    await loadAndReconcileConfig(DEFAULT_CONFIG_DIR);
    return {
      usedConfigRepo: false,
      configPath: DEFAULT_CONFIG_DIR,
    };
  }

  const repoPath = await cloneOrPullConfigRepo(response.configRepo);
  await installConfigRepoDependencies(repoPath);
  await loadAndReconcileConfig(repoPath);

  return {
    usedConfigRepo: true,
    configPath: repoPath,
  };
}

export const configRepoOrpcRouter = {
  reload: publicProcedure.handler(async () => {
    const result = await reloadConfigRepo();
    return { success: true, ...result };
  }),
};
