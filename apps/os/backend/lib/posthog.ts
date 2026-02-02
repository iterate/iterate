import { getDb } from "../db/client.ts";
import { outboxClient } from "../outbox/client.ts";

/** Minimal env type for PostHog functions */
type PostHogEnv = {
  POSTHOG_PUBLIC_KEY?: string;
  VITE_APP_STAGE: string;
};

/**
 * Capture a server-side event via outbox pattern.
 * Events are queued for reliable delivery with retry support.
 * Use with waitUntil() in Cloudflare Workers to ensure delivery.
 */
export async function captureServerEvent(
  _env: PostHogEnv,
  params: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    groups?: Record<string, string>;
  },
): Promise<void> {
  const db = getDb();
  await outboxClient.sendTx(db, "posthog:event", async (_tx) => ({
    payload: {
      distinctId: params.distinctId,
      event: params.event,
      properties: params.properties,
      groups: params.groups,
    },
  }));
}

/**
 * Capture an exception to PostHog error tracking via outbox pattern.
 * Includes stack trace and additional context.
 * Use with waitUntil() in Cloudflare Workers to ensure delivery.
 */
export async function captureServerException(
  _env: PostHogEnv,
  params: {
    distinctId: string;
    error: Error;
    properties?: Record<string, unknown>;
  },
): Promise<void> {
  const db = getDb();
  await outboxClient.sendTx(db, "posthog:exception", async (_tx) => ({
    payload: {
      distinctId: params.distinctId,
      error: {
        name: params.error.name,
        message: params.error.message,
        stack: params.error.stack,
      },
      properties: params.properties,
    },
  }));
}
