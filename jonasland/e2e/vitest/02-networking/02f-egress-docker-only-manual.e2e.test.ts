import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  CLOUDFLARE_TUNNEL_TOKEN: z.string().trim().min(1),
  CLOUDFLARE_TUNNEL_PUBLIC_URL: z.url(),
});

function tomlString(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      `name = ${tomlString("vitest-egress-docker-only-manual")}`,
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

describe("egress", () => {
  test(
    "docker deployment reaches a host-side HTTP proxy through public ingress and FRP",
    {
      tags: ["docker", "third-party"],
      timeout: 240_000,
    },
    async ({ expect, e2e }) => {
      const { image } = DockerDeploymentTestEnv.parse(process.env);

      const deployment = await Deployment.create({
        provider: createDockerProvider({}),
        opts: {
          slug: e2e.deploymentSlug,
          image,
        },
      });

      await using f = await e2e.useDeployment({
        deployment,
        waitUntilHealthyTimeoutMs: 60_000,
      });

      const tokenTunnelEnv = TokenBackedTunnelEnv.safeParse(process.env);
      await f.deployment.setEnvVars(
        {
          CLOUDFLARE_TUNNEL_ENABLED: "true",
          CLOUDFLARE_TUNNEL_TOKEN: tokenTunnelEnv.success
            ? tokenTunnelEnv.data.CLOUDFLARE_TUNNEL_TOKEN
            : "",
          CLOUDFLARE_TUNNEL_PUBLIC_URL: tokenTunnelEnv.success
            ? tokenTunnelEnv.data.CLOUDFLARE_TUNNEL_PUBLIC_URL
            : "",
        },
        {
          waitForHealthy: false,
        },
      );
      await f.deployment.waitUntilHealthy({
        timeoutMs: 60_000,
      });
      await f.deployment.pidnap.processes.waitFor({
        processes: {
          "cloudflare-tunnel": "healthy",
        },
        timeoutMs: 60_000,
      });
      const cloudflareTunnelUrl = tokenTunnelEnv.success
        ? tokenTunnelEnv.data.CLOUDFLARE_TUNNEL_PUBLIC_URL
        : await f.deployment.getCloudflareTunnelUrl({
            timeoutMs: 60_000,
          });

      await using routes = await f.useIngressProxyRoutes({
        targetURL: cloudflareTunnelUrl,
        routingType: "dunder-prefix",
        timeoutMs: 60_000,
        metadata: {
          source: "jonasland-vitest-egress-docker-only-manual",
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

      await using mockHttpProxy = await useMockHttpServer({
        onUnhandledRequest: "bypass",
        recorder: {
          enabled: true,
          harPath: join(e2e.outputDir, "example-com.har"),
        },
      });

      await using frpTunnel = await useFrpTunnel({
        controlServerHost: `frp__${routes.publicBaseHost}`,
        controlServerPort: 443,
        controlTransportProtocol: "wss",
        localTargetPort: mockHttpProxy.port,
      });
      await frpTunnel.waitUntilConnected();

      // FRP always exposes the data proxy on remote port 27180. The active
      // client session is selected by the control connection we just opened
      // against `frp__${publicBaseHost}`.
      await deployment.setEnvVars({
        ITERATE_EGRESS_PROXY: frpTunnel.proxyUrl,
      });

      const curlResult = await deployment.shell({
        cmd: `curl -fsSL --proxy ${frpTunnel.proxyUrl} http://example.com/`,
      });
      expect(curlResult).toMatchObject({
        exitCode: 0,
        output: expect.stringContaining("Example Domain"),
      });
    },
  );
});
