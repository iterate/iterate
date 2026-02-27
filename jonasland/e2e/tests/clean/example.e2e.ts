import { describe, expect, test } from "vitest";
import { DockerDeployment, FlyDeployment } from "@iterate-com/shared/jonasland/deployment";
import { MockEgressProxy } from "../../test-helpers/mock-egress-proxy.ts";

const DOCKER_IMAGE = "jonasland-sandbox:local";
const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";

const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runAllProviders = providerEnv === "all";

// Run a single provider with `pnpm jonasland e2e -t docker` or `-t fly`.
const providers = [
  {
    label: "docker",
    enabled: runAllProviders || providerEnv === "docker",
    factory: DockerDeployment.withConfig({ image: DOCKER_IMAGE }),
  },
  {
    label: "fly",
    enabled: (runAllProviders || providerEnv === "fly") && FLY_IMAGE.trim().length > 0,
    factory: FlyDeployment.withConfig({ image: FLY_IMAGE }),
  },
];

for (const { label, enabled, factory } of providers) {
  describe.runIf(enabled)(`example end2end (${label})`, () => {
    test("egress request is observable from the test runner", async () => {
      await using proxy = await MockEgressProxy.create();
      await using deployment = await factory.create();
      await deployment.useEgressProxy(proxy);

      const requestPath = "/v1/chat/completions";
      const observed = proxy.waitFor((req) => new URL(req.url).pathname === requestPath, {
        timeout: 10_000,
      });

      proxy.fetch = async () =>
        Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello from mock" } }],
        });

      const curl = await deployment.runEgressRequestViaCurl({
        requestPath,
        payloadJson: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "say hello" }],
        }),
      });

      expect(curl.exitCode).toBe(0);
      expect(curl.output).toMatch(/HTTP\/\d(?:\.\d)? 200/);
      expect(curl.output).toContain("chatcmpl-mock");

      const record = await observed;
      expect(new URL(record.request.url).pathname).toBe(requestPath);
      expect(record.response.status).toBe(200);
    }, 30_000);
  });
}
