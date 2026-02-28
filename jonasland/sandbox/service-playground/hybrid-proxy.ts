/**
 * Service proxy — HTTP reverse proxy with managed routes.
 *
 * Sits in front of an inner HTTP service. Managed paths (/service/*,
 * /openapi.json) are handled by the Hono app. Everything else is
 * proxied through to the inner service via HTTP.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { Hono } from "hono";
import { serve } from "@hono/node-server";

export interface ServiceProxyOptions {
  /** Port of the inner HTTP service to proxy to */
  innerPort: number;
  /** Hono app handling managed routes + catch-all proxy */
  app: Hono;
}

export interface ServiceProxyHandle {
  port: number;
  close(): void;
}

/**
 * Create an HTTP proxy that serves managed routes via Hono and
 * proxies everything else to the inner service.
 */
export function createServiceProxy(opts: ServiceProxyOptions): Promise<ServiceProxyHandle> {
  const { innerPort, app } = opts;

  // Mount a catch-all that proxies to the inner service
  app.all("/*", async (c) => {
    const url = new URL(c.req.url);
    const proxyRes = await new Promise<IncomingMessage>((resolve, reject) => {
      const proxyReq = httpRequest(
        {
          hostname: "127.0.0.1",
          port: innerPort,
          path: url.pathname + url.search,
          method: c.req.method,
          headers: {
            ...Object.fromEntries(c.req.raw.headers),
            host: `127.0.0.1:${innerPort}`,
          },
        },
        resolve,
      );
      proxyReq.on("error", reject);
      if (c.req.raw.body) {
        Readable.fromWeb(c.req.raw.body as ReadableStream).pipe(proxyReq);
      } else {
        proxyReq.end();
      }
    });

    // Build headers properly to handle multi-value headers (e.g. Set-Cookie)
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) responseHeaders.append(key, v);
      } else {
        responseHeaders.set(key, value);
      }
    }

    return new Response(
      proxyRes.statusCode === 204 || proxyRes.statusCode === 304
        ? null
        : (Readable.toWeb(proxyRes as unknown as Readable) as ReadableStream),
      {
        status: proxyRes.statusCode,
        headers: responseHeaders,
      },
    );
  });

  return new Promise<ServiceProxyHandle>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      resolve({
        port: info.port,
        close() {
          server.close();
        },
      });
    });
  });
}
