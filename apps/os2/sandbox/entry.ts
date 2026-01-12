import { spawn, execSync, type ExecSyncOptions, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// Fixed path for iterate repo (user-agnostic, set by Dockerfile or bind mount)
const ITERATE_REPO_PATH = "/iterate-repo";
const ITERATE_REPO_URL = "https://github.com/iterate/iterate.git";
const DAEMON2_PATH = join(ITERATE_REPO_PATH, "apps", "daemon2");
const S6_DAEMONS_PATH = join(ITERATE_REPO_PATH, "s6-daemons");

// Go-style path for compatibility with tooling that expects it
const SRC_BASE = join(homedir(), "src", "github.com");
const GO_STYLE_ITERATE_PATH = join(SRC_BASE, "iterate", "iterate");

const isDevMode = () => process.env.ITERATE_DEV === "true";

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

const getUserRepoPath = (): string | null => {
  const repoFullName = process.env.GITHUB_REPO_FULL_NAME;
  if (!repoFullName) return null;
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return null;
  return join(SRC_BASE, owner, repo);
};

const getGitEnvWithToken = (): ExecSyncOptions["env"] => {
  const token = process.env.GITHUB_ACCESS_TOKEN;
  if (!token) return process.env;

  const repoFullName = process.env.GITHUB_REPO_FULL_NAME;
  if (!repoFullName) return process.env;

  const [owner] = repoFullName.split("/");
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.https://x-access-token:${token}@github.com/${owner}/.insteadOf`,
    GIT_CONFIG_VALUE_0: `https://github.com/${owner}/`,
  };
};

const cloneUserRepo = () => {
  const userRepoPath = getUserRepoPath();
  if (!userRepoPath) {
    console.log("No GITHUB_REPO_FULL_NAME found, skipping user repository clone");
    return;
  }

  const repoFullName = process.env.GITHUB_REPO_FULL_NAME!;
  const token = process.env.GITHUB_ACCESS_TOKEN;
  if (!token) {
    console.log("No GITHUB_ACCESS_TOKEN found, skipping user repository clone");
    return;
  }

  const defaultBranch = process.env.GITHUB_REPO_DEFAULT_BRANCH || "main";
  const repoUrl = `https://github.com/${repoFullName}.git`;
  const gitEnv = getGitEnvWithToken();

  // Ensure parent directory exists
  const parentDir = join(userRepoPath, "..");
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  if (existsSync(userRepoPath)) {
    console.log(`User repository already exists at ${userRepoPath}, pulling latest...`);
    execSync(`git fetch origin ${defaultBranch}`, {
      cwd: userRepoPath,
      stdio: "inherit",
      env: gitEnv,
    });
    execSync(`git reset --hard origin/${defaultBranch}`, { cwd: userRepoPath, stdio: "inherit" });
  } else {
    console.log(`Cloning ${repoFullName} to ${userRepoPath}...`);
    execSync(`git clone --branch ${defaultBranch} ${repoUrl} ${userRepoPath}`, {
      stdio: "inherit",
      env: gitEnv,
    });
  }

  console.log(`User repository ${repoFullName} ready at ${userRepoPath}`);
};

const cloneAndSetupIterateRepo = () => {
  if (!existsSync(ITERATE_REPO_PATH)) {
    console.log(`Cloning ${ITERATE_REPO_URL} to ${ITERATE_REPO_PATH}...`);
    const parentDir = dirname(ITERATE_REPO_PATH);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    execSync(`git clone ${ITERATE_REPO_URL} ${ITERATE_REPO_PATH}`, { stdio: "inherit" });
    console.log("Running pnpm install...");
    execSync("pnpm install", { cwd: ITERATE_REPO_PATH, stdio: "inherit" });
  } else if (isDevMode()) {
    console.log(
      `Dev mode: using local iterate repo at ${ITERATE_REPO_PATH} (skipping git operations and pnpm install)`,
    );
  } else {
    console.log(`Iterate repository exists at ${ITERATE_REPO_PATH}, fetching latest...`);
    execSync("git fetch origin main", { cwd: ITERATE_REPO_PATH, stdio: "inherit" });
    execSync("git reset --hard origin/main", { cwd: ITERATE_REPO_PATH, stdio: "inherit" });

    const distPath = join(DAEMON2_PATH, "dist");
    if (existsSync(distPath)) {
      console.log("Source updated, removing stale dist/ to trigger rebuild...");
      rmSync(distPath, { recursive: true, force: true });
    }

    console.log("Running pnpm install (should be fast if lockfile unchanged)...");
    execSync("pnpm install", { cwd: ITERATE_REPO_PATH, stdio: "inherit" });
  }
};

const buildDaemonIfNeeded = () => {
  if (isDevMode()) {
    console.log("Dev mode: skipping daemon2 build (using host's build)");
    return;
  }

  const distPath = join(DAEMON2_PATH, "dist");
  if (existsSync(distPath)) {
    console.log(`Daemon2 already built at ${distPath}, skipping build`);
    return;
  }

  console.log(`Building daemon2 in ${DAEMON2_PATH}...`);
  execSync("npx vite build", { cwd: DAEMON2_PATH, stdio: "inherit" });
};

const startS6Svscan = (): ChildProcess => {
  console.log(`Starting s6-svscan on ${S6_DAEMONS_PATH}...`);

  const svscan = spawn("s6-svscan", [S6_DAEMONS_PATH], {
    stdio: "inherit",
    env: {
      ...process.env,
      // Make iterate repo path available to run scripts (avoids hardcoding paths)
      ITERATE_REPO: ITERATE_REPO_PATH,
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
  cloneUserRepo();
  buildDaemonIfNeeded();

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
