import { env } from "../../env.ts";
import type { PostHogEventTypes } from "../outbox/event-types.ts";
import { logger } from "../tag-logger.ts";

const POSTHOG_CAPTURE_URL = "https://eu.i.posthog.com/capture/";

type PostHogEventPayload = PostHogEventTypes["posthog:event.captured"];
type PostHogExceptionPayload = PostHogEventTypes["posthog:exception.captured"];

type PostHogStackFrame = {
  filename: string;
  function: string;
  lineno: number | undefined;
  colno: number | undefined;
  in_app: boolean;
};

type PostHogRequestBody = {
  api_key: string;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
};

function parseStackTrace(stack: string | undefined): PostHogStackFrame[] {
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
        lineno: lineno ? Number.parseInt(lineno, 10) : undefined,
        colno: colno ? Number.parseInt(colno, 10) : undefined,
        in_app: !filename?.includes("node_modules"),
      };
    })
    .filter((frame): frame is NonNullable<typeof frame> => frame !== null);
}

async function sendPosthogRequest(body: PostHogRequestBody): Promise<void> {
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

function getPosthogApiKey(): string | undefined {
  const apiKey = env.POSTHOG_PUBLIC_KEY;
  if (!apiKey && env.VITE_APP_STAGE !== "prd") {
    logger.warn("POSTHOG_PUBLIC_KEY not configured, skipping event capture");
  }
  return apiKey;
}

// Outbox handles retry; we emit one event per job to preserve ordering.
export async function handlePosthogEventCaptured(payload: PostHogEventPayload): Promise<void> {
  const apiKey = getPosthogApiKey();
  if (!apiKey) return;

  await sendPosthogRequest({
    api_key: apiKey,
    event: payload.event,
    distinct_id: payload.distinctId,
    properties: {
      ...payload.properties,
      $environment: env.VITE_APP_STAGE,
      $lib: "posthog-fetch",
      ...(payload.groups && { $groups: payload.groups }),
    },
    timestamp: payload.capturedAt,
  });
}

export async function handlePosthogExceptionCaptured(
  payload: PostHogExceptionPayload,
): Promise<void> {
  const apiKey = getPosthogApiKey();
  if (!apiKey) return;

  const frames = parseStackTrace(payload.error.stack);
  await sendPosthogRequest({
    api_key: apiKey,
    event: "$exception",
    distinct_id: payload.distinctId,
    properties: {
      $exception_list: [
        {
          type: payload.error.name,
          value: payload.error.message,
          mechanism: {
            handled: true,
            synthetic: false,
          },
          stacktrace: {
            type: "raw",
            frames,
          },
        },
      ],
      $environment: env.VITE_APP_STAGE,
      $lib: "posthog-fetch",
      ...payload.properties,
    },
    timestamp: payload.capturedAt,
  });
}
