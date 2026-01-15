import type { CloudflareEnv } from "../../env.ts";
import { logger } from "../tag-logger.ts";

const POSTHOG_CAPTURE_URL = "https://eu.i.posthog.com/capture/";

/**
 * Capture a server-side event via PostHog HTTP API.
 * Returns a Promise that resolves when the event is sent.
 * Use with waitUntil() in Cloudflare Workers to ensure delivery.
 */
export async function captureServerEvent(
  env: CloudflareEnv,
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

  const body = {
    api_key: apiKey,
    event: params.event,
    distinct_id: params.distinctId,
    properties: {
      ...params.properties,
      $environment: env.VITE_APP_STAGE,
      $lib: "posthog-fetch",
      ...(params.groups && { $groups: params.groups }),
    },
    timestamp: new Date().toISOString(),
  };

  const response = await fetch(POSTHOG_CAPTURE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`PostHog capture failed: ${response.status} ${response.statusText}`);
  }
}

/**
 * Capture an exception to PostHog error tracking via HTTP API.
 * Includes stack trace and additional context.
 * Use with waitUntil() in Cloudflare Workers to ensure delivery.
 */
export async function captureServerException(
  env: CloudflareEnv,
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

  const body = {
    api_key: apiKey,
    event: "$exception",
    distinct_id: params.distinctId,
    properties: {
      $exception_type: params.error.name,
      $exception_message: params.error.message,
      $exception_stack_trace_raw: params.error.stack,
      $environment: env.VITE_APP_STAGE,
      $lib: "posthog-fetch",
      ...params.properties,
    },
    timestamp: new Date().toISOString(),
  };

  const response = await fetch(POSTHOG_CAPTURE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`PostHog capture failed: ${response.status} ${response.statusText}`);
  }
}
