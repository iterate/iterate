import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DockerDeployment, FlyDeployment } from "@iterate-com/shared/jonasland/deployment";
import { startFlyFrpEgressBridge } from "../../test-helpers/frp-egress-bridge.ts";
import { waitForBuiltInServicesOnline } from "../../test-helpers/deployment-bootstrap.ts";
import { mockEgressProxy } from "../../test-helpers/mock-egress-proxy.ts";
import { useDockerPublicIngress } from "../../test-helpers/use-docker-public-ingress.ts";

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

type ProviderCase = {
  label: "docker" | "docker-public" | "fly";
  enabled: boolean;
  deploymentFactory:
    | ReturnType<typeof DockerDeployment.createWithConfig<{ dockerImage: string }>>
    | ReturnType<typeof FlyDeployment.createWithConfig<{ flyImage: string }>>;
  setupPublicIngress?: boolean;
};

const providers: ProviderCase[] = [
  {
    label: "docker",
    enabled: (runAllProviders || providerEnv === "docker") && runDockerLocal,
    deploymentFactory: DockerDeployment.createWithConfig({ dockerImage: DOCKER_IMAGE }),
    setupPublicIngress: false,
  },
  {
    label: "docker-public",
    enabled: (runAllProviders || providerEnv === "docker") && runDockerPublic,
    deploymentFactory: DockerDeployment.createWithConfig({ dockerImage: DOCKER_IMAGE }),
    setupPublicIngress: true,
  },
  {
    label: "fly",
    enabled: (runAllProviders || providerEnv === "fly") && FLY_IMAGE.trim().length > 0,
    deploymentFactory: FlyDeployment.createWithConfig({ flyImage: FLY_IMAGE }),
    setupPublicIngress: false,
  },
];

for (const { label, enabled, deploymentFactory, setupPublicIngress } of providers) {
  describe.runIf(enabled)(`example end2end (${label})`, () => {
    test("egress request is observable from the test runner", async () => {
      await using proxy = await mockEgressProxy();
      await using deployment = await deploymentFactory({
        name: `jonasland-e2e-clean-example-${label}-${randomUUID().slice(0, 8)}`,
      });
      await waitForBuiltInServicesOnline({ deployment });
      await using _publicIngress =
        setupPublicIngress && deployment instanceof DockerDeployment
          ? await useDockerPublicIngress({
              deployment,
              testSlug: `example-${label}`,
            })
          : undefined;

      const requestPath = "/v1/chat/completions";

      proxy.fetch = async () =>
        Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello from mock" } }],
        });

      const runEgressCheck = async (proxyUrl: string, options?: { expectForwarded: boolean }) => {
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
        if (options?.expectForwarded) {
          expect(record.request.headers.get("forwarded")?.toLowerCase()).toContain("host=");
          expect(record.request.headers.get("forwarded")?.toLowerCase()).toContain("proto=");
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
        await runEgressCheck(frpBridge.dataProxyUrl, { expectForwarded: true });
        return;
      }

      await runEgressCheck(proxy.proxyUrl, { expectForwarded: false });
    }, 300_000);
  });
}
