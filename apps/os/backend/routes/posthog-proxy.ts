import { Hono } from "hono";
import type { CloudflareEnv } from "../../env.ts";
import { logger } from "../tag-logger.ts";

const POSTHOG_HOST = "eu.i.posthog.com";

// Allowlisted paths for PostHog proxy (from PostHog docs)
// - /batch: Ingest/capture batched events
// - /e: Capture individual events
// - /i/v0/e: Capture individual events (alternate path)
// - /capture: Legacy capture endpoint
// - /decide: Feature flags and config (legacy)
// - /flags: Autocapture, session recording, feature flags
// - /s: Session recordings
// - /static: Static assets (array.js, etc.)
const ALLOWED_PATH_PREFIXES = [
  "/batch",
  "/e",
  "/i/",
  "/capture",
  "/decide",
  "/flags",
  "/s",
  "/static",
];

// Headers safe to forward to PostHog
const ALLOWED_HEADERS = ["content-type", "accept", "user-agent", "accept-encoding", "origin"];

export const posthogProxyApp = new Hono<{ Bindings: CloudflareEnv }>();

// Proxy all /ingest/* requests to PostHog EU
posthogProxyApp.all("/ingest/*", async (c) => {
  const url = new URL(c.req.url);

  // Remove /ingest prefix and forward to PostHog
  const posthogPath = url.pathname.replace(/^\/ingest/, "");

  // Validate path against allowlist
  // Only allow exact match or match with trailing slash (e.g., "/e" or "/e/something")
  const isAllowed = ALLOWED_PATH_PREFIXES.some(
    (prefix) => posthogPath === prefix || posthogPath.startsWith(prefix + "/"),
  );

  if (!isAllowed) {
    logger.warn("PostHog proxy: blocked unallowed path", { path: posthogPath });
    return c.text("Not found", 404);
  }

  const posthogUrl = new URL(`https://${POSTHOG_HOST}${posthogPath}${url.search}`);

  // Use header allowlist for security - only forward safe headers
  const headers = new Headers();
  headers.set("Host", POSTHOG_HOST);

  for (const name of ALLOWED_HEADERS) {
    const value = c.req.header(name);
    if (value) {
      headers.set(name, value);
    }
  }

  // Preserve client IP for geolocation
  const clientIP = c.req.header("cf-connecting-ip") || c.req.header("x-real-ip");
  if (clientIP) {
    headers.set("X-Forwarded-For", clientIP);
  }

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
