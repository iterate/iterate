import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import { useMitmProxy, useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { DockerDeploymentTestEnv } from "../../test-helpers/deployment-test-env.ts";
import { useCloudflareTunnel } from "../../test-helpers/old/use-cloudflare-tunnel.ts";
import { resolveIngressProxyConfig } from "../../test-helpers/old/public-ingress-config.ts";
import { useIngressProxyRoutes } from "../../test-helpers/old/use-ingress-proxy-routes.ts";
import { test } from "../../test-support/e2e-test.ts";

describe("egress", () => {
  test(
    "docker deployment reaches a host-side HTTP proxy through public ingress and FRP",
    {
      tags: ["providers/docker", "third-party-dependency"],
      timeout: 240_000,
    },
    async ({ expect, e2e }) => {
      const { image } = DockerDeploymentTestEnv.parse(process.env);

      // [[ This should not exist - the e2e fixture should do it implicitly when e2e.useIngressProxyRoutes() is used ]]
      const ingress = resolveIngressProxyConfig();

      const deployment = await Deployment.create({
        provider: createDockerProvider({}),
        opts: {
          slug: e2e.deploymentSlug,
          image,
        },
      });

      // [[ should take timeout for becoming alive ]]
      await using f = await e2e.useDeployment({ deployment });

      // [[ Not needed - e2e.useDeployment() should do that ]]
      await f.deployment.waitUntilAlive({
        signal: AbortSignal.timeout(60_000),
      });

      const localPort = Number(new URL(deployment.baseUrl).port);
      if (!Number.isFinite(localPort) || localPort <= 0) {
        throw new Error(`docker deployment baseUrl has no local port: ${deployment.baseUrl}`);
      }

      // [[ The cloudflare tunnel process should be run _inside_ the container - can just have f.useCloudflareTunnel(), which calls deployment.shell or something in the container and returns the URL and points at localhost:80 ]]
      await using cloudflareTunnel = await useCloudflareTunnel({
        localPort,
        cloudflaredBin: process.env.JONASLAND_E2E_CLOUDFLARED_BIN,
        timeoutMs: 60_000,
        waitForReady: false,
      });

      const publicBaseHost = `${e2e.testSlug
        .toLowerCase()
        .replaceAll(/[^a-z0-9-]+/g, "-")
        .replaceAll(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 32)}-${randomUUID().slice(0, 6)}.${ingress.ingressProxyDomain}`;

      // [[ should be f.useIngressProxyRoutes(), which should check the env vars then ]]
      await using routes = await useIngressProxyRoutes({
        ingressProxyApiKey: ingress.ingressProxyApiKey,
        ingressProxyBaseUrl: ingress.ingressProxyBaseUrl,
        routes: [
          {
            metadata: {
              // [[ add deployment snapshot ]]
              source: "jonasland-vitest-egress-docker-only-manual",
              testId: e2e.testId,
              publicBaseHost,
            },
            patterns: [
              {
                pattern: publicBaseHost,
                target: cloudflareTunnel.tunnelUrl,
              },
              {
                pattern: `*__${publicBaseHost}`,
                target: cloudflareTunnel.tunnelUrl,
              },
            ],
          },
        ],
      });
      expect(routes.routeIds.length).toBe(1);

      // [[ should be f.deployment.updateIngressConfig() ]]
      await deployment.updateIngressConfig({
        ingressHost: publicBaseHost,
        ingressHostType: "dunder-prefix",
      });

      // There should be some helper on deployment for this and in any case updateIngressConfig should not return until this isachieved
      let publicCaddyHealth = "";
      const publicCaddyHealthUrl = `https://${publicBaseHost}/__iterate/caddy-health`;
      const publicCaddyDeadline = Date.now() + 60_000;
      while (Date.now() < publicCaddyDeadline) {
        try {
          const response = await fetch(publicCaddyHealthUrl, {
            signal: AbortSignal.timeout(10_000),
          });
          const body = await response.text();
          if (response.ok && body.includes("ok")) {
            publicCaddyHealth = body;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(publicCaddyHealth).toContain("ok");

      // [[ should use pidnap processes.waitFor - see if frps can have a healthcheck ]]

      let frpPublicUrl = "";
      const frpPublicUrlDeadline = Date.now() + 60_000;
      while (Date.now() < frpPublicUrlDeadline) {
        try {
          const result = await deployment.registryService.getPublicURL({
            internalURL: "http://frp.iterate.localhost",
          });
          if (result.publicURL === `https://frp__${publicBaseHost}/`) {
            frpPublicUrl = result.publicURL;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(frpPublicUrl).toBe(`https://frp__${publicBaseHost}/`);

      await using mockHttpProxy = await useMockHttpServer({
        onUnhandledRequest: "bypass",
        recorder: {
          enabled: true,
          harPath: join(e2e.outputDir, "example-com.har"),
        },
      });

      // [[ This is not needed i think?! the mockHttpProxy can directly be used as the frp tunnel target ]]
      await using externalHttpProxy = await useMitmProxy({
        proxyTargetUrl: mockHttpProxy.url,
      });

      const frpcConfigDir = await mkdtemp(join(tmpdir(), "jonasland-e2e-frpc-"));
      const frpcConfigPath = join(frpcConfigDir, "frpc.toml");
      // [[ This seems kinda crazy - can we not pass this in as CLI args or something?
      await writeFile(
        frpcConfigPath,
        [
          `serverAddr = "frp__${publicBaseHost}"`,
          "serverPort = 443",
          'transport.protocol = "wss"',
          "loginFailExit = false",
          "",
          "[[proxies]]",
          'name = "vitest-egress-docker-only-manual"',
          'type = "tcp"',
          'localIP = "127.0.0.1"',
          `localPort = ${String(externalHttpProxy.port)}`,
          "remotePort = 27180",
          "",
        ].join("\n"),
        "utf8",
      );

      const frpcLogs: string[] = [];
      const frpc = spawn(process.env.JONASLAND_E2E_FRPC_BIN || "frpc", ["-c", frpcConfigPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      frpc.stdout.on("data", (chunk) => {
        frpcLogs.push(String(chunk));
      });
      frpc.stderr.on("data", (chunk) => {
        frpcLogs.push(String(chunk));
      });

      await using _frpTunnel = {
        async [Symbol.asyncDispose]() {
          if (frpc.exitCode === null && frpc.signalCode === null) {
            frpc.kill("SIGTERM");
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          if (frpc.exitCode === null && frpc.signalCode === null) {
            frpc.kill("SIGKILL");
          }
          await rm(frpcConfigDir, { recursive: true, force: true }).catch(() => {});
        },
      };

      const frpcDeadline = Date.now() + 45_000;
      while (Date.now() < frpcDeadline) {
        if (frpc.exitCode !== null) {
          throw new Error(
            `frpc exited early with code ${String(frpc.exitCode)}:\n${frpcLogs.join("")}`,
          );
        }
        const output = frpcLogs.join("");
        if (
          /start proxy success/i.test(output) ||
          /proxy added successfully/i.test(output) ||
          /login to server success/i.test(output)
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (
        !/start proxy success|proxy added successfully|login to server success/i.test(
          frpcLogs.join(""),
        )
      ) {
        throw new Error(`timed out waiting for frpc to connect:\n${frpcLogs.join("")}`);
      }

      // [[ this won't do as a constant - how does localhost 27180 know which frpc client to forward the traffic to? need explain ]]
      await deployment.updateEgressConfig({
        egressProxyURL: "http://127.0.0.1:27180",
      });
      // [[ this tests that updateEgressConfig works as intended - that shouldn't be necessary  ]]

      expect(
        await deployment.shell({
          cmd: "rg '^ITERATE_EGRESS_PROXY=http://127.0.0.1:27180$' ~/.iterate/.env",
        }),
      ).toMatchObject({
        exitCode: 0,
        output: expect.stringContaining("ITERATE_EGRESS_PROXY=http://127.0.0.1:27180"),
      });

      const curlResult = await deployment.shell({
        cmd: "curl -fsSL --proxy http://127.0.0.1:27180 http://example.com/",
      });
      expect(curlResult).toMatchObject({
        exitCode: 0,
        output: expect.stringContaining("Example Domain"),
      });
    },
  );
});
