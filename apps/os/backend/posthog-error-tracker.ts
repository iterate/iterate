import { waitUntil } from "cloudflare:workers";
import { PostHog } from "posthog-node";
import { env } from "../env.ts";
import type { TagLogger } from "./tag-logger.ts";

export const posthogErrorTracking: TagLogger.ErrorTrackingFn = (error, metadata) => {
  waitUntil(
    (async () => {
      const posthog = new PostHog(env.POSTHOG_PUBLIC_KEY, {
        host: "https://eu.i.posthog.com",
      });

      posthog.captureException(error, metadata.userId, {
        environment: env.POSTHOG_ENVIRONMENT,
        ...metadata,
      });

      await posthog.shutdown();
    })(),
  );
};
