/**
 * Local Docker + pidnap Integration Tests
 *
 * Verifies sandbox container setup with pidnap process supervision.
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
import { dockerApi, execInContainer } from "./test-helpers.ts";

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
    "PATH=/home/iterate/.opencode/bin:/home/iterate/.local/bin:/home/iterate/.npm-global/bin:/home/iterate/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
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
      // Map host.docker.internal to the host machine (needed on Linux, automatic on Mac Docker Desktop)
      ExtraHosts: ["host.docker.internal:host-gateway"],
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

async function waitForContainerReady(containerId: string, timeoutMs = 180000): Promise<void> {
  const start = Date.now();

  // First wait for container to be running
  while (Date.now() - start < timeoutMs) {
    try {
      const info = await dockerApi<{ State: { Running: boolean } }>(
        "GET",
        `/containers/${containerId}/json`,
      );
      if (info.State.Running) break;
    } catch {
      // Container not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Then wait for entry.sh to complete setup (creates ready file after setup-home.sh)
  while (Date.now() - start < timeoutMs) {
    try {
      // Use sh -c with && echo to get output only on success
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
    }, 300000);

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

    test.runIf(process.env.OPENAI_API_KEY)(
      "opencode answers secret question",
      async () => {
        const output = await execInContainer(container.id, [
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
        const output = await execInContainer(container.id, [
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
        const output = await execInContainer(container.id, [
          "pi",
          "-p",
          "what messaging app are you built to help with?",
        ]);
        expect(output.toLowerCase()).toContain("slack");
      },
      30000,
    );

    test("container setup correct", async () => {
      // tmux installed
      const tmux = await execInContainer(container.id, ["which", "tmux"]);
      expect(tmux.trim()).toBe("/usr/bin/tmux");

      // repo cloned
      const ls = await execInContainer(container.id, ["ls", CONTAINER_REPO_PATH]);
      expect(ls).toContain("README.md");
      expect(ls).toContain("apps");

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
      // CI checks out PR merge commits in detached HEAD state, which is fine
      expect(status).toMatch(/On branch|HEAD detached/);
    });
  });

  // ============ Daemon ============
  describe.concurrent("Daemon", () => {
    let container: ContainerInfo;

    beforeAll(async () => {
      container = await createContainer({ exposePort: true });
      await waitForContainerReady(container.id);
    }, 300000);

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

  // ============ Config Loading ============
  describe.concurrent("Config Loading", () => {
    let container: ContainerInfo;

    beforeAll(async () => {
      // Create container with ITERATE_CONFIG_PATH pointing to sample-iterate-internal
      const containerName = createContainerName("config-test");
      const port = getRandomPort();

      const envVars = [
        "PATH=/home/iterate/.local/bin:/home/iterate/.npm-global/bin:/home/iterate/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        // Point to the sample-iterate-internal that gets synced from local repo
        `ITERATE_CONFIG_PATH=${CONTAINER_REPO_PATH}/sample-iterate-internal`,
      ];

      const config: Record<string, unknown> = {
        Image: IMAGE_NAME,
        name: containerName,
        Env: envVars,
        Tty: false,
        HostConfig: {
          AutoRemove: false,
          Binds: [`${REPO_ROOT}:/local-iterate-repo:ro`],
          ExtraHosts: ["host.docker.internal:host-gateway"],
          PortBindings: {
            "3000/tcp": [{ HostPort: String(port) }],
          },
        },
        ExposedPorts: { "3000/tcp": {} },
      };

      const createResponse = await dockerApi<{ Id: string }>("POST", "/containers/create", config);
      await dockerApi("POST", `/containers/${createResponse.Id}/start`, {});

      container = { id: createResponse.Id, port };
      await waitForContainerReady(container.id);

      // Install dependencies in sample-iterate-internal
      console.log("Installing sample-iterate-internal dependencies...");
      await execInContainer(container.id, [
        "sh",
        "-c",
        `cd ${CONTAINER_REPO_PATH}/sample-iterate-internal && pnpm install`,
      ]);
    }, 300000);

    afterAll(async () => {
      if (container?.id) await destroyContainer(container.id);
    }, 30000);

    test("daemon loads iterate.config.ts from ITERATE_CONFIG_PATH", async () => {
      await waitForDaemonReady(container.port!);
      const baseUrl = `http://localhost:${container.port}`;

      // Health endpoint should still work (fallthrough)
      const health = await fetch(`${baseUrl}/api/health`);
      expect(health.ok).toBe(true);

      // Slack webhook should be handled by the config (not 404)
      const slackResponse = await fetch(`${baseUrl}/api/integrations/slack/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "url_verification", challenge: "test" }),
      });
      // Should get a response from the config, not a 404
      expect(slackResponse.status).not.toBe(404);
    }, 210000);

    test("fallthrough works for unhandled routes", async () => {
      await waitForDaemonReady(container.port!);

      // tRPC should still work (fallthrough from config's 404)
      const trpc = createDaemonTrpcClient(container.port!);
      const cwd = await trpc.getServerCwd.query();
      expect(cwd.cwd).toBe(`${CONTAINER_REPO_PATH}/apps/daemon`);
    }, 210000);
  });

  // ============ Config Hot Reload ============
  describe("Config Hot Reload", () => {
    let container: ContainerInfo;

    beforeAll(async () => {
      // Create container with ITERATE_CONFIG_PATH pointing to sample-iterate-internal
      const containerName = createContainerName("config-reload-test");
      const port = getRandomPort();

      const envVars = [
        "PATH=/home/iterate/.local/bin:/home/iterate/.npm-global/bin:/home/iterate/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        `ITERATE_CONFIG_PATH=${CONTAINER_REPO_PATH}/sample-iterate-internal`,
      ];

      const config: Record<string, unknown> = {
        Image: IMAGE_NAME,
        name: containerName,
        Env: envVars,
        Tty: false,
        HostConfig: {
          AutoRemove: false,
          Binds: [`${REPO_ROOT}:/local-iterate-repo:ro`],
          ExtraHosts: ["host.docker.internal:host-gateway"],
          PortBindings: {
            "3000/tcp": [{ HostPort: String(port) }],
          },
        },
        ExposedPorts: { "3000/tcp": {} },
      };

      const createResponse = await dockerApi<{ Id: string }>("POST", "/containers/create", config);
      await dockerApi("POST", `/containers/${createResponse.Id}/start`, {});

      container = { id: createResponse.Id, port };
      await waitForContainerReady(container.id);

      // Install dependencies in sample-iterate-internal
      console.log("Installing sample-iterate-internal dependencies...");
      await execInContainer(container.id, [
        "sh",
        "-c",
        `cd ${CONTAINER_REPO_PATH}/sample-iterate-internal && pnpm install`,
      ]);
    }, 300000);

    afterAll(async () => {
      if (container?.id) await destroyContainer(container.id);
    }, 30000);

    test("daemon picks up config changes after restart", async () => {
      await waitForDaemonReady(container.port!);
      const baseUrl = `http://localhost:${container.port}`;

      // 1. Verify initial config works - Slack webhook returns non-404
      const initialSlack = await fetch(`${baseUrl}/api/integrations/slack/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "url_verification", challenge: "test" }),
      });
      expect(initialSlack.status).not.toBe(404);

      // 2. Verify new endpoint doesn't exist yet
      const initialPing = await fetch(`${baseUrl}/api/test/ping`);
      expect(initialPing.status).toBe(404);

      // 3. Modify iterate.config.ts to add /api/test/ping endpoint
      const newConfigContent = `import { Hono } from "hono";
import { slackRouter } from "./plugins/slack/router.ts";

const app = new Hono();

// Mount Slack integration
app.route("/api/integrations/slack", slackRouter);

// New test endpoint added dynamically
app.get("/api/test/ping", (c) => c.text("pong"));

// Return 404 for unhandled routes so daemon can try its own routes
app.all("*", (c) => c.notFound());

export default { fetch: app.fetch };
`;

      await execInContainer(container.id, [
        "sh",
        "-c",
        `cat > ${CONTAINER_REPO_PATH}/sample-iterate-internal/iterate.config.ts << 'CONFIGEOF'
${newConfigContent}
CONFIGEOF`,
      ]);

      // 4. Rebuild the config
      console.log("Rebuilding config with new endpoint...");
      await execInContainer(container.id, [
        "sh",
        "-c",
        `cd ${CONTAINER_REPO_PATH}/sample-iterate-internal && pnpm build`,
      ]);

      // 5. Restart the daemon service using pidnap
      console.log("Restarting daemon service...");
      await execInContainer(container.id, ["pidnap", "processes", "restart", "iterate-daemon"]);

      // 6. Wait for daemon to be ready again
      await waitForDaemonReady(container.port!);

      // 7. Verify new endpoint now works
      const newPing = await fetch(`${baseUrl}/api/test/ping`);
      expect(newPing.status).toBe(200);
      const pingText = await newPing.text();
      expect(pingText).toBe("pong");

      // 8. Verify original Slack webhook still works
      const finalSlack = await fetch(`${baseUrl}/api/integrations/slack/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "url_verification", challenge: "verify" }),
      });
      expect(finalSlack.status).not.toBe(404);

      // 9. Verify daemon's own routes still work (fallthrough)
      const trpc = createDaemonTrpcClient(container.port!);
      const cwd = await trpc.getServerCwd.query();
      expect(cwd.cwd).toBe(`${CONTAINER_REPO_PATH}/apps/daemon`);
    }, 300000);
  });
});
