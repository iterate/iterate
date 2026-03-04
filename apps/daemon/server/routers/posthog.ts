import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod/v4";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";

const logger = console;

const DAEMON_PORT = process.env.PORT || "3001";
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;
const AGENT_ROUTER_BASE_URL = `${DAEMON_BASE_URL}/api/agents`;
const ERROR_PULSE_CHANNEL_ID = "C09K1CTN4M7";

const ForwardedPostHogInput = z.object({
  deliveryId: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

const inflightDeliveryIds = new Set<string>();

export const posthogRouter = new Hono();

posthogRouter.post("/webhook", async (c) => {
  const parsed = ForwardedPostHogInput.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", issues: parsed.error.issues }, 400);
  }

  const input = parsed.data;
  const reservation = await reserveDelivery(input.deliveryId);
  if (reservation.duplicate) {
    return c.json({ success: true, duplicate: true });
  }

  const alertKey = resolveAlertKey(input.payload);
  const agentPath = `/posthog/alert/${toPathSegment(alertKey)}`;

  const prompt = buildPrompt({
    payload: input.payload,
    deliveryId: input.deliveryId,
    alertKey,
  });

  try {
    const response = await fetch(`${AGENT_ROUTER_BASE_URL}${agentPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "iterate:agent:prompt-added", message: prompt }],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "<no body>");
      logger.error("[daemon/posthog] Failed to post prompt", {
        deliveryId: input.deliveryId,
        agentPath,
        status: response.status,
        body: body.slice(0, 200),
      });
      return c.json({ error: "Failed to queue alert" }, 502);
    }

    await markDeliveryProcessed(input.deliveryId, input.payload);
    return c.json({ success: true, agentPath, alertKey });
  } finally {
    inflightDeliveryIds.delete(input.deliveryId);
  }
});

async function reserveDelivery(deliveryId: string): Promise<{ duplicate: boolean }> {
  if (inflightDeliveryIds.has(deliveryId)) return { duplicate: true };
  inflightDeliveryIds.add(deliveryId);

  const [existing] = await db
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(and(eq(schema.events.type, "posthog:webhook"), eq(schema.events.externalId, deliveryId)))
    .limit(1);

  if (existing) {
    inflightDeliveryIds.delete(deliveryId);
    return { duplicate: true };
  }

  return { duplicate: false };
}

async function markDeliveryProcessed(
  deliveryId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(schema.events).values({
    id: `evt_${createHash("sha1").update(`${deliveryId}:${Date.now()}`).digest("hex").slice(0, 16)}`,
    type: "posthog:webhook",
    externalId: deliveryId,
    payload,
  });
}

function resolveAlertKey(payload: Record<string, unknown>): string {
  const alert = readRecord(payload.alert);
  const candidates = [
    alert?.id,
    alert?.key,
    alert?.name,
    payload.alert_id,
    payload.id,
    payload.uuid,
    payload.event_id,
  ];

  for (const candidate of candidates) {
    const value = stringifyScalar(candidate);
    if (value) return value;
  }

  const hash = createHash("sha1").update(JSON.stringify(payload)).digest("hex").slice(0, 12);
  return `unknown-${hash}`;
}

function buildPrompt(params: {
  payload: Record<string, unknown>;
  deliveryId: string;
  alertKey: string;
}): string {
  const title =
    stringifyScalar(readRecord(params.payload.alert)?.name) ||
    stringifyScalar(params.payload.name) ||
    stringifyScalar(params.payload.alert_name) ||
    "PostHog alert";
  const severity =
    stringifyScalar(readRecord(params.payload.alert)?.severity) ||
    stringifyScalar(params.payload.severity) ||
    "unknown";
  const url =
    stringifyScalar(readRecord(params.payload.alert)?.url) ||
    stringifyScalar(params.payload.url) ||
    "";
  const detail = compactText(
    stringifyScalar(params.payload.body) ||
      stringifyScalar(params.payload.message) ||
      JSON.stringify(params.payload),
    1200,
  );

  const lines = [
    "@error-pulse",
    `[posthog] delivery=${params.deliveryId} key=${params.alertKey}`,
    `title: ${title}`,
    `severity: ${severity}`,
    url ? `url: ${url}` : "",
    "",
    detail,
    "",
    "If you post in #error-pulse, subscribe that Slack thread so replies route back here:",
    `iterate tool subscribe-slack-thread --channel ${ERROR_PULSE_CHANNEL_ID} --thread-ts <thread_ts> --session-id <session_id>`,
  ];

  return lines.filter(Boolean).join("\n");
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringifyScalar(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function compactText(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  if (maxLength <= 3) return collapsed.slice(0, maxLength);
  return `${collapsed.slice(0, maxLength - 3)}...`;
}

function toPathSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x"
  );
}
