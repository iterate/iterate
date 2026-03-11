import { describe } from "vitest";
import { exampleServiceManifest } from "@iterate-com/example-contract";
import { serviceManifestToPidnapConfig } from "@iterate-com/shared/jonasland";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { createFlyProvider } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import {
  DockerDeploymentTestEnv,
  FlyDeploymentTestEnv,
} from "../../test-helpers/deployment-test-env.ts";
import { useCloudflareTunnel } from "../../test-helpers/old/use-cloudflare-tunnel.ts";
import { useIngressProxyRoutes } from "../../test-helpers/old/use-ingress-proxy-routes.ts";
import { test } from "../../test-support/e2e-test.ts";
import {
  buildIngressPublicBaseUrl,
  resolveIngressProxyConfig,
} from "../../test-helpers/old/public-ingress-config.ts";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonFromResponse(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("empty response body");
  }
  return JSON.parse(trimmed) as Record<string, unknown>;
}

async function waitForRouteRegistered(params: {
  deployment: Deployment;
  host: string;
  timeoutMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const listed = await params.deployment.registryService.routes.list({});
      if (listed.routes.some((route) => route.host === params.host)) return;
    } catch {
      // Registry can briefly restart while process definitions are applied.
    }
    await sleep(500);
  }
  throw new Error(`route ${params.host} not registered within ${String(params.timeoutMs)}ms`);
}

async function curlWithHost(params: { deployment: Deployment; host: string; path: string }) {
  return await params.deployment.exec([
    "curl",
    "-fsS",
    "--max-time",
    "10",
    "-H",
    `Host: ${params.host}`,
    `http://127.0.0.1${params.path}`,
  ]);
}

async function waitForInternalRoute(params: {
  deployment: Deployment;
  host: string;
  path: string;
  timeoutMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const result = await curlWithHost({
      deployment: params.deployment,
      host: params.host,
      path: params.path,
    }).catch(() => null);
    if (result?.exitCode === 0) return result.output;
    lastOutput = result?.output ?? lastOutput;
    await sleep(500);
  }
  throw new Error(
    `internal route ${params.host}${params.path} did not become reachable${lastOutput ? `: ${lastOutput}` : ""}`,
  );
}

async function waitForPublicText(params: {
  url: string;
  timeoutMs: number;
  matches: (body: string) => boolean;
}) {
  const deadline = Date.now() + params.timeoutMs;
  let lastFailure = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(params.url, {
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      if (response.ok && params.matches(body)) return body;
      lastFailure = `status=${String(response.status)} body=${body.slice(0, 200)}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${params.url}: ${lastFailure}`);
}

type PublicExposure = AsyncDisposable & {
  targetUrl: string;
  targetHost: string;
};

const cases = [
  {
    id: "docker" as const,
    tags: ["providers/docker", "third-party-dependency"] as const,
    timeoutMs: 60_000,
    createDeployment: async ({ slug }: { slug: string }) => {
      const env = DockerDeploymentTestEnv.parse(process.env);
      return await Deployment.create({
        provider: createDockerProvider({}),
        opts: {
          slug,
          image: env.image,
        },
      });
    },
    exposePublicTarget: async ({
      deployment,
      timeoutMs,
    }: {
      deployment: Deployment;
      timeoutMs: number;
    }) => {
      const port = Number(new URL(deployment.baseUrl).port);
      if (!Number.isFinite(port) || port <= 0) {
        throw new Error(`docker deployment baseUrl has no local port: ${deployment.baseUrl}`);
      }
      const tunnel = await useCloudflareTunnel({
        localPort: port,
        cloudflaredBin: process.env.JONASLAND_E2E_CLOUDFLARED_BIN,
        timeoutMs,
        waitForReady: false,
      });
      return {
        targetUrl: tunnel.tunnelUrl,
        targetHost: new URL(tunnel.tunnelUrl).host,
        async [Symbol.asyncDispose]() {
          await tunnel[Symbol.asyncDispose]();
        },
      } satisfies PublicExposure;
    },
  },
  {
    id: "fly" as const,
    tags: ["providers/fly", "slow", "third-party-dependency"] as const,
    timeoutMs: 180_000,
    createDeployment: async ({ slug }: { slug: string }) => {
      const env = FlyDeploymentTestEnv.parse(process.env);
      return await Deployment.create({
        provider: createFlyProvider({
          flyApiToken: env.flyApiToken,
        }),
        opts: {
          slug,
          image: env.image,
        },
      });
    },
    exposePublicTarget: async ({ deployment }: { deployment: Deployment; timeoutMs: number }) => ({
      targetUrl: deployment.baseUrl,
      targetHost: new URL(deployment.baseUrl).host,
      async [Symbol.asyncDispose]() {},
    }),
  },
];

describe("public ingress", () => {
  describe.each(cases)("$id", ({ createDeployment, exposePublicTarget, tags, timeoutMs }) => {
    test(
      "public ingress reaches intended services through root and wildcard ingress proxy route patterns",
      { tags: [...tags], timeout: timeoutMs + 120_000 },
      async ({ expect, e2e }) => {
        const ingress = resolveIngressProxyConfig();
        const deployment = await createDeployment({
          slug: e2e.deploymentSlug,
        });
        await using _deployment = await e2e.useDeployment({ deployment });
        await deployment.waitUntilAlive({
          signal: AbortSignal.timeout(timeoutMs),
        });
        const pidnapConfigs = serviceManifestToPidnapConfig({
          manifests: [exampleServiceManifest],
        });
        for (const config of pidnapConfigs) {
          await deployment.pidnap.processes.updateConfig(config);
        }
        await waitForRouteRegistered({
          deployment,
          host: "example.iterate.localhost",
          timeoutMs,
        });
        await waitForInternalRoute({
          deployment,
          host: "example.iterate.localhost",
          path: "/api/echo?from=internal-public-ingress-readiness",
          timeoutMs,
        });

        await using exposure = await exposePublicTarget({ deployment, timeoutMs });
        const publicBaseUrl = buildIngressPublicBaseUrl({
          testSlug: e2e.testSlug,
          ingressProxyDomain: ingress.ingressProxyDomain,
        });
        const publicBaseHost = new URL(publicBaseUrl).host;
        const wildcardPattern = `*__${publicBaseHost}`;
        await deployment.setEnvVars({
          ITERATE_INGRESS_HOST: publicBaseHost,
          ITERATE_INGRESS_ROUTING_TYPE: "dunder-prefix",
        });

        const registryDeadline = Date.now() + timeoutMs;
        while (Date.now() < registryDeadline) {
          try {
            const result = await deployment.registryService.getPublicURL({
              internalURL: "http://example.iterate.localhost",
            });
            if (result.publicURL.includes(publicBaseHost)) break;
          } catch {
            // Registry may be mid-restart while env-file updates are applied.
          }
          await sleep(500);
        }

        await using routes = await useIngressProxyRoutes({
          ingressProxyApiKey: ingress.ingressProxyApiKey,
          ingressProxyBaseUrl: ingress.ingressProxyBaseUrl,
          routes: [
            {
              metadata: {
                source: "jonasland-vitest-public-ingress",
                publicBaseHost,
              },
              patterns: [
                {
                  pattern: publicBaseHost,
                  target: exposure.targetUrl,
                  headers: { Host: exposure.targetHost },
                },
                {
                  pattern: wildcardPattern,
                  target: exposure.targetUrl,
                  headers: { Host: exposure.targetHost },
                },
              ],
            },
          ],
        });
        expect(routes.routeIds.length).toBe(1);

        const caddyHealth = await waitForPublicText({
          url: `${publicBaseUrl}/__iterate/caddy-health`,
          timeoutMs,
          matches: (body) => body.includes("ok"),
        });
        expect(caddyHealth).toContain("ok");

        const echoBody = await waitForPublicText({
          url: `https://example__${publicBaseHost}/api/echo?from=public-ingress-test`,
          timeoutMs,
          matches: (body) => body.includes("public-ingress-test"),
        });
        const payload = parseJsonFromResponse(echoBody);
        expect(String(payload.url)).toContain("/api/echo?from=public-ingress-test");
        expect(String(payload.host)).toBe(`example__${publicBaseHost}`);
        const headers = payload.headers as Record<string, string>;
        expect(String(headers["x-forwarded-host"] ?? "")).toBe(`example__${publicBaseHost}`);
        expect(String(headers["x-iterate-resolved-service"] ?? "")).toBe("example");
      },
    );
  });
});

/*
Specific test cases 

From within fly and within docker

ITERATE_INGRESS_HOST=whatever
ITERATE_INGRESS_ROUTING_TYPE=dunder-prefix

- GET http://iterate.localhost should work (home service)
- GET http://home.iterate.localhost should work (home service)
- GET http://example.iterate.localhost should work (example service)

then change ITERATE_INGRESS_DEFAULT_SERVICE=example in .env

- GET http://iterate.localhost should work (example service)
- GET http://home.iterate.localhost should work (home service)
- GET http://example.iterate.localhost should work (example service)

then restart (with .env still in tact)

- GET http://iterate.localhost should work (example service)
- GET http://home.iterate.localhost should work (home service)
- GET http://example.iterate.localhost should work (example service)

then test websockets using pnpx wscat or something 

- GET http://events.iterate.localhost should work (events service)

*/
