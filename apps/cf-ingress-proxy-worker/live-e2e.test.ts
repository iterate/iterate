import { afterAll, beforeAll, describe, expect, it } from "vitest";

type ProcedureError = {
  code: string;
  status: number;
  message: string;
  data?: unknown;
};

type RoutePatternRecord = {
  patternId: number;
  pattern: string;
  target: string;
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

type RouteRecord = {
  routeId: string;
  metadata: Record<string, unknown>;
  patterns: RoutePatternRecord[];
  createdAt: string;
  updatedAt: string;
};

const baseUrl = process.env.INGRESS_PROXY_E2E_BASE_URL;
const apiToken = process.env.INGRESS_PROXY_E2E_API_TOKEN ?? process.env.INGRESS_PROXY_API_TOKEN;

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

function requireEnv(): { baseUrl: string; apiToken: string } {
  if (!baseUrl) {
    throw new Error("INGRESS_PROXY_E2E_BASE_URL is required for live E2E tests");
  }
  if (!apiToken) {
    throw new Error("INGRESS_PROXY_E2E_API_TOKEN (or INGRESS_PROXY_API_TOKEN) is required");
  }
  return { baseUrl, apiToken };
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

  const payload = (await response.json()) as { json?: T & ProcedureError };
  if (!response.ok) {
    throw payload.json as ProcedureError;
  }

  return payload.json as T;
}

async function createRoute(params: {
  baseUrl: string;
  apiToken: string;
  metadata: Record<string, unknown>;
  patterns: Array<{ pattern: string; target: string; headers?: Record<string, string> }>;
}): Promise<RouteRecord> {
  return callProcedure<RouteRecord>({
    name: "createRoute",
    input: {
      metadata: params.metadata,
      patterns: params.patterns,
    },
    baseUrl: params.baseUrl,
    apiToken: params.apiToken,
  });
}

async function updateRoute(params: {
  baseUrl: string;
  apiToken: string;
  routeId: string;
  metadata: Record<string, unknown>;
  patterns: Array<{ pattern: string; target: string; headers?: Record<string, string> }>;
}): Promise<RouteRecord> {
  return callProcedure<RouteRecord>({
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

async function listRoutes(params: { baseUrl: string; apiToken: string }): Promise<RouteRecord[]> {
  return callProcedure<RouteRecord[]>({
    name: "listRoutes",
    input: {},
    baseUrl: params.baseUrl,
    apiToken: params.apiToken,
  });
}

async function deleteRoute(params: {
  baseUrl: string;
  apiToken: string;
  routeId: string;
}): Promise<void> {
  await callProcedure<{ deleted: boolean }>({
    name: "deleteRoute",
    input: { routeId: params.routeId },
    baseUrl: params.baseUrl,
    apiToken: params.apiToken,
  });
}

describe("live ingress-proxy E2E", () => {
  const createdRouteIds = new Set<string>();
  let env: { baseUrl: string; apiToken: string };
  let suiteId = "";

  beforeAll(async () => {
    env = requireEnv();
    suiteId = `live-e2e-${Date.now()}`;

    const existing = await listRoutes(env);
    for (const route of existing) {
      if (route.metadata?.suiteId === suiteId) {
        await deleteRoute({ ...env, routeId: route.routeId });
      }
    }
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

  it("covers exact-vs-wildcard, wildcard specificity, create/update conflicts", async () => {
    const requestHost = new URL(env.baseUrl).hostname;

    const shortSuffix = "workers.dev";
    const longSuffix = "iterate.workers.dev";

    const shortCandidates = [`*.${shortSuffix}`, `**.${shortSuffix}`, `***.${shortSuffix}`];
    const longCandidates = [`*.${longSuffix}`, `**.${longSuffix}`, `***.${longSuffix}`];

    let shortRoute: RouteRecord | null = null;
    let shortPattern = "";
    for (const pattern of shortCandidates) {
      try {
        shortRoute = await createRoute({
          ...env,
          metadata: { suiteId, kind: "short" },
          patterns: [
            {
              pattern,
              target: "https://httpbingo.org",
              headers: { host: "httpbingo.org", "x-route-kind": "short" },
            },
          ],
        });
        shortPattern = pattern;
        createdRouteIds.add(shortRoute.routeId);
        break;
      } catch (error) {
        if ((error as ProcedureError).code !== "CONFLICT") throw error;
      }
    }
    expect(shortRoute).not.toBeNull();

    let longRoute: RouteRecord | null = null;
    let longPattern = "";
    for (const pattern of longCandidates) {
      try {
        longRoute = await createRoute({
          ...env,
          metadata: { suiteId, kind: "long" },
          patterns: [
            {
              pattern,
              target: "https://httpbingo.org",
              headers: { host: "httpbingo.org", "x-route-kind": "long" },
            },
          ],
        });
        longPattern = pattern;
        createdRouteIds.add(longRoute.routeId);
        break;
      } catch (error) {
        if ((error as ProcedureError).code !== "CONFLICT") throw error;
      }
    }
    expect(longRoute).not.toBeNull();

    const exactRoute = await createRoute({
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
    createdRouteIds.add(exactRoute.routeId);

    const exactResponse = await fetch(`${env.baseUrl}/anything?scenario=exact`);
    expect(exactResponse.status).toBe(200);
    expect(exactResponse.headers.get("x-ingress-proxy-route-id")).toBe(exactRoute.routeId);

    const exactJson = (await exactResponse.json()) as {
      headers?: Record<string, string | string[]>;
      url?: string;
    };
    expect(exactJson.url).toBe("https://httpbingo.org/anything?scenario=exact");
    expect(getHeaderValueCaseInsensitive(exactJson.headers, "x-route-kind")).toBe("exact");

    await deleteRoute({ ...env, routeId: exactRoute.routeId });
    createdRouteIds.delete(exactRoute.routeId);

    const wildcardResponse = await fetch(`${env.baseUrl}/anything?scenario=wildcard-specificity`);
    expect(wildcardResponse.status).toBe(200);
    expect(wildcardResponse.headers.get("x-ingress-proxy-route-id")).toBe(longRoute!.routeId);
    const wildcardJson = (await wildcardResponse.json()) as {
      headers?: Record<string, string | string[]>;
      url?: string;
    };
    expect(wildcardJson.url).toBe("https://httpbingo.org/anything?scenario=wildcard-specificity");
    expect(getHeaderValueCaseInsensitive(wildcardJson.headers, "x-route-kind")).toBe("long");

    await expect(
      createRoute({
        ...env,
        metadata: { suiteId, kind: "conflict-create" },
        patterns: [{ pattern: longPattern, target: "https://example.com" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      updateRoute({
        ...env,
        routeId: shortRoute!.routeId,
        metadata: { suiteId, kind: "conflict-update" },
        patterns: [{ pattern: longPattern, target: "https://example.com" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const selfUpdated = await updateRoute({
      ...env,
      routeId: longRoute!.routeId,
      metadata: { suiteId, kind: "self-update" },
      patterns: [
        {
          pattern: longPattern,
          target: "https://httpbingo.org",
          headers: { host: "httpbingo.org", "x-route-kind": "long2" },
        },
      ],
    });
    expect(selfUpdated.routeId).toBe(longRoute!.routeId);

    const postUpdateResponse = await fetch(`${env.baseUrl}/anything?scenario=post-update`);
    expect(postUpdateResponse.status).toBe(200);
    expect(postUpdateResponse.headers.get("x-ingress-proxy-route-id")).toBe(longRoute!.routeId);
    const postUpdateJson = (await postUpdateResponse.json()) as {
      headers?: Record<string, string | string[]>;
      url?: string;
    };
    expect(postUpdateJson.url).toBe("https://httpbingo.org/anything?scenario=post-update");
    expect(getHeaderValueCaseInsensitive(postUpdateJson.headers, "x-route-kind")).toBe("long2");

    const listed = await listRoutes(env);
    const listedIds = new Set(listed.map((route) => route.routeId));
    expect(listedIds.has(shortRoute!.routeId)).toBe(true);
    expect(listedIds.has(longRoute!.routeId)).toBe(true);
    expect(shortPattern.length).toBeGreaterThan(0);
  }, 120_000);
});
