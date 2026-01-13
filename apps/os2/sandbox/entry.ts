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
  renameSync,
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

// Configure git for the current runtime user (handles both node and daytona users)
const configureGitForCurrentUser = () => {
  try {
    // Check if git is already configured for iterate
    const existingName = execSync("git config --global user.name", { encoding: "utf-8" }).trim();
    if (existingName === "iterate") {
      console.log("Git already configured for iterate");
      return;
    }
  } catch {
    // Git config not set, proceed to set it
  }

  console.log("Configuring git for current user...");
  execSync('git config --global user.name "iterate"');
  execSync('git config --global user.email "233973017+iterate[bot]@users.noreply.github.com"');
};

const setupGoStyleSymlink = () => {
  // Atomically check and create symlink to avoid TOCTOU race
  const parentDir = dirname(GO_STYLE_ITERATE_PATH);
  mkdirSync(parentDir, { recursive: true });

  try {
    // Try to create symlink atomically - if it exists, this will throw EEXIST
    symlinkSync(ITERATE_REPO_PATH, GO_STYLE_ITERATE_PATH);
    console.log(`Created symlink: ${GO_STYLE_ITERATE_PATH} -> ${ITERATE_REPO_PATH}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Path exists - check if it's already the correct symlink
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
      } catch (lstatErr) {
        console.error(`Failed to check existing path: ${(lstatErr as Error).message}`);
      }
    } else {
      throw err;
    }
  }
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

const cloneAndSetupIterateRepo = (): boolean => {
  let codeChanged = false;

  if (!existsSync(ITERATE_REPO_PATH)) {
    console.log(`Cloning ${ITERATE_REPO_URL} to ${ITERATE_REPO_PATH}...`);
    const parentDir = dirname(ITERATE_REPO_PATH);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    try {
      execSync(`git clone ${ITERATE_REPO_URL} ${ITERATE_REPO_PATH}`, { stdio: "inherit" });
      codeChanged = true;
    } catch (err) {
      console.error(`Failed to clone repository: ${(err as Error).message}`);
      throw new Error(`Git clone failed for ${ITERATE_REPO_URL}`);
    }
  } else if (!isDevMode()) {
    // In non-dev mode (e.g. Daytona), pull latest code since the image might be stale
    console.log("Pulling latest code from origin...");
    try {
      const headBefore = execSync("git rev-parse HEAD", {
        cwd: ITERATE_REPO_PATH,
        encoding: "utf-8",
      }).trim();

      execSync("git fetch origin main && git reset --hard origin/main", {
        cwd: ITERATE_REPO_PATH,
        stdio: "inherit",
      });

      const headAfter = execSync("git rev-parse HEAD", {
        cwd: ITERATE_REPO_PATH,
        encoding: "utf-8",
      }).trim();

      codeChanged = headBefore !== headAfter;
      if (codeChanged) {
        console.log(`Updated from ${headBefore.slice(0, 8)} to ${headAfter.slice(0, 8)}`);
      } else {
        console.log("Already at latest commit");
      }
    } catch (err) {
      console.error(`Failed to pull latest code: ${(err as Error).message}`);
      throw new Error("Git pull failed");
    }
  } else {
    console.log("Dev mode: using local code, skipping git pull");
  }

  const nodeModulesPath = join(ITERATE_REPO_PATH, "node_modules");
  const shouldInstall = codeChanged || isDevMode() || !existsSync(nodeModulesPath);

  if (shouldInstall) {
    const reason = codeChanged ? "code updated" : isDevMode() ? "dev mode" : "no node_modules";
    console.log(`Running pnpm install (${reason})...`);
    try {
      execSync("pnpm install", {
        cwd: ITERATE_REPO_PATH,
        stdio: "inherit",
        env: { ...process.env, CI: "true" },
      });
    } catch (err) {
      console.error(`Failed to install dependencies: ${(err as Error).message}`);
      throw new Error("pnpm install failed");
    }
  } else {
    console.log("Code unchanged and dependencies installed, skipping pnpm install");
  }

  return codeChanged;
};

const buildDaemonIfNeeded = (codeChanged: boolean) => {
  const distPath = join(DAEMON2_PATH, "dist");

  // In local dev mode, always rebuild to pick up local code changes
  if (isDevMode()) {
    console.log("Dev mode: rebuilding daemon2 frontend...");
    execSync("npx vite build", { cwd: DAEMON2_PATH, stdio: "inherit" });
    return;
  }

  // If code changed (git pull brought new commits), rebuild even if dist exists
  if (codeChanged) {
    console.log("Code changed: rebuilding daemon2 frontend...");
    execSync("npx vite build", { cwd: DAEMON2_PATH, stdio: "inherit" });
    return;
  }

  // For Daytona/production: use pre-built frontend from image/snapshot
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

  try {
    const current = readFileSync(runPath, "utf-8");
    if (current === desired) return;
  } catch {
    // File doesn't exist or can't be read, continue to write
  }

  // Use atomic write: write to temp file then rename to avoid race with s6 reading
  const tempPath = `${runPath}.tmp.${process.pid}`;
  try {
    writeFileSync(tempPath, desired, { mode: 0o755 });
    renameSync(tempPath, runPath);
  } catch (err) {
    // Clean up temp file on error
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
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

const SHUTDOWN_TIMEOUT_MS = 10000; // 10 seconds for graceful shutdown

const main = () => {
  configureGitForCurrentUser();
  setupGoStyleSymlink();
  const codeChanged = cloneAndSetupIterateRepo();
  cloneUserRepos();
  ensureIterateServerRunScript();
  buildDaemonIfNeeded(codeChanged);
  cleanupS6RuntimeState();

  const svscan = startS6Svscan();

  let shuttingDown = false;
  let shutdownTimer: NodeJS.Timeout | null = null;

  const initiateShutdown = (signal: string) => {
    if (shuttingDown) {
      console.log(`Already shutting down, ignoring ${signal}`);
      return;
    }
    shuttingDown = true;

    console.log(`Received ${signal}, shutting down s6-svscan...`);
    svscan.kill("SIGTERM");

    // Force exit after timeout if graceful shutdown doesn't complete
    shutdownTimer = setTimeout(() => {
      console.error(`Shutdown timeout after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
      svscan.kill("SIGKILL");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
  };

  // Clear timeout when s6-svscan exits naturally
  svscan.on("exit", () => {
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
    }
  });

  // Forward signals to s6-svscan for clean shutdown
  process.on("SIGINT", () => initiateShutdown("SIGINT"));
  process.on("SIGTERM", () => initiateShutdown("SIGTERM"));
};

main();
