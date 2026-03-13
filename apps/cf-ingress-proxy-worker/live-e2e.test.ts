import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const baseUrl = process.env.INGRESS_PROXY_E2E_BASE_URL;
const apiToken = process.env.INGRESS_PROXY_E2E_API_TOKEN ?? process.env.INGRESS_PROXY_API_TOKEN;
const proxyBaseDomain = process.env.INGRESS_PROXY_E2E_PROXY_BASE_DOMAIN?.trim();
const wildcardSubdomainBaseLabel = "example-with-wildcards-for-e2e-tests";

function requireEnv() {
  if (!baseUrl) {
    throw new Error("INGRESS_PROXY_E2E_BASE_URL is required for live E2E tests");
  }
  if (!apiToken) {
    throw new Error("INGRESS_PROXY_E2E_API_TOKEN (or INGRESS_PROXY_API_TOKEN) is required");
  }
  return { baseUrl, apiToken };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableLiveE2eError(error: unknown): boolean {
  if (error instanceof SyntaxError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("Unexpected non-JSON response");
}

function randomSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeProxyHost(baseUrl: string) {
  if (proxyBaseDomain && proxyBaseDomain.length > 0) {
    return `proxy-${randomSuffix()}.${proxyBaseDomain}`;
  }
  return new URL(baseUrl).host;
}

function makeProxyHostCandidates(baseUrl: string) {
  const baseHost = new URL(baseUrl).host;
  const preferred = makeProxyHost(baseUrl);
  return [...new Set([preferred, baseHost])];
}

function makeConflictPatterns(baseUrl: string) {
  const domain =
    proxyBaseDomain && proxyBaseDomain.length > 0 ? proxyBaseDomain : new URL(baseUrl).host;
  const suffix = randomSuffix();
  return {
    existingPattern: `existing-${suffix}.${domain}`,
    conflictingPattern: `existing-${suffix}.${domain}`,
    otherPattern: `other-${suffix}.${domain}`,
  };
}

function makeWildcardSubdomainHost(baseUrl: string) {
  const domain =
    proxyBaseDomain && proxyBaseDomain.length > 0 ? proxyBaseDomain : new URL(baseUrl).host;
  return `bla-${randomSuffix()}.${wildcardSubdomainBaseLabel}.${domain}`;
}

function makeDoubleUnderscoreHost(baseUrl: string) {
  const domain =
    proxyBaseDomain && proxyBaseDomain.length > 0 ? proxyBaseDomain : new URL(baseUrl).host;
  return `bla-${randomSuffix()}__some-other-thing.${domain}`;
}

async function callProcedure<T>(params: {
  name: string;
  input: unknown;
  baseUrl: string;
  apiToken: string;
}): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(`${params.baseUrl}/api/orpc/${params.name}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${params.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ json: params.input }),
      });

      const responseText = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("application/json")) {
        throw new Error(
          `Unexpected non-JSON response (status ${response.status}): ${responseText.slice(0, 200)}`,
        );
      }

      const payload = JSON.parse(responseText) as { json?: T };
      if (!response.ok) {
        throw payload.json;
      }

      return payload.json as T;
    } catch (error) {
      lastError = error;
      if (attempt === 5 || !isRetryableLiveE2eError(error)) {
        throw error;
      }
      await sleep(attempt * 250);
    }
  }

  throw lastError;
}

function createRoute(params: {
  baseUrl: string;
  apiToken: string;
  metadata: Record<string, unknown>;
  patterns: Array<{ pattern: string; target: string; headers?: Record<string, string> }>;
  externalId?: string | null;
}) {
  return callProcedure<{
    routeId: string;
    externalId: string | null;
    metadata: Record<string, unknown>;
    patterns: Array<{ patternId: number; pattern: string; target: string }>;
  }>({
    name: "createRoute",
    input: {
      metadata: params.metadata,
      patterns: params.patterns,
      externalId: params.externalId,
    },
    baseUrl: params.baseUrl,
    apiToken: params.apiToken,
  });
}

function updateRoute(params: {
  baseUrl: string;
  apiToken: string;
  routeId: string;
  metadata: Record<string, unknown>;
  patterns: Array<{ pattern: string; target: string; headers?: Record<string, string> }>;
  externalId?: string | null;
}) {
  return callProcedure<{
    routeId: string;
    externalId: string | null;
    metadata: Record<string, unknown>;
    patterns: Array<{ patternId: number; pattern: string; target: string }>;
  }>({
    name: "updateRoute",
    input: {
      routeId: params.routeId,
      metadata: params.metadata,
      patterns: params.patterns,
      externalId: params.externalId,
    },
    baseUrl: params.baseUrl,
    apiToken: params.apiToken,
  });
}

function deleteRoute(params: {
  baseUrl: string;
  apiToken: string;
  routeId?: string;
  externalId?: string;
}) {
  return callProcedure<{ deleted: boolean }>({
    name: "deleteRoute",
    input: {
      ...(params.routeId ? { routeId: params.routeId } : {}),
      ...(params.externalId ? { externalId: params.externalId } : {}),
    },
    baseUrl: params.baseUrl,
    apiToken: params.apiToken,
  });
}

async function assertProxyRoundTrip(params: {
  env: { baseUrl: string; apiToken: string };
  createdRouteIds: Set<string>;
  suiteId: string;
  host: string;
  protocol?: "http" | "https";
  patterns?: Array<{ pattern: string; target: string; headers?: Record<string, string> }>;
}) {
  const token = randomSuffix();
  const route = await createRoute({
    baseUrl: params.env.baseUrl,
    apiToken: params.env.apiToken,
    metadata: { suiteId: params.suiteId, kind: "proxy-http", proxyHost: params.host },
    patterns: params.patterns ?? [
      {
        pattern: params.host,
        target: "https://postman-echo.com",
        headers: {
          "x-ingress-proxy-e2e": token,
        },
      },
    ],
  });
  params.createdRouteIds.add(route.routeId);

  const protocol = params.protocol ?? "https";
  const response = await fetch(
    `${protocol}://${params.host}/get?token=${encodeURIComponent(token)}`,
    {
      headers: {
        "x-ingress-proxy-client": token,
      },
    },
  );
  expect(response.status).toBe(200);

  const payload = (await response.json()) as {
    args: { token?: string };
    headers: Record<string, string | undefined>;
    url: string;
  };
  expect(payload.args.token).toBe(token);
  expect(payload.headers["x-ingress-proxy-client"]).toBe(token);
  if (!params.patterns) {
    expect(payload.headers["x-ingress-proxy-e2e"]).toBe(token);
  }
  expect(payload.headers["host"]).toBe("postman-echo.com");
  expect(payload.headers["x-forwarded-host"]).toBe(params.host);
  expect(payload.headers["x-forwarded-proto"]).toBeTruthy();
  expect(payload.url).toContain(`https://postman-echo.com/get?token=${token}`);
}

describe("live ingress-proxy E2E", () => {
  const createdRouteIds = new Set<string>();
  let env: ReturnType<typeof requireEnv>;
  let suiteId = "";

  async function cleanupCreatedRoutes() {
    for (const routeId of Array.from(createdRouteIds).reverse()) {
      try {
        await deleteRoute({ baseUrl: env.baseUrl, apiToken: env.apiToken, routeId });
      } catch {
        // best-effort cleanup
      }
      createdRouteIds.delete(routeId);
    }
  }

  beforeAll(async () => {
    env = requireEnv();
    suiteId = `live-e2e-${Date.now()}`;
  });

  afterEach(async () => {
    await cleanupCreatedRoutes();
  });

  afterAll(async () => {
    await cleanupCreatedRoutes();
  });

  it.each([
    {
      name: "createRoute",
      makeRequest: (params: {
        env: { baseUrl: string; apiToken: string };
        suiteId: string;
        conflictingPattern: string;
        baseRouteId: string;
      }) =>
        createRoute({
          baseUrl: params.env.baseUrl,
          apiToken: params.env.apiToken,
          metadata: { suiteId: params.suiteId, kind: "conflict-create" },
          patterns: [{ pattern: params.conflictingPattern, target: "https://example.com" }],
        }),
    },
    {
      name: "updateRoute",
      makeRequest: (params: {
        env: { baseUrl: string; apiToken: string };
        suiteId: string;
        conflictingPattern: string;
        baseRouteId: string;
      }) =>
        updateRoute({
          baseUrl: params.env.baseUrl,
          apiToken: params.env.apiToken,
          routeId: params.baseRouteId,
          metadata: { suiteId: params.suiteId, kind: "conflict-update" },
          patterns: [{ pattern: params.conflictingPattern, target: "https://example.com" }],
        }),
    },
  ])(
    "returns CONFLICT for $name",
    async ({ makeRequest }) => {
      const { existingPattern, conflictingPattern, otherPattern } = makeConflictPatterns(
        env.baseUrl,
      );

      const baseRoute = await createRoute({
        baseUrl: env.baseUrl,
        apiToken: env.apiToken,
        metadata: { suiteId, kind: "base-conflict-route" },
        patterns: [{ pattern: otherPattern, target: "https://example.com" }],
      });
      createdRouteIds.add(baseRoute.routeId);

      const existingRoute = await createRoute({
        baseUrl: env.baseUrl,
        apiToken: env.apiToken,
        metadata: { suiteId, kind: "existing-conflict-route" },
        patterns: [{ pattern: existingPattern, target: "https://example.com" }],
      });
      createdRouteIds.add(existingRoute.routeId);

      await expect(
        makeRequest({
          env,
          suiteId,
          conflictingPattern,
          baseRouteId: baseRoute.routeId,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    },
    120_000,
  );

  it("proxies a real HTTP request via ingress hostname", async () => {
    const candidates = makeProxyHostCandidates(env.baseUrl);
    const errors: unknown[] = [];

    for (const proxyHost of candidates) {
      try {
        await assertProxyRoundTrip({
          env,
          createdRouteIds,
          suiteId,
          host: proxyHost,
        });
        return;
      } catch (error) {
        errors.push(error);
      }
    }

    throw errors.at(-1) ?? new Error("Failed to proxy HTTP request via ingress hostname");
  }, 120_000);

  it("proxies bla.example-with-wildcards-for-e2e-tests.<ingress-domain>", async () => {
    await assertProxyRoundTrip({
      env,
      createdRouteIds,
      suiteId,
      host: makeWildcardSubdomainHost(env.baseUrl),
      protocol: "http",
    });
  }, 120_000);

  it("proxies bla__some-other-thing.<ingress-domain>", async () => {
    await assertProxyRoundTrip({
      env,
      createdRouteIds,
      suiteId,
      host: makeDoubleUnderscoreHost(env.baseUrl),
    });
  }, 120_000);

  it("supports apex plus wildcard routes without per-pattern headers", async () => {
    const domain =
      proxyBaseDomain && proxyBaseDomain.length > 0 ? proxyBaseDomain : new URL(env.baseUrl).host;
    const apexHost = `${wildcardSubdomainBaseLabel}.${domain}`;
    const subdomainHost = `events.${apexHost}`;

    await assertProxyRoundTrip({
      env,
      createdRouteIds,
      suiteId,
      host: apexHost,
      patterns: [
        { pattern: apexHost, target: "https://postman-echo.com" },
        { pattern: `*.${apexHost}`, target: "https://postman-echo.com" },
      ],
    });

    await cleanupCreatedRoutes();

    await assertProxyRoundTrip({
      env,
      createdRouteIds,
      suiteId,
      host: subdomainHost,
      patterns: [
        { pattern: apexHost, target: "https://postman-echo.com" },
        { pattern: `*.${apexHost}`, target: "https://postman-echo.com" },
      ],
      protocol: "http",
    });
  }, 120_000);

  it("supports externalId uniqueness and delete by externalId", async () => {
    const externalId = `ext-${suiteId}-${Date.now()}`;
    const routeA = await createRoute({
      baseUrl: env.baseUrl,
      apiToken: env.apiToken,
      metadata: { suiteId, kind: "external-id-route-a" },
      externalId,
      patterns: [{ pattern: `ext-a-${suiteId}.workers.dev`, target: "https://example.com" }],
    });
    createdRouteIds.add(routeA.routeId);
    expect(routeA.externalId).toBe(externalId);

    await expect(
      createRoute({
        baseUrl: env.baseUrl,
        apiToken: env.apiToken,
        metadata: { suiteId, kind: "external-id-route-b" },
        externalId,
        patterns: [{ pattern: `ext-b-${suiteId}.workers.dev`, target: "https://example.com" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      deleteRoute({
        baseUrl: env.baseUrl,
        apiToken: env.apiToken,
        externalId,
      }),
    ).resolves.toEqual({ deleted: true });
    createdRouteIds.delete(routeA.routeId);

    await expect(
      deleteRoute({
        baseUrl: env.baseUrl,
        apiToken: env.apiToken,
        externalId,
      }),
    ).resolves.toEqual({ deleted: false });
  }, 120_000);
});
