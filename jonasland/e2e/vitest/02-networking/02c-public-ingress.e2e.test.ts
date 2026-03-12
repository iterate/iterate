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
import { useCloudflareTunnelToLocalhost } from "../../test-helpers/old/use-cloudflare-tunnel.ts";
import { test } from "../../test-support/e2e-test.ts";

/**
 * Legacy migration notes from deleted `jonasland/e2e/tests/clean/playground.e2e.test.ts`.
 *
 * That file was a manual operator workflow rather than a CI assertion:
 *
 * - create a Docker deployment
 * - expose it through a Cloudflare tunnel
 * - create root and wildcard ingress proxy routes that forward with a fixed
 *   `Host` header
 * - print the resulting URLs
 * - wait for `SIGINT` so a human could manually poke at the setup
 *
 * If we revive that behavior, keep it as an explicit manual harness or a
 * skipped/debug-only test rather than something the normal suite runs in CI.
 */
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

async function waitForPublicText(params: {
  url: string;
  timeoutMs: number;
  matches: (body: string) => boolean;
}) {
  console.log("[public-ingress] waiting for public URL", {
    url: params.url,
    timeoutMs: params.timeoutMs,
  });
  const deadline = Date.now() + params.timeoutMs;
  let lastFailure = "no response";
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const response = await fetch(params.url, {
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      if (response.ok && params.matches(body)) {
        console.log("[public-ingress] public URL ready", {
          url: params.url,
          attempt,
          status: response.status,
          bodyPreview: body.slice(0, 200),
        });
        return body;
      }
      lastFailure = `status=${String(response.status)} body=${body.slice(0, 200)}`;
      console.log("[public-ingress] public URL not ready", {
        url: params.url,
        attempt,
        status: response.status,
        bodyPreview: body.slice(0, 200),
      });
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      console.log("[public-ingress] public URL fetch failed", {
        url: params.url,
        attempt,
        error: lastFailure,
      });
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${params.url}: ${lastFailure}`);
}

async function waitForRegistryPublicUrl(params: {
  deployment: Deployment;
  internalURL: string;
  expectedPublicURL: string;
  timeoutMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await params.deployment.registryService.getPublicURL({
        internalURL: params.internalURL,
      });
      if (result.publicURL === params.expectedPublicURL) return result;
    } catch {
      // Registry can briefly restart while ingress env changes are applied.
    }
    await sleep(500);
  }
  throw new Error(
    `registry public URL for ${params.internalURL} did not stabilize to ${params.expectedPublicURL}`,
  );
}

type PublicExposure = AsyncDisposable & {
  targetUrl: string;
  targetHost: string;
};

const cases = [
  {
    id: "docker" as const,
    tags: ["docker", "third-party"] as const,
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
      const tunnel = await useCloudflareTunnelToLocalhost({
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
    tags: ["fly", "slow", "third-party"] as const,
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
        console.log("[public-ingress] starting test", {
          testId: e2e.testId,
          testSlug: e2e.testSlug,
          deploymentSlug: e2e.deploymentSlug,
          timeoutMs,
        });

        await using f = await e2e.useDeployment({
          deployment: await createDeployment({ slug: e2e.deploymentSlug }),
        });

        console.log("[public-ingress] deployment created", {
          baseUrl: f.deployment.baseUrl,
          deploymentSlug: f.deployment.opts.slug,
        });

        await f.deployment.waitUntilAlive({
          signal: AbortSignal.timeout(timeoutMs),
        });
        console.log("[public-ingress] deployment reported alive", {
          baseUrl: f.deployment.baseUrl,
        });

        const pidnapConfigs = serviceManifestToPidnapConfig({
          manifests: [exampleServiceManifest],
        });
        console.log("[public-ingress] derived pidnap configs", {
          count: pidnapConfigs.length,
          processSlugs: pidnapConfigs.map((config) => config.processSlug),
        });

        for (const config of pidnapConfigs) {
          console.log("[public-ingress] applying pidnap config", {
            processSlug: config.processSlug,
          });
          await f.deployment.pidnap.processes.updateConfig(config);
        }
        await f.deployment.pidnap.processes.waitFor({
          processes: {
            [exampleServiceManifest.slug]: "healthy",
          },
          timeoutMs: 10_000,
        });
        console.log("[public-ingress] example service is healthy", {
          slug: exampleServiceManifest.slug,
        });

        await using exposure = await exposePublicTarget({ deployment: f.deployment, timeoutMs });
        console.log("[public-ingress] public target exposed", {
          targetUrl: exposure.targetUrl,
          targetHost: exposure.targetHost,
        });
        await using routes = await f.useIngressProxyRoutes({
          targetURL: exposure.targetUrl,
          routingType: "dunder-prefix",
          timeoutMs,
          metadata: {
            source: "jonasland-vitest-public-ingress",
            publicTargetHost: exposure.targetHost,
          },
        });
        const { publicBaseHost, publicBaseUrl } = routes;
        console.log("[public-ingress] ingress proxy routes created", {
          routeIds: routes.routeIds,
          publicBaseHost,
          publicBaseUrl,
          ingressHost: f.deployment.env.ITERATE_INGRESS_HOST,
        });

        const resolvedPublicURL = await waitForRegistryPublicUrl({
          deployment: f.deployment,
          internalURL: "http://example.iterate.localhost",
          expectedPublicURL: `https://example__${publicBaseHost}/`,
          timeoutMs,
        });
        console.log("[public-ingress] registry public URL stabilized", resolvedPublicURL);

        const caddyHealth = await waitForPublicText({
          url: `${publicBaseUrl}/__iterate/caddy-health`,
          timeoutMs,
          matches: (body) => body.includes("ok"),
        });
        console.log("[public-ingress] caddy health response", caddyHealth);
        expect(caddyHealth).toContain("ok");

        const echoBody = await waitForPublicText({
          url: `https://example__${publicBaseHost}/api/echo?from=public-ingress-test`,
          timeoutMs,
          matches: (body) => body.includes("public-ingress-test"),
        });
        console.log("[public-ingress] public example echo response", echoBody);
        const payload = parseJsonFromResponse(echoBody);
        console.log("[public-ingress] parsed public example echo payload", payload);
        expect(String(payload.url)).toContain("/api/echo?from=public-ingress-test");
        expect(String(payload.host)).toBe(`example__${publicBaseHost}`);
        const headers = payload.headers as Record<string, string>;
        console.log("[public-ingress] public example echo headers", headers);
        expect(String(headers["x-forwarded-host"] ?? "")).toBe(`example__${publicBaseHost}`);
        expect(String(headers["x-iterate-resolved-service"] ?? "")).toBe("example");
        console.log("[public-ingress] test completed successfully", {
          publicBaseHost,
          resolvedService: headers["x-iterate-resolved-service"] ?? null,
        });
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
