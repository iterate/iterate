import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  DockerDeployment,
  FlyDeployment,
  MockEgressProxy,
  startFlyFrpEgressBridge,
  type Deployment,
} from "../test-helpers/index.ts";

type ProviderName = "docker" | "fly";

type ProviderCase = {
  name: ProviderName;
  enabled: boolean;
  create: () => Promise<Deployment>;
};

const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runAllProviders = providerEnv === "all";

const DOCKER_IMAGE = "jonasland-sandbox:local";
const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";

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
  return `jonasland-vitest-${provider}-${workerId}-${slug}`;
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

function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const maybeCode = (error as { code?: string }).code;
  const message = error.message.toLowerCase();
  return (
    maybeCode === "ECONNRESET" ||
    maybeCode === "EPIPE" ||
    maybeCode === "ETIMEDOUT" ||
    message.includes("econnreset") ||
    message.includes("socket hang up") ||
    message.includes("und_err_socket")
  );
}

async function retry<T>(task: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i < attempts; i += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (i === attempts - 1 || !isTransientError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (i + 1)));
    }
  }

  throw lastError;
}

async function postEventsOrpc(
  deployment: Deployment,
  procedure: string,
  body: unknown,
): Promise<{ exitCode: number; output: string }> {
  return await deployment.exec([
    "curl",
    "-fsS",
    "-H",
    "Host: events.iterate.localhost",
    "-H",
    "content-type: application/json",
    "--data",
    JSON.stringify({ json: body }),
    `http://127.0.0.1/orpc/${procedure}`,
  ]);
}

for (const provider of providerCases) {
  // Tip: run a single provider with `pnpm jonasland e2e -t docker` or `-t fly`.
  describe.runIf(provider.enabled)(`deployment abstraction parity (${provider.name})`, () => {
    test("core control plane + events orpc append/list works", async () => {
      await using deployment = await provider.create();

      const streamPath = `frp-parity/events/${randomUUID().slice(0, 8)}`;
      const appendResult = await retry(
        async () =>
          await postEventsOrpc(deployment, "append", {
            path: streamPath,
            events: [
              {
                type: "https://events.iterate.com/events/test/e2e-recorded",
                payload: { ok: true },
              },
            ],
          }),
        6,
      );
      expect(appendResult.exitCode).toBe(0);
      expect(appendResult.output).toBe("{}");

      const listResult = await retry(
        async () => await postEventsOrpc(deployment, "listStreams", {}),
        6,
      );
      expect(listResult.exitCode).toBe(0);
      const parsed = JSON.parse(listResult.output) as {
        json: Array<{ path: string; eventCount: number }>;
      };
      const expectedPath = `/${streamPath}`;
      expect(
        parsed.json.some((entry) => entry.path === expectedPath && entry.eventCount >= 1),
      ).toBe(true);
    }, 900_000);

    test("frp + egress external-proxy mode delivers payload to local vitest mock", async () => {
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

      const requestPath = "/vitest-frp-external";
      const payload = JSON.stringify({
        source: `${provider.name}-frp-external`,
      });
      const observed = proxy.waitFor((request) => new URL(request.url).pathname === requestPath);
      proxy.fetch = async (request) =>
        Response.json({
          ok: true,
          path: new URL(request.url).pathname,
          mode: "external-proxy",
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
      expect(curl.output).toContain('"ok":true');
      expect(curl.output.toLowerCase()).toContain("x-iterate-egress-mode: external-proxy");
      expect(curl.output.toLowerCase()).toContain("x-iterate-egress-proxy-seen: 1");

      // Slightly clunky for now: register mock observation before the request
      // to avoid even theoretical race windows.
      const { request, response } = await observed;
      expect(new URL(request.url).pathname).toBe(requestPath);
      expect(await request.text()).toBe(payload);
      expect(request.headers.get("host")).toContain("127.0.0.1:27180");
      expect(response.status).toBe(200);
    }, 900_000);
  });
}
