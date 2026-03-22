import { waitUntil } from "../../env.ts";
import type { WideLog } from "../logging/types.ts";
import { logger } from "../tag-logger.ts";
import type { RequestInfoForWideLog } from "../worker.ts";

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

function getTimestamp(timestamp?: string): string {
  return timestamp ?? new Date().toISOString();
}

function getEffectiveEgress(log: WideLog): Record<string, string> {
  let original: WideLog | undefined = log;
  while (original) {
    if (original.egress) return original.egress;
    original = original.parent;
  }
  return {};
}

function resolveEgressURL(url: string, log: WideLog): string {
  const egress = getEffectiveEgress(log);
  if (Object.keys(egress).length === 0) return url;

  if (egress[url]) return egress[url]!;

  const target = new URL(url);
  if (egress[target.origin]) {
    return new URL(
      `${target.pathname}${target.search}${target.hash}`,
      egress[target.origin]!,
    ).toString();
  }

  if (egress[target.hostname]) {
    return new URL(
      `${target.pathname}${target.search}${target.hash}`,
      egress[target.hostname]!,
    ).toString();
  }

  return url;
}

async function posthogCapture(body: Record<string, unknown>): Promise<void> {
  const response = await fetch(resolveEgressURL(POSTHOG_CAPTURE_URL, logger.get()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "<no body>");
    throw new Error(
      `PostHog capture failed: ${response.status} ${response.statusText} ${details.slice(0, 500)}`,
    );
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
  platform: string;
  lang: string;
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
        platform: "custom",
        lang: "javascript",
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

  const fallbackFrames = [
    {
      platform: "custom",
      lang: "javascript",
      filename: "<unknown>",
      function: "<unknown>",
      lineno: undefined,
      colno: undefined,
      in_app: true,
    },
  ];

  await posthogCapture({
    api_key: params.apiKey,
    event: "$exception",
    distinct_id: params.distinctId,
    properties: {
      $exception_list: params.errors.map((error) => {
        const frames = parseStackTrace(error.stack);
        return {
          type: error.name,
          value: error.message,
          mechanism: {
            handled: true,
            synthetic: false,
          },
          stacktrace: {
            type: "raw",
            frames: frames.length > 0 ? frames : fallbackFrames,
          },
        };
      }),
      $environment: params.environment,
      $lib: params.lib ?? "posthog-fetch",
      request: params.request,
      user: params.user,
      ...params.properties,
    },
    timestamp: getTimestamp(params.timestamp),
  });
}

function toPostHogRequestContext(event: WideLog): PostHogRequestContext {
  const eventRequest =
    (event.request as Partial<RequestInfoForWideLog> & {
      waitUntil?: boolean;
      parentRequestId?: string;
      trpcProcedure?: string;
    }) || {};
  const parent =
    typeof event.parent === "object" && event.parent !== null
      ? (event.parent as WideLog)
      : undefined;
  const parentRequest =
    (parent?.request as Partial<RequestInfoForWideLog> & {
      waitUntil?: boolean;
      parentRequestId?: string;
      trpcProcedure?: string;
    }) || {};
  const request = { ...parentRequest, ...eventRequest };

  return {
    id: request.id ?? "unknown",
    method: request.method ?? "unknown",
    path: request.path ?? "unknown",
    status: request.status ?? 500,
    duration: event.meta.durationMs ?? 0,
    waitUntil: request?.waitUntil === true,
    parentRequestId: request.parentRequestId ?? undefined,
    trpcProcedure: typeof event.trpcProcedure === "string" ? event.trpcProcedure : undefined,
    url: request.url ?? undefined,
  };
}

function toPostHogUserContext(event: WideLog): PostHogUserContext {
  const user = event.user as Record<string, unknown> | undefined;
  return {
    id: typeof user?.id === "string" ? user.id : "anonymous",
    email: typeof user?.email === "string" ? user.email : "unknown",
  };
}

export async function sendLogExceptionToPostHog(params: {
  log: WideLog;
  env?: { POSTHOG_PUBLIC_KEY?: string; VITE_APP_STAGE?: string };
}): Promise<void> {
  const errors = (params.log.errors ?? []).map((entry) => {
    const normalized =
      typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>)
        : { message: String(entry) };
    const error = new Error(
      typeof normalized.message === "string" ? normalized.message : String(entry),
    );
    error.name = typeof normalized.name === "string" ? normalized.name : "Error";
    error.stack = typeof normalized.stack === "string" ? normalized.stack : undefined;
    return error;
  });

  if (errors.length === 0) return;

  const apiKey = params.env?.POSTHOG_PUBLIC_KEY;
  if (!apiKey) {
    logger.warn("POSTHOG_PUBLIC_KEY missing for log exception flush");
    return;
  }

  const request = toPostHogRequestContext(params.log);
  const user = toPostHogUserContext(params.log);

  logger.info(
    `PostHog log exception dispatch requestId=${request.id} path=${request.path} errorCount=${errors.length}`,
  );

  try {
    await sendPostHogException({
      apiKey,
      distinctId: user.id,
      errors,
      request,
      user,
      environment: params.env?.VITE_APP_STAGE ?? evlogAppStage,
      lib: "os-logging",
    });
    logger.info(`PostHog log exception sent requestId=${request.id}`);
  } catch (error) {
    logger.error("PostHog log exception failed", {
      requestId: request.id,
      path: request.path,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
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
