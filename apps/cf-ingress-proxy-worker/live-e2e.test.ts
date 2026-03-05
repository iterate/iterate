import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const baseUrl = process.env.INGRESS_PROXY_E2E_BASE_URL;
const apiToken = process.env.INGRESS_PROXY_E2E_API_TOKEN ?? process.env.INGRESS_PROXY_API_TOKEN;
const SHORT_CANDIDATES = ["*.workers.dev", "*-a.workers.dev", "*-b.workers.dev", "*-c.workers.dev"];
const LONG_CANDIDATES = [
  "*.iterate.workers.dev",
  "*-a.iterate.workers.dev",
  "*-b.iterate.workers.dev",
  "*-c.iterate.workers.dev",
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

async function createFromCandidates(params: {
  env: { baseUrl: string; apiToken: string };
  metadata: Record<string, unknown>;
  candidates: string[];
  createdRouteIds: Set<string>;
  externalId?: string | null;
}) {
  for (const pattern of params.candidates) {
    try {
      const route = await createRoute({
        baseUrl: params.env.baseUrl,
        apiToken: params.env.apiToken,
        metadata: params.metadata,
        externalId: params.externalId,
        patterns: [
          {
            pattern,
            target: "https://example.com",
          },
        ],
      });
      params.createdRouteIds.add(route.routeId);
      return { route, pattern };
    } catch (error) {
      if ((error as { code?: string } | undefined)?.code !== "CONFLICT") throw error;
    }
  }

  throw new Error("No available candidate pattern");
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
        longPattern: string;
        shortRouteId: string;
      }) =>
        createRoute({
          baseUrl: params.env.baseUrl,
          apiToken: params.env.apiToken,
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
          baseUrl: params.env.baseUrl,
          apiToken: params.env.apiToken,
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
        createdRouteIds,
      });

      const long = await createFromCandidates({
        env,
        metadata: { suiteId, kind: "long-conflict" },
        candidates: LONG_CANDIDATES,
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
