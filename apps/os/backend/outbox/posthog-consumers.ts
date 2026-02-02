import { env } from "../../env.ts";
import { logger } from "../tag-logger.ts";
import { outboxClient as cc } from "./client.ts";

const POSTHOG_CAPTURE_URL = "https://eu.i.posthog.com/capture/";

/**
 * Parse a stack trace string into PostHog-compatible frames.
 */
function parseStackTrace(stack: string | undefined): Array<{
  filename: string;
  function: string;
  lineno: number | undefined;
  colno: number | undefined;
  in_app: boolean;
}> {
  if (!stack) return [];

  const lines = stack.split("\n").slice(1); // Skip the first line (error message)
  return lines
    .map((line) => {
      // Match patterns like "at functionName (filename:line:col)" or "at filename:line:col"
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

export function registerPostHogConsumers() {
  cc.registerConsumer({
    name: "handlePostHogEvent",
    on: "posthog:event",
    handler: async (params) => {
      const apiKey = env.POSTHOG_PUBLIC_KEY;

      if (!apiKey) {
        if (env.VITE_APP_STAGE !== "prd") {
          logger.warn("POSTHOG_PUBLIC_KEY not configured, skipping event capture", {
            event: params.payload.event,
          });
        }
        return;
      }

      const body = {
        api_key: apiKey,
        event: params.payload.event,
        distinct_id: params.payload.distinctId,
        properties: {
          ...params.payload.properties,
          $environment: env.VITE_APP_STAGE,
          $lib: "posthog-fetch",
          ...(params.payload.groups && { $groups: params.payload.groups }),
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

      logger.info("PostHog event captured", { event: params.payload.event });
    },
  });

  cc.registerConsumer({
    name: "handlePostHogException",
    on: "posthog:exception",
    handler: async (params) => {
      const apiKey = env.POSTHOG_PUBLIC_KEY;

      if (!apiKey) {
        if (env.VITE_APP_STAGE !== "prd") {
          logger.warn("POSTHOG_PUBLIC_KEY not configured, skipping exception capture");
        }
        return;
      }

      const frames = parseStackTrace(params.payload.error.stack);

      const body = {
        api_key: apiKey,
        event: "$exception",
        distinct_id: params.payload.distinctId,
        properties: {
          $exception_list: [
            {
              type: params.payload.error.name,
              value: params.payload.error.message,
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
          ...params.payload.properties,
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

      logger.info("PostHog exception captured", { error: params.payload.error.name });
    },
  });
}
