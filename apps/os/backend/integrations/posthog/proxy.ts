import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { CloudflareEnv } from "../../../env.ts";
import type { Variables } from "../../types.ts";
import * as schema from "../../db/schema.ts";
import { outboxClient } from "../../outbox/client.ts";
import { logger } from "../../tag-logger.ts";
import { buildMachineFetcher } from "../../services/machine-readiness-probe.ts";

const POSTHOG_HOST = "eu.i.posthog.com";
const POSTHOG_SECRET_HEADER = "x-iterate-webhook-secret";

/**
 * PostHog event types that should NOT be forwarded to machines.
 * `$error_tracking_issue_created` events are generated when our own outbox DLQ
 * sends a `$exception` to PostHog, which then fires a webhook back to us.
 * Forwarding these creates a recursive loop:
 *   forwardPosthogWebhook fails → DLQ → $exception → PostHog webhook
 *   → forwardPosthogWebhook → fail → DLQ → $exception → …
 */
const IGNORED_EVENT_TYPES = new Set([
  "$error_tracking_issue_created",
  "$error_tracking_issue_status_change",
]);

export const posthogProxyApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

posthogProxyApp.post("/api/integrations/posthog/webhook", async (c) => {
  const body = await c.req.text();
  const incomingSecret = c.req.header(POSTHOG_SECRET_HEADER);
  if (!verifySharedSecret(c.env.POSTHOG_WEBHOOK_SECRET, incomingSecret)) {
    logger.warn("[PostHog Webhook] Invalid shared secret");
    return c.json({ error: "Invalid shared secret" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  // Drop PostHog-internal events that would cause recursive error loops.
  const eventType = resolveEventType(payload);
  if (eventType && IGNORED_EVENT_TYPES.has(eventType)) {
    logger.debug("[PostHog Webhook] Ignoring internal event type", { eventType });
    return c.json({ received: true, ignored: true, reason: `event type ${eventType} is filtered` });
  }

  const deliveryId =
    c.req.header("x-posthog-delivery-id") ??
    c.req.header("x-request-id") ??
    c.req.header("x-posthog-event-id") ??
    `ph-${randomUUID()}`;

  const result = await outboxClient.send(c.var.db, {
    name: "posthog:webhook-received",
    payload: {
      deliveryId,
      payload,
    },
    deduplicationKey: deliveryId,
  });

  if (result.duplicate) {
    logger.debug("[PostHog Webhook] Duplicate, skipping", { deliveryId });
    return c.json({ received: true, duplicate: true });
  }

  return c.json({ received: true });
});

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

/**
 * Extract the PostHog event type from a webhook payload.
 * PostHog webhooks nest the event data under `event.event` (action webhooks)
 * or at the top-level `event` key (direct event webhooks).
 */
function resolveEventType(payload: Record<string, unknown>): string | null {
  // Action webhook format: { event: { event: "$error_tracking_issue_created", ... } }
  const nested = payload.event;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const inner = (nested as Record<string, unknown>).event;
    if (typeof inner === "string") return inner;
  }
  // Direct event format: { event: "$error_tracking_issue_created" }
  if (typeof payload.event === "string") return payload.event;
  return null;
}

function verifySharedSecret(
  expected: string | undefined,
  actual: string | null | undefined,
): boolean {
  if (!expected || !actual) return false;

  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();

  return timingSafeEqual(expectedDigest, actualDigest);
}

export async function forwardPosthogWebhookToMachine(params: {
  machine: typeof schema.machine.$inferSelect;
  env: CloudflareEnv;
  deliveryId: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const fetcher = await buildMachineFetcher(params.machine, params.env, "PostHog Webhook");
  if (!fetcher) {
    throw new Error("Could not build machine fetcher");
  }

  const response = await fetcher("/api/integrations/posthog/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deliveryId: params.deliveryId,
      payload: params.payload,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<no body>");
    throw new Error(`Machine forward failed (${response.status}): ${body.slice(0, 500)}`);
  }
}
