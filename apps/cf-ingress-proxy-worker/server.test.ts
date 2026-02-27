import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildUpstreamUrl,
  createRoute,
  createUpstreamHeaders,
  deleteRoute,
  getRoute,
  listRoutes,
  proxyRequest,
  resolveRoute,
  updateRoute,
} from "./server.ts";
import { parseWorkerEnv } from "./env.ts";

const TEST_SCHEMA_STATEMENTS = [
  `
  CREATE TABLE IF NOT EXISTS routes (
    id TEXT PRIMARY KEY,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`,
  `
  CREATE TABLE IF NOT EXISTS route_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    pattern TEXT NOT NULL,
    target TEXT NOT NULL,
    headers TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pattern)
  )
`,
];

async function resetDb(): Promise<void> {
  await env.DB.prepare("DROP TABLE IF EXISTS route_patterns").run();
  await env.DB.prepare("DROP TABLE IF EXISTS routes").run();
  for (const statement of TEST_SCHEMA_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});

describe("route groups", () => {
  test("create/get/list/update/delete", async () => {
    const created = await createRoute(env.DB, {
      typeIdPrefix: "tst",
      metadata: { project: "abc" },
      patterns: [
        { pattern: "app.project.ingress.iterate.com", target: "https://project.fly.dev" },
        { pattern: "*.project.ingress.iterate.com", target: "https://project.fly.dev" },
      ],
    });

    expect(created.routeId.startsWith("tst_")).toBe(true);
    expect(created.patterns).toHaveLength(2);

    const fetched = await getRoute(env.DB, created.routeId);
    expect(fetched?.routeId).toBe(created.routeId);
    expect(fetched?.metadata).toEqual({ project: "abc" });

    const listed = await listRoutes(env.DB);
    expect(listed).toHaveLength(1);

    const updated = await updateRoute(env.DB, {
      routeId: created.routeId,
      metadata: { project: "def" },
      patterns: [
        {
          pattern: "api.project.ingress.iterate.com",
          target: "https://project.fly.dev/base",
          headers: { authorization: "Bearer test" },
        },
      ],
    });

    expect(updated.metadata).toEqual({ project: "def" });
    expect(updated.patterns).toHaveLength(1);
    expect(updated.patterns[0]?.pattern).toBe("api.project.ingress.iterate.com");

    await expect(deleteRoute(env.DB, created.routeId)).resolves.toBe(true);
    await expect(getRoute(env.DB, created.routeId)).resolves.toBeNull();
  });

  test("create rejects conflicting pattern", async () => {
    await createRoute(env.DB, {
      typeIdPrefix: "tst",
      patterns: [{ pattern: "same.ingress.iterate.com", target: "https://one.fly.dev" }],
    });

    await expect(
      createRoute(env.DB, {
        typeIdPrefix: "tst",
        patterns: [{ pattern: "same.ingress.iterate.com", target: "https://two.fly.dev" }],
      }),
    ).rejects.toThrow("Pattern conflicts");
  });

  test("resolve prioritizes exact over wildcard", async () => {
    const wildcard = await createRoute(env.DB, {
      typeIdPrefix: "tst",
      patterns: [{ pattern: "*.proj.ingress.iterate.com", target: "https://wild.fly.dev" }],
    });

    const exact = await createRoute(env.DB, {
      typeIdPrefix: "tst",
      patterns: [{ pattern: "app.proj.ingress.iterate.com", target: "https://exact.fly.dev" }],
    });

    const request = new Request("https://app.proj.ingress.iterate.com/hello", {
      headers: { host: "app.proj.ingress.iterate.com" },
    });

    const resolved = await resolveRoute(env.DB, request);
    expect(resolved?.routeId).toBe(exact.routeId);
    expect(resolved?.routeId).not.toBe(wildcard.routeId);
  });

  test("double underscore hostnames are treated as opaque strings", async () => {
    await createRoute(env.DB, {
      typeIdPrefix: "tst",
      patterns: [{ pattern: "*__proj.ingress.iterate.com", target: "https://proj.fly.dev" }],
    });

    const request = new Request("https://web__proj.ingress.iterate.com/path", {
      headers: { host: "web__proj.ingress.iterate.com" },
    });

    const resolved = await resolveRoute(env.DB, request);
    expect(resolved?.pattern).toBe("*__proj.ingress.iterate.com");
  });
});

describe("proxy behavior", () => {
  test("builds upstream URL using target base path", () => {
    const upstream = buildUpstreamUrl(
      new URL("https://target.fly.dev/base"),
      new URL("https://app.ingress.iterate.com/foo/bar?x=1"),
    );

    expect(upstream.toString()).toBe("https://target.fly.dev/base/foo/bar?x=1");
  });

  test("preserves inbound Host header by default", async () => {
    await createRoute(env.DB, {
      typeIdPrefix: "tst",
      patterns: [{ pattern: "app.ingress.iterate.com", target: "https://target.fly.dev/base" }],
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input as Request;
      expect(request.url).toBe("https://target.fly.dev/base/path?y=2");
      expect(request.headers.get("host")).toBe("app.ingress.iterate.com");
      expect(request.headers.get("x-custom")).toBe("ok");
      return new Response("proxied", { status: 200 });
    });

    const parsedEnv = parseWorkerEnv(env);
    const response = await proxyRequest(
      new Request("https://app.ingress.iterate.com/path?y=2", {
        headers: {
          host: "app.ingress.iterate.com",
          "x-custom": "ok",
        },
      }),
      parsedEnv,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ingress-proxy-route-id")).toBeTruthy();
  });

  test("applies optional per-pattern header overrides", async () => {
    await createRoute(env.DB, {
      typeIdPrefix: "tst",
      patterns: [
        {
          pattern: "api.ingress.iterate.com",
          target: "https://target.fly.dev",
          headers: { authorization: "Bearer from-route" },
        },
      ],
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input as Request;
      expect(request.headers.get("authorization")).toBe("Bearer from-route");
      return new Response("ok", { status: 200 });
    });

    const response = await proxyRequest(
      new Request("https://api.ingress.iterate.com/v1", {
        headers: {
          host: "api.ingress.iterate.com",
          authorization: "Bearer inbound",
        },
      }),
      parseWorkerEnv(env),
    );

    expect(response.status).toBe(200);
  });

  test("keeps websocket upgrade headers", () => {
    const request = new Request("https://socket.ingress.iterate.com/ws", {
      headers: {
        host: "socket.ingress.iterate.com",
        upgrade: "websocket",
        connection: "Upgrade",
      },
    });

    const headers = createUpstreamHeaders(request, {});
    expect(headers.get("upgrade")?.toLowerCase()).toBe("websocket");
    expect(headers.get("connection")?.toLowerCase()).toContain("upgrade");
  });

  test("returns 404 when no route matches", async () => {
    const response = await proxyRequest(
      new Request("https://none.ingress.iterate.com", {
        headers: { host: "none.ingress.iterate.com" },
      }),
      parseWorkerEnv(env),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "route_not_found" });
  });

  test("returns 502 when upstream fetch fails", async () => {
    await createRoute(env.DB, {
      typeIdPrefix: "tst",
      patterns: [{ pattern: "fail.ingress.iterate.com", target: "https://target.fly.dev" }],
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));

    const response = await proxyRequest(
      new Request("https://fail.ingress.iterate.com", {
        headers: { host: "fail.ingress.iterate.com" },
      }),
      parseWorkerEnv(env),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "proxy_error" });
  });
});
