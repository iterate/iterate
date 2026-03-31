import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createIngressProxyAppFixture,
  ingressProxyBaseDomain,
  requireIngressProxyApiToken,
  requireIngressProxyBaseUrl,
} from "../helpers.ts";

const wildcardSubdomainBaseLabel = "example-with-wildcards-for-e2e-tests";
const app = createIngressProxyAppFixture({
  apiToken: requireIngressProxyApiToken(),
  baseURL: requireIngressProxyBaseUrl(),
});

function randomSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeRootHost(currentBaseUrl: string) {
  return `proxy-${randomSuffix()}.${ingressProxyBaseDomain(currentBaseUrl)}`;
}

function makeWildcardRootHost(currentBaseUrl: string) {
  return `${wildcardSubdomainBaseLabel}.${ingressProxyBaseDomain(currentBaseUrl)}`;
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) => {
      if (typeof value === "string") return [[key.toLowerCase(), value]];
      if (Array.isArray(value) && value[0]) return [[key.toLowerCase(), value[0]]];
      return [];
    }),
  );
}

describe.sequential("live ingress proxy", () => {
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

  it("creates, gets, lists, and proxies exact root hosts through httpbin", async () => {
    const rootHost = makeRootHost(app.baseURL);
    const token = randomSuffix();

    const created = await apiJson<{ id: string; rootHost: string }>(
      `/api/routes/${encodeURIComponent(rootHost)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          targetUrl: "https://httpbin.org",
          metadata: { kind: "exact" },
        }),
      },
    );
    createdRootHosts.add(rootHost);

    expect(created.id).toBeTruthy();
    expect(created.rootHost).toBe(rootHost);

    const fetched = await apiJson<{ id: string; rootHost: string }>(
      `/api/routes/${encodeURIComponent(rootHost)}`,
      { method: "GET" },
    );
    expect(fetched.id).toBe(created.id);
    expect(fetched.rootHost).toBe(rootHost);

    const listed = await apiJson<{ routes: Array<{ rootHost: string }> }>(
      "/api/routes?limit=100&offset=0",
      { method: "GET" },
    );
    expect(listed.routes.some((route) => route.rootHost === rootHost)).toBe(true);

    const response = await fetch(
      `https://${rootHost}/anything?token=${encodeURIComponent(token)}`,
      {
        headers: {
          "x-ingress-proxy-client": token,
        },
      },
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      args: { token?: string };
      headers: Record<string, string | string[] | undefined>;
      url: string;
    };
    const headers = normalizeHeaders(payload.headers);

    expect(payload.args.token).toBe(token);
    expect(headers["x-ingress-proxy-client"]).toBe(token);
    expect(headers["host"]).toBe("httpbin.org");
    expect(headers["x-forwarded-host"]).toBe(rootHost);
    expect(headers["cf-connecting-ip"]).toBeTruthy();
    expect(headers["x-forwarded-proto"]).toBeUndefined();
    expect(headers["x-forwarded-for"]).toBeUndefined();
    expect(headers["x-real-ip"]).toBeUndefined();
    expect(payload.url).toContain(`/anything?token=${token}`);
  }, 120_000);

  it("proxies both dunder and subdomain forms for one root host", async () => {
    const rootHost = makeWildcardRootHost(app.baseURL);

    await apiJson<{ id: string }>(`/api/routes/${encodeURIComponent(rootHost)}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        targetUrl: "https://httpbin.org",
        metadata: { kind: "wildcard-forms" },
      }),
    });
    createdRootHosts.add(rootHost);

    for (const host of [`events__${rootHost}`, `events.${rootHost}`]) {
      const response = await fetch(`https://${host}/anything?token=test`);
      expect(response.status).toBe(200);

      const payload = (await response.json()) as {
        headers: Record<string, string | string[] | undefined>;
      };
      const headers = normalizeHeaders(payload.headers);

      expect(headers["host"]).toBe("httpbin.org");
      expect(headers["x-forwarded-host"]).toBe(host);
    }
  }, 120_000);
});

async function apiJson<T>(pathname: string, init: RequestInit) {
  const response = await app.apiFetch(pathname, init);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(body || `${init.method ?? "GET"} ${pathname} failed with ${response.status}`);
  }

  return JSON.parse(body) as T;
}
