import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import {
  buildUpstreamUrl,
  createUpstreamHeaders,
  deleteRoute,
  listRoutes,
  readBearerToken,
  resolveRoute,
  setRoute,
} from "./server.ts";

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS routes;");
});

describe("route table", () => {
  test("set/list/delete route", async () => {
    await setRoute(env.DB, {
      route: "app1__someapp.cf-ingress-worker.com",
      target: "https://someapp.fly.dev",
      headers: { host: "app1__someapp.cf-ingress-worker.com" },
      metadata: { app: "app1" },
      ttlSeconds: 3600,
    });

    const routes = await listRoutes(env.DB);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.route).toBe("app1__someapp.cf-ingress-worker.com");
    expect(routes[0]?.target).toBe("https://someapp.fly.dev/");
    expect(routes[0]?.status).toBe("active");
    expect(routes[0]?.ttlSeconds).toBe(3600);
    expect(routes[0]?.expiresAt).not.toBeNull();
    expect(routes[0]?.expiredAt).toBeNull();

    const deleted = await deleteRoute(env.DB, "app1__someapp.cf-ingress-worker.com");
    expect(deleted).toBe(true);
    await expect(listRoutes(env.DB)).resolves.toHaveLength(0);
  });

  test("resolve prefers exact route over wildcard", async () => {
    await setRoute(env.DB, {
      route: "*.cf-ingress-worker.com",
      target: "https://wildcard.fly.dev",
      metadata: { kind: "wildcard" },
    });

    await setRoute(env.DB, {
      route: "app2__someapp.cf-ingress-worker.com",
      target: "https://exact.fly.dev",
      metadata: { kind: "exact" },
    });

    const exactRequest = new Request("https://app2__someapp.cf-ingress-worker.com/a", {
      headers: {
        host: "app2__someapp.cf-ingress-worker.com",
      },
    });

    const wildcardRequest = new Request("https://other.cf-ingress-worker.com/b", {
      headers: {
        host: "other.cf-ingress-worker.com",
      },
    });

    const exact = await resolveRoute(env.DB, exactRequest);
    const wildcard = await resolveRoute(env.DB, wildcardRequest);

    expect(exact?.route).toBe("app2__someapp.cf-ingress-worker.com");
    expect(exact?.metadata.kind).toBe("exact");
    expect(wildcard?.route).toBe("*.cf-ingress-worker.com");
    expect(wildcard?.metadata.kind).toBe("wildcard");
  });

  test("upstream URL and header rewriting", async () => {
    await setRoute(env.DB, {
      route: "app3__someapp.cf-ingress-worker.com",
      target: "https://someapp.fly.dev/base",
      headers: {
        host: "app3__someapp.cf-ingress-worker.com",
        "x-custom-upstream": "yes",
      },
    });

    const request = new Request("https://app3__someapp.cf-ingress-worker.com/path/inside?x=1", {
      method: "GET",
      headers: {
        host: "app3__someapp.cf-ingress-worker.com",
      },
    });

    const resolved = await resolveRoute(env.DB, request);
    expect(resolved).not.toBeNull();

    const upstreamUrl = buildUpstreamUrl(resolved!.targetUrl, new URL(request.url));
    expect(upstreamUrl.toString()).toBe("https://someapp.fly.dev/base/path/inside?x=1");

    const upstreamHeaders = createUpstreamHeaders(request, upstreamUrl.host, resolved!.headers);
    expect(upstreamHeaders.get("host")).toBe("app3__someapp.cf-ingress-worker.com");
    expect(upstreamHeaders.get("x-custom-upstream")).toBe("yes");
  });

  test("expired TTL matching rows are marked expired and ignored", async () => {
    await setRoute(env.DB, {
      route: "app4__someapp.cf-ingress-worker.com",
      target: "https://someapp.fly.dev",
      ttlSeconds: 60,
    });

    await env.DB.prepare(`
        UPDATE routes
        SET status = 'active', expires_at = datetime('now', '-1 second'), expired_at = NULL
        WHERE route = ?1
      `)
      .bind("app4__someapp.cf-ingress-worker.com")
      .run();

    const request = new Request("https://app4__someapp.cf-ingress-worker.com/path", {
      headers: {
        host: "app4__someapp.cf-ingress-worker.com",
      },
    });

    await expect(resolveRoute(env.DB, request)).resolves.toBeNull();

    const row = await env.DB.prepare(`SELECT status, expired_at FROM routes WHERE route = ?1`)
      .bind("app4__someapp.cf-ingress-worker.com")
      .first<{ status: string; expired_at: string | null }>();

    expect(row?.status).toBe("expired");
    expect(row?.expired_at).not.toBeNull();
  });

  test("falls back to wildcard when exact route is expired", async () => {
    await setRoute(env.DB, {
      route: "*.cf-ingress-worker.com",
      target: "https://wildcard.fly.dev",
      metadata: { kind: "wildcard" },
    });

    await setRoute(env.DB, {
      route: "app5__someapp.cf-ingress-worker.com",
      target: "https://exact.fly.dev",
      ttlSeconds: 60,
      metadata: { kind: "exact" },
    });

    await env.DB.prepare(`
        UPDATE routes
        SET status = 'active', expires_at = datetime('now', '-1 second'), expired_at = NULL
        WHERE route = ?1
      `)
      .bind("app5__someapp.cf-ingress-worker.com")
      .run();

    const request = new Request("https://app5__someapp.cf-ingress-worker.com/path", {
      headers: {
        host: "app5__someapp.cf-ingress-worker.com",
      },
    });

    const resolved = await resolveRoute(env.DB, request);
    expect(resolved?.route).toBe("*.cf-ingress-worker.com");
    expect(resolved?.metadata.kind).toBe("wildcard");

    const row = await env.DB.prepare(`SELECT status, expired_at FROM routes WHERE route = ?1`)
      .bind("app5__someapp.cf-ingress-worker.com")
      .first<{ status: string; expired_at: string | null }>();

    expect(row?.status).toBe("expired");
    expect(row?.expired_at).not.toBeNull();
  });

  test("bearer token parsing", () => {
    expect(readBearerToken("Bearer abc123")).toBe("abc123");
    expect(readBearerToken("bearer abc123")).toBe("abc123");
    expect(readBearerToken("Token abc123")).toBeNull();
    expect(readBearerToken(null)).toBeNull();
  });
});
