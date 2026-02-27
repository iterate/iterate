import { afterAll, beforeAll, describe, expect, it } from "vitest";

const baseUrl = process.env.INGRESS_PROXY_E2E_BASE_URL;
const apiToken = process.env.INGRESS_PROXY_E2E_API_TOKEN ?? process.env.INGRESS_PROXY_API_TOKEN;

async function rpc<T>(name: string, input: unknown): Promise<T> {
  if (!baseUrl || !apiToken) throw new Error("E2E env vars not set");
  const res = await fetch(`${baseUrl}/api/orpc/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({ json: input }),
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    const text = await res.text();
    throw new Error(`rpc ${name}: expected JSON but got ${res.status} ${contentType}: ${text.slice(0, 200)}`);
  }
  const payload = (await res.json()) as { json?: T & { code?: string; status?: number } };
  if (!res.ok) throw payload.json;
  return payload.json as T;
}

function headerValue(headers: Record<string, string | string[]> | undefined, name: string) {
  if (!headers) return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return null;
  const v = headers[key];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

describe("live ingress-proxy E2E", () => {
  const createdRouteIds = new Set<string>();
  const suiteId = `live-e2e-${Date.now()}`;

  beforeAll(async () => {
    if (!baseUrl || !apiToken) throw new Error("Missing INGRESS_PROXY_E2E_BASE_URL / API_TOKEN");
    const existing = await rpc<{ routeId: string; metadata: Record<string, unknown> }[]>(
      "listRoutes",
      {},
    );
    for (const r of existing) {
      if (r.metadata?.suiteId === suiteId) await rpc("deleteRoute", { routeId: r.routeId });
    }
  });

  afterAll(async () => {
    for (const id of [...createdRouteIds].reverse()) {
      try {
        await rpc("deleteRoute", { routeId: id });
      } catch {
        // best-effort
      }
    }
  });

  async function create(
    patterns: { pattern: string; target: string; headers?: Record<string, string> }[],
    kind: string,
  ) {
    const route = await rpc<{ routeId: string }>("createRoute", {
      metadata: { suiteId, kind },
      patterns,
    });
    createdRouteIds.add(route.routeId);
    return route;
  }

  it("exact route wins over wildcards, longer wildcard wins over shorter", async () => {
    const requestHost = new URL(baseUrl!).hostname;
    const shortSuffix = "workers.dev";
    const longSuffix = "iterate.workers.dev";

    // Find available wildcard patterns (some may be taken by other runs)
    const tryPatterns = async (suffixes: string[], kind: string) => {
      for (const p of [`*.${suffixes[0]}`, `**.${suffixes[0]}`, `***.${suffixes[0]}`]) {
        try {
          return {
            route: await create(
              [
                {
                  pattern: p,
                  target: "https://httpbingo.org",
                  headers: { host: "httpbingo.org", "x-route-kind": kind },
                },
              ],
              kind,
            ),
            pattern: p,
          };
        } catch (e) {
          if ((e as { code?: string }).code !== "CONFLICT") throw e;
        }
      }
      throw new Error(`All wildcard patterns for ${suffixes[0]} are taken`);
    };

    const short = await tryPatterns([shortSuffix], "short");
    const long = await tryPatterns([longSuffix], "long");

    // Exact match should win
    const exact = await create(
      [
        {
          pattern: requestHost,
          target: "https://httpbingo.org",
          headers: { host: "httpbingo.org", "x-route-kind": "exact" },
        },
      ],
      "exact",
    );

    const exactRes = await fetch(`${baseUrl}/anything?scenario=exact`);
    expect(exactRes.status).toBe(200);
    expect(exactRes.headers.get("x-ingress-proxy-route-id")).toBe(exact.routeId);
    const exactJson = (await exactRes.json()) as {
      headers?: Record<string, string | string[]>;
      url?: string;
    };
    expect(exactJson.url).toBe("https://httpbingo.org/anything?scenario=exact");
    expect(headerValue(exactJson.headers, "x-route-kind")).toBe("exact");

    // Delete exact, longer wildcard should now win
    await rpc("deleteRoute", { routeId: exact.routeId });
    createdRouteIds.delete(exact.routeId);

    const wcRes = await fetch(`${baseUrl}/anything?scenario=wildcard-specificity`);
    expect(wcRes.status).toBe(200);
    expect(wcRes.headers.get("x-ingress-proxy-route-id")).toBe(long.route.routeId);
    const wcJson = (await wcRes.json()) as { headers?: Record<string, string | string[]> };
    expect(headerValue(wcJson.headers, "x-route-kind")).toBe("long");

    expect(short.pattern.length).toBeGreaterThan(0);
  }, 120_000);

  it.each([
    { scenario: "create duplicate", action: "createRoute" as const },
    { scenario: "update to taken pattern", action: "updateRoute" as const },
  ])(
    "$scenario returns CONFLICT",
    async ({ action }) => {
      // Ensure we have a route to conflict with
      let targetRoute: { routeId: string };
      try {
        targetRoute = await create(
          [
            {
              pattern: `conflict-test-${Date.now()}.example.test`,
              target: "https://httpbingo.org",
            },
          ],
          `conflict-${action}`,
        );
      } catch {
        // Route may already exist from another test; just use a fresh pattern
        targetRoute = await create(
          [
            {
              pattern: `conflict-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.example.test`,
              target: "https://httpbingo.org",
            },
          ],
          `conflict-${action}`,
        );
      }

      const takenPattern = `conflict-target-${Date.now()}.example.test`;
      await create([{ pattern: takenPattern, target: "https://httpbingo.org" }], "conflict-holder");

      if (action === "createRoute") {
        await expect(
          rpc("createRoute", {
            metadata: { suiteId },
            patterns: [{ pattern: takenPattern, target: "https://example.com" }],
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      } else {
        await expect(
          rpc("updateRoute", {
            routeId: targetRoute.routeId,
            metadata: { suiteId },
            patterns: [{ pattern: takenPattern, target: "https://example.com" }],
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      }
    },
    30_000,
  );

  it("self-update preserves own patterns without conflict", async () => {
    const pattern = `self-update-${Date.now()}.example.test`;
    const route = await create(
      [
        {
          pattern,
          target: "https://httpbingo.org",
          headers: { host: "httpbingo.org", "x-route-kind": "v1" },
        },
      ],
      "self-update",
    );

    const updated = await rpc<{ routeId: string }>("updateRoute", {
      routeId: route.routeId,
      metadata: { suiteId, kind: "self-updated" },
      patterns: [
        {
          pattern,
          target: "https://httpbingo.org",
          headers: { host: "httpbingo.org", "x-route-kind": "v2" },
        },
      ],
    });
    expect(updated.routeId).toBe(route.routeId);
  }, 30_000);

  it("listRoutes includes created routes", async () => {
    const listed = await rpc<{ routeId: string }[]>("listRoutes", {});
    const ids = new Set(listed.map((r) => r.routeId));
    for (const id of createdRouteIds) {
      expect(ids.has(id)).toBe(true);
    }
  }, 30_000);
});
