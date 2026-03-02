import { afterAll, beforeAll, describe, expect, it } from "vitest";

const baseUrl = process.env.INGRESS_PROXY_E2E_BASE_URL;
const apiToken = process.env.INGRESS_PROXY_E2E_API_TOKEN ?? process.env.INGRESS_PROXY_API_TOKEN;
const SHORT_CANDIDATES = ["*.workers.dev", "**.workers.dev", "***.workers.dev", "****.workers.dev"];
const LONG_CANDIDATES = [
  "*.iterate.workers.dev",
  "**.iterate.workers.dev",
  "***.iterate.workers.dev",
  "****.iterate.workers.dev",
];

function requireEnv() {
  if (!baseUrl) {
    throw new Error("INGRESS_PROXY_E2E_BASE_URL is required for live E2E tests");
  }
  if (!apiToken) {
    throw new Error("INGRESS_PROXY_E2E_API_TOKEN (or INGRESS_PROXY_API_TOKEN) is required");
  }
  return { baseUrl, apiToken };
}

function getHeaderValueCaseInsensitive(
  headers: Record<string, string | string[]> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? (value[0] ?? null) : value;
  }
  return null;
}

async function callProcedure<T>(params: {
  name: string;
  input: unknown;
  baseUrl: string;
  apiToken: string;
}): Promise<T> {
  const response = await fetch(`${params.baseUrl}/api/orpc/${params.name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ json: params.input }),
  });

  const payload = (await response.json()) as { json?: T };
  if (!response.ok) {
    throw payload.json;
  }

  return payload.json as T;
}

function createRoute(params: {
  baseUrl: string;
  apiToken: string;
  metadata: Record<string, unknown>;
  patterns: Array<{ pattern: string; target: string; headers?: Record<string, string> }>;
}) {
  return callProcedure<{
    routeId: string;
    metadata: Record<string, unknown>;
    patterns: Array<{ patternId: number; pattern: string; target: string }>;
  }>({
    name: "createRoute",
    input: {
      metadata: params.metadata,
      patterns: params.patterns,
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
}) {
  return callProcedure<{
    routeId: string;
    metadata: Record<string, unknown>;
    patterns: Array<{ patternId: number; pattern: string; target: string }>;
  }>({
    name: "updateRoute",
    input: {
      routeId: params.routeId,
      metadata: params.metadata,
      patterns: params.patterns,
    },
    baseUrl: params.baseUrl,
    apiToken: params.apiToken,
  });
}

function listRoutes(params: { baseUrl: string; apiToken: string }) {
  return callProcedure<Array<{ routeId: string }>>({
    name: "listRoutes",
    input: {},
    baseUrl: params.baseUrl,
    apiToken: params.apiToken,
  });
}

function deleteRoute(params: { baseUrl: string; apiToken: string; routeId: string }) {
  return callProcedure<{ deleted: boolean }>({
    name: "deleteRoute",
    input: { routeId: params.routeId },
    baseUrl: params.baseUrl,
    apiToken: params.apiToken,
  });
}

async function createFromCandidates(params: {
  env: { baseUrl: string; apiToken: string };
  metadata: Record<string, unknown>;
  candidates: string[];
  routeHeader: string;
  createdRouteIds: Set<string>;
}) {
  for (const pattern of params.candidates) {
    try {
      const route = await createRoute({
        ...params.env,
        metadata: params.metadata,
        patterns: [
          {
            pattern,
            target: "https://httpbingo.org",
            headers: { host: "httpbingo.org", "x-route-kind": params.routeHeader },
          },
        ],
      });
      params.createdRouteIds.add(route.routeId);
      return { route, pattern };
    } catch (error) {
      if ((error as { code?: string } | undefined)?.code !== "CONFLICT") throw error;
    }
  }

  throw new Error(`No available candidate pattern for ${params.routeHeader}`);
}

describe("live ingress-proxy E2E", () => {
  const createdRouteIds = new Set<string>();
  let env: ReturnType<typeof requireEnv>;
  let suiteId = "";

  beforeAll(async () => {
    env = requireEnv();
    suiteId = `live-e2e-${Date.now()}`;
  });

  afterAll(async () => {
    for (const routeId of [...createdRouteIds].reverse()) {
      try {
        await deleteRoute({ ...env, routeId });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("routes by exact host first and wildcard specificity after exact deletion", async () => {
    const requestHost = new URL(env.baseUrl).hostname;

    const short = await createFromCandidates({
      env,
      metadata: { suiteId, kind: "short" },
      candidates: SHORT_CANDIDATES,
      routeHeader: "short",
      createdRouteIds,
    });

    const long = await createFromCandidates({
      env,
      metadata: { suiteId, kind: "long" },
      candidates: LONG_CANDIDATES,
      routeHeader: "long",
      createdRouteIds,
    });

    const exact = await createRoute({
      ...env,
      metadata: { suiteId, kind: "exact" },
      patterns: [
        {
          pattern: requestHost,
          target: "https://httpbingo.org",
          headers: { host: "httpbingo.org", "x-route-kind": "exact" },
        },
      ],
    });
    createdRouteIds.add(exact.routeId);

    const exactResponse = await fetch(`${env.baseUrl}/anything?scenario=exact`);
    expect(exactResponse.status).toBe(200);
    expect(exactResponse.headers.get("x-ingress-proxy-route-id")).toBe(exact.routeId);
    const exactJson = (await exactResponse.json()) as {
      headers?: Record<string, string | string[]>;
      url?: string;
    };
    expect(exactJson.url).toBe("https://httpbingo.org/anything?scenario=exact");
    expect(getHeaderValueCaseInsensitive(exactJson.headers, "x-route-kind")).toBe("exact");

    await deleteRoute({ ...env, routeId: exact.routeId });
    createdRouteIds.delete(exact.routeId);

    const wildcardResponse = await fetch(`${env.baseUrl}/anything?scenario=wildcard-specificity`);
    expect(wildcardResponse.status).toBe(200);
    expect(wildcardResponse.headers.get("x-ingress-proxy-route-id")).toBe(long.route.routeId);
    const wildcardJson = (await wildcardResponse.json()) as {
      headers?: Record<string, string | string[]>;
      url?: string;
    };
    expect(wildcardJson.url).toBe("https://httpbingo.org/anything?scenario=wildcard-specificity");
    expect(getHeaderValueCaseInsensitive(wildcardJson.headers, "x-route-kind")).toBe("long");

    const selfUpdated = await updateRoute({
      ...env,
      routeId: long.route.routeId,
      metadata: { suiteId, kind: "self-update" },
      patterns: [
        {
          pattern: long.pattern,
          target: "https://httpbingo.org",
          headers: { host: "httpbingo.org", "x-route-kind": "long2" },
        },
      ],
    });
    expect(selfUpdated.routeId).toBe(long.route.routeId);

    const postUpdateResponse = await fetch(`${env.baseUrl}/anything?scenario=post-update`);
    expect(postUpdateResponse.status).toBe(200);
    expect(postUpdateResponse.headers.get("x-ingress-proxy-route-id")).toBe(long.route.routeId);
    const postUpdateJson = (await postUpdateResponse.json()) as {
      headers?: Record<string, string | string[]>;
      url?: string;
    };
    expect(postUpdateJson.url).toBe("https://httpbingo.org/anything?scenario=post-update");
    expect(getHeaderValueCaseInsensitive(postUpdateJson.headers, "x-route-kind")).toBe("long2");

    const listed = await listRoutes(env);
    const listedIds = new Set(listed.map((route) => route.routeId));
    expect(listedIds.has(short.route.routeId)).toBe(true);
    expect(listedIds.has(long.route.routeId)).toBe(true);
  }, 120_000);

  it.each([
    {
      name: "createRoute",
      makeRequest: (params: {
        env: { baseUrl: string; apiToken: string };
        suiteId: string;
        longPattern: string;
        shortRouteId: string;
      }) =>
        createRoute({
          ...params.env,
          metadata: { suiteId: params.suiteId, kind: "conflict-create" },
          patterns: [{ pattern: params.longPattern, target: "https://example.com" }],
        }),
    },
    {
      name: "updateRoute",
      makeRequest: (params: {
        env: { baseUrl: string; apiToken: string };
        suiteId: string;
        longPattern: string;
        shortRouteId: string;
      }) =>
        updateRoute({
          ...params.env,
          routeId: params.shortRouteId,
          metadata: { suiteId: params.suiteId, kind: "conflict-update" },
          patterns: [{ pattern: params.longPattern, target: "https://example.com" }],
        }),
    },
  ])(
    "returns CONFLICT for $name",
    async ({ makeRequest }) => {
      const short = await createFromCandidates({
        env,
        metadata: { suiteId, kind: "short-conflict" },
        candidates: SHORT_CANDIDATES,
        routeHeader: "short-conflict",
        createdRouteIds,
      });

      const long = await createFromCandidates({
        env,
        metadata: { suiteId, kind: "long-conflict" },
        candidates: LONG_CANDIDATES,
        routeHeader: "long-conflict",
        createdRouteIds,
      });

      await expect(
        makeRequest({
          env,
          suiteId,
          longPattern: long.pattern,
          shortRouteId: short.route.routeId,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    },
    120_000,
  );
});
