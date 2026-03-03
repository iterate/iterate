import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { describe, expect, test } from "vitest";
import { useCloudflareTunnel } from "../../test-helpers/use-cloudflare-tunnel.ts";
import { useIngressProxyRoutes } from "../../test-helpers/use-ingress-proxy-routes.ts";

const DEFAULT_INGRESS_PROXY_BASE_URL = "https://ingress.iterate.com";
const DEFAULT_INGRESS_PROXY_DOMAIN = "ingress.iterate.com";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      });
    });
  });
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate local port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHttpText(params: {
  url: string;
  expectedText: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 90_000;
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;
  let lastBody = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(params.url, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      lastStatus = response.status;
      const body = await response.text();
      lastBody = body;
      if (response.ok && body.includes(params.expectedText)) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `timed out waiting for ${params.url} to include ${JSON.stringify(params.expectedText)} (lastStatus=${String(lastStatus)} lastBody=${JSON.stringify(lastBody.slice(0, 200))})`,
  );
}

interface DockerHostNetworkEchoHandle extends AsyncDisposable {
  port: number;
  expectedText: string;
  stop(): Promise<void>;
}

async function startDockerHostNetworkEcho(): Promise<DockerHostNetworkEchoHandle> {
  const containerName = `jonasland-e2e-hostnet-${randomUUID().slice(0, 8)}`;
  const port = await allocatePort();
  const expectedText = `host-network-ok-${randomUUID().slice(0, 8)}`;

  const runResult = await runCommand("docker", [
    "run",
    "--detach",
    "--rm",
    "--network",
    "host",
    "--name",
    containerName,
    "hashicorp/http-echo:1.0.0",
    `-listen=:${String(port)}`,
    `-text=${expectedText}`,
  ]);

  if (runResult.exitCode !== 0) {
    throw new Error(
      `failed starting docker host-network echo container:\n${runResult.stdout}${runResult.stderr}`,
    );
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await runCommand("docker", ["rm", "-f", containerName]).catch(() => {});
  };

  try {
    await waitForHttpText({
      url: `http://127.0.0.1:${String(port)}/`,
      expectedText,
      timeoutMs: 20_000,
    });
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }

  return {
    port,
    expectedText,
    stop,
    async [Symbol.asyncDispose]() {
      await stop();
    },
  };
}

describe("clean ingress proxy via cloudflare tunnel", () => {
  test("routes ingress hostname to local docker host-network service through trycloudflare", async () => {
    const ingressProxyApiKey =
      process.env.INGRESS_PROXY_API_TOKEN?.trim() ??
      process.env.INGRESS_PROXY_E2E_API_TOKEN?.trim() ??
      "";
    if (!ingressProxyApiKey) {
      throw new Error(
        "set INGRESS_PROXY_API_TOKEN (or INGRESS_PROXY_E2E_API_TOKEN) to run this test",
      );
    }

    const ingressProxyBaseUrl = (
      process.env.JONASLAND_E2E_INGRESS_PROXY_BASE_URL ??
      process.env.INGRESS_PROXY_BASE_URL ??
      DEFAULT_INGRESS_PROXY_BASE_URL
    )
      .trim()
      .replace(/\/+$/, "");
    const ingressProxyDomain = (
      process.env.JONASLAND_E2E_INGRESS_PROXY_DOMAIN ??
      process.env.INGRESS_PROXY_DOMAIN ??
      DEFAULT_INGRESS_PROXY_DOMAIN
    ).trim();

    await using dockerEcho = await startDockerHostNetworkEcho();
    await using tunnel = await useCloudflareTunnel({
      localPort: dockerEcho.port,
      cloudflaredBin: process.env.JONASLAND_E2E_CLOUDFLARED_BIN,
    });

    const tunnelHost = new URL(tunnel.tunnelUrl).host;
    const ingressHost = `docker-tunnel-${randomUUID().slice(0, 8)}.${ingressProxyDomain}`;

    await using routes = await useIngressProxyRoutes({
      ingressProxyApiKey,
      ingressProxyBaseUrl,
      routes: [
        {
          metadata: {
            source: "jonasland-vitest-cloudflare-tunnel",
            ingressHost,
          },
          patterns: [
            {
              pattern: ingressHost,
              target: tunnel.tunnelUrl,
              headers: {
                Host: tunnelHost,
              },
            },
          ],
        },
      ],
    });

    expect(routes.routeIds.length).toBe(1);

    await waitForHttpText({
      url: `https://${ingressHost}/`,
      expectedText: dockerEcho.expectedText,
      timeoutMs: 120_000,
    });
  }, 300_000);
});
