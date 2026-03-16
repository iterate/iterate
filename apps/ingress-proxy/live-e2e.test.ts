import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createIngressProxyClient } from "@iterate-com/ingress-proxy-contract";

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

function randomSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeRootHost(currentBaseUrl: string) {
  const domain =
    proxyBaseDomain && proxyBaseDomain.length > 0 ? proxyBaseDomain : new URL(currentBaseUrl).host;
  return `proxy-${randomSuffix()}.${domain}`;
}

function makeWildcardRootHost(currentBaseUrl: string) {
  const domain =
    proxyBaseDomain && proxyBaseDomain.length > 0 ? proxyBaseDomain : new URL(currentBaseUrl).host;
  return `${wildcardSubdomainBaseLabel}.${domain}`;
}

describe("live ingress proxy", () => {
  const createdRootHosts = new Set<string>();
  let env: ReturnType<typeof requireEnv>;

  async function cleanupCreatedRoutes() {
    const client = createIngressProxyClient({
      baseURL: env.baseUrl,
      apiToken: env.apiToken,
    });

    for (const rootHost of Array.from(createdRootHosts).reverse()) {
      try {
        await client.routes.remove({ rootHost });
      } catch {
        // best-effort cleanup
      }
      createdRootHosts.delete(rootHost);
    }
  }

  beforeAll(async () => {
    env = requireEnv();
  });

  afterEach(async () => {
    await cleanupCreatedRoutes();
  });

  afterAll(async () => {
    await cleanupCreatedRoutes();
  });

  it("serves OpenAPI for the route contract", async () => {
    const response = await fetch(new URL("/api/openapi.json", env.baseUrl));
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      paths?: Record<string, unknown>;
    };

    expect(payload.paths?.["/routes"]).toBeTruthy();
    expect(payload.paths?.["/routes/{rootHost}"]).toBeTruthy();
  });

  it("creates, gets, lists, and proxies exact root hosts", async () => {
    const client = createIngressProxyClient({
      baseURL: env.baseUrl,
      apiToken: env.apiToken,
    });
    const rootHost = makeRootHost(env.baseUrl);
    const token = randomSuffix();

    const created = await client.routes.upsert({
      rootHost,
      targetUrl: "https://postman-echo.com",
      metadata: { kind: "exact" },
    });
    createdRootHosts.add(rootHost);

    expect(created.id).toBeTruthy();
    expect(created.rootHost).toBe(rootHost);

    const fetched = await client.routes.get({ rootHost });
    expect(fetched.id).toBe(created.id);
    expect(fetched.rootHost).toBe(rootHost);

    const listed = await client.routes.list({ limit: 100, offset: 0 });
    expect(listed.routes.some((route) => route.rootHost === rootHost)).toBe(true);

    const response = await fetch(`https://${rootHost}/get?token=${encodeURIComponent(token)}`, {
      headers: {
        "x-ingress-proxy-client": token,
      },
    });
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      args: { token?: string };
      headers: Record<string, string | undefined>;
      url: string;
    };

    expect(payload.args.token).toBe(token);
    expect(payload.headers["x-ingress-proxy-client"]).toBe(token);
    expect(payload.headers["host"]).toBe("postman-echo.com");
    expect(payload.headers["x-forwarded-host"]).toBe(rootHost);
    expect(payload.headers["x-forwarded-proto"]).toBeTruthy();
    expect(payload.url).toContain(`https://postman-echo.com/get?token=${token}`);
  });

  it("proxies both dunder and subdomain forms for one root host", async () => {
    const client = createIngressProxyClient({
      baseURL: env.baseUrl,
      apiToken: env.apiToken,
    });
    const rootHost = makeWildcardRootHost(env.baseUrl);

    await client.routes.upsert({
      rootHost,
      targetUrl: "https://postman-echo.com",
      metadata: { kind: "wildcard-forms" },
    });
    createdRootHosts.add(rootHost);

    for (const host of [`events__${rootHost}`, `events.${rootHost}`]) {
      const response = await fetch(`https://${host}/get?token=test`);
      expect(response.status).toBe(200);

      const payload = (await response.json()) as {
        headers: Record<string, string | undefined>;
      };

      expect(payload.headers["host"]).toBe("postman-echo.com");
      expect(payload.headers["x-forwarded-host"]).toBe(host);
    }
  });
});
