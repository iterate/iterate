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
// Coding tools installation
// ============================================

const installCodingTools = () => {
  console.log("");
  console.log("========================================");
  console.log("Installing coding tools");
  console.log("========================================");

  // pi-coding-agent
  console.log("");
  console.log("--- pi-coding-agent ---");
  try {
    execSync("which pi", { stdio: "pipe" });
    console.log("Already installed");
  } catch {
    console.log("Installing...");
    execSync("npm install -g @mariozechner/pi-coding-agent@0.44.0", { stdio: "inherit" });
  }

  // opencode
  console.log("");
  console.log("--- opencode --- (skipping because slow)");
  // try {
  //   execSync("which opencode", { stdio: "pipe" });
  //   console.log("Already installed");
  // } catch {
  //   console.log("Installing...");
  //   execSync("curl -fsSL https://opencode.ai/install | bash", { stdio: "inherit" });
  // }

  // Claude Code
  console.log("");
  console.log("--- Claude Code (skipping because slow) ---");
  // try {
  //   execSync("which claude", { stdio: "pipe" });
  //   console.log("Already installed");
  // } catch {
  //   console.log("Installing...");
  //   try {
  //     execSync("curl -fsSL https://claude.ai/install.sh | bash", { stdio: "inherit" });
  //   } catch {
  //     console.log("Claude install failed (may hang in non-interactive mode)");
  //   }
  // }

  console.log("");
};

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
 */
const cloneOrPullFromGit = () => {
  // todo: pull from my branch, not just main every time.
  if (!existsSync(ITERATE_REPO)) {
    console.log("");
    console.log("Cloning iterate repo...");
    execSync(`mkdir -p ${join(homedir(), "src", "github.com", "iterate")}`, { stdio: "inherit" });
    execSync("git clone https://github.com/iterate/iterate.git " + ITERATE_REPO, {
      stdio: "inherit",
    });
  } else {
    console.log("");
    console.log("Pulling latest code...");
    execSync("git fetch origin main && git reset --hard origin/main", {
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
  //
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

  installCodingTools();
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
