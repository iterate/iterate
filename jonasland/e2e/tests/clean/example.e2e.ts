import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DockerDeployment, FlyDeployment } from "@iterate-com/shared/jonasland/deployment";
import { MockEgressProxy } from "../../test-helpers/mock-egress-proxy.ts";
import { startFlyFrpEgressBridge } from "../../test-helpers/frp-egress-bridge.ts";

const DOCKER_IMAGE = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";
const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const dockerEgressMode = (process.env.JONASLAND_E2E_DOCKER_EGRESS_MODE ?? "host")
  .trim()
  .toLowerCase();

const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runAllProviders = providerEnv === "all";

// Run a single provider with `pnpm jonasland e2e -t docker` or `-t fly`.
const providers = [
  {
    label: "docker",
    enabled: runAllProviders || providerEnv === "docker",
    create: async () =>
      await DockerDeployment.withConfig({ image: DOCKER_IMAGE }).create({
        name: `jonasland-e2e-clean-example-docker-${randomUUID().slice(0, 8)}`,
      }),
  },
  {
    label: "fly",
    enabled: (runAllProviders || providerEnv === "fly") && FLY_IMAGE.trim().length > 0,
    create: async () =>
      await FlyDeployment.withConfig({ image: FLY_IMAGE }).create({
        name: `jonasland-e2e-clean-example-fly-${randomUUID().slice(0, 8)}`,
      }),
  },
];

for (const { label, enabled, create } of providers) {
  describe.runIf(enabled)(`example end2end (${label})`, () => {
    test("egress request is observable from the test runner", async () => {
      let step = "create proxy";
      const proxy = await MockEgressProxy.create();
      let deployment: Awaited<ReturnType<typeof create>> | undefined;
      let frpBridge: Awaited<ReturnType<typeof startFlyFrpEgressBridge>> | undefined;

      try {
        step = "create deployment";
        deployment = await create();

        const useFrpBridge = label === "fly" || (label === "docker" && dockerEgressMode === "frp");
        if (useFrpBridge) {
          step = "start frp bridge";
          frpBridge = await startFlyFrpEgressBridge({
            deployment,
            localTargetPort: proxy.port,
            frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
          });
        }

        step = "configure egress proxy";
        await deployment.useEgressProxy({
          proxyUrl: frpBridge?.dataProxyUrl ?? proxy.proxyUrl,
        });

        const requestPath = "/v1/chat/completions";
        step = "subscribe proxy waitFor";
        const observed = proxy.waitFor((req) => new URL(req.url).pathname === requestPath, {
          timeout: 10_000,
        });

        proxy.fetch = async () =>
          Response.json({
            id: "chatcmpl-mock",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "Hello from mock" } }],
          });

        step = "run egress curl";
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

        step = "await observed request";
        const record = await observed;
        expect(new URL(record.request.url).pathname).toBe(requestPath);
        expect(record.response.status).toBe(200);
      } catch (error) {
        const deploymentLogs =
          deployment !== undefined
            ? await deployment
                .logs()
                .catch(
                  (logsError) =>
                    `failed to fetch deployment logs: ${logsError instanceof Error ? logsError.message : String(logsError)}`,
                )
            : "deployment was not created";
        const frpLogs = frpBridge?.clientLogs() ?? "frp bridge was not started";

        throw new Error(
          `example end2end (${label}) failed during: ${step}\nfrp logs:\n${frpLogs}\ndeployment logs:\n${deploymentLogs}`,
          { cause: error },
        );
      } finally {
        if (frpBridge !== undefined) {
          await frpBridge[Symbol.asyncDispose]();
        }
        if (deployment !== undefined) {
          await deployment[Symbol.asyncDispose]();
        }
        await proxy.close();
      }
    }, 900_000);
  });
}
