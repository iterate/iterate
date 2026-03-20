import { logger } from "../logging/index.ts";
import {
  sendLogExceptionToPostHog,
  sendPostHogException,
  type PostHogRequestContext,
  type PostHogUserContext,
} from "../lib/posthog.ts";
import type { JobLifecycleHook, QueuerEvent } from "./pgmq-lib.ts";

const appStage =
  process.env.VITE_APP_STAGE ?? process.env.APP_STAGE ?? process.env.NODE_ENV ?? "development";

export const createOutboxJobLifecycleHook = (): JobLifecycleHook => {
  return async (ctx, run) => {
    const eventContext = ctx.eventContext as {
      causedBy?: { eventId: number; consumerName: string; jobId: number | string };
    } | null;

    return logger.run(async ({ store }) => {
      logger.set({
        user: {
          id: "system:outbox",
          email: "outbox@system",
        },
        outbox: {
          consumerName: ctx.consumerName,
          jobId: ctx.jobId,
          attempt: ctx.attempt,
          eventName: ctx.eventName,
          eventId: ctx.eventId,
          causation: eventContext?.causedBy ?? null,
        },
      });
      store.exitHandlers.push((log) => {
        if (!log.errors?.length) return;
        void sendLogExceptionToPostHog({
          log,
          env: {
            POSTHOG_PUBLIC_KEY:
              process.env.POSTHOG_PUBLIC_KEY ?? process.env.VITE_POSTHOG_PUBLIC_KEY,
            VITE_APP_STAGE: appStage,
          },
        });
      });

      const outcome = await run();
      logger.set({ outbox: { ...outcome } });

      if (!outcome.ok) {
        logger.error(outcome.error);
      }

      return outcome;
    });
  };
};

export function sendDLQToPostHog(event: QueuerEvent): void {
  if (!event.isDLQ || !event.error) return;

  const apiKey = process.env.POSTHOG_PUBLIC_KEY ?? process.env.VITE_POSTHOG_PUBLIC_KEY;
  if (!apiKey) return;

  const msg = event.job.message;
  const eventContext = msg.event_context as {
    causedBy?: { eventId: number; consumerName: string; jobId: number | string };
  } | null;

  const request: PostHogRequestContext = {
    id: `outbox:${msg.consumer_name}:${event.job.msg_id}`,
    method: "OUTBOX",
    path: `outbox/${msg.consumer_name}`,
    status: 500,
    duration: 0,
    waitUntil: false,
  };

  const user: PostHogUserContext = {
    id: "system:outbox",
    email: "outbox@system",
  };

  const error = new Error(event.error);
  error.name = `OutboxDLQ:${msg.consumer_name}`;

  sendPostHogException({
    apiKey,
    distinctId: "system:outbox",
    errors: [error],
    request,
    user,
    environment: appStage,
    lib: "outbox-dlq",
    properties: {
      outbox: {
        consumerName: msg.consumer_name,
        jobId: event.job.msg_id,
        attempt: event.job.read_ct,
        eventName: msg.event_name,
        eventId: msg.event_id,
        causation: eventContext?.causedBy ?? null,
        processingResults: msg.processing_results,
        status: msg.status,
      },
    },
  }).catch((err) => {
    void logger.run(async () => {
      logger.set({
        service: "os",
        environment: appStage,
        request: {
          id: `outbox:${msg.consumer_name}:${event.job.msg_id}:posthog-dlq-error`,
          method: "OUTBOX",
          path: `outbox/${msg.consumer_name}`,
          status: 500,
        },
        outbox: {
          consumerName: msg.consumer_name,
          eventName: msg.event_name,
          eventId: msg.event_id,
          jobId: event.job.msg_id,
        },
      });
      logger.error("[outbox] PostHog DLQ exception dispatch failed", err);
    });
  });
}
