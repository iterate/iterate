import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { ProxyWorkerRouter } from "./server.ts";

type RoutePatternInput = {
  pattern: string;
  target: string;
  headers?: Record<string, string>;
};

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = nowMs();
  try {
    return await fn();
  } finally {
    const elapsedMs = nowMs() - started;
    console.log(`latencyMs ${label} ${elapsedMs.toFixed(1)}`);
  }
}

function getErrorCode(error: unknown): string {
  return String((error as { code?: string }).code ?? "");
}

async function main(): Promise<void> {
  const baseUrl =
    process.env.INGRESS_PROXY_E2E_BASE_URL ?? "https://ingress-proxy.iterate.workers.dev";
  const token = process.env.INGRESS_PROXY_E2E_API_TOKEN ?? process.env.INGRESS_PROXY_API_TOKEN;

  if (!token) {
    throw new Error("INGRESS_PROXY_E2E_API_TOKEN or INGRESS_PROXY_API_TOKEN is required");
  }

  const requestHost = new URL(baseUrl).hostname;
  const testId = randomUUID().slice(0, 8);

  const client: RouterClient<ProxyWorkerRouter> = createORPCClient(
    new RPCLink({
      url: `${baseUrl}/api/orpc/`,
      headers: {
        authorization: `Bearer ${token}`,
      },
    }),
  );

  const createdRouteIds: string[] = [];

  const cleanup = async (): Promise<void> => {
    for (const routeId of createdRouteIds.splice(0).reverse()) {
      try {
        await client.deleteRoute({ routeId });
      } catch {
        // best-effort cleanup
      }
    }
  };

  try {
    const health = await timed("health", async () => fetch(`${baseUrl}/health`));
    assert.equal(health.status, 200, "health should return 200");

    const candidatePatterns = [
      "*.workers.dev",
      "*.iterate.workers.dev",
      `*.${requestHost.split(".").slice(1).join(".")}`,
    ];
    let route: Awaited<ReturnType<typeof client.createRoute>> | null = null;
    let runPattern = "";
    for (const pattern of candidatePatterns) {
      try {
        route = await timed(`create-route:${pattern}`, async () =>
          client.createRoute({
            metadata: { testId, mode: "live-e2e", patternCandidate: pattern },
            patterns: [
              {
                pattern,
                target: "https://httpbingo.org",
                headers: {
                  host: "httpbingo.org",
                  "x-ingress-e2e": `live-${testId}`,
                },
              } satisfies RoutePatternInput,
            ],
          }),
        );
        runPattern = pattern;
        break;
      } catch (error) {
        if (getErrorCode(error) !== "CONFLICT") throw error;
      }
    }
    assert.notEqual(route, null, "failed to create a test route after trying fallback patterns");
    assert.ok(route);
    createdRouteIds.push(route.routeId);

    const proxied = await timed("proxy", async () =>
      fetch(`${baseUrl}/anything?hello=${testId}`, {
        headers: { "x-client-e2e": testId },
      }),
    );

    assert.equal(proxied.status, 200, "proxied request should return 200");
    assert.equal(
      proxied.headers.get("x-ingress-proxy-route-id"),
      route.routeId,
      "proxy response must include resolved route id",
    );

    const proxiedJson = (await proxied.json()) as {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
    };

    assert.equal(proxiedJson.method, "GET", "upstream should receive GET");
    assert.equal(
      proxiedJson.url,
      `https://httpbingo.org/anything?hello=${testId}`,
      "upstream URL should reflect configured route target",
    );

    let sawConflict = false;
    try {
      await timed("create-conflict", async () =>
        client.createRoute({
          patterns: [{ pattern: runPattern, target: "https://example.com" }],
        }),
      );
    } catch (error) {
      sawConflict = String((error as { code?: string }).code ?? "") === "CONFLICT";
    }

    assert.equal(sawConflict, true, "duplicate pattern create should fail with CONFLICT");

    const listed = await timed("list", async () => client.listRoutes());
    assert.equal(
      listed.some((item) => item.routeId === route.routeId),
      true,
      "listRoutes should include created route",
    );

    console.log("e2eResult ok");
    console.log("routeId", route.routeId);
    console.log("runPattern", runPattern);
    console.log("requestHost", requestHost);
  } finally {
    await timed("cleanup", cleanup);
  }
}

void main();
