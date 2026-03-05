import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { fromTrafficWithWebSocket, useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gitOutput(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function resolveDockerHostSync() {
  return {
    repoRoot: gitOutput(["rev-parse", "--show-toplevel"]),
    gitDir: gitOutput(["rev-parse", "--path-format=absolute", "--git-dir"]),
    commonDir: gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  };
}

function resolveFrpcBinary(): string {
  const explicit = process.env.JONASLAND_E2E_FRPC_BIN?.trim();
  if (explicit) return explicit;
  return execFileSync("sh", ["-lc", "command -v frpc"], { encoding: "utf8" }).trim();
}

function normalizeContainerName(name: string | undefined): string {
  const value = (name ?? "").trim();
  if (!value) return "";
  return value.startsWith("/") ? value.slice(1) : value;
}

function probeFrpControlHost(baseUrl: string, host: string): string {
  const output = execFileSync(
    "curl",
    [
      "-sS",
      "-i",
      "--max-time",
      "5",
      "-H",
      "Connection: Upgrade",
      "-H",
      "Upgrade: websocket",
      "-H",
      "Sec-WebSocket-Version: 13",
      "-H",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "-H",
      `Host: ${host}`,
      baseUrl,
    ],
    { encoding: "utf8" },
  );
  const statusLine = output.split("\n")[0] ?? "";
  return statusLine.trim();
}

async function waitForFrpControlRoute(baseUrl: string, host: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    try {
      const statusLine = probeFrpControlHost(baseUrl, host);
      lastStatus = statusLine;
      // Any reverse-proxy status from frps path means host routing is active.
      if (
        statusLine.includes(" 502") ||
        statusLine.includes(" 403") ||
        statusLine.includes(" 101")
      ) {
        return;
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for FRP control route for host=${host}; last=${lastStatus}`);
}

async function startFrpc(params: {
  controlServerHost: string;
  controlServerPort: number;
  localTargetPort: number;
}): Promise<{
  logs: () => string;
  stop: () => Promise<void>;
  waitUntilConnected: () => Promise<void>;
}> {
  const frpcBin = resolveFrpcBinary();
  const tempDir = await mkdtemp(join(tmpdir(), "frp-minimal-"));
  const configPath = join(tempDir, "frpc.toml");
  const config = [
    `serverAddr = "${params.controlServerHost}"`,
    `serverPort = ${String(params.controlServerPort)}`,
    'transport.protocol = "websocket"',
    "loginFailExit = false",
    "",
    "[[proxies]]",
    'name = "minimal-egress"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${String(params.localTargetPort)}`,
    "remotePort = 27180",
    "",
  ].join("\n");
  await writeFile(configPath, config, "utf8");

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(frpcBin, ["-c", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  child.stdout.on("data", (chunk) => lines.push(String(chunk)));
  child.stderr.on("data", (chunk) => lines.push(String(chunk)));

  const stop = async () => {
    if (!child.killed) child.kill("SIGTERM");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      await sleep(50);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(tempDir, { recursive: true, force: true });
  };

  const waitUntilConnected = async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const joined = lines.join("");
      if (
        /start proxy success/i.test(joined) ||
        /proxy added successfully/i.test(joined) ||
        /login to server success/i.test(joined)
      ) {
        return;
      }
      if (child.exitCode !== null) {
        throw new Error(`frpc exited early with code ${String(child.exitCode)}\n${joined}`);
      }
      await sleep(100);
    }
    throw new Error(`timed out waiting for frpc connection\n${lines.join("")}`);
  };

  return {
    logs: () => lines.join(""),
    stop,
    waitUntilConnected,
  };
}

async function ensureExternalProxyConfigured(params: {
  deployment: DockerDeployment;
  proxyUrl: string;
}): Promise<void> {
  await params.deployment.setEnvVars({
    ITERATE_EXTERNAL_EGRESS_PROXY: params.proxyUrl,
  });
  await params.deployment.pidnap.processes.updateConfig({
    processSlug: "egress-proxy",
    definition: {
      command: "/home/iterate/src/github.com/iterate/iterate/packages/pidnap/node_modules/.bin/tsx",
      args: ["/home/iterate/src/github.com/iterate/iterate/services/egress-service/src/server.ts"],
      env: {
        EGRESS_PROXY_PORT: "19000",
        EGRESS_ADMIN_PORT: "19001",
      },
    },
    options: { restartPolicy: "always" },
    envOptions: { reloadDelay: 500 },
    healthCheck: {
      url: "http://127.0.0.1:19001/__iterate/health",
      intervalMs: 2_000,
    },
  });
  const runtime = await params.deployment.exec([
    "sh",
    "-lc",
    "for i in $(seq 1 45); do out=$(curl -fsS http://127.0.0.1:19001/api/runtime 2>/dev/null || true); echo \"$out\" | rg -q '\"externalProxyConfigured\":true' && { echo \"$out\"; exit 0; }; sleep 1; done; exit 1",
  ]);
  expect(runtime.exitCode, runtime.output).toBe(0);
}

async function ensureEgressProxyRunning(deployment: DockerDeployment): Promise<void> {
  await deployment.setEnvVars({
    ITERATE_EXTERNAL_EGRESS_PROXY: "",
  });
  await deployment.pidnap.processes.updateConfig({
    processSlug: "egress-proxy",
    definition: {
      command: "/home/iterate/src/github.com/iterate/iterate/packages/pidnap/node_modules/.bin/tsx",
      args: ["/home/iterate/src/github.com/iterate/iterate/services/egress-service/src/server.ts"],
      env: {
        EGRESS_PROXY_PORT: "19000",
        EGRESS_ADMIN_PORT: "19001",
      },
    },
    options: { restartPolicy: "always" },
    envOptions: { reloadDelay: 500 },
    healthCheck: {
      url: "http://127.0.0.1:19001/__iterate/health",
      intervalMs: 2_000,
    },
  });
  const runtime = await deployment.exec([
    "sh",
    "-lc",
    "for i in $(seq 1 45); do out=$(curl -fsS http://127.0.0.1:19001/api/runtime 2>/dev/null || true); [ -n \"$out\" ] && { echo \"$out\"; exit 0; }; sleep 1; done; exit 1",
  ]);
  expect(runtime.exitCode, runtime.output).toBe(0);
}

describe.runIf(DOCKER_IMAGE.length > 0)("frp egress minimal", () => {
  test(
    "records HAR from scripts executed inside deployment via FRP external proxy",
    async () => {
      const runId = randomUUID().slice(0, 8);
      const artifactsDir = join(process.cwd(), "artifacts", "frp-minimal");
      await mkdir(artifactsDir, { recursive: true });
      const harPath = join(artifactsDir, `docker-frp-minimal-${runId}.har`);
      const fixtureHarPath = join(
        process.cwd(),
        "..",
        "..",
        "packages",
        "mock-http-proxy",
        "src",
        "integration",
        "fixtures",
        "parallel-openai-slack-curl.har",
      );
      const sourceHar = JSON.parse(await readFile(fixtureHarPath, "utf8")) as {
        log?: { entries?: unknown[] };
      };
      const handlers = fromTrafficWithWebSocket(sourceHar as never);

      {
        await using mockServer = await useMockHttpServer({
          recorder: { enabled: true, harPath },
          onUnhandledRequest: "error",
        });
        mockServer.use(...handlers);

        await using deployment = await DockerDeployment.create({
          dockerImage: DOCKER_IMAGE,
          name: `e2e-frp-minimal-${runId}`,
          dockerHostSync: resolveDockerHostSync(),
        });
        await deployment.waitUntilAlive({ signal: AbortSignal.timeout(180_000) });

        const inspect = await deployment.containerInspect();
        const containerName = normalizeContainerName(inspect.Name);
        expect(containerName.length).toBeGreaterThan(0);

        const publicBaseHost = `${containerName}.orb.local`;
        const frpControlHost = `frp.${publicBaseHost}`;
        await waitForFrpControlRoute(deployment.baseUrl, frpControlHost);

        let frpc:
          | {
              logs: () => string;
              stop: () => Promise<void>;
              waitUntilConnected: () => Promise<void>;
            }
          | undefined;
        try {
          frpc = await startFrpc({
            controlServerHost: frpControlHost,
            controlServerPort: 80,
            localTargetPort: mockServer.port,
          });
          await frpc.waitUntilConnected();

          await ensureExternalProxyConfigured({
            deployment,
            proxyUrl: "http://127.0.0.1:27180",
          });

          const curl = await deployment.exec([
            "curl",
            "-sS",
            "--fail",
            "http://example.com/",
          ]);
          expect(curl.exitCode, curl.output).toBe(0);

          const slack = await deployment.exec([
            "curl",
            "-k",
            "-sS",
            "--fail",
            "-X",
            "POST",
            "-H",
            "authorization: Bearer xoxb-replay-token",
            "-H",
            "content-type: application/x-www-form-urlencoded",
            "--data",
            "",
            "https://slack.com/api/auth.test",
          ]);
          expect(slack.exitCode, slack.output).toBe(0);
        } finally {
          if (frpc) await frpc.stop().catch(() => {});
        }
      }
      const har = JSON.parse(await readFile(harPath, "utf8")) as {
        log?: {
          entries?: Array<{
            request?: { url?: string };
            _webSocketMessages?: Array<{ type: "send" | "receive" }>;
          }>;
        };
      };
      const entries = har.log?.entries ?? [];
      expect(entries.some((entry) => entry.request?.url?.includes("https://slack.com/api/auth.test"))).toBe(
        true,
      );
      expect(entries.some((entry) => entry.request?.url?.includes("http://example.com/"))).toBe(true);
    },
    240_000,
  );

  test(
    "pnpm install works from inside deployment through FRP external proxy",
    async () => {
      const runId = randomUUID().slice(0, 8);
      const artifactsDir = join(process.cwd(), "artifacts", "frp-minimal");
      await mkdir(artifactsDir, { recursive: true });
      const harPath = join(artifactsDir, `docker-frp-pnpm-install-${runId}.har`);

      {
        await using mockServer = await useMockHttpServer({
          recorder: { enabled: true, harPath },
          onUnhandledRequest: "bypass",
        });

        await using deployment = await DockerDeployment.create({
          dockerImage: DOCKER_IMAGE,
          name: `e2e-frp-pnpm-install-${runId}`,
          dockerHostSync: resolveDockerHostSync(),
        });
        await deployment.waitUntilAlive({ signal: AbortSignal.timeout(180_000) });

        const inspect = await deployment.containerInspect();
        const containerName = normalizeContainerName(inspect.Name);
        expect(containerName.length).toBeGreaterThan(0);
        const frpControlHost = `frp.${containerName}.orb.local`;
        await waitForFrpControlRoute(deployment.baseUrl, frpControlHost);

        let frpc:
          | {
              logs: () => string;
              stop: () => Promise<void>;
              waitUntilConnected: () => Promise<void>;
            }
          | undefined;
        try {
          frpc = await startFrpc({
            controlServerHost: frpControlHost,
            controlServerPort: 80,
            localTargetPort: mockServer.port,
          });
          await frpc.waitUntilConnected();

          await ensureExternalProxyConfigured({
            deployment,
            proxyUrl: "http://127.0.0.1:27180",
          });

          const install = await deployment.exec([
            "sh",
            "-lc",
            [
              "rm -rf /tmp/pnpm-frp-install",
              "mkdir -p /tmp/pnpm-frp-install",
              "cat > /tmp/pnpm-frp-install/package.json <<'EOF'\n{\"name\":\"pnpm-frp-install\",\"private\":true,\"version\":\"1.0.0\",\"dependencies\":{\"is-number\":\"^7.0.0\"}}\nEOF",
              "CI=true pnpm --dir /tmp/pnpm-frp-install install --registry=https://registry.npmjs.org --ignore-scripts",
            ].join(" && "),
          ]);
          expect(install.exitCode, install.output).toBe(0);

          const registryProbe = await deployment.exec([
            "curl",
            "-k",
            "-sS",
            "--fail",
            "https://registry.npmjs.org/is-number",
          ]);
          expect(registryProbe.exitCode, registryProbe.output).toBe(0);
        } finally {
          if (frpc) await frpc.stop().catch(() => {});
        }
      }
      const har = JSON.parse(await readFile(harPath, "utf8")) as {
        log?: { entries?: Array<{ request?: { url?: string } }> };
      };
      const entries = har.log?.entries ?? [];
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((entry) => entry.request?.url?.includes("registry.npmjs.org"))).toBe(true);
    },
    240_000,
  );
});

