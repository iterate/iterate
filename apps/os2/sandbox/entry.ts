import { spawn, execSync, type ExecSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";

const ITERATE_REPO_PATH = "/repos/iterate";
const ITERATE_REPO_URL = "https://github.com/iterate/iterate.git";
const DAEMON_PATH = `${ITERATE_REPO_PATH}/apps/daemon`;

const USER_REPO_PATH = "/repos/user";

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
  const repoFullName = process.env.GITHUB_REPO_FULL_NAME;
  if (!repoFullName) {
    console.log("No GITHUB_REPO_FULL_NAME found, skipping user repository clone");
    return;
  }

  const token = process.env.GITHUB_ACCESS_TOKEN;
  if (!token) {
    console.log("No GITHUB_ACCESS_TOKEN found, skipping user repository clone");
    return;
  }

  const defaultBranch = process.env.GITHUB_REPO_DEFAULT_BRANCH || "main";
  const repoUrl = `https://github.com/${repoFullName}.git`;
  const gitEnv = getGitEnvWithToken();

  if (existsSync(USER_REPO_PATH)) {
    console.log(`User repository already exists at ${USER_REPO_PATH}, pulling latest...`);
    execSync(`git fetch origin ${defaultBranch}`, {
      cwd: USER_REPO_PATH,
      stdio: "inherit",
      env: gitEnv,
    });
    execSync(`git reset --hard origin/${defaultBranch}`, { cwd: USER_REPO_PATH, stdio: "inherit" });
  } else {
    console.log(`Cloning ${repoFullName} to ${USER_REPO_PATH}...`);
    execSync(`git clone --branch ${defaultBranch} ${repoUrl} ${USER_REPO_PATH}`, {
      stdio: "inherit",
      env: gitEnv,
    });
  }

  console.log(`User repository ${repoFullName} ready at ${USER_REPO_PATH}`);
};

const cloneAndSetupIterateRepo = () => {
  if (existsSync(ITERATE_REPO_PATH)) {
    console.log(`Iterate repository already exists at ${ITERATE_REPO_PATH}, pulling latest...`);
    execSync("git pull", { cwd: ITERATE_REPO_PATH, stdio: "inherit" });
  } else {
    console.log(`Cloning ${ITERATE_REPO_URL} to ${ITERATE_REPO_PATH}...`);
    execSync(`git clone ${ITERATE_REPO_URL} ${ITERATE_REPO_PATH}`, { stdio: "inherit" });
  }

  console.log("Running pnpm install...");
  execSync("pnpm install", { cwd: ITERATE_REPO_PATH, stdio: "inherit" });
};

const startDaemon = () => {
  console.log(`Starting daemon with vite in ${DAEMON_PATH}...`);

  const daemon = spawn("pnpm", ["vite"], {
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
  cloneUserRepo();
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
