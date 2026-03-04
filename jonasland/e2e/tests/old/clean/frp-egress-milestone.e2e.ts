import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  DockerDeployment,
  FlyDeployment,
  type Deployment,
} from "@iterate-com/shared/jonasland/deployment";
import { startFlyFrpEgressBridge } from "../../test-helpers/frp-egress-bridge.ts";
import { mockEgressProxy } from "../../test-helpers/mock-egress-proxy.ts";
import {
  allocateLoopbackPort,
  buildIngressPublicBaseUrl,
  resolveIngressProxyConfig,
} from "../../test-helpers/public-ingress-config.ts";
import { useCloudflareTunnel } from "../../test-helpers/use-cloudflare-tunnel.ts";

type ProviderName = "docker" | "docker-public" | "fly";

type ProviderRuntime = {
  deployment: Deployment;
  tunnel?: AsyncDisposable;
};

type ProviderCase = {
  name: ProviderName;
  enabled: boolean;
  create: () => Promise<ProviderRuntime>;
};

const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runAllProviders = providerEnv === "all";
const dockerAccessModes = new Set(
  (process.env.JONASLAND_E2E_DOCKER_ACCESS_MODES ?? "local")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0),
);
const runDockerLocal =
  dockerAccessModes.has("all") || dockerAccessModes.has("local") || dockerAccessModes.size === 0;
const runDockerPublic = dockerAccessModes.has("all") || dockerAccessModes.has("public-ingress");

const DOCKER_IMAGE = process.env.JONASLAND_E2E_DOCKER_IMAGE ?? "jonasland-sandbox:local";
const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? "";

const providerCases: ProviderCase[] = [
  {
    name: "docker",
    enabled: (runAllProviders || providerEnv === "docker") && runDockerLocal,
    create: async () => ({
      deployment: await DockerDeployment.createWithOpts({
        dockerImage: DOCKER_IMAGE,
      }).create({
        name: deploymentNameForCurrentTest("docker"),
      }),
    }),
  },
  {
    name: "docker-public",
    enabled: (runAllProviders || providerEnv === "docker") && runDockerPublic,
    create: async () => {
      const ingress = resolveIngressProxyConfig();
      const ingressHostPort = await allocateLoopbackPort();
      const tunnel = await useCloudflareTunnel({
        localPort: ingressHostPort,
        cloudflaredBin: process.env.JONASLAND_E2E_CLOUDFLARED_BIN,
      });
      const publicBaseHost = buildIngressPublicBaseUrl({
        testSlug: "frp-egress-milestone-docker-public",
        ingressProxyDomain: ingress.ingressProxyDomain,
      });

      const deployment = await DockerDeployment.create({
        dockerImage: DOCKER_IMAGE,
        name: deploymentNameForCurrentTest("docker"),
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
    name: "fly",
    enabled: (runAllProviders || providerEnv === "fly") && FLY_IMAGE.trim().length > 0,
    create: async () => ({
      deployment: await FlyDeployment.createWithOpts({
        flyImage: FLY_IMAGE,
        flyApiToken: process.env.FLY_API_TOKEN!,
        flyBaseDomain: process.env.FLY_BASE_DOMAIN ?? "fly.dev",
      }).create({
        name: deploymentNameForCurrentTest("fly"),
      }),
    }),
  },
];

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

async function withTimeout<T>(params: {
  promise: Promise<T>;
  timeoutMs: number;
  message: string;
}): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(params.message)), params.timeoutMs);
    params.promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function waitForFirehoseEvent(params: {
  deployment: Deployment;
  path: string;
  type: string;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const deadline = Date.now() + (params.timeoutMs ?? 120_000);
  const normalizedPath = params.path.replace(/^\/+/, "");
  let lastError: unknown;

  while (Date.now() < deadline) {
    const stream = await params.deployment.events.firehose({});
    if (!stream || typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
      throw new Error(`events.firehose() returned non-iterator: ${String(stream)}`);
    }
    const firehose = stream[Symbol.asyncIterator]();
    try {
      while (Date.now() < deadline) {
        const remainingMs = Math.max(1, deadline - Date.now());
        const nextEvent = await withTimeout<IteratorResult<unknown>>({
          promise: firehose.next(),
          timeoutMs: Math.min(remainingMs, 15_000),
          message: "timed out waiting for next firehose event chunk",
        });
        if (nextEvent.done) {
          break;
        }

        const event = nextEvent.value as Record<string, unknown>;
        const eventType = String(event["type"] ?? "");
        const eventPath = String(event["path"] ?? "").replace(/^\/+/, "");
        if (eventType === params.type && eventPath === normalizedPath) {
          return event;
        }
      }
    } catch (error) {
      lastError = error;
    } finally {
      await firehose.return?.().catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `timed out waiting for matching firehose event (${params.type} @ ${params.path})`,
    {
      cause: lastError,
    },
  );
}

for (const provider of providerCases) {
  // Tip: run a single provider with `pnpm jonasland e2e -t docker` or `-t fly`.
  describe.runIf(provider.enabled)(`frp egress milestone (${provider.name})`, () => {
    test("routes external-proxy egress via frp to local mock", async () => {
      await using proxy = await mockEgressProxy();

      const runtime = await provider.create();
      await using deployment = runtime.deployment;
      await using _tunnel = runtime.tunnel;

      await using frpBridge = await startFlyFrpEgressBridge({
        deployment,
        localTargetPort: proxy.port,
        frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
      });

      await deployment.useEgressProxy({ proxyUrl: frpBridge.dataProxyUrl });

      const requestPath = "/vitest-frp-milestone";
      const payload = JSON.stringify({
        source: `${provider.name}-frp-milestone`,
      });
      const observed = proxy.waitFor((request) => new URL(request.url).pathname === requestPath, {
        timeout: provider.name === "fly" ? 180_000 : 30_000,
      });
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

      const { request, response } = await observed;
      expect(new URL(request.url).pathname).toBe(requestPath);
      expect(await request.text()).toBe(payload);
      expect(request.headers.get("host")).toContain("127.0.0.1:27180");
      expect(request.headers.get("x-forwarded-host")).toBeTruthy();
      expect(request.headers.get("x-forwarded-proto")).toBeTruthy();
      expect(response.status).toBe(200);
    }, 900_000);

    test("events firehose SSE emits appended event", async () => {
      const runtime = await provider.create();
      await using deployment = runtime.deployment;
      await using _tunnel = runtime.tunnel;

      const streamPath = `frp-milestone/events/${randomUUID().slice(0, 8)}`;
      const expectedType = "https://events.iterate.com/events/test/frp-milestone-sse";
      const expectedPayload = {
        source: `${provider.name}-firehose`,
        run: randomUUID().slice(0, 8),
      };

      const observed = waitForFirehoseEvent({
        deployment,
        path: streamPath,
        type: expectedType,
        timeoutMs: 120_000,
      });
      let matched = false;
      observed
        .then(() => {
          matched = true;
        })
        .catch(() => {});

      for (let attempt = 0; attempt < 24 && !matched; attempt += 1) {
        await deployment.events.append({
          path: streamPath,
          events: [
            {
              type: expectedType,
              payload: expectedPayload,
            },
          ],
        });
        if (matched) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const event = await observed;
      expect(String(event["path"]).replace(/^\/+/, "")).toBe(streamPath);
      expect(String(event["type"])).toBe(expectedType);
      expect(event["payload"]).toEqual(expectedPayload);
    }, 900_000);
  });
}
