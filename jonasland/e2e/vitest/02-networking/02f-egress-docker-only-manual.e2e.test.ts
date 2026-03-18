import { join } from "node:path";
import { describe } from "vitest";
import { useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { z } from "zod/v4";
import { DockerDeploymentTestEnv } from "../../test-helpers/deployment-test-env.ts";
import {
  useDeploymentManagedCloudflareTunnel,
  useDeploymentManagedFrpService,
  useFrpTunnelToPublicDeployment,
} from "../../test-helpers/use-deployment-network-services.ts";
import { test } from "../../test-support/e2e-test.ts";

const TokenBackedTunnelEnv = z.object({
  CLOUDFLARE_TUNNEL_TOKEN: z.string().trim().min(1),
  CLOUDFLARE_TUNNEL_PUBLIC_URL: z.url(),
});

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

      await using f = await e2e.useDeployment({ deployment });

      const tokenTunnelEnv = TokenBackedTunnelEnv.parse(process.env);
      await f.deployment.waitUntilHealthy({
        timeoutMs: 60_000,
      });
      await using cloudflareTunnel = await useDeploymentManagedCloudflareTunnel({
        deployment: f.deployment,
        tunnelToken: tokenTunnelEnv.CLOUDFLARE_TUNNEL_TOKEN,
        publicURL: tokenTunnelEnv.CLOUDFLARE_TUNNEL_PUBLIC_URL,
        timeoutMs: 60_000,
      });

      await using routes = await f.useIngressProxyRoutes({
        targetURL: cloudflareTunnel.publicURL,
        routingType: "dunder-prefix",
        timeoutMs: 60_000,
        metadata: {
          source: "jonasland-vitest-egress-docker-only-manual",
          deployment: f.snapshot(),
        },
      });

      await using frpService = await useDeploymentManagedFrpService({
        deployment: f.deployment,
        publicBaseHost: routes.publicBaseHost,
        timeoutMs: 30_000,
      });
      expect(frpService.publicURL).toBe(`https://frp__${routes.publicBaseHost}/`);

      await using mockHttpProxy = await useMockHttpServer({
        onUnhandledRequest: "bypass",
        recorder: {
          enabled: true,
          harPath: join(e2e.outputDir, "example-com.har"),
        },
      });

      await using frpTunnel = await useFrpTunnelToPublicDeployment({
        publicBaseHost: routes.publicBaseHost,
        localTargetPort: mockHttpProxy.port,
        name: "vitest-egress-docker-only-manual",
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
