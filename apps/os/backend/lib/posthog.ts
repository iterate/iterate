import { PostHog } from "posthog-node";
import type { CloudflareEnv } from "../../env.ts";

let posthogClient: PostHog | null = null;

/**
 * Get or create the PostHog client singleton.
 * Uses posthog-node SDK for better error tracking and batching.
 */
export function getPostHogClient(env: CloudflareEnv): PostHog | null {
  const apiKey = env.POSTHOG_KEY;
  if (!apiKey) return null;

  if (!posthogClient) {
    posthogClient = new PostHog(apiKey, {
      host: "https://eu.i.posthog.com",
      // Flush immediately in serverless - no batching
      flushAt: 1,
      flushInterval: 0,
    });
  }

  return posthogClient;
}

/**
 * Capture a server-side event via PostHog.
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
  const client = getPostHogClient(env);
  if (!client) return;

  client.capture({
    distinctId: params.distinctId,
    event: params.event,
    properties: {
      ...params.properties,
      $environment: env.VITE_APP_STAGE,
      ...(params.groups && { $groups: params.groups }),
    },
    groups: params.groups,
  });

  await client.flush();
}

/**
 * Capture an exception to PostHog error tracking.
 * Includes stack trace and additional context.
 */
export async function captureServerException(
  env: CloudflareEnv,
  params: {
    distinctId: string;
    error: Error;
    properties?: Record<string, unknown>;
  },
): Promise<void> {
  const client = getPostHogClient(env);
  if (!client) return;

  client.capture({
    distinctId: params.distinctId,
    event: "$exception",
    properties: {
      $exception_type: params.error.name,
      $exception_message: params.error.message,
      $exception_stack_trace_raw: params.error.stack,
      $environment: env.VITE_APP_STAGE,
      ...params.properties,
    },
  });

  await client.flush();
}
