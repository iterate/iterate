import { spawn, execSync, type ExecSyncOptions, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

interface RepoConfig {
  owner: string;
  name: string;
  defaultBranch: string;
}

// Fixed path for iterate repo (user-agnostic, set by Dockerfile)
const ITERATE_REPO_PATH = "/iterate-repo";
const ITERATE_REPO_URL = "https://github.com/iterate/iterate.git";
const DAEMON2_PATH = join(ITERATE_REPO_PATH, "apps", "daemon2");
const S6_DAEMONS_PATH = join(ITERATE_REPO_PATH, "s6-daemons");

// Go-style path for compatibility with tooling that expects it
const SRC_BASE = join(homedir(), "src", "github.com");
const GO_STYLE_ITERATE_PATH = join(SRC_BASE, "iterate", "iterate");

const isDevMode = () => process.env.ITERATE_DEV === "true";

const getRepoPath = (owner: string, name: string) => join(SRC_BASE, owner, name);

const setupGoStyleSymlink = () => {
  if (existsSync(GO_STYLE_ITERATE_PATH)) {
    try {
      const stats = lstatSync(GO_STYLE_ITERATE_PATH);
      if (stats.isSymbolicLink()) {
        console.log(
          `Go-style symlink already exists: ${GO_STYLE_ITERATE_PATH} -> ${ITERATE_REPO_PATH}`,
        );
        return;
      }
      console.log(
        `Warning: ${GO_STYLE_ITERATE_PATH} exists but is not a symlink, skipping symlink creation`,
      );
      return;
    } catch {
      // lstatSync failed, path doesn't exist
    }
  }

  const parentDir = dirname(GO_STYLE_ITERATE_PATH);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  console.log(`Creating symlink: ${GO_STYLE_ITERATE_PATH} -> ${ITERATE_REPO_PATH}`);
  symlinkSync(ITERATE_REPO_PATH, GO_STYLE_ITERATE_PATH);
};

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
  if (!existsSync(ITERATE_REPO_PATH)) {
    console.log(`Cloning ${ITERATE_REPO_URL} to ${ITERATE_REPO_PATH}...`);
    const parentDir = dirname(ITERATE_REPO_PATH);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    execSync(`git clone ${ITERATE_REPO_URL} ${ITERATE_REPO_PATH}`, { stdio: "inherit" });
  }

  console.log("Running pnpm install...");
  execSync("pnpm install", {
    cwd: ITERATE_REPO_PATH,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
};

const buildDaemonIfNeeded = () => {
  const distPath = join(DAEMON2_PATH, "dist");

  if (isDevMode()) {
    console.log("Dev mode: rebuilding daemon2 with Linux native modules...");
    execSync("npx vite build", { cwd: DAEMON2_PATH, stdio: "inherit" });
    return;
  }

  if (existsSync(distPath)) {
    console.log(`Daemon2 already built at ${distPath}, skipping build`);
    return;
  }

  console.log(`Building daemon2 in ${DAEMON2_PATH}...`);
  execSync("npx vite build", { cwd: DAEMON2_PATH, stdio: "inherit" });
};

const ensureIterateServerRunScript = () => {
  if (isDevMode()) return;
  const runPath = join(S6_DAEMONS_PATH, "iterate-server", "run");
  if (!existsSync(runPath)) return;

  const desired = [
    "#!/bin/sh",
    "exec 2>&1",
    'cd "$ITERATE_REPO/apps/daemon2"',
    "",
    '"$ITERATE_REPO/scripts/s6-healthcheck-notify.sh" http://localhost:3000/api/health &',
    "",
    "exec env HOSTNAME=0.0.0.0 PORT=3000 tsx server.ts",
    "",
  ].join("\n");

  const current = readFileSync(runPath, "utf-8");
  if (current === desired) return;

  writeFileSync(runPath, desired);
  chmodSync(runPath, 0o755);
};

const cleanupS6RuntimeState = () => {
  rmSync(join(S6_DAEMONS_PATH, ".s6-svscan"), { recursive: true, force: true });

  for (const entry of readdirSync(S6_DAEMONS_PATH, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    rmSync(join(S6_DAEMONS_PATH, entry.name, "supervise"), { recursive: true, force: true });
    rmSync(join(S6_DAEMONS_PATH, entry.name, "log", "supervise"), { recursive: true, force: true });
  }
};

const startS6Svscan = (): ChildProcess => {
  console.log(`Starting s6-svscan on ${S6_DAEMONS_PATH}...`);

  const svscan = spawn("s6-svscan", [S6_DAEMONS_PATH], {
    stdio: "inherit",
    env: {
      ...process.env,
      // Make iterate repo path available to run scripts (avoids hardcoding paths)
      ITERATE_REPO: ITERATE_REPO_PATH,
      HOSTNAME: "0.0.0.0",
    },
  });

  svscan.on("error", (err) => {
    console.error("Failed to start s6-svscan:", err);
    process.exit(1);
  });

  svscan.on("exit", (code, signal) => {
    console.log(`s6-svscan exited with code ${code}, signal ${signal}`);
    process.exit(code ?? 1);
  });

  return svscan;
};

const main = () => {
  setupGoStyleSymlink();
  cloneAndSetupIterateRepo();
  cloneUserRepos();
  ensureIterateServerRunScript();
  buildDaemonIfNeeded();
  cleanupS6RuntimeState();

  const svscan = startS6Svscan();

  // Forward signals to s6-svscan for clean shutdown
  process.on("SIGINT", () => {
    console.log("Received SIGINT, shutting down s6-svscan...");
    svscan.kill("SIGINT");
  });

  process.on("SIGTERM", () => {
    console.log("Received SIGTERM, shutting down s6-svscan...");
    svscan.kill("SIGTERM");
  });
};

main();
