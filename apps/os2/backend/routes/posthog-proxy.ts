import { Hono } from "hono";
import type { CloudflareEnv } from "../../env.ts";

const POSTHOG_HOST = "eu.i.posthog.com";

export const posthogProxyApp = new Hono<{ Bindings: CloudflareEnv }>();

// Proxy all /ingest/* requests to PostHog EU
posthogProxyApp.all("/ingest/*", async (c) => {
  const url = new URL(c.req.url);

  // Remove /ingest prefix and forward to PostHog
  const posthogPath = url.pathname.replace(/^\/ingest/, "");
  const posthogUrl = new URL(`https://${POSTHOG_HOST}${posthogPath}${url.search}`);

  // Clone the request with the new URL
  const headers = new Headers(c.req.raw.headers);
  headers.set("Host", POSTHOG_HOST);

  // Remove headers that shouldn't be forwarded
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-proto");

  const response = await fetch(posthogUrl.toString(), {
    method: c.req.method,
    headers,
    body:
      c.req.method !== "GET" && c.req.method !== "HEAD" ? await c.req.raw.arrayBuffer() : undefined,
  });

  // Return the PostHog response
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
});
