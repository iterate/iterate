import { describe, expect, test } from "vitest";
import {
  DockerDeployment,
  FlyDeployment,
  MockEgressProxy,
  startFlyFrpEgressBridge,
  type Deployment,
} from "../../test-helpers/index.ts";

type ProviderName = "docker" | "fly";

type ProviderCase = {
  name: ProviderName;
  enabled: boolean;
  create: () => Promise<Deployment>;
};

const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runAllProviders = providerEnv === "all";

const DOCKER_IMAGE = "jonasland-sandbox:local";
const FLY_IMAGE =
  process.env.JONASLAND_E2E_FLY_IMAGE ??
  process.env.FLY_DEFAULT_IMAGE ??
  process.env.JONASLAND_SANDBOX_IMAGE ??
  "";

function slugifyForName(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 32);
}

function deploymentNameForCurrentTest(provider: ProviderName): string {
  const currentTestName = expect.getState().currentTestName ?? "unnamed-test";
  const workerId = process.env.VITEST_WORKER_ID ?? "0";
  const slug = slugifyForName(currentTestName);
  return `jonasland-vtest-${provider}-${workerId}-${slug}`;
}

const providerCases: ProviderCase[] = [
  {
    name: "docker",
    enabled: runAllProviders || providerEnv === "docker",
    create: async () =>
      await DockerDeployment.withConfig({
        image: DOCKER_IMAGE,
      }).create({
        name: deploymentNameForCurrentTest("docker"),
      }),
  },
  {
    name: "fly",
    enabled: (runAllProviders || providerEnv === "fly") && FLY_IMAGE.trim().length > 0,
    create: async () =>
      await FlyDeployment.withConfig({
        image: FLY_IMAGE,
      }).create({
        name: deploymentNameForCurrentTest("fly"),
      }),
  },
];

for (const provider of providerCases) {
  // Tip: run one provider with `pnpm jonasland e2e -t docker` or `-t fly`.
  describe.runIf(provider.enabled)(`example end2end (${provider.name})`, () => {
    test("egress request is observable from the test runner", async () => {
      await using proxy = await MockEgressProxy.create();
      await using deployment = await provider.create();

      await using frpBridge = await startFlyFrpEgressBridge({
        deployment,
        localTargetPort: proxy.port,
        frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
      });

      const egressProcess = await deployment.pidnap.processes.get({
        target: "egress-proxy",
        includeEffectiveEnv: false,
      });
      await deployment.pidnap.processes.updateConfig({
        processSlug: "egress-proxy",
        definition: {
          ...egressProcess.definition,
          env: {
            ...(egressProcess.definition.env ?? {}),
            ITERATE_EXTERNAL_EGRESS_PROXY: frpBridge.dataProxyUrl,
          },
        },
        options: {
          restartPolicy: "always",
        },
        restartImmediately: true,
      });
      await deployment.pidnap.processes.start({ target: "egress-proxy" }).catch(() => {});
      await deployment.waitForPidnapProcessRunning({ target: "egress-proxy" });

      const requestPath = "/example-end2end";
      const payload = JSON.stringify({
        source: "example-end2end",
        provider: provider.name,
      });

      // Slightly clunky for now: register waitFor before making the request
      // to avoid race conditions.
      const observed = proxy.waitFor((request) => new URL(request.url).pathname === requestPath);

      proxy.fetch = async (request) =>
        Response.json({
          ok: true,
          path: new URL(request.url).pathname,
          echoedBody: await request.text(),
        });

      const curl = await deployment.exec([
        "curl",
        "-4",
        "-k",
        "-sS",
        "-i",
        "-H",
        "content-type: application/json",
        "--data",
        payload,
        `https://api.openai.com${requestPath}`,
      ]);

      expect(curl.exitCode).toBe(0);
      expect(curl.output).toMatch(/HTTP\/\d(?:\.\d)? 200/);

      const curlBody =
        curl.output
          .split(/\r?\n\r?\n/)
          .at(-1)
          ?.trim() ?? "";
      const curlJson = JSON.parse(curlBody) as {
        ok: boolean;
        path: string;
        echoedBody: string;
      };
      expect(curlJson.ok).toBe(true);
      expect(curlJson.path).toBe(requestPath);
      expect(curlJson.echoedBody).toBe(payload);

      const { request, response } = await observed;
      expect(new URL(request.url).pathname).toBe(requestPath);
      expect(await request.text()).toBe(payload);
      expect(response.status).toBe(200);

      const observedJson = (await response.json()) as {
        ok: boolean;
        path: string;
        echoedBody: string;
      };
      expect(observedJson.ok).toBe(true);
      expect(observedJson.path).toBe(requestPath);
      expect(observedJson.echoedBody).toBe(payload);
    }, 900_000);
  });
}
