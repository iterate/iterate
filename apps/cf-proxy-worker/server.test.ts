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
    });

    const routes = await listRoutes(env.DB);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.route).toBe("app1__someapp.cf-ingress-worker.com");
    expect(routes[0]?.target).toBe("https://someapp.fly.dev/");

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

  test("bearer token parsing", () => {
    expect(readBearerToken("Bearer abc123")).toBe("abc123");
    expect(readBearerToken("bearer abc123")).toBeNull();
    expect(readBearerToken("Token abc123")).toBeNull();
    expect(readBearerToken(null)).toBeNull();
  });
});
