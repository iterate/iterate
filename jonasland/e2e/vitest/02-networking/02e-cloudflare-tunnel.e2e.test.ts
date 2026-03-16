import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe } from "vitest";
import { useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { z } from "zod/v4";
import {
  useDeploymentManagedCloudflareTunnel,
  useDeploymentManagedFrpService,
  useFrpTunnelToPublicDeployment,
} from "../../test-helpers/use-deployment-network-services.ts";
import { useCloudflareTunnelFromSemaphore } from "../../test-helpers/use-cloudflare-tunnel-from-semaphore.ts";
import { test } from "../../test-support/e2e-test.ts";

const CloudflareTunnelTestEnv = z.object({
  JONASLAND_SANDBOX_IMAGE: z.string().trim().min(1),
  SEMAPHORE_API_TOKEN: z.string().trim().min(1),
  SEMAPHORE_BASE_URL: z.string().trim().min(1),
  E2E_NO_DISPOSE: z.string().optional(),
});

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
      const env = CloudflareTunnelTestEnv.parse(process.env);
      console.log("[cloudflare-tunnel.e2e] creating deployment", {
        image: env.JONASLAND_SANDBOX_IMAGE,
      });
      const deployment = await Deployment.create({
        provider: createDockerProvider({}),
        opts: {
          slug: e2e.deploymentSlug,
          image: env.JONASLAND_SANDBOX_IMAGE,
          env: {
            DOCKER_HOST_SYNC_ENABLED: "true",
          },
        },
      });

      await using f = await e2e.useDeployment({ deployment });
      await using cloudflareTunnel = await useCloudflareTunnelFromSemaphore({
        apiToken: env.SEMAPHORE_API_TOKEN,
        baseUrl: env.SEMAPHORE_BASE_URL,
        leaseMs: 10 * 60 * 1000,
        waitMs: 60_000,
      });
      await f.deployment.waitUntilHealthy({
        timeoutMs: 60_000,
      });
      const tunnelUrl = `https://${cloudflareTunnel.publicHostname}`;
      await using managedTunnel = await useDeploymentManagedCloudflareTunnel({
        deployment: f.deployment,
        tunnelToken: cloudflareTunnel.tunnelToken,
        publicURL: tunnelUrl,
        timeoutMs: 60_000,
      });

      console.log("[cloudflare-tunnel.e2e] tunnel url", tunnelUrl);

      await using routes = await f.useIngressProxyRoutes({
        targetURL: managedTunnel.publicURL,
        routingType: "dunder-prefix",
        timeoutMs: 60_000,
        metadata: {
          source: "jonasland-vitest-cloudflare-tunnel",
          deployment: f.snapshot(),
        },
      });
      console.log("[cloudflare-tunnel.e2e] created ingress proxy routes", {
        publicBaseHost: routes.publicBaseHost,
        rootHost: routes.route.rootHost,
      });

      await using frpService = await useDeploymentManagedFrpService({
        deployment: f.deployment,
        publicBaseHost: routes.publicBaseHost,
        timeoutMs: 30_000,
      });
      console.log("[cloudflare-tunnel.e2e] frps process is running");

      const expectedFrpPublicUrl = `https://frp__${routes.publicBaseHost}/`;
      console.log("[cloudflare-tunnel.e2e] registry resolved frp public url", {
        expectedFrpPublicUrl,
      });

      expect(frpService.publicURL).toBe(expectedFrpPublicUrl);

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

      await using frpTunnel = await useFrpTunnelToPublicDeployment({
        publicBaseHost: routes.publicBaseHost,
        localTargetPort: recordingProxy.port,
        name: "vitest-cloudflare-tunnel",
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
