import { PostHog } from "posthog-node";
import type { CloudflareEnv } from "../../env.ts";

// PostHog EU host
const POSTHOG_HOST = "https://eu.i.posthog.com";

// Singleton client instance (lazy initialized)
let posthogClient: PostHog | null = null;

/**
 * Get or create the PostHog server-side client.
 * Returns null if POSTHOG_KEY is not configured.
 */
export function getPostHogClient(env: CloudflareEnv): PostHog | null {
  const apiKey = env.POSTHOG_KEY;

  if (!apiKey) {
    return null;
  }

  if (!posthogClient) {
    posthogClient = new PostHog(apiKey, {
      host: POSTHOG_HOST,
      // Disable batching for Cloudflare Workers (flush immediately)
      flushAt: 1,
      flushInterval: 0,
    });
  }

  return posthogClient;
}

/**
 * Capture a server-side event.
 * Safe to call even if PostHog is not configured.
 */
export function captureServerEvent(
  env: CloudflareEnv,
  params: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    groups?: Record<string, string>;
  },
): void {
  const client = getPostHogClient(env);

  if (!client) return;

  client.capture({
    distinctId: params.distinctId,
    event: params.event,
    properties: {
      ...params.properties,
      $environment: env.VITE_APP_STAGE,
      $lib: "posthog-node",
    },
    groups: params.groups,
  });
}

/**
 * Shutdown PostHog client (call on worker shutdown if needed).
 */
export async function shutdownPostHog(): Promise<void> {
  if (posthogClient) {
    await posthogClient.shutdown();
    posthogClient = null;
  }
}
