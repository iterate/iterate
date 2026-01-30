/**
 * Build local docker sandbox image for testing.
 *
 * Uses docker compose to build the sandbox service, which:
 * - Sets SANDBOX_LOCAL_DEV=true (repo mounted, not cloned)
 * - Installs all dependencies and tools
 *
 * The built image can then be used for integration tests.
 */
import { execSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", "..");
const imageName = process.env.LOCAL_DOCKER_IMAGE_NAME ?? "iterate-sandbox:local";

// Docker compose uses directory name as project name (lowercased, special chars removed)
const projectName = basename(repoRoot)
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, "");

console.log(`Building local docker sandbox: ${imageName}`);

const buildArgs = process.argv.includes("--no-cache") ? "--no-cache" : "";

// Build the sandbox service using docker compose
// Explicitly set COMPOSE_PROJECT_NAME to ensure consistent image naming
// (overrides any inherited value from parent shell)
execSync(`docker compose build ${buildArgs} sandbox`, {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    COMPOSE_PROJECT_NAME: projectName,
    DOCKER_BUILDKIT: "1",
    BUILDKIT_PROGRESS: "plain",
  },
});

// Tag the built image with the expected name for tests
execSync(`docker tag ${projectName}-sandbox ${imageName}`, {
  cwd: repoRoot,
  stdio: "inherit",
});

console.log(`Local docker sandbox ready: ${imageName}`);
