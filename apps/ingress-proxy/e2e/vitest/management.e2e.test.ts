import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createIngressProxyAppFixture,
  requireIngressProxyApiToken,
  requireIngressProxyBaseUrl,
} from "../helpers.ts";

function randomSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe.sequential("ingress proxy management api", () => {
  const app = createIngressProxyAppFixture({
    apiToken: requireIngressProxyApiToken(),
    baseURL: requireIngressProxyBaseUrl(),
  });
  const createdRootHosts = new Set<string>();

  async function cleanupCreatedRoutes() {
    for (const rootHost of Array.from(createdRootHosts).reverse()) {
      try {
        await app.apiFetch(`/api/routes/${encodeURIComponent(rootHost)}`, {
          method: "DELETE",
        });
      } catch {
        // best-effort cleanup
      }
      createdRootHosts.delete(rootHost);
    }
  }

  afterEach(async () => {
    await cleanupCreatedRoutes();
  });

  afterAll(async () => {
    await cleanupCreatedRoutes();
  });

  it("serves OpenAPI for the route contract", async () => {
    const response = await app.fetch("/api/openapi.json");
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      paths?: Record<string, unknown>;
    };

    expect(payload.paths?.["/routes"]).toBeTruthy();
    expect(payload.paths?.["/routes/{rootHost}"]).toBeTruthy();
  }, 120_000);

  it("creates, gets, lists, and deletes root hosts through the management api", async () => {
    const rootHost = `proxy-${randomSuffix()}.preview-management.test`;

    const created = await apiJson<{ id: string; rootHost: string }>(
      app,
      `/api/routes/${encodeURIComponent(rootHost)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          targetUrl: "https://httpbin.org",
          metadata: { kind: "management-api" },
        }),
      },
    );
    createdRootHosts.add(rootHost);

    expect(created.id).toBeTruthy();
    expect(created.rootHost).toBe(rootHost);

    const fetched = await apiJson<{ id: string; rootHost: string }>(
      app,
      `/api/routes/${encodeURIComponent(rootHost)}`,
      { method: "GET" },
    );
    expect(fetched.id).toBe(created.id);
    expect(fetched.rootHost).toBe(rootHost);

    const listed = await apiJson<{ routes: Array<{ rootHost: string }> }>(
      app,
      "/api/routes?limit=100&offset=0",
      { method: "GET" },
    );
    expect(listed.routes.some((route) => route.rootHost === rootHost)).toBe(true);

    const deleted = await apiJson<{ deleted: boolean }>(
      app,
      `/api/routes/${encodeURIComponent(rootHost)}`,
      {
        method: "DELETE",
      },
    );
    expect(deleted.deleted).toBe(true);
    createdRootHosts.delete(rootHost);

    const missingGet = await app.apiFetch(`/api/routes/${encodeURIComponent(rootHost)}`, {
      method: "GET",
    });
    expect(missingGet.status).toBe(404);
  }, 120_000);
});

async function apiJson<T>(
  app: ReturnType<typeof createIngressProxyAppFixture>,
  pathname: string,
  init: RequestInit,
) {
  const response = await app.apiFetch(pathname, init);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(body || `${init.method ?? "GET"} ${pathname} failed with ${response.status}`);
  }

  return JSON.parse(body) as T;
}
