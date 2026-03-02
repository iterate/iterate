import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DockerDeployment, FlyDeployment } from "@iterate-com/shared/jonasland/deployment";
import { startFlyFrpEgressBridge } from "../../test-helpers/frp-egress-bridge.ts";
import { MockEgressProxy } from "../../test-helpers/mock-egress-proxy.ts";

const DOCKER_IMAGE = process.env.JONASLAND_E2E_DOCKER_IMAGE ?? "jonasland-sandbox:local";
const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? "";

const dockerEgressMode = (process.env.JONASLAND_E2E_DOCKER_EGRESS_MODE ?? "host")
  .trim()
  .toLowerCase();
const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runAllProviders = providerEnv === "all";

const providers = [
  {
    label: "docker",
    enabled: runAllProviders || providerEnv === "docker",
    deploymentFactory: DockerDeployment.createWithConfig({ dockerImage: DOCKER_IMAGE }),
  },
  {
    label: "fly",
    enabled: (runAllProviders || providerEnv === "fly") && FLY_IMAGE.trim().length > 0,
    deploymentFactory: FlyDeployment.createWithConfig({ flyImage: FLY_IMAGE }),
  },
] as const;

for (const { label, enabled, deploymentFactory } of providers) {
  describe.runIf(enabled)(`example end2end (${label})`, () => {
    test("egress request is observable from the test runner", async () => {
      await using proxy = await MockEgressProxy.create();
      await using deployment = await deploymentFactory({
        name: `jonasland-e2e-clean-example-${label}-${randomUUID().slice(0, 8)}`,
      });

      const requestPath = "/v1/chat/completions";

      proxy.fetch = async () =>
        Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello from mock" } }],
        });

      const runEgressCheck = async (proxyUrl: string) => {
        await deployment.useEgressProxy({ proxyUrl });
        const observed = proxy.waitFor((req) => new URL(req.url).pathname === requestPath, {
          timeout: label === "fly" ? 120_000 : 20_000,
        });

        const payloadJson = JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "say hello" }],
        });
        const curl = await deployment.exec([
          "sh",
          "-ec",
          [
            "curl -4 -k -sS -i",
            "-H 'content-type: application/json'",
            `--data '${payloadJson.replaceAll("'", "'\"'\"'")}'`,
            `https://api.openai.com${requestPath}`,
          ].join(" "),
        ]);

        expect(curl.exitCode).toBe(0);
        expect(curl.output).toMatch(/HTTP\/\d(?:\.\d)? 200/);
        expect(curl.output).toContain("chatcmpl-mock");

        const record = await observed;
        expect(new URL(record.request.url).pathname).toBe(requestPath);
        expect(record.response.status).toBe(200);
      };

      const useFrpBridge = label === "fly" || (label === "docker" && dockerEgressMode === "frp");
      if (useFrpBridge) {
        await using frpBridge = await startFlyFrpEgressBridge({
          deployment,
          localTargetPort: proxy.port,
          frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
        });
        await runEgressCheck(frpBridge.dataProxyUrl);
        return;
      }

      await runEgressCheck(proxy.proxyUrl);
    }, 900_000);
  });
}
