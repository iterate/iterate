/**
 * Local Docker + pidnap Integration Tests
 *
 * Verifies sandbox container setup with pidnap process supervision.
 * Uses docker-compose for container management - each test group gets isolated via --project-name.
 *
 * RUN WITH:
 *   RUN_LOCAL_DOCKER_TESTS=true pnpm vitest run sandbox/local-docker.test.ts
 */

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTRPCClient, httpLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TRPCRouter } from "../../daemon/server/trpc/router.ts";
import { createClient as createPidnapClient } from "../../../packages/pidnap/src/api/client.ts";
import { execInContainer } from "./tests/helpers/test-helpers.ts";
import { getLocalDockerGitInfo } from "./tests/helpers/local-docker-utils.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");

const CONTAINER_REPO_PATH = "/home/iterate/src/github.com/iterate/iterate";

const RUN_LOCAL_DOCKER_TESTS = process.env.RUN_LOCAL_DOCKER_TESTS === "true";

// ============ Docker Compose Helpers ============

/**
 * Get environment variables needed for docker-compose
 */
function getComposeEnv(): Record<string, string> {
  const gitInfo = getLocalDockerGitInfo(REPO_ROOT);
  if (!gitInfo) throw new Error("Failed to get git info for local Docker tests");
  return {
    ...process.env,
    LOCAL_DOCKER_IMAGE_NAME: process.env.LOCAL_DOCKER_IMAGE_NAME ?? "ghcr.io/iterate/sandbox:local",
    LOCAL_DOCKER_REPO_CHECKOUT: gitInfo.repoRoot,
    LOCAL_DOCKER_GIT_DIR: gitInfo.gitDir,
    LOCAL_DOCKER_COMMON_DIR: gitInfo.commonDir,
    // Pass API keys if available (for agent CLI tests)
    ...(process.env.ANTHROPIC_API_KEY
      ? { SANDBOX_ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
      : {}),
    ...(process.env.OPENAI_API_KEY ? { SANDBOX_OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
  } as Record<string, string>;
}

interface ComposeProject {
  projectName: string;
  containerId: string;
  port3000?: number;
  port9876?: number;
}

function createProjectName(): string {
  return `sandbox-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Start sandbox via docker-compose with unique project name for isolation
 */
function composeUp(projectName: string): void {
  execSync(`docker compose --project-name ${projectName} up -d sandbox`, {
    cwd: REPO_ROOT,
    env: getComposeEnv(),
    stdio: "inherit",
  });
}

/**
 * Stop and remove containers/volumes for a project
 */
function composeDown(projectName: string): void {
  try {
    execSync(`docker compose --project-name ${projectName} down -v --remove-orphans`, {
      cwd: REPO_ROOT,
      env: getComposeEnv(),
      stdio: "inherit",
    });
  } catch {
    // Best effort cleanup
  }
}

/**
 * Get container ID for the sandbox service
 */
function getContainerId(projectName: string): string {
  return execSync(`docker compose --project-name ${projectName} ps -q sandbox`, {
    cwd: REPO_ROOT,
    env: getComposeEnv(),
    encoding: "utf-8",
  }).trim();
}

/**
 * Get allocated host port for a container port
 */
function getPort(projectName: string, containerPort: number): number {
  const output = execSync(
    `docker compose --project-name ${projectName} port sandbox ${containerPort}`,
    {
      cwd: REPO_ROOT,
      env: getComposeEnv(),
      encoding: "utf-8",
    },
  ).trim();
  // Output is like "0.0.0.0:54321" - extract port
  const match = output.match(/:(\d+)$/);
  if (!match) throw new Error(`Failed to parse port from: ${output}`);
  return parseInt(match[1], 10);
}

/**
 * Create and start a sandbox container via docker-compose
 */
function createProject(): ComposeProject {
  const projectName = createProjectName();
  composeUp(projectName);
  const containerId = getContainerId(projectName);
  const port3000 = getPort(projectName, 3000);
  const port9876 = getPort(projectName, 9876);
  return { projectName, containerId, port3000, port9876 };
}

/**
 * Wait for a pidnap-managed process to become running.
 * Polls pidnap's processes.get endpoint until the process is running.
 * Handles connection failures gracefully (pidnap may not be up yet).
 */
async function waitForServiceHealthy(
  port: number,
  service: string,
  timeoutMs = 180000,
): Promise<void> {
  const start = Date.now();
  const client = createPidnapClient(`http://127.0.0.1:${port}/rpc`);

  while (Date.now() - start < timeoutMs) {
    try {
      const data = await client.processes.get({ target: service });
      if (data.state === "running") return;
      if (data.state === "stopped" || data.state === "max-restarts-reached") {
        throw new Error(`Service ${service} in terminal state: ${data.state}`);
      }
    } catch (e) {
      // Connection refused (pidnap not up yet) or service not ready - retry
      if (e instanceof Error && e.message.includes("terminal state")) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timeout waiting for service ${service} to become healthy`);
}

function createDaemonTrpcClient(port: number) {
  return createTRPCClient<TRPCRouter>({
    links: [httpLink({ url: `http://127.0.0.1:${port}/api/trpc` })],
  });
}

function createPidnapRpcClient(port: number) {
  return createPidnapClient(`http://127.0.0.1:${port}/rpc`);
}

// ============ Tests ============

describe.runIf(RUN_LOCAL_DOCKER_TESTS)("Local Docker Integration", () => {
  beforeAll(async () => {
    console.log("Building sandbox image via docker compose build...");
    execSync(`docker compose build sandbox`, {
      cwd: REPO_ROOT,
      env: getComposeEnv(),
      stdio: "inherit",
    });
  }, 300000);

  // ============ Container Setup ============
  describe("Container Setup", () => {
    let project: ComposeProject;

    beforeAll(async () => {
      project = createProject();
      await waitForServiceHealthy(project.port9876!, "daemon-backend");
      await waitForServiceHealthy(project.port9876!, "daemon-frontend");
    }, 300000);

    afterAll(() => {
      if (project?.projectName) composeDown(project.projectName);
    }, 30000);

    test("agent CLIs installed", async () => {
      const opencode = await execInContainer(project.containerId, ["opencode", "--version"]);
      expect(opencode).toMatch(/\d+\.\d+\.\d+/);

      const claude = await execInContainer(project.containerId, ["claude", "--version"]);
      expect(claude).toMatch(/\d+\.\d+\.\d+/);

      const pi = await execInContainer(project.containerId, ["pi", "--version"]);
      expect(pi).toMatch(/\d+\.\d+\.\d+/);
    });

    test.runIf(process.env.OPENAI_API_KEY)(
      "opencode answers secret question",
      async () => {
        const output = await execInContainer(project.containerId, [
          "opencode",
          "run",
          "what messaging app are you built to help with?",
        ]);
        expect(output.toLowerCase()).toContain("slack");
      },
      30000,
    );

    test.runIf(process.env.ANTHROPIC_API_KEY)(
      "claude answers secret question",
      async () => {
        const output = await execInContainer(project.containerId, [
          "claude",
          "-p",
          "what messaging app are you built to help with?",
        ]);
        expect(output.toLowerCase()).toContain("slack");
      },
      30000,
    );

    test.runIf(process.env.ANTHROPIC_API_KEY)(
      "pi answers secret question",
      async () => {
        const output = await execInContainer(project.containerId, [
          "pi",
          "-p",
          "what messaging app are you built to help with?",
        ]);
        expect(output.toLowerCase()).toContain("slack");
      },
      30000,
    );

    test("container setup correct", async () => {
      // repo cloned
      const ls = await execInContainer(project.containerId, ["ls", CONTAINER_REPO_PATH]);
      expect(ls).toContain("README.md");
      expect(ls).toContain("apps");
    });

    test("git operations work", async () => {
      const init = await execInContainer(project.containerId, ["git", "init", "/tmp/test-repo"]);
      expect(init).toContain("Initialized");

      const config = await execInContainer(project.containerId, [
        "git",
        "-C",
        "/tmp/test-repo",
        "config",
        "user.email",
      ]);
      expect(config).toContain("@");

      await execInContainer(project.containerId, [
        "sh",
        "-c",
        "echo 'hello' > /tmp/test-repo/test.txt",
      ]);
      await execInContainer(project.containerId, ["git", "-C", "/tmp/test-repo", "add", "."]);

      const commit = await execInContainer(project.containerId, [
        "git",
        "-C",
        "/tmp/test-repo",
        "commit",
        "-m",
        "test",
      ]);
      expect(commit).toContain("test");
    });

    test("git state matches host", async () => {
      const gitInfo = getLocalDockerGitInfo(REPO_ROOT);
      expect(gitInfo).toBeDefined();

      // Check branch matches (empty string if detached HEAD on both)
      const containerBranch = (
        await execInContainer(project.containerId, [
          "git",
          "-C",
          CONTAINER_REPO_PATH,
          "branch",
          "--show-current",
        ])
      ).trim();
      expect(containerBranch).toBe(gitInfo!.branch ?? "");

      // Check commit matches
      const containerCommit = (
        await execInContainer(project.containerId, [
          "git",
          "-C",
          CONTAINER_REPO_PATH,
          "rev-parse",
          "HEAD",
        ])
      ).trim();
      expect(containerCommit).toBe(gitInfo!.commit);
    });

    test("shell sources ~/.iterate/.env automatically", async () => {
      // Write env var to ~/.iterate/.env
      await execInContainer(project.containerId, [
        "sh",
        "-c",
        'echo "TEST_ITERATE_ENV_VAR=hello_from_env_file" >> ~/.iterate/.env',
      ]);

      // Start a new login shell and check if env var is available
      const envOutput = await execInContainer(project.containerId, [
        "bash",
        "-l",
        "-c",
        "env | grep TEST_ITERATE_ENV_VAR",
      ]);

      expect(envOutput).toContain("hello_from_env_file");
    });
  });

  // ============ Daemon ============
  describe("Daemon", () => {
    let project: ComposeProject;

    beforeAll(async () => {
      project = createProject();
      await waitForServiceHealthy(project.port9876!, "daemon-backend");
    }, 300000);

    afterAll(() => {
      if (project?.projectName) composeDown(project.projectName);
    }, 30000);

    test("daemon accessible", async () => {
      // Verify health endpoint from host
      const healthResponse = await fetch(`http://127.0.0.1:${project.port3000}/api/health`);
      expect(healthResponse.ok).toBe(true);
      const healthText = await healthResponse.text();
      expect(healthText.includes("ok") || healthText.includes("healthy")).toBe(true);

      // Verify health from inside container
      const internalHealth = await execInContainer(project.containerId, [
        "curl",
        "-s",
        "http://localhost:3000/api/health",
      ]);
      expect(internalHealth.includes("ok") || internalHealth.includes("healthy")).toBe(true);
    }, 210000);

    test("PTY endpoint works", async () => {
      // PTY endpoint exists
      const ptyResponse = await fetch(
        `http://127.0.0.1:${project.port3000}/api/pty/ws?cols=80&rows=24`,
      );
      expect(ptyResponse.status).not.toBe(404);
    }, 210000);

    test("serves assets and routes correctly", async () => {
      const baseUrl = `http://127.0.0.1:${project.port3000}`;
      const trpc = createDaemonTrpcClient(project.port3000!);

      // index.html
      const root = await fetch(`${baseUrl}/`);
      expect(root.ok).toBe(true);
      expect(root.headers.get("content-type")).toContain("text/html");
      const html = await root.text();
      expect(html.toLowerCase()).toContain("<!doctype html>");

      // health
      const health = await fetch(`${baseUrl}/api/health`);
      expect(health.ok).toBe(true);

      // tRPC
      const cwd = await trpc.getServerCwd.query();
      expect(cwd.cwd).toBe(`${CONTAINER_REPO_PATH}/apps/daemon`);

      // CSS/JS bundles
      const cssMatch = html.match(/href="(\.?\/assets\/[^"]+\.css)"/);
      const jsMatch = html.match(/src="(\.?\/assets\/[^"]+\.js)"/);
      if (cssMatch) {
        const css = await fetch(`${baseUrl}${cssMatch[1]!.replace(/^\.\//, "/")}`);
        expect(css.ok).toBe(true);
      }
      if (jsMatch) {
        const js = await fetch(`${baseUrl}${jsMatch[1]!.replace(/^\.\//, "/")}`);
        expect(js.ok).toBe(true);
      }

      // logo
      const logo = await fetch(`${baseUrl}/logo.svg`);
      expect(logo.ok).toBe(true);

      // SPA fallback
      const spa = await fetch(`${baseUrl}/agents/some-agent-id`);
      expect(spa.ok).toBe(true);
      expect(spa.headers.get("content-type")).toContain("text/html");
    }, 210000);
  });

  // ============ Pidnap ============
  describe("Pidnap", () => {
    let project: ComposeProject;

    beforeAll(async () => {
      project = createProject();
      await waitForServiceHealthy(project.port9876!, "daemon-backend");
    }, 300000);

    afterAll(() => {
      if (project?.projectName) composeDown(project.projectName);
    }, 30000);

    test("processes.get returns running state for daemon-backend", async () => {
      // daemon-backend is already running (waited in beforeAll)
      // Call pidnap's processes.get for daemon-backend (should already be running)
      const client = createPidnapRpcClient(project.port9876!);
      const result = await client.processes.get({ target: "daemon-backend" });
      expect(result.state).toBe("running");
    }, 210000);

    test("processes.get fails for non-existent service", async () => {
      const client = createPidnapRpcClient(project.port9876!);
      await expect(client.processes.get({ target: "nonexistent" })).rejects.toThrow(
        /Process not found/i,
      );
    }, 30000);
  });
});
