import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DockerDeployment, FlyDeployment } from "@iterate-com/shared/jonasland/deployment";
import { startFlyFrpEgressBridge } from "../../test-helpers/frp-egress-bridge.ts";
import { waitForBuiltInServicesOnline } from "../../test-helpers/deployment-bootstrap.ts";
import { mockEgressProxy } from "../../test-helpers/mock-egress-proxy.ts";
import {
  allocateLoopbackPort,
  buildIngressPublicBaseUrl,
  resolveIngressProxyConfig,
} from "../../test-helpers/public-ingress-config.ts";
import { useCloudflareTunnel } from "../../test-helpers/use-cloudflare-tunnel.ts";

const DOCKER_IMAGE = process.env.JONASLAND_E2E_DOCKER_IMAGE ?? "jonasland-sandbox:local";
const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? "";

const dockerEgressMode = (process.env.JONASLAND_E2E_DOCKER_EGRESS_MODE ?? "host")
  .trim()
  .toLowerCase();
const dockerAccessModes = new Set(
  (process.env.JONASLAND_E2E_DOCKER_ACCESS_MODES ?? "local")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0),
);
const runDockerLocal =
  dockerAccessModes.has("all") || dockerAccessModes.has("local") || dockerAccessModes.size === 0;
const runDockerPublic = dockerAccessModes.has("all") || dockerAccessModes.has("public-ingress");
const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runAllProviders = providerEnv === "all";

type ProviderRuntime = {
  deployment: DockerDeployment | FlyDeployment;
  tunnel?: AsyncDisposable;
};

type ProviderCase = {
  label: "docker" | "docker-public" | "fly";
  enabled: boolean;
  create: (name: string) => Promise<ProviderRuntime>;
};

const providers: ProviderCase[] = [
  {
    label: "docker",
    enabled: (runAllProviders || providerEnv === "docker") && runDockerLocal,
    create: async (name) => ({
      deployment: await DockerDeployment.createWithOpts({ dockerImage: DOCKER_IMAGE }).create({
        name,
      }),
    }),
  },
  {
    label: "docker-public",
    enabled: (runAllProviders || providerEnv === "docker") && runDockerPublic,
    create: async (name) => {
      const ingress = resolveIngressProxyConfig();
      const ingressHostPort = await allocateLoopbackPort();
      const tunnel = await useCloudflareTunnel({
        localPort: ingressHostPort,
        cloudflaredBin: process.env.JONASLAND_E2E_CLOUDFLARED_BIN,
      });
      const publicBaseUrl = buildIngressPublicBaseUrl({
        testSlug: `example-${name}`,
        ingressProxyDomain: ingress.ingressProxyDomain,
      });

      const deployment = await DockerDeployment.create({
        dockerImage: DOCKER_IMAGE,
        name,
        ingressHostPort,
        ingress: {
          publicBaseUrl,
          publicBaseUrlType: "prefix",
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
    enabled: (runAllProviders || providerEnv === "fly") && FLY_IMAGE.trim().length > 0,
    create: async (name) => ({
      deployment: await FlyDeployment.createWithOpts({
        flyImage: FLY_IMAGE,
        flyApiToken: process.env.FLY_API_TOKEN!,
        flyBaseDomain: process.env.FLY_BASE_DOMAIN ?? "fly.dev",
      }).create({
        name,
      }),
    }),
  },
];

for (const { label, enabled, create } of providers) {
  describe.runIf(enabled)(`example end2end (${label})`, () => {
    test("egress request is observable from the test runner", async () => {
      await using proxy = await mockEgressProxy();
      const runtime = await create(
        `jonasland-e2e-clean-example-${label}-${randomUUID().slice(0, 8)}`,
      );
      await using deployment = runtime.deployment;
      await using _tunnel = runtime.tunnel;
      await waitForBuiltInServicesOnline({ deployment });

      const requestPath = "/v1/chat/completions";

      proxy.fetch = async () =>
        Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello from mock" } }],
        });

      const runEgressCheck = async (
        proxyUrl: string,
        options?: { expectForwardingHeaders: boolean },
      ) => {
        const observed = proxy.waitFor((req) => new URL(req.url).pathname === requestPath, {
          timeout: label === "fly" ? 120_000 : 20_000,
        });
        const targetUrl = new URL(requestPath, proxyUrl).toString();

        const payloadJson = JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "say hello" }],
        });
        const curl = await deployment.exec([
          "sh",
          "-ec",
          [
            "curl -4 -sS -i",
            "-H 'content-type: application/json'",
            `--data '${payloadJson.replaceAll("'", "'\"'\"'")}'`,
            `'${targetUrl}'`,
          ].join(" "),
        ]);

        expect(curl.exitCode).toBe(0);
        expect(curl.output).toMatch(/HTTP\/\d(?:\.\d)? 200/);
        expect(curl.output).toContain("chatcmpl-mock");

        const record = await observed;
        expect(new URL(record.request.url).pathname).toBe(requestPath);
        if (options?.expectForwardingHeaders) {
          expect(record.request.headers.get("x-forwarded-host")).toBeTruthy();
          expect(record.request.headers.get("x-forwarded-proto")).toBeTruthy();
        }
        expect(record.response.status).toBe(200);
      };

      const useFrpBridge =
        label === "fly" ||
        ((label === "docker" || label === "docker-public") && dockerEgressMode === "frp");
      if (useFrpBridge) {
        const frpDataProxyUrl = "http://127.0.0.1:27180";
        await deployment.useEgressProxy({ proxyUrl: frpDataProxyUrl });
        await using frpBridge = await startFlyFrpEgressBridge({
          deployment,
          localTargetPort: proxy.port,
          frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
        });
        await runEgressCheck(frpBridge.dataProxyUrl, { expectForwardingHeaders: true });
        return;
      }

      await runEgressCheck(proxy.proxyUrl, { expectForwardingHeaders: false });
    }, 300_000);
  });
}
