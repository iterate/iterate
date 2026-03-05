import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DockerDeployment, FlyDeployment } from "@iterate-com/shared/jonasland/deployment";
import { waitForBuiltInServicesOnline } from "../../test-helpers/deployment-bootstrap.ts";
import {
  allocateLoopbackPort,
  buildIngressPublicBaseUrl,
  resolveIngressProxyConfig,
} from "../../test-helpers/public-ingress-config.ts";
import { useCloudflareTunnel } from "../../test-helpers/use-cloudflare-tunnel.ts";

const DOCKER_IMAGE = process.env.JONASLAND_E2E_DOCKER_IMAGE ?? "jonasland-sandbox:local";
const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? "";

const dockerAccessModes = new Set(
  (process.env.JONASLAND_E2E_DOCKER_ACCESS_MODES ?? "local")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0),
);
const runDockerPublic = dockerAccessModes.has("all") || dockerAccessModes.has("public-ingress");
const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runFly = providerEnv === "fly" || providerEnv === "all";

type ProviderRuntime = {
  deployment: DockerDeployment | FlyDeployment;
  tunnel?: AsyncDisposable;
};

type ProviderCase = {
  label: "docker" | "docker-public" | "fly";
  enabled: boolean;
  create: () => Promise<ProviderRuntime>;
};

const providers: ProviderCase[] = [
  {
    label: "docker",
    enabled: providerEnv === "docker" || providerEnv === "all",
    create: async () => ({
      deployment: await DockerDeployment.create({
        dockerImage: DOCKER_IMAGE,
        name: `jonasland-e2e-clean-bootstrap-docker-${randomUUID().slice(0, 8)}`,
      }),
    }),
  },
  {
    label: "docker-public",
    enabled: (providerEnv === "docker" || providerEnv === "all") && runDockerPublic,
    create: async () => {
      const ingress = resolveIngressProxyConfig();
      const ingressHostPort = await allocateLoopbackPort();
      const tunnel = await useCloudflareTunnel({
        localPort: ingressHostPort,
        cloudflaredBin: process.env.JONASLAND_E2E_CLOUDFLARED_BIN,
      });
      const publicBaseHost = buildIngressPublicBaseUrl({
        testSlug: "bootstrap-docker-public",
        ingressProxyDomain: ingress.ingressProxyDomain,
      });

      const deployment = await DockerDeployment.create({
        dockerImage: DOCKER_IMAGE,
        name: `jonasland-e2e-clean-bootstrap-docker-public-${randomUUID().slice(0, 8)}`,
        ingressHostPort,
        ingress: {
          publicBaseHost,
          publicBaseHostType: "prefix",
          createIngressProxyRoutes: true,
          ingressProxyBaseUrl: ingress.ingressProxyBaseUrl,
          ingressProxyApiKey: ingress.ingressProxyApiKey,
          ingressProxyTargetUrl: tunnel.tunnelUrl,
        },
      }).catch(async (error) => {
        try {
          await Promise.resolve(tunnel[Symbol.asyncDispose]());
        } catch {}
        throw error;
      });

      return { deployment, tunnel };
    },
  },
  {
    label: "fly",
    enabled: runFly && FLY_IMAGE.trim().length > 0,
    create: async () => ({
      deployment: await FlyDeployment.create({
        flyImage: FLY_IMAGE,
        flyApiToken: process.env.FLY_API_TOKEN!,
        flyBaseDomain: process.env.FLY_BASE_DOMAIN ?? "fly.dev",
        name: `jonasland-e2e-clean-bootstrap-fly-${randomUUID().slice(0, 8)}`,
      }),
    }),
  },
];

for (const provider of providers) {
  describe.runIf(provider.enabled)(
    `clean bootstrap + on-demand service (${provider.label})`,
    () => {
      test("boot built-ins, start docs via pidnap, serve through public ingress hostname", async () => {
        const runtime = await provider.create();
        await using deployment = runtime.deployment;
        await using _tunnel = runtime.tunnel;

        await waitForBuiltInServicesOnline({ deployment });

        const docsPort = 19050;
        await deployment.pidnap.processes.updateConfig({
          processSlug: "docs",
          definition: {
            command: "npx",
            args: ["tsx", "services/docs/src/server.ts"],
            env: { PORT: String(docsPort) },
          },
          tags: ["on-demand"],
          restartImmediately: true,
          healthCheck: {
            url: "http://docs.iterate.localhost/api/__iterate/health",
            intervalMs: 2_000,
          },
        });
        await deployment.pidnap.processes.waitForRunning({
          processSlug: "docs",
          timeoutMs: 60_000,
        });

        const { publicURL: publicDocsHealthUrl } = await deployment.registry.getPublicURL({
          internalURL: "http://docs.iterate.localhost/api/__iterate/health",
        });

        const response = await fetch(publicDocsHealthUrl, {
          signal: AbortSignal.timeout(90_000),
        });
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(body.toLowerCase()).toContain("ok");
      }, 600_000);
    },
  );
}
