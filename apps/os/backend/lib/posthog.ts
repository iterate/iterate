import type { WideEvent } from "evlog";
import { waitUntil } from "../../env.ts";
import type { EvlogExceptionEvent } from "../evlog-event-schema.ts";
import { logger } from "../tag-logger.ts";

const POSTHOG_CAPTURE_URL = "https://eu.i.posthog.com/capture/";

const evlogAppStage =
  process.env.VITE_APP_STAGE ?? process.env.APP_STAGE ?? process.env.NODE_ENV ?? "development";

/** Minimal env type for PostHog functions */
export type PostHogEnv = {
  POSTHOG_PUBLIC_KEY?: string;
  VITE_APP_STAGE: string;
};

type PostHogCaptureBase = {
  apiKey: string;
  distinctId: string;
  environment: string;
  timestamp?: string;
};

export type PostHogRequestContext = {
  id: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  waitUntil: boolean;
  parentRequestId?: string;
  trpcProcedure?: string;
  url?: string;
};

export type PostHogUserContext = {
  id: string;
  email: string;
};

type EvlogPostHogEnv = {
  POSTHOG_PUBLIC_KEY?: string;
  VITE_APP_STAGE?: string;
};

export type EvlogExceptionPayload = {
  event: WideEvent;
  errors?: Error[];
  env?: EvlogPostHogEnv;
};

function getTimestamp(timestamp?: string): string {
  return timestamp ?? new Date().toISOString();
}

async function posthogCapture(body: Record<string, unknown>): Promise<void> {
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

export async function sendPostHogEvent(
  params: PostHogCaptureBase & {
    event: string;
    properties?: Record<string, unknown>;
    groups?: Record<string, string>;
    lib?: string;
  },
): Promise<void> {
  await posthogCapture({
    api_key: params.apiKey,
    event: params.event,
    distinct_id: params.distinctId,
    properties: {
      ...params.properties,
      $environment: params.environment,
      $lib: params.lib ?? "posthog-fetch",
      ...(params.groups && { $groups: params.groups }),
    },
    timestamp: getTimestamp(params.timestamp),
  });
}

function parseStackTrace(stack: string | undefined): Array<{
  filename: string;
  function: string;
  lineno: number | undefined;
  colno: number | undefined;
  in_app: boolean;
}> {
  if (!stack) return [];

  const lines = stack.split("\n").slice(1);
  return lines
    .map((line) => {
      const match = line.match(/^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
      if (!match) return null;

      const [, fn, filename, lineno, colno] = match;
      return {
        filename: filename || "<unknown>",
        function: fn || "<anonymous>",
        lineno: lineno ? parseInt(lineno, 10) : undefined,
        colno: colno ? parseInt(colno, 10) : undefined,
        in_app: !filename?.includes("node_modules"),
      };
    })
    .filter((frame): frame is NonNullable<typeof frame> => frame !== null);
}

export async function sendPostHogException(
  params: PostHogCaptureBase & {
    errors: Error[];
    request: PostHogRequestContext;
    user: PostHogUserContext;
    properties?: Record<string, unknown>;
    lib?: string;
  },
): Promise<void> {
  if (params.errors.length === 0) return;

  await posthogCapture({
    api_key: params.apiKey,
    event: "$exception",
    distinct_id: params.distinctId,
    properties: {
      $exception_list: params.errors.map((error) => ({
        type: error.name,
        value: error.message,
        mechanism: {
          handled: true,
          synthetic: false,
        },
        stacktrace: {
          type: "raw",
          frames: parseStackTrace(error.stack),
        },
      })),
      $environment: params.environment,
      $lib: params.lib ?? "posthog-fetch",
      request: params.request,
      user: params.user,
      ...params.properties,
    },
    timestamp: getTimestamp(params.timestamp),
  });
}

function toPostHogRequestContext(event: EvlogExceptionEvent): PostHogRequestContext {
  const request = event.request;
  return {
    id: request.id,
    method: request.method,
    path: request.path,
    status: request.status,
    duration: request.duration,
    waitUntil: request.waitUntil,
    parentRequestId: request.parentRequestId,
    trpcProcedure: request.trpcProcedure,
    url: request.url,
  };
}

function toPostHogUserContext(event: EvlogExceptionEvent): PostHogUserContext {
  const user = event.user;
  return {
    id: user.id,
    email: user.email,
  };
}

export async function sendEvlogExceptionToPostHog(payload: EvlogExceptionPayload): Promise<void> {
  if (!payload.errors || payload.errors.length === 0) return;

  const apiKey = payload.env?.POSTHOG_PUBLIC_KEY;
  if (!apiKey) return;

  const event = payload.event as unknown as EvlogExceptionEvent;
  const request = toPostHogRequestContext(event);
  const user = toPostHogUserContext(event);

  await sendPostHogException({
    apiKey,
    distinctId: user.id,
    errors: payload.errors,
    request,
    user,
    environment: payload.env?.VITE_APP_STAGE ?? evlogAppStage,
    lib: "evlog-worker",
  });
}

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
      logger.warn(
        `POSTHOG_PUBLIC_KEY not configured, skipping event capture event=${params.event}`,
      );
    }
    return;
  }

  await sendPostHogEvent({
    apiKey,
    distinctId: params.distinctId,
    event: params.event,
    properties: params.properties,
    groups: params.groups,
    environment: env.VITE_APP_STAGE,
  });
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
      logger.error("Failed to track webhook event", error, { event: params.event });
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
      logger.error("Failed to link external ID to groups", error, {
        distinctId: params.distinctId,
      });
    }),
  );
}
