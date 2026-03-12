import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import { useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { z } from "zod/v4";
import { DockerDeploymentTestEnv } from "../../test-helpers/deployment-test-env.ts";
import { test } from "../../test-support/e2e-test.ts";

const FRP_DATA_REMOTE_PORT = 27180;
const FRP_READY_REGEX = /start proxy success|proxy added successfully|login to server success/i;
const TokenBackedTunnelEnv = z.object({
  CLOUDFLARE_TUNNEL_TOKEN: z
    .string()
    .trim()
    .min(1)
    .default(
      "eyJhIjoiMDRiM2I1NzI5MWVmMjYyNmM2YThkYWE5ZDQ3MDY1YTciLCJ0IjoiNTZjN2JmMzYtNTQwOC00YTQ3LWE5MTUtNzE0MGY5OTliMjhhIiwicyI6Imp1c0dUemlaSUhoVm1uT1MwT0V1bnZRSGRpbGZnOGcxcy8rbUZvbG5XTG9RUFpzeXQ4QmtpZFRma004ZnoxNmxlZjF3aWlOZDVZUjdka3BOSzk1dVB3PT0ifQ==",
    ),
  CLOUDFLARE_TUNNEL_PUBLIC_URL: z.url().default("https://e2e-public-test-tunnel.iterate.com"),
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tomlString(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function waitForPublicText(params: {
  url: string;
  timeoutMs: number;
  matches: (body: string) => boolean;
}) {
  const deadline = Date.now() + params.timeoutMs;
  let lastBody = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(params.url, {
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      lastBody = body;
      if (response.ok && params.matches(body)) return body;
    } catch {}
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${params.url}; last body=${lastBody}`);
}

async function useFrpTunnel(params: {
  controlServerHost: string;
  controlServerPort: number;
  controlTransportProtocol: "websocket" | "wss";
  localTargetHost?: string;
  localTargetPort: number;
  frpcBin?: string;
}) {
  const tmpDir = await mkdtemp(join(tmpdir(), "jonasland-e2e-frpc-"));
  const configPath = join(tmpDir, "frpc.toml");
  await writeFile(
    configPath,
    [
      `serverAddr = ${tomlString(params.controlServerHost)}`,
      `serverPort = ${String(params.controlServerPort)}`,
      `transport.protocol = ${tomlString(params.controlTransportProtocol)}`,
      "loginFailExit = false",
      "",
      "[[proxies]]",
      `name = ${tomlString("vitest-cloudflare-tunnel")}`,
      `type = ${tomlString("tcp")}`,
      `localIP = ${tomlString(params.localTargetHost ?? "127.0.0.1")}`,
      `localPort = ${String(params.localTargetPort)}`,
      `remotePort = ${String(FRP_DATA_REMOTE_PORT)}`,
      "",
    ].join("\n"),
    "utf8",
  );

  const logs: string[] = [];
  const frpc = spawn(
    params.frpcBin?.trim() || process.env.JONASLAND_E2E_FRPC_BIN || "frpc",
    ["-c", configPath],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  frpc.stdout.on("data", (chunk) => {
    logs.push(String(chunk));
  });
  frpc.stderr.on("data", (chunk) => {
    logs.push(String(chunk));
  });

  let disposed = false;
  const stop = async () => {
    if (disposed) return;
    disposed = true;
    if (frpc.exitCode === null && frpc.signalCode === null) {
      frpc.kill("SIGTERM");
      await sleep(500);
    }
    if (frpc.exitCode === null && frpc.signalCode === null) {
      frpc.kill("SIGKILL");
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };

  const waitUntilConnected = async () => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (frpc.exitCode !== null) {
        throw new Error(`frpc exited early with code ${String(frpc.exitCode)}:\n${logs.join("")}`);
      }
      if (FRP_READY_REGEX.test(logs.join(""))) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for frpc to connect:\n${logs.join("")}`);
  };

  return {
    proxyUrl: `http://127.0.0.1:${String(FRP_DATA_REMOTE_PORT)}`,
    logs: () => logs.join(""),
    stop,
    waitUntilConnected,
    async [Symbol.asyncDispose]() {
      await stop();
    },
  };
}

describe("cloudflare tunnel", () => {
  test(
    "deployment-managed token-backed tunnel becomes deployment ingress",
    {
      tags: ["docker", "third-party"],
      timeout: 240_000,
    },
    async ({ expect, e2e }) => {
      const tokenEnv = TokenBackedTunnelEnv.parse(process.env);
      const { image } = DockerDeploymentTestEnv.parse(process.env);
      const deployment = await Deployment.create({
        provider: createDockerProvider({}),
        opts: {
          slug: e2e.deploymentSlug,
          image,
          env: {
            DOCKER_HOST_SYNC_ENABLED: "true",
          },
        },
      });

      await using f = await e2e.useDeployment({
        deployment,
        waitUntilHealthyTimeoutMs: 90_000,
      });

      await f.deployment.setEnvVars(
        {
          CLOUDFLARE_TUNNEL_ENABLED: "true",
          CLOUDFLARE_TUNNEL_TOKEN: tokenEnv.CLOUDFLARE_TUNNEL_TOKEN,
          CLOUDFLARE_TUNNEL_PUBLIC_URL: tokenEnv.CLOUDFLARE_TUNNEL_PUBLIC_URL,
        },
        {
          waitForHealthy: false,
        },
      );
      await f.deployment.waitUntilHealthy({
        timeoutMs: 90_000,
      });

      await f.deployment.pidnap.processes.waitFor({
        processes: {
          "cloudflare-tunnel": "healthy",
        },
        timeoutMs: 90_000,
      });

      const tunnelUrl = tokenEnv.CLOUDFLARE_TUNNEL_PUBLIC_URL;
      console.log("[cloudflare-tunnel.e2e] tunnel url", tunnelUrl);

      expect(tunnelUrl).toBe(tokenEnv.CLOUDFLARE_TUNNEL_PUBLIC_URL);
      expect(
        await waitForPublicText({
          url: new URL("/__iterate/caddy-health", tunnelUrl).toString(),
          timeoutMs: 90_000,
          matches: (body) => body.includes("ok"),
        }),
      ).toContain("ok");

      await using routes = await f.useIngressProxyRoutes({
        targetURL: tunnelUrl,
        routingType: "dunder-prefix",
        timeoutMs: 90_000,
        metadata: {
          source: "jonasland-vitest-cloudflare-tunnel",
          deployment: f.snapshot(),
        },
      });
      expect(routes.routeIds.length).toBe(1);

      await f.deployment.pidnap.processes.waitFor({
        processes: {
          frps: "running",
        },
        timeoutMs: 30_000,
      });

      const expectedFrpPublicUrl = `https://frp__${routes.publicBaseHost}/`;
      const registryDeadline = Date.now() + 60_000;
      while (Date.now() < registryDeadline) {
        try {
          const resolved = await deployment.registryService.getPublicURL({
            internalURL: "http://frp.iterate.localhost",
          });
          if (resolved.publicURL === expectedFrpPublicUrl) break;
        } catch {}
        await sleep(500);
      }

      expect(
        (
          await deployment.registryService.getPublicURL({
            internalURL: "http://frp.iterate.localhost",
          })
        ).publicURL,
      ).toBe(expectedFrpPublicUrl);

      const harPath = join(e2e.outputDir, "example-com.har");
      await using recordingProxy = await useMockHttpServer({
        onUnhandledRequest: "bypass",
        recorder: {
          enabled: true,
          harPath,
        },
      });

      await using frpTunnel = await useFrpTunnel({
        controlServerHost: `frp__${routes.publicBaseHost}`,
        controlServerPort: 443,
        controlTransportProtocol: "wss",
        localTargetPort: recordingProxy.port,
        frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
      });
      await frpTunnel.waitUntilConnected();

      await deployment.setEnvVars({
        ITERATE_EGRESS_PROXY: frpTunnel.proxyUrl,
      });

      await deployment.shellWithRetry({
        cmd: "curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:27180/__iterate/health",
        timeoutMs: 30_000,
        retryIf: (result) => result.output.trim() === "000" || result.exitCode !== 0,
      });

      const curlResult = await deployment.shell({
        cmd: "curl -fsSL https://example.com/",
      });
      expect(curlResult).toMatchObject({
        exitCode: 0,
        output: expect.stringContaining("Example Domain"),
      });

      await recordingProxy.writeHar(harPath);
      const har = JSON.parse(await readFile(harPath, "utf8")) as {
        log?: {
          entries?: Array<{
            request?: {
              url?: string;
            };
          }>;
        };
      };
      const recordedUrls = (har.log?.entries ?? [])
        .map((entry) => entry.request?.url)
        .filter((value): value is string => Boolean(value));
      expect(recordedUrls).toContain("https://example.com/");

      console.log("[cloudflare-tunnel.e2e] deployment env", f.deployment.env);
      console.log("[cloudflare-tunnel.e2e] frpc logs", frpTunnel.logs());
    },
  );
});
