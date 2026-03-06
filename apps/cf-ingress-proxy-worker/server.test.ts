import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  app,
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
import { parseWorkerEnv, type RawProxyWorkerEnv } from "./env.ts";
import { resetDb } from "./test/test-helpers.ts";

const testEnv = env as RawProxyWorkerEnv;

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDb(testEnv.DB);
});

async function createSinglePatternRoute(params: {
  pattern: string;
  target: string;
  headers?: Record<string, string>;
}) {
  return createRoute(testEnv.DB, {
    typeIdPrefix: "tst",
    patterns: [
      {
        pattern: params.pattern,
        target: params.target,
        headers: params.headers,
      },
    ],
  });
}

function buildInboundRequest(params: {
  host: string;
  path: string;
  headers?: Record<string, string>;
}) {
  return new Request(`https://${params.host}${params.path}`, {
    headers: {
      host: params.host,
      ...(params.headers ?? {}),
    },
  });
}

describe("route groups", () => {
  test("create/get/list/update/delete", async () => {
    const created = await createRoute(testEnv.DB, {
      typeIdPrefix: "tst",
      externalId: "machine-abc",
      metadata: { project: "abc" },
      patterns: [
        { pattern: "app.project.ingress.iterate.com", target: "https://project.fly.dev" },
        { pattern: "*.project.ingress.iterate.com", target: "https://project.fly.dev" },
      ],
    });

    expect(created.routeId.startsWith("tst_")).toBe(true);
    expect(created.patterns).toHaveLength(2);

    const fetched = await getRoute(testEnv.DB, created.routeId);
    expect(fetched?.routeId).toBe(created.routeId);
    expect(fetched?.externalId).toBe("machine-abc");
    expect(fetched?.metadata).toEqual({ project: "abc" });

    const listed = await listRoutes(testEnv.DB);
    expect(listed).toHaveLength(1);

    const updated = await updateRoute(testEnv.DB, {
      routeId: created.routeId,
      externalId: "machine-def",
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
    expect(updated.externalId).toBe("machine-def");
    expect(updated.patterns).toHaveLength(1);
    expect(updated.patterns[0]?.pattern).toBe("api.project.ingress.iterate.com");

    await expect(deleteRoute(testEnv.DB, { routeId: created.routeId })).resolves.toBe(true);
    await expect(getRoute(testEnv.DB, created.routeId)).resolves.toBeNull();
  });

  test("create rejects conflicting pattern", async () => {
    await createRoute(testEnv.DB, {
      typeIdPrefix: "tst",
      patterns: [{ pattern: "same.ingress.iterate.com", target: "https://one.fly.dev" }],
    });

    await expect(
      createRoute(testEnv.DB, {
        typeIdPrefix: "tst",
        patterns: [{ pattern: "same.ingress.iterate.com", target: "https://two.fly.dev" }],
      }),
    ).rejects.toThrow("UNIQUE constraint failed");
  });

  test("externalId uniqueness allows null and rejects duplicate values", async () => {
    await createRoute(testEnv.DB, {
      typeIdPrefix: "tst",
      patterns: [{ pattern: "one-null.ingress.iterate.com", target: "https://one.fly.dev" }],
    });

    await createRoute(testEnv.DB, {
      typeIdPrefix: "tst",
      patterns: [{ pattern: "two-null.ingress.iterate.com", target: "https://two.fly.dev" }],
    });

    await createRoute(testEnv.DB, {
      typeIdPrefix: "tst",
      externalId: "machine-unique",
      patterns: [{ pattern: "one-ext.ingress.iterate.com", target: "https://one.fly.dev" }],
    });

    await expect(
      createRoute(testEnv.DB, {
        typeIdPrefix: "tst",
        externalId: "machine-unique",
        patterns: [{ pattern: "two-ext.ingress.iterate.com", target: "https://two.fly.dev" }],
      }),
    ).rejects.toThrow("UNIQUE constraint failed");
  });

  test("update can clear externalId", async () => {
    const created = await createRoute(testEnv.DB, {
      typeIdPrefix: "tst",
      externalId: "machine-clear",
      patterns: [{ pattern: "clear.ingress.iterate.com", target: "https://one.fly.dev" }],
    });

    const updated = await updateRoute(testEnv.DB, {
      routeId: created.routeId,
      externalId: null,
      metadata: {},
      patterns: [{ pattern: "clear.ingress.iterate.com", target: "https://one.fly.dev" }],
    });

    expect(updated.externalId).toBeNull();
  });

  test("delete supports externalId", async () => {
    const created = await createRoute(testEnv.DB, {
      typeIdPrefix: "tst",
      externalId: "machine-delete",
      patterns: [{ pattern: "delete.ingress.iterate.com", target: "https://one.fly.dev" }],
    });

    await expect(deleteRoute(testEnv.DB, { externalId: "machine-delete" })).resolves.toBe(true);
    await expect(deleteRoute(testEnv.DB, { externalId: "machine-delete" })).resolves.toBe(false);
    await expect(getRoute(testEnv.DB, created.routeId)).resolves.toBeNull();
  });

  test("resolve prioritizes exact over wildcard", async () => {
    const wildcard = await createSinglePatternRoute({
      pattern: "*.proj.ingress.iterate.com",
      target: "https://wild.fly.dev",
    });

    const exact = await createSinglePatternRoute({
      pattern: "app.proj.ingress.iterate.com",
      target: "https://exact.fly.dev",
    });

    const request = new Request("https://app.proj.ingress.iterate.com/hello", {
      headers: { host: "app.proj.ingress.iterate.com" },
    });

    const resolved = await resolveRoute(testEnv.DB, request);
    expect(resolved?.routeId).toBe(exact.routeId);
    expect(resolved?.routeId).not.toBe(wildcard.routeId);
  });

  test("double underscore hostnames are treated as opaque strings", async () => {
    await createSinglePatternRoute({
      pattern: "*__proj.ingress.iterate.com",
      target: "https://proj.fly.dev",
    });

    const request = new Request("https://web__proj.ingress.iterate.com/path", {
      headers: { host: "web__proj.ingress.iterate.com" },
    });

    const resolved = await resolveRoute(testEnv.DB, request);
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

  test("uses target host by default for cross-host proxying", async () => {
    await createSinglePatternRoute({
      pattern: "app.ingress.iterate.com",
      target: "https://target.fly.dev/base",
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("proxied", { status: 200 }));

    const parsedEnv = parseWorkerEnv(testEnv);
    const response = await proxyRequest(
      buildInboundRequest({
        host: "app.ingress.iterate.com",
        path: "/path?y=2",
        headers: { "x-custom": "ok" },
      }),
      parsedEnv,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = fetchSpy.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("https://target.fly.dev/base/path?y=2");
    expect(request.headers.get("host")).not.toBe("app.ingress.iterate.com");
    expect(request.headers.get("x-custom")).toBe("ok");
    expect(response.status).toBe(200);
  });

  test("applies optional per-pattern header overrides", async () => {
    await createSinglePatternRoute({
      pattern: "api.ingress.iterate.com",
      target: "https://target.fly.dev",
      headers: { authorization: "Bearer from-route" },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input as Request;
      expect(request.headers.get("authorization")).toBe("Bearer from-route");
      return new Response("ok", { status: 200 });
    });

    const response = await proxyRequest(
      buildInboundRequest({
        host: "api.ingress.iterate.com",
        path: "/v1",
        headers: { authorization: "Bearer inbound" },
      }),
      parseWorkerEnv(testEnv),
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

    const headers = createUpstreamHeaders(request, {}, new URL("https://target.fly.dev/ws"));
    expect(headers.get("upgrade")?.toLowerCase()).toBe("websocket");
    expect(headers.get("connection")?.toLowerCase()).toContain("upgrade");
  });

  test("proxies websocket upgrade transparently", async () => {
    await createSinglePatternRoute({
      pattern: "socket.ingress.iterate.com",
      target: "https://target.fly.dev/ws",
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.addEventListener("message", (event) => {
        server.send(`echo:${String(event.data)}`);
      });
      return new Response(null, {
        status: 101,
        headers: { connection: "Upgrade", upgrade: "websocket" },
        webSocket: client,
      });
    });

    const response = await proxyRequest(
      buildInboundRequest({
        host: "socket.ingress.iterate.com",
        path: "/ws",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
        },
      }),
      parseWorkerEnv(testEnv),
    );

    expect(response.status).toBe(101);
    const websocket = response.webSocket;
    expect(websocket).toBeTruthy();
    if (!websocket) {
      throw new Error("Expected websocket on upgrade response");
    }

    const messagePromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for websocket echo"));
      }, 2_000);
      websocket.addEventListener("message", (event) => {
        clearTimeout(timeout);
        resolve(String(event.data));
      });
      websocket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Websocket error"));
      });
    });

    websocket.accept();
    websocket.send("ping");
    await expect(messagePromise).resolves.toBe("echo:ping");
    websocket.close();
  });

  test("returns 404 when no route matches", async () => {
    const response = await proxyRequest(
      buildInboundRequest({
        host: "none.ingress.iterate.com",
        path: "/",
      }),
      parseWorkerEnv(testEnv),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "route_not_found" });
  });

  test("returns 502 when upstream fetch fails", async () => {
    await createSinglePatternRoute({
      pattern: "fail.ingress.iterate.com",
      target: "https://target.fly.dev",
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));

    const response = await proxyRequest(
      buildInboundRequest({
        host: "fail.ingress.iterate.com",
        path: "/",
      }),
      parseWorkerEnv(testEnv),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "proxy_error" });
  });

  test("POST /health does not skip env parsing and falls through safely", async () => {
    const response = await app.fetch(
      new Request("https://ingress.iterate.com/health", {
        method: "POST",
        headers: { host: "ingress.iterate.com" },
      }),
      testEnv,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "route_not_found" });
  });
});
