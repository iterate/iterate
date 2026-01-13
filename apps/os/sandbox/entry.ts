import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ITERATE_REPO = join(homedir(), "src", "github.com", "iterate", "iterate");
const S6_DAEMONS_PATH = join(ITERATE_REPO, "s6-daemons");
const DAEMON_PATH = join(ITERATE_REPO, "apps", "daemon");

// Path where local repo is mounted in local-docker mode
const LOCAL_REPO_MOUNT = "/local-iterate-repo";

// ============================================
// Repository setup
// ============================================

/**
 * Copies files from the mounted local repo, excluding git-ignored files.
 * Uses rsync with common exclusions (node_modules, .git, etc.)
 */
const copyFromLocalMount = () => {
  console.log("");
  console.log("Copying from mounted local repo...");

  execSync(`mkdir -p ${ITERATE_REPO}`, { stdio: "inherit" });

  // Use rsync to copy, excluding common gitignored patterns
  // The mounted repo is read-only, so we copy to the target location
  execSync(
    `rsync -av --delete \
      --exclude='node_modules' \
      --exclude='.git' \
      --exclude='dist' \
      --exclude='.turbo' \
      --exclude='.cache' \
      --exclude='*.log' \
      --exclude='.next' \
      --exclude='.wrangler' \
      --exclude='.alchemy' \
      --exclude='coverage' \
      --exclude='.env*' \
      ${LOCAL_REPO_MOUNT}/ ${ITERATE_REPO}/`,
    { stdio: "inherit" },
  );
};

/**
 * Clones or pulls the iterate repo from GitHub (for Daytona/production use).
 * Use ITERATE_GIT_REF env var to specify a branch/ref (defaults to "main").
 */
const cloneOrPullFromGit = () => {
  const gitRef = process.env.ITERATE_GIT_REF || "main";

  if (!existsSync(ITERATE_REPO)) {
    console.log("");
    console.log(`Cloning iterate repo (ref: ${gitRef})...`);
    execSync(`mkdir -p ${join(homedir(), "src", "github.com", "iterate")}`, {
      stdio: "inherit",
    });
    execSync(
      `git clone --branch ${gitRef} https://github.com/iterate/iterate.git ${ITERATE_REPO}`,
      {
        stdio: "inherit",
      },
    );
  } else {
    console.log("");
    console.log(`Pulling latest code (ref: ${gitRef})...`);
    execSync(`git fetch origin ${gitRef} && git reset --hard origin/${gitRef}`, {
      cwd: ITERATE_REPO,
      stdio: "inherit",
    });
  }
};

const setupIterateRepo = () => {
  console.log("");
  console.log("========================================");
  console.log("Setting up iterate repo");
  console.log("========================================");

  // Use mounted local repo if available (local-docker dev mode)
  // Otherwise clone/pull from GitHub (Daytona mode)
  if (existsSync(LOCAL_REPO_MOUNT)) {
    copyFromLocalMount();
  } else {
    cloneOrPullFromGit();
  }

  console.log("");
  console.log("Running pnpm install...");
  execSync("pnpm install", {
    cwd: ITERATE_REPO,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });

  console.log("");
};

// ============================================
// Daemon frontend build
// ============================================

const buildDaemon = () => {
  console.log("");
  console.log("========================================");
  console.log("Building daemon frontend");
  console.log("========================================");
  console.log("");

  execSync("npx vite build", { cwd: DAEMON_PATH, stdio: "inherit" });

  console.log("");
};

// ============================================
// S6 process supervision
// ============================================

const cleanupS6RuntimeState = () => {
  if (!existsSync(S6_DAEMONS_PATH)) {
    return;
  }

  rmSync(join(S6_DAEMONS_PATH, ".s6-svscan"), { recursive: true, force: true });

  for (const entry of readdirSync(S6_DAEMONS_PATH, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    rmSync(join(S6_DAEMONS_PATH, entry.name, "supervise"), { recursive: true, force: true });
    rmSync(join(S6_DAEMONS_PATH, entry.name, "log", "supervise"), { recursive: true, force: true });
  }
};

const startS6Svscan = (): ChildProcess => {
  console.log("");
  console.log("========================================");
  console.log("Starting s6-svscan");
  console.log("========================================");
  console.log("");

  const svscan = spawn("s6-svscan", [S6_DAEMONS_PATH], {
    stdio: "inherit",
    env: {
      ...process.env,
      ITERATE_REPO,
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

// ============================================
// Main
// ============================================

const main = () => {
  console.log("");
  console.log("########################################");
  console.log("# iterate sandbox entry point");
  console.log("########################################");

  setupIterateRepo();
  buildDaemon();
  cleanupS6RuntimeState();

  const svscan = startS6Svscan();

  // Forward signals for clean shutdown
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    svscan.kill("SIGTERM");
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main();
