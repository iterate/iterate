import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";

const REPO_PATH = "/repos/iterate";
const REPO_URL = "https://github.com/iterate/iterate.git";
const DAEMON_PATH = `${REPO_PATH}/apps/os2/daemon`;

const cloneAndSetupRepo = () => {
  if (existsSync(REPO_PATH)) {
    console.log(`Repository already exists at ${REPO_PATH}, pulling latest...`);
    execSync("git pull", { cwd: REPO_PATH, stdio: "inherit" });
  } else {
    console.log(`Cloning ${REPO_URL} to ${REPO_PATH}...`);
    execSync(`git clone ${REPO_URL} ${REPO_PATH}`, { stdio: "inherit" });
  }

  console.log("Running pnpm install...");
  execSync("pnpm install", { cwd: REPO_PATH, stdio: "inherit" });
};

const startDaemon = () => {
  console.log(`Starting daemon with vite in ${DAEMON_PATH}...`);

  const daemon = spawn("pnpm", ["dev"], {
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
  cloneAndSetupRepo();
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
