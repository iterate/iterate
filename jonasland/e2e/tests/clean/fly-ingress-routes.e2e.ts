import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { FlyDeployment } from "@iterate-com/shared/jonasland/deployment";

const DEFAULT_INGRESS_PROXY_BASE_URL = "https://ingress.iterate.com";
const DEFAULT_INGRESS_PROXY_DOMAIN = "ingress.iterate.com";

const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runFly = providerEnv === "fly" || providerEnv === "all";
const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? "";

type IngressRouteRecord = {
  routeId: string;
  metadata: Record<string, unknown>;
  patterns: Array<{ pattern: string }>;
};

type IngressProxyClient = {
  listRoutes: () => Promise<IngressRouteRecord[]>;
};

function resolveIngressProxyConfig() {
  const baseUrl = (
    process.env.JONASLAND_E2E_INGRESS_PROXY_BASE_URL ??
    process.env.INGRESS_PROXY_BASE_URL ??
    DEFAULT_INGRESS_PROXY_BASE_URL
  )
    .trim()
    .replace(/\/+$/, "");
  const domain = (
    process.env.JONASLAND_E2E_INGRESS_PROXY_DOMAIN ??
    process.env.INGRESS_PROXY_DOMAIN ??
    DEFAULT_INGRESS_PROXY_DOMAIN
  ).trim();
  const apiToken = (
    process.env.INGRESS_PROXY_API_TOKEN ??
    process.env.INGRESS_PROXY_E2E_API_TOKEN ??
    ""
  ).trim();

  if (!apiToken) {
    throw new Error(
      "Missing ingress proxy API token (set INGRESS_PROXY_API_TOKEN or INGRESS_PROXY_E2E_API_TOKEN)",
    );
  }

  return {
    baseUrl,
    domain,
    apiToken,
  };
}

async function callIngressProxyProcedure<TResponse>(params: {
  baseUrl: string;
  apiToken: string;
  name: string;
  input: unknown;
}): Promise<TResponse> {
  const response = await fetch(`${params.baseUrl}/api/orpc/${params.name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ json: params.input }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    json?: TResponse;
    error?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      `ingress proxy ${params.name} failed (${response.status}): ${JSON.stringify(payload.json ?? payload.error ?? payload)}`,
    );
  }

  if (payload.json === undefined) {
    throw new Error(`ingress proxy ${params.name} returned no json payload`);
  }

  return payload.json;
}

function createIngressProxyClient(params: {
  baseUrl: string;
  apiToken: string;
}): IngressProxyClient {
  return {
    listRoutes: async () =>
      await callIngressProxyProcedure<IngressRouteRecord[]>({
        baseUrl: params.baseUrl,
        apiToken: params.apiToken,
        name: "listRoutes",
        input: undefined,
      }),
  };
}

describe.runIf(runFly)("clean fly ingress routes", () => {
  test("creates and deletes ingress routes with deployment lifecycle", async () => {
    if (FLY_IMAGE.trim().length === 0) {
      throw new Error("Set JONASLAND_E2E_FLY_IMAGE for Fly tests");
    }

    const ingressProxyConfig = resolveIngressProxyConfig();
    const ingressClient = createIngressProxyClient(ingressProxyConfig);

    const createdRouteIds: string[] = [];
    let deployment: FlyDeployment | undefined;

    try {
      deployment = await FlyDeployment.createWithConfig({
        flyImage: FLY_IMAGE,
      }).create({
        name: `jonasland-e2e-clean-fly-ingress-routes-${randomUUID().slice(0, 8)}`,
      });

      const locator = deployment.getDeploymentLocator();
      const expectedBasePattern = `${locator.appName}.${ingressProxyConfig.domain}`;
      const expectedWildcardPattern = `*__${locator.appName}.${ingressProxyConfig.domain}`;

      const ingressUrl = await deployment.ingressUrl();
      expect(new URL(ingressUrl).host).toBe(expectedBasePattern);

      const routes = await ingressClient.listRoutes();
      const ownedRoutes = routes.filter((route) =>
        route.patterns.some(
          (pattern) =>
            pattern.pattern === expectedBasePattern || pattern.pattern === expectedWildcardPattern,
        ),
      );

      expect(ownedRoutes.length).toBeGreaterThanOrEqual(1);

      const observedPatterns = ownedRoutes
        .flatMap((route) => route.patterns.map((pattern) => pattern.pattern))
        .sort();
      expect(observedPatterns).toEqual([expectedBasePattern, expectedWildcardPattern].sort());

      createdRouteIds.push(...ownedRoutes.map((route) => route.routeId));
    } finally {
      if (deployment) {
        await deployment[Symbol.asyncDispose]();
      }
    }

    const remainingRouteIds = new Set(
      (await ingressClient.listRoutes()).map((route) => route.routeId),
    );
    for (const routeId of createdRouteIds) {
      expect(remainingRouteIds.has(routeId)).toBe(false);
    }
  }, 300_000);
});
