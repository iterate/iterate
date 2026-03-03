import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { describe, expect, test } from "vitest";
import { useCloudflareTunnel } from "../../test-helpers/use-cloudflare-tunnel.ts";
import { useIngressProxyRoutes } from "../../test-helpers/use-ingress-proxy-routes.ts";

const INGRESS_PROXY_BASE_URL = "https://ingress.iterate.com";
const INGRESS_PROXY_DOMAIN = "ingress.iterate.com";

describe("clean ingress proxy forwarded headers", () => {
  test("routes <id>.ingress.iterate.com and bla__<id>.ingress.iterate.com with correct forwarded headers", async () => {
    const ingressProxyApiKey =
      process.env.INGRESS_PROXY_API_TOKEN?.trim() ??
      process.env.INGRESS_PROXY_E2E_API_TOKEN?.trim() ??
      "";
    if (!ingressProxyApiKey) {
      throw new Error("set INGRESS_PROXY_API_TOKEN (or INGRESS_PROXY_E2E_API_TOKEN)");
    }

    const id = randomUUID().slice(0, 10);
    const baseHost = `${id}.${INGRESS_PROXY_DOMAIN}`;
    const wildcardPattern = `*__${baseHost}`;
    const wildcardHost = `bla__${baseHost}`;

    const server = createServer((request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("ok");
        return;
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          url: request.url ?? "/",
          headers: request.headers,
        }),
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("failed to bind local server");
    }

    try {
      await using tunnel = await useCloudflareTunnel({
        localPort: address.port,
        cloudflaredBin: process.env.JONASLAND_E2E_CLOUDFLARED_BIN,
        timeoutMs: 120_000,
      });
      const tunnelHost = new URL(tunnel.tunnelUrl).host;
      await using _routes = await useIngressProxyRoutes({
        ingressProxyApiKey,
        ingressProxyBaseUrl: INGRESS_PROXY_BASE_URL,
        routes: [
          {
            metadata: { source: "jonasland-vitest-forwarded-headers", baseHost },
            patterns: [
              {
                pattern: baseHost,
                target: tunnel.tunnelUrl,
                headers: { Host: tunnelHost },
              },
              {
                pattern: wildcardPattern,
                target: tunnel.tunnelUrl,
                headers: { Host: tunnelHost },
              },
            ],
          },
        ],
      });

      const fetchEcho = async (host: string, route: "direct" | "wildcard") => {
        const deadline = Date.now() + 120_000;
        let lastError = "no response";
        while (Date.now() < deadline) {
          try {
            const response = await fetch(`https://${host}/echo?route=${route}`, {
              headers: { "x-jonasland-forwarded-test": "1" },
              signal: AbortSignal.timeout(10_000),
            });
            const text = await response.text();
            if (response.ok) {
              return JSON.parse(text) as {
                url: string;
                headers: Record<string, string | string[] | undefined>;
              };
            }
            lastError = `status=${String(response.status)} body=${text.slice(0, 200)}`;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error(`timed out fetching ${host}: ${lastError}`);
      };

      const direct = await fetchEcho(baseHost, "direct");
      const wildcard = await fetchEcho(wildcardHost, "wildcard");

      const first = (headers: Record<string, string | string[] | undefined>, name: string) => {
        const value = headers[name];
        return Array.isArray(value) ? value[0] : value;
      };

      for (const [host, payload, route] of [
        [baseHost, direct, "direct"],
        [wildcardHost, wildcard, "wildcard"],
      ] as const) {
        const headers = payload.headers;
        expect(first(headers, "host")).toBe(tunnelHost);
        expect(first(headers, "x-forwarded-host")).toBe(host);
        expect(first(headers, "x-forwarded-proto")).toBe("https");
        expect(first(headers, "x-jonasland-forwarded-test")).toBe("1");
        expect(first(headers, "forwarded")).toBeUndefined();
        expect(first(headers, "x-original-host")).toBeUndefined();
        const forwardedFor = first(headers, "x-forwarded-for") ?? "";
        const clientIp = forwardedFor.split(",")[0]?.trim() ?? "";
        expect(clientIp).not.toBe("");
        expect(isIP(clientIp)).not.toBe(0);
        const observedUrl = new URL(payload.url, "http://local");
        expect(observedUrl.searchParams.get("route")).toBe(route);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  }, 300_000);
});
