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
import { execInContainer } from "./test-helpers.ts";
import { getLocalDockerGitInfo } from "./local-docker-utils.ts";

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
    LOCAL_DOCKER_GIT_DIR: gitInfo.gitDir,
    LOCAL_DOCKER_GIT_COMMIT: gitInfo.commit,
    ...(gitInfo.branch ? { LOCAL_DOCKER_GIT_BRANCH: gitInfo.branch } : {}),
  } as Record<string, string>;
}

interface ComposeProject {
  projectName: string;
  containerId: string;
  port3000?: number;
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
  return { projectName, containerId, port3000 };
}

/**
 * Wait for container setup to complete (ready file created by entry.sh)
 */
async function waitForContainerReady(containerId: string, timeoutMs = 180000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const result = await execInContainer(containerId, [
        "sh",
        "-c",
        "test -f /tmp/.iterate-sandbox-ready && echo ready",
      ]);
      if (result.trim() === "ready") return;
    } catch {
      // File doesn't exist yet or container not ready
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timeout waiting for container setup to complete");
}

async function waitForDaemonReady(port: number, timeoutMs = 180000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://localhost:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timeout waiting for daemon to be ready");
}

function createDaemonTrpcClient(port: number) {
  return createTRPCClient<TRPCRouter>({
    links: [httpLink({ url: `http://localhost:${port}/api/trpc` })],
  });
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
      await waitForContainerReady(project.containerId);
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

    test("git status works in iterate repo", async () => {
      const status = await execInContainer(project.containerId, [
        "git",
        "-C",
        CONTAINER_REPO_PATH,
        "status",
      ]);
      // CI: detached HEAD from PR merge commits
      // Regular clone: normal branch
      expect(status).toMatch(/On branch|HEAD detached/);
    });
  });

  // ============ Daemon ============
  describe("Daemon", () => {
    let project: ComposeProject;

    beforeAll(async () => {
      project = createProject();
      await waitForContainerReady(project.containerId);
    }, 300000);

    afterAll(() => {
      if (project?.projectName) composeDown(project.projectName);
    }, 30000);

    test("daemon accessible", async () => {
      await waitForDaemonReady(project.port3000!);

      // Verify health endpoint from host
      const healthResponse = await fetch(`http://localhost:${project.port3000}/api/health`);
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
      await waitForDaemonReady(project.port3000!);

      // PTY endpoint exists
      const ptyResponse = await fetch(
        `http://localhost:${project.port3000}/api/pty/ws?cols=80&rows=24`,
      );
      expect(ptyResponse.status).not.toBe(404);
    }, 210000);

    test("serves assets and routes correctly", async () => {
      await waitForDaemonReady(project.port3000!);
      const baseUrl = `http://localhost:${project.port3000}`;
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
});
