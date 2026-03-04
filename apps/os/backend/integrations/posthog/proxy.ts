import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { CloudflareEnv } from "../../../env.ts";
import { waitUntil } from "../../../env.ts";
import type { Variables } from "../../types.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import { buildMachineFetcher } from "../../services/machine-readiness-probe.ts";

const POSTHOG_HOST = "eu.i.posthog.com";
const ITERATE_SLACK_TEAM_ID = "T0675PSN873";
const POSTHOG_SECRET_HEADER = "x-iterate-webhook-secret";

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

  const deliveryId =
    c.req.header("x-posthog-delivery-id") ??
    c.req.header("x-request-id") ??
    c.req.header("x-posthog-event-id") ??
    `ph-${randomUUID()}`;

  waitUntil(
    (async () => {
      const db = c.var.db;
      try {
        const connection = await db.query.projectConnection.findFirst({
          where: (pc, { and, eq }) =>
            and(eq(pc.provider, "slack"), eq(pc.externalId, ITERATE_SLACK_TEAM_ID)),
          with: {
            project: {
              with: {
                machines: {
                  where: (m, { eq }) => eq(m.state, "active"),
                  limit: 1,
                },
              },
            },
          },
        });

        const projectId = connection?.projectId ?? null;
        const machine = connection?.project?.machines[0] ?? null;

        if (!machine) {
          logger.set({
            deliveryId,
            projectId,
          });
          logger.warn("[PostHog Webhook] No active machine for Iterate Slack team");
        } else {
          try {
            await forwardPosthogWebhookToMachine({
              machine,
              env: c.env,
              deliveryId,
              payload,
            });
          } catch (error) {
            logger.set({
              deliveryId,
              machineId: machine.id,
              projectId,
            });
            logger.warn(
              `[PostHog Webhook] Failed to forward to machine: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        await db
          .insert(schema.event)
          .values({
            type: "posthog:webhook-received",
            payload,
            projectId,
            externalId: deliveryId,
          })
          .onConflictDoNothing();
      } catch (error) {
        logger.error("[PostHog Webhook] Failed in background handler", error, { deliveryId });
      }
    })(),
  );

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

function verifySharedSecret(
  expected: string | undefined,
  actual: string | null | undefined,
): boolean {
  if (!expected || !actual) return false;
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

async function forwardPosthogWebhookToMachine(params: {
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
