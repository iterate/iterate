import { spawn, execSync, type ExecSyncOptions } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

interface RepoConfig {
  owner: string;
  name: string;
  defaultBranch: string;
}

const SRC_BASE = `${homedir()}/src/github.com`;
const ITERATE_REPO_OWNER = "iterate";
const ITERATE_REPO_NAME = "iterate";
const ITERATE_REPO_PATH = `${SRC_BASE}/${ITERATE_REPO_OWNER}/${ITERATE_REPO_NAME}`;
const ITERATE_REPO_URL = `https://github.com/${ITERATE_REPO_OWNER}/${ITERATE_REPO_NAME}.git`;
const DAEMON_PATH = `${ITERATE_REPO_PATH}/apps/daemon2`;

const getRepoPath = (owner: string, name: string) => `${SRC_BASE}/${owner}/${name}`;

const getGitEnvWithToken = (owners: string[]): ExecSyncOptions["env"] => {
  const token = process.env.GITHUB_ACCESS_TOKEN;
  if (!token || owners.length === 0) return process.env;

  const uniqueOwners = [...new Set(owners)];
  const gitConfig: Record<string, string> = {
    ...process.env,
    GIT_CONFIG_COUNT: uniqueOwners.length.toString(),
  };

  uniqueOwners.forEach((owner, index) => {
    gitConfig[`GIT_CONFIG_KEY_${index}`] =
      `url.https://x-access-token:${token}@github.com/${owner}/.insteadOf`;
    gitConfig[`GIT_CONFIG_VALUE_${index}`] = `https://github.com/${owner}/`;
  });

  return gitConfig;
};

const cloneOrUpdateRepo = (repo: RepoConfig, gitEnv: ExecSyncOptions["env"]) => {
  const repoPath = getRepoPath(repo.owner, repo.name);
  const repoFullName = `${repo.owner}/${repo.name}`;
  const repoUrl = `https://github.com/${repoFullName}.git`;

  mkdirSync(dirname(repoPath), { recursive: true });

  if (existsSync(repoPath)) {
    console.log(`Repository ${repoFullName} already exists at ${repoPath}, pulling latest...`);
    execSync(`git fetch origin ${repo.defaultBranch}`, {
      cwd: repoPath,
      stdio: "inherit",
      env: gitEnv,
    });
    execSync(`git reset --hard origin/${repo.defaultBranch}`, { cwd: repoPath, stdio: "inherit" });
  } else {
    console.log(`Cloning ${repoFullName} to ${repoPath}...`);
    execSync(`git clone --branch ${repo.defaultBranch} ${repoUrl} ${repoPath}`, {
      stdio: "inherit",
      env: gitEnv,
    });
  }

  console.log(`Repository ${repoFullName} ready at ${repoPath}`);
};

const cloneUserRepos = () => {
  const reposJson = process.env.GITHUB_REPOS;
  if (!reposJson) {
    console.log("No GITHUB_REPOS found, skipping user repository clone");
    return;
  }

  const token = process.env.GITHUB_ACCESS_TOKEN;
  if (!token) {
    console.log("No GITHUB_ACCESS_TOKEN found, skipping user repository clone");
    return;
  }

  let repos: RepoConfig[];
  try {
    repos = JSON.parse(reposJson) as RepoConfig[];
  } catch {
    console.error("Failed to parse GITHUB_REPOS JSON:", reposJson);
    return;
  }

  if (repos.length === 0) {
    console.log("No repositories configured, skipping user repository clone");
    return;
  }

  const owners = repos.map((r) => r.owner);
  const gitEnv = getGitEnvWithToken(owners);

  for (const repo of repos) {
    cloneOrUpdateRepo(repo, gitEnv);
  }
};

const cloneAndSetupIterateRepo = () => {
  mkdirSync(dirname(ITERATE_REPO_PATH), { recursive: true });

  if (existsSync(ITERATE_REPO_PATH)) {
    console.log(`Iterate repository exists at ${ITERATE_REPO_PATH}, fetching latest...`);
    execSync("git fetch origin main", { cwd: ITERATE_REPO_PATH, stdio: "inherit" });
    execSync("git reset --hard origin/main", { cwd: ITERATE_REPO_PATH, stdio: "inherit" });
  } else {
    console.log(`Cloning ${ITERATE_REPO_URL} to ${ITERATE_REPO_PATH}...`);
    execSync(`git clone ${ITERATE_REPO_URL} ${ITERATE_REPO_PATH}`, { stdio: "inherit" });
  }

  console.log("Running pnpm install (should be fast if lockfile unchanged)...");
  execSync("pnpm install", { cwd: ITERATE_REPO_PATH, stdio: "inherit" });
};

const startDaemon = () => {
  console.log(`Building daemon in ${DAEMON_PATH}...`);
  execSync("npx vite build", { cwd: DAEMON_PATH, stdio: "inherit" });

  console.log(`Starting daemon server in ${DAEMON_PATH}...`);
  const daemon = spawn("node", ["dist/server/index.mjs"], {
    cwd: DAEMON_PATH,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: "3000",
    },
  });

  daemon.on("error", (err) => {
    console.error("Failed to start daemon:", err);
    process.exit(1);
  });

  daemon.on("exit", (code) => {
    console.log(`Daemon exited with code ${code}`);
    process.exit(code ?? 1);
  });

  return daemon;
};

const main = () => {
  cloneAndSetupIterateRepo();
  cloneUserRepos();
  const daemon = startDaemon();

  process.on("SIGINT", () => {
    console.log("Received SIGINT, shutting down...");
    daemon.kill("SIGINT");
  });

  process.on("SIGTERM", () => {
    console.log("Received SIGTERM, shutting down...");
    daemon.kill("SIGTERM");
  });
};

main();
