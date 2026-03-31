import { logger } from "../logging/index.ts";
import {
  sendLogExceptionToPostHog,
  sendPostHogException,
  type PostHogRequestContext,
  type PostHogUserContext,
} from "../lib/posthog.ts";
import type { JobLifecycleHook, OutboxEventContext, QueuerEvent } from "./pgmq-lib.ts";

const appStage =
  process.env.VITE_APP_STAGE ?? process.env.APP_STAGE ?? process.env.NODE_ENV ?? "development";

export const createOutboxJobLifecycleHook = (): JobLifecycleHook => {
  return async (ctx, run) => {
    const eventContext = (ctx.eventContext as OutboxEventContext | null) ?? null;

    return logger.run(async ({ store }) => {
      logger.set({
        request: {
          id: `outbox:${ctx.consumerName}:${ctx.jobId}`,
          method: "OUTBOX",
          path: `outbox/${ctx.consumerName}`,
          status: -1,
          waitUntil: false,
        },
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
      logger.set({
        request: {
          status: outcome.ok ? 200 : 500,
        },
        outbox: { ...outcome },
      });

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
  const eventContext =
    event.kind === "parsed-job"
      ? ((event.job.message.event_context as OutboxEventContext | null) ?? null)
      : ((event.eventContext as OutboxEventContext | null) ?? null);
  const posthogEgress = eventContext?.telemetry?.egress;
  const request = getPostHogRequestContextForQueuerEvent(event);
  const outbox = getPostHogOutboxPropertiesForQueuerEvent(event, eventContext);

  const user: PostHogUserContext = {
    id: "system:outbox",
    email: "outbox@system",
  };

  const error = new Error(event.error);
  error.name = `OutboxDLQ:${outbox.consumerName}`;

  void logger
    .run(async () => {
      if (posthogEgress) {
        logger.set({ egress: posthogEgress });
      }

      await sendPostHogException({
        apiKey,
        distinctId: "system:outbox",
        errors: [error],
        request,
        user,
        environment: appStage,
        lib: "outbox-dlq",
        properties: {
          outbox,
        },
      });
    })
    .catch((err) => {
      void logger.run(async () => {
        logger.set({
          service: "os",
          environment: appStage,
          request: request,
          outbox,
        });
        logger.error("[outbox] PostHog DLQ exception dispatch failed", err);
      });
    });
}

function getPostHogRequestContextForQueuerEvent(event: QueuerEvent): PostHogRequestContext {
  if (event.kind === "parsed-job") {
    return {
      id: `outbox:${event.job.message.consumer_name}:${event.job.msg_id}`,
      method: "OUTBOX",
      path: `outbox/${event.job.message.consumer_name}`,
      status: 500,
      duration: 0,
      waitUntil: false,
    };
  }

  return {
    id: `outbox:invalid-consumer-job:${event.msgId}`,
    method: "OUTBOX",
    path: "outbox/invalid-consumer-job",
    status: 500,
    duration: 0,
    waitUntil: false,
  };
}

function getPostHogOutboxPropertiesForQueuerEvent(
  event: QueuerEvent,
  eventContext: OutboxEventContext | null,
) {
  if (event.kind === "parsed-job") {
    return {
      consumerName: event.job.message.consumer_name,
      jobId: event.job.msg_id,
      attempt: event.job.read_ct,
      eventName: event.job.message.event_name,
      eventId: event.job.message.event_id,
      causation: eventContext?.causedBy ?? null,
      processingResults: event.job.message.processing_results,
      status: event.job.message.status,
    };
  }

  return {
    consumerName: "invalid-consumer-job",
    jobId: event.msgId,
    attempt: event.readCt,
    eventName: "invalid-message",
    eventId: -1,
    causation: eventContext?.causedBy ?? null,
    processingResults: [],
    status: "failed" as const,
  };
}
