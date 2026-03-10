/**
 * Evlog integration for outbox consumer jobs.
 *
 * Wraps each consumer handler execution in its own evlog request context so that:
 * - Each job emits a structured wide event with consumer/job/event/causality fields
 * - logger.set() / logger.info() / logger.error() inside handlers target the job's wide event
 * - DLQ failures (retry exhausted) are sent to PostHog as $exception events
 */

import { createRequestLogger } from "evlog";
import { logger } from "../tag-logger.ts";
import {
  withRequestEvlogContext,
  flushRequestEvlog,
  recordRequestEvlogError,
  log as evlog,
  type RequestEvlogEvent,
} from "../evlog.ts";
import { sendPostHogException, type PostHogRequestContext, type PostHogUserContext } from "../lib/posthog.ts";
import type { ConsumerJobContext, JobLifecycleHook, QueuerEvent } from "./pgmq-lib.ts";

const appStage =
  process.env.VITE_APP_STAGE ?? process.env.APP_STAGE ?? process.env.NODE_ENV ?? "development";

/**
 * Creates a job lifecycle hook that wraps each consumer handler in an evlog context.
 *
 * The wide event for each job includes:
 * - consumer.name, job.id, job.attempt
 * - event.name, event.id
 * - causation chain from event_context
 */
export const createOutboxJobLifecycleHook = (): JobLifecycleHook => {
  return async (ctx, run) => {
    const jobRequestId = `outbox:${ctx.consumerName}:${ctx.jobId}:${ctx.attempt}`;
    const jobPath = `outbox/${ctx.consumerName}`;

    const jobLogger = createRequestLogger<RequestEvlogEvent>({
      method: "OUTBOX",
      path: jobPath,
      requestId: jobRequestId,
    });

    // Parse causation from event context
    const eventContext = ctx.eventContext as { causedBy?: { eventId: number; consumerName: string; jobId: number | string } } | null;
    const causation = eventContext?.causedBy ?? null;

    jobLogger.set({
      request: {
        id: jobRequestId,
        method: "OUTBOX",
        path: jobPath,
        status: 200,
        duration: 0,
        waitUntil: false,
      },
      // System user context for PostHog (outbox jobs are not user-initiated)
      user: {
        id: "system:outbox",
        email: "outbox@system",
      },
      outbox: {
        consumer: ctx.consumerName,
        jobId: ctx.jobId,
        attempt: ctx.attempt,
        eventName: ctx.eventName,
        eventId: ctx.eventId,
        ...(causation ? { causation } : {}),
      },
    });

    const startedAt = Date.now();

    return withRequestEvlogContext(
      {
        logger: jobLogger,
        request: {
          requestId: jobRequestId,
          method: "OUTBOX",
          path: jobPath,
        },
      },
      async () => {
        const outcome = await run();

        const duration = Date.now() - startedAt;
        const status = outcome.ok ? 200 : 500;

        evlog.set({
          request: { status, duration },
          outbox: {
            status: outcome.ok ? "success" : "error",
            ...(outcome.ok ? { result: String(outcome.result) } : {}),
          },
        });

        if (!outcome.ok) {
          recordRequestEvlogError(outcome.error, {
            outbox: {
              consumer: ctx.consumerName,
              jobId: ctx.jobId,
              attempt: ctx.attempt,
              eventName: ctx.eventName,
              eventId: ctx.eventId,
            },
          });
        }

        flushRequestEvlog();

        return outcome;
      },
    );
  };
};

/**
 * Listener for outbox statusChange events that sends DLQ failures to PostHog as $exception.
 * Attach via `queuer.on("statusChange", sendDLQToPostHog)`.
 */
export function sendDLQToPostHog(event: QueuerEvent): void {
  if (!event.isDLQ || !event.error) return;

  const apiKey = process.env.POSTHOG_PUBLIC_KEY ?? process.env.VITE_POSTHOG_PUBLIC_KEY;
  if (!apiKey) return;

  const msg = event.job.message;
  const eventContext = msg.event_context as { causedBy?: { eventId: number; consumerName: string; jobId: number | string } } | null;

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
        consumer: msg.consumer_name,
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
    logger.error("[outbox] PostHog DLQ exception dispatch failed", err);
  });
}
