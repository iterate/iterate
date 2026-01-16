/**
 * Local Docker + s6 Integration Tests
 *
 * Verifies sandbox container setup with s6 process supervision.
 * Image rebuilt once, each test group gets its own container.
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
import { dockerApi, DOCKER_API_URL, execInContainer } from "./test-helpers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");

const IMAGE_NAME = "iterate-sandbox-test";
const CONTAINER_REPO_PATH = "/home/iterate/src/github.com/iterate/iterate";

const RUN_LOCAL_DOCKER_TESTS = process.env.RUN_LOCAL_DOCKER_TESTS === "true";

// ============ Container Helpers ============

interface ContainerInfo {
  id: string;
  port?: number;
}

function createContainerName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getRandomPort(): number {
  return 13000 + Math.floor(Math.random() * 2000);
}

async function createContainer(options?: { exposePort?: boolean }): Promise<ContainerInfo> {
  const containerName = createContainerName("sandbox-test");
  const port = options?.exposePort ? getRandomPort() : undefined;

  const envVars = [
    "PATH=/home/iterate/.local/bin:/home/iterate/.npm-global/bin:/home/iterate/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  ];

  if (process.env.ANTHROPIC_API_KEY) {
    envVars.push(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
  }
  if (process.env.OPENAI_API_KEY) {
    envVars.push(`OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`);
  }

  const config: Record<string, unknown> = {
    Image: IMAGE_NAME,
    name: containerName,
    Env: envVars,
    Tty: false,
    HostConfig: {
      AutoRemove: false,
      // Mount local repo so entry.sh can rsync it into the container
      Binds: [`${REPO_ROOT}:/local-iterate-repo:ro`],
    },
  };

  if (port) {
    config.ExposedPorts = { "3000/tcp": {} };
    (config.HostConfig as Record<string, unknown>).PortBindings = {
      "3000/tcp": [{ HostPort: String(port) }],
    };
  }

  const createResponse = await dockerApi<{ Id: string }>("POST", "/containers/create", config);
  await dockerApi("POST", `/containers/${createResponse.Id}/start`, {});

  return { id: createResponse.Id, port };
}

async function destroyContainer(containerId: string): Promise<void> {
  try {
    await dockerApi("POST", `/containers/${containerId}/stop?t=5`, {});
  } catch {
    // might already be stopped
  }
  await dockerApi("DELETE", `/containers/${containerId}?force=true`, undefined);
}

async function waitForContainerReady(containerId: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${DOCKER_API_URL}/containers/${containerId}/json`);
      const info = (await response.json()) as { State: { Running: boolean } };
      if (info.State.Running) {
        await new Promise((r) => setTimeout(r, 2000));
        return;
      }
    } catch {
      // Container not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timeout waiting for container to start");
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
    console.log("Building sandbox image via pnpm snapshot:local-docker...");
    // Use the existing script - builds without SANDBOX_ITERATE_REPO_REF (local dev mode)
    execSync(`pnpm snapshot:local-docker`, {
      cwd: join(REPO_ROOT, "apps/os"),
      stdio: "inherit",
      env: { ...process.env, LOCAL_DOCKER_IMAGE_NAME: IMAGE_NAME },
    });
  }, 300000);

  // ============ Container Setup ============
  describe.concurrent("Container Setup", () => {
    let container: ContainerInfo;

    beforeAll(async () => {
      container = await createContainer();
      await waitForContainerReady(container.id);
    }, 60000);

    afterAll(async () => {
      if (container?.id) await destroyContainer(container.id);
    }, 30000);

    test("agent CLIs installed", async () => {
      const opencode = await execInContainer(container.id, ["opencode", "--version"]);
      expect(opencode).toMatch(/\d+\.\d+\.\d+/);

      const claude = await execInContainer(container.id, ["claude", "--version"]);
      expect(claude).toMatch(/\d+\.\d+\.\d+/);

      const pi = await execInContainer(container.id, ["pi", "--version"]);
      expect(pi).toMatch(/\d+\.\d+\.\d+/);
    });

    test("opencode answers math question", async () => {
      const output = await execInContainer(container.id, ["opencode", "run", "what is 50 - 8"]);
      expect(output).toContain("42");
    }, 30000);

    test("claude answers math question", async () => {
      const output = await execInContainer(container.id, ["claude", "-p", "what is 50 - 8"]);
      expect(output).toContain("42");
    }, 30000);

    test("pi answers math question", async () => {
      const output = await execInContainer(container.id, ["pi", "-p", "what is 50 - 8"]);
      expect(output).toContain("42");
    }, 30000);

    test("container setup correct", async () => {
      // tmux installed
      const tmux = await execInContainer(container.id, ["which", "tmux"]);
      expect(tmux.trim()).toBe("/usr/bin/tmux");

      // repo cloned
      const ls = await execInContainer(container.id, ["ls", CONTAINER_REPO_PATH]);
      expect(ls).toContain("README.md");
      expect(ls).toContain("apps");
      // s6-daemons moved into apps/os/sandbox/

      // has bind mount for local repo (entry.sh syncs from this)
      const inspect = await dockerApi<{ HostConfig?: { Binds?: string[] } }>(
        "GET",
        `/containers/${container.id}/json`,
      );
      expect(inspect.HostConfig?.Binds).toHaveLength(1);
      expect(inspect.HostConfig?.Binds?.[0]).toContain("/local-iterate-repo");
    });

    test("git operations work", async () => {
      const init = await execInContainer(container.id, ["git", "init", "/tmp/test-repo"]);
      expect(init).toContain("Initialized");

      const config = await execInContainer(container.id, [
        "git",
        "-C",
        "/tmp/test-repo",
        "config",
        "user.email",
      ]);
      expect(config).toContain("@");

      await execInContainer(container.id, ["sh", "-c", "echo 'hello' > /tmp/test-repo/test.txt"]);
      await execInContainer(container.id, ["git", "-C", "/tmp/test-repo", "add", "."]);

      const commit = await execInContainer(container.id, [
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
      const status = await execInContainer(container.id, [
        "git",
        "-C",
        CONTAINER_REPO_PATH,
        "status",
      ]);
      expect(status).toContain("On branch");
    });
  });

  // ============ Daemon ============
  describe.concurrent("Daemon", () => {
    let container: ContainerInfo;

    beforeAll(async () => {
      container = await createContainer({ exposePort: true });
      await waitForContainerReady(container.id);
    }, 60000);

    afterAll(async () => {
      if (container?.id) await destroyContainer(container.id);
    }, 30000);

    test("daemon accessible", async () => {
      // Wait for daemon to be ready (entry.sh does pnpm install + vite build)
      await waitForDaemonReady(container.port!);

      // Verify health endpoint from host
      const healthResponse = await fetch(`http://localhost:${container.port}/api/health`);
      expect(healthResponse.ok).toBe(true);
      const healthText = await healthResponse.text();
      expect(healthText.includes("ok") || healthText.includes("healthy")).toBe(true);

      // Verify health from inside container
      const internalHealth = await execInContainer(container.id, [
        "curl",
        "-s",
        "http://localhost:3000/api/health",
      ]);
      expect(internalHealth.includes("ok") || internalHealth.includes("healthy")).toBe(true);
    }, 210000);

    test("tmux and PTY work", async () => {
      await waitForDaemonReady(container.port!);

      // PTY endpoint exists
      const ptyResponse = await fetch(
        `http://localhost:${container.port}/api/pty/ws?cols=80&rows=24`,
      );
      expect(ptyResponse.status).not.toBe(404);

      // tmux via tRPC
      const trpc = createDaemonTrpcClient(container.port!);
      const sessionName = `test-${Date.now()}`;
      const createResult = await trpc.ensureTmuxSession.mutate({
        sessionName,
        command: "bash",
      });
      expect(createResult.created).toBe(true);

      const sessions = await trpc.listTmuxSessions.query();
      expect(sessions.some((s: { name: string }) => s.name === sessionName)).toBe(true);
    }, 210000);

    test("serves assets and routes correctly", async () => {
      await waitForDaemonReady(container.port!);
      const baseUrl = `http://localhost:${container.port}`;
      const trpc = createDaemonTrpcClient(container.port!);

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
