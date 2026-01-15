import { Hono } from "hono";
import type { CloudflareEnv } from "../../../env.ts";

const POSTHOG_HOST = "eu.i.posthog.com";

export const posthogProxyApp = new Hono<{ Bindings: CloudflareEnv }>();

posthogProxyApp.all("/api/integrations/posthog/proxy/*", async (c) => {
  const url = new URL(c.req.url);
  const posthogPath = url.pathname.replace(/^\/api\/integrations\/posthog\/proxy/, "");
  const posthogUrl = `https://${POSTHOG_HOST}${posthogPath}${url.search}`;

  const headers = new Headers(c.req.raw.headers);
  headers.set("Host", POSTHOG_HOST);
  headers.set("X-Forwarded-Host", url.hostname);
  headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));

  // Forward client IP for geolocation - Cloudflare provides the real client IP
  const clientIP = c.req.header("cf-connecting-ip");
  if (clientIP) {
    headers.set("X-Forwarded-For", clientIP);
  }

  const response = await fetch(posthogUrl, {
    method: c.req.method,
    headers,
    body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
  });

  return new Response(response.body, response);
});
