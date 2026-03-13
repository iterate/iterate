import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import { useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { DockerDeploymentTestEnv } from "../../test-helpers/deployment-test-env.ts";
import { useCloudflareTunnelFromSemaphore } from "../../test-helpers/use-cloudflare-tunnel-from-semaphore.ts";
import { test } from "../../test-support/e2e-test.ts";

const FRP_DATA_REMOTE_PORT = 27180;
const FRP_READY_REGEX = /start proxy success|proxy added successfully|login to server success/i;

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

async function connectFrpToPublicDeployment(params: {
  publicBaseHost: string;
  localTargetPort: number;
}) {
  const tmpDir = await mkdtemp(join(tmpdir(), "jonasland-e2e-frpc-"));
  const configPath = join(tmpDir, "frpc.toml");
  const controlHost = `frp__${params.publicBaseHost}`;
  await writeFile(
    configPath,
    [
      `serverAddr = ${tomlString(controlHost)}`,
      "serverPort = 443",
      `transport.protocol = ${tomlString("wss")}`,
      "loginFailExit = false",
      "",
      "[[proxies]]",
      `name = ${tomlString("vitest-cloudflare-tunnel")}`,
      `type = ${tomlString("tcp")}`,
      `localIP = ${tomlString("127.0.0.1")}`,
      `localPort = ${String(params.localTargetPort)}`,
      `remotePort = ${String(FRP_DATA_REMOTE_PORT)}`,
      "",
    ].join("\n"),
    "utf8",
  );

  const logs: string[] = [];
  const frpc = spawn("frpc", ["-c", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    let lastLoggedSnapshot = "";
    while (Date.now() < deadline) {
      if (frpc.exitCode !== null) {
        throw new Error(`frpc exited early with code ${String(frpc.exitCode)}:\n${logs.join("")}`);
      }
      const snapshot = logs.join("");
      if (snapshot !== lastLoggedSnapshot && snapshot.trim().length > 0) {
        lastLoggedSnapshot = snapshot;
        console.log("[cloudflare-tunnel.e2e] frpc progress", snapshot.trim());
      }
      if (/bad status/i.test(snapshot)) {
        throw new Error(`frpc rejected by public control host ${controlHost}:\n${snapshot}`);
      }
      if (FRP_READY_REGEX.test(snapshot)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for frpc to connect to ${controlHost}:\n${logs.join("")}`);
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

function requireSemaphoreWorkerEnv() {
  const semaphoreWorkerUrl = process.env.SEMAPHORE_E2E_BASE_URL?.trim();
  const semaphoreWorkerApiKey = (
    process.env.SEMAPHORE_E2E_API_TOKEN ?? process.env.SEMAPHORE_API_TOKEN
  )?.trim();

  if (!semaphoreWorkerUrl) {
    throw new Error(
      "SEMAPHORE_E2E_BASE_URL is required for the Cloudflare tunnel semaphore fixture",
    );
  }
  if (!semaphoreWorkerApiKey) {
    throw new Error(
      "SEMAPHORE_E2E_API_TOKEN (or SEMAPHORE_API_TOKEN) is required for the Cloudflare tunnel semaphore fixture",
    );
  }

  return {
    semaphoreWorkerUrl,
    semaphoreWorkerApiKey,
  };
}

describe("cloudflare tunnel", () => {
  test(
    "deployment-managed semaphore-backed tunnel becomes deployment ingress",
    {
      tags: ["docker", "third-party"],
      timeout: 240_000,
    },
    async ({ expect, e2e }) => {
      console.log("[cloudflare-tunnel.e2e] test start", {
        testSlug: e2e.testSlug,
        deploymentSlug: e2e.deploymentSlug,
      });
      const semaphoreWorker = requireSemaphoreWorkerEnv();
      const { image } = DockerDeploymentTestEnv.parse(process.env);
      console.log("[cloudflare-tunnel.e2e] creating deployment", { image });
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
      await using cloudflareTunnel = await useCloudflareTunnelFromSemaphore({
        semaphoreWorkerUrl: semaphoreWorker.semaphoreWorkerUrl,
        semaphoreWorkerApiKey: semaphoreWorker.semaphoreWorkerApiKey,
      });
      const tunnelUrl = `https://${cloudflareTunnel.publicHostname}`;
      console.log("[cloudflare-tunnel.e2e] leased semaphore tunnel", {
        slug: cloudflareTunnel.slug,
        publicHostname: cloudflareTunnel.publicHostname,
        expiresAt: cloudflareTunnel.expiresAt,
      });

      await f.deployment.setEnvVars(
        {
          CLOUDFLARE_TUNNEL_ENABLED: "true",
          CLOUDFLARE_TUNNEL_TOKEN: cloudflareTunnel.tunnelToken,
          CLOUDFLARE_TUNNEL_PUBLIC_URL: tunnelUrl,
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
      console.log("[cloudflare-tunnel.e2e] cloudflare tunnel reported healthy");

      console.log("[cloudflare-tunnel.e2e] tunnel url", tunnelUrl);
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
      console.log("[cloudflare-tunnel.e2e] created ingress proxy routes", {
        publicBaseHost: routes.publicBaseHost,
        routeIds: routes.routeIds,
      });

      await f.deployment.pidnap.processes.waitFor({
        processes: {
          frps: "running",
        },
        timeoutMs: 30_000,
      });
      console.log("[cloudflare-tunnel.e2e] frps process is running");

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
      console.log("[cloudflare-tunnel.e2e] registry resolved frp public url", {
        expectedFrpPublicUrl,
      });

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
      console.log("[cloudflare-tunnel.e2e] mock http server ready", {
        harPath,
        port: recordingProxy.port,
      });

      await using frpTunnel = await connectFrpToPublicDeployment({
        publicBaseHost: routes.publicBaseHost,
        localTargetPort: recordingProxy.port,
      });
      console.log("[cloudflare-tunnel.e2e] starting frpc", {
        controlServerHost: `frp__${routes.publicBaseHost}`,
        localTargetPort: recordingProxy.port,
      });
      await frpTunnel.waitUntilConnected();
      console.log("[cloudflare-tunnel.e2e] frpc connected");

      await deployment.setEnvVars({
        ITERATE_EGRESS_PROXY: frpTunnel.proxyUrl,
      });
      console.log("[cloudflare-tunnel.e2e] configured iterate egress proxy", {
        proxyUrl: frpTunnel.proxyUrl,
      });

      await deployment.shellWithRetry({
        cmd: "curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:27180/__iterate/health",
        timeoutMs: 30_000,
        retryIf: (result) => result.output.trim() === "000" || result.exitCode !== 0,
      });
      console.log("[cloudflare-tunnel.e2e] frp data proxy health check passed");

      console.log("[cloudflare-tunnel.e2e] running deployment curl", {
        url: "https://example.com/",
      });
      const curlResult = await deployment.shell({
        cmd: "curl -fsSL https://example.com/",
      });
      console.log("[cloudflare-tunnel.e2e] deployment curl completed", {
        exitCode: curlResult.exitCode,
        outputPreview: curlResult.output.slice(0, 200),
      });
      expect(curlResult).toMatchObject({
        exitCode: 0,
        output: expect.stringContaining("Example Domain"),
      });

      await recordingProxy.writeHar(harPath);
      console.log("[cloudflare-tunnel.e2e] wrote har file", { harPath });
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
      console.log("[cloudflare-tunnel.e2e] har urls", recordedUrls);
      expect(recordedUrls).toContain("https://example.com/");

      console.log("[cloudflare-tunnel.e2e] deployment env", f.deployment.env);
      console.log("[cloudflare-tunnel.e2e] frpc logs", frpTunnel.logs());
    },
  );
});
