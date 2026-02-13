import { waitUntil } from "../../env.ts";
import { logger } from "../tag-logger.ts";

const POSTHOG_CAPTURE_URL = "https://eu.i.posthog.com/capture/";

/** Minimal env type for PostHog functions */
type PostHogEnv = {
  POSTHOG_PUBLIC_KEY?: string;
  VITE_APP_STAGE: string;
};

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
 * Track a webhook event in PostHog (non-blocking).
 *
 * TODO: Once we have experience with Analytics Engine, consider migrating
 * high-volume webhook telemetry there to reduce PostHog costs and improve
 * query performance. AE → PostHog sync can happen via scheduled worker.
 */
export function trackWebhookEvent(
  env: PostHogEnv,
  params: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    groups?: Record<string, string>;
  },
): void {
  waitUntil(
    captureServerEvent(env, params).catch((error) => {
      logger.error("Failed to track webhook event", { error, event: params.event });
    }),
  );
}

/**
 * Link an external distinct_id (e.g., slack:T123 or github:owner/name) to an
 * organization and project using PostHog groups.
 *
 * Capturing an event with the `groups` property automatically associates
 * the distinct_id with those groups in PostHog.
 */
export function linkExternalIdToGroups(
  env: PostHogEnv,
  params: {
    distinctId: string;
    organizationId: string;
    projectId: string;
  },
): void {
  waitUntil(
    captureServerEvent(env, {
      distinctId: params.distinctId,
      event: "external_id_linked",
      groups: {
        organization: params.organizationId,
        project: params.projectId,
      },
    }).catch((error) => {
      logger.error("Failed to link external ID to groups", {
        error,
        distinctId: params.distinctId,
      });
    }),
  );
}
