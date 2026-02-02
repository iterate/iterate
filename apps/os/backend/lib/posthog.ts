import { getDb } from "../db/client.ts";
import type { PostHogEventTypes } from "../outbox/event-types.ts";
import { internalOutboxClient } from "../outbox/internal-client.ts";
import { logger } from "../tag-logger.ts";

/** Minimal env type for PostHog functions */
type PostHogEnv = {
  POSTHOG_PUBLIC_KEY?: string;
  VITE_APP_STAGE: string;
};

type PostHogEventPayload = PostHogEventTypes["posthog:event.captured"];
type PostHogExceptionPayload = PostHogEventTypes["posthog:exception.captured"];

/**
 * Capture a server-side event via PostHog HTTP API.
 * Returns a Promise that resolves when the event is sent.
 * Use with waitUntil() in Cloudflare Workers to ensure delivery.
 */
export async function captureServerEvent(
  env: PostHogEnv,
  params: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    groups?: Record<string, string>;
  },
): Promise<void> {
  const apiKey = env.POSTHOG_PUBLIC_KEY;

  if (!apiKey) {
    if (env.VITE_APP_STAGE !== "prd") {
      logger.warn("POSTHOG_PUBLIC_KEY not configured, skipping event capture", {
        event: params.event,
      });
    }
    return;
  }

  const db = getDb();
  const payload: PostHogEventPayload = {
    distinctId: params.distinctId,
    event: params.event,
    properties: params.properties,
    groups: params.groups,
    capturedAt: new Date().toISOString(),
  };

  await internalOutboxClient.send(
    { transaction: db, parent: db },
    "posthog:event.captured",
    payload,
  );
}

/**
 * Capture an exception to PostHog error tracking via HTTP API.
 * Includes stack trace and additional context.
 * Use with waitUntil() in Cloudflare Workers to ensure delivery.
 */
export async function captureServerException(
  env: PostHogEnv,
  params: {
    distinctId: string;
    error: Error;
    properties?: Record<string, unknown>;
  },
): Promise<void> {
  const apiKey = env.POSTHOG_PUBLIC_KEY;

  if (!apiKey) {
    if (env.VITE_APP_STAGE !== "prd") {
      logger.warn("POSTHOG_PUBLIC_KEY not configured, skipping exception capture");
    }
    return;
  }

  const db = getDb();
  const payload: PostHogExceptionPayload = {
    distinctId: params.distinctId,
    error: {
      name: params.error.name,
      message: params.error.message,
      stack: params.error.stack,
    },
    properties: params.properties,
    capturedAt: new Date().toISOString(),
  };

  await internalOutboxClient.send(
    { transaction: db, parent: db },
    "posthog:exception.captured",
    payload,
  );
}
