import type { CloudflareEnv } from "../../env.ts";

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
  const apiKey = env.POSTHOG_KEY;

  if (!apiKey) return;

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
