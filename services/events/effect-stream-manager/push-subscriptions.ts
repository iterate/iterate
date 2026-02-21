import {
  PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE,
  type PushSubscriptionCallbackAddedPayload,
  type PushSubscriptionRetryPolicy,
  type PushSubscriptionRetrySchedule,
  parsePushSubscriptionCallbackAddedPayload,
} from "@iterate-com/services-contracts/events";
import { Duration, Schedule } from "effect";

import { Event, EventInput } from "./domain.ts";

const DEFAULT_RETRY_POLICY: PushSubscriptionRetryPolicy = {
  times: 2,
  schedule: {
    type: "fixed",
    intervalMs: 100,
  },
};

export const parsePushSubscriptionPayload = (
  payload: unknown,
): PushSubscriptionCallbackAddedPayload | undefined =>
  parsePushSubscriptionCallbackAddedPayload(payload);

export interface CreatePushSubscriptionPayloadInput {
  readonly callbackURL: string;
  readonly subscriptionSlug: string;
  readonly subscriptionType?: PushSubscriptionCallbackAddedPayload["type"];
  readonly retryPolicy?: PushSubscriptionRetryPolicy;
  readonly jsonataFilter?: string;
  readonly jsonataTransform?: string;
  readonly httpRequestHeaders?: Record<string, string>;
  readonly sendHistoricEventsFromOffset?: string;
}

export const createPushSubscriptionPayload = (
  input: CreatePushSubscriptionPayloadInput,
): PushSubscriptionCallbackAddedPayload => {
  const candidate: Record<string, unknown> = {
    type: input.subscriptionType ?? "webhook",
    URL: input.callbackURL,
    subscriptionSlug: input.subscriptionSlug,
  };

  if (input.retryPolicy !== undefined) candidate.retryPolicy = input.retryPolicy;
  if (input.jsonataFilter !== undefined) candidate.jsonataFilter = input.jsonataFilter;
  if (input.jsonataTransform !== undefined) candidate.jsonataTransform = input.jsonataTransform;
  if (input.httpRequestHeaders !== undefined)
    candidate.httpRequestHeaders = input.httpRequestHeaders;
  if (input.sendHistoricEventsFromOffset !== undefined) {
    candidate.sendHistoricEventsFromOffset = input.sendHistoricEventsFromOffset;
  }

  const parsed = parsePushSubscriptionPayload(candidate);
  if (parsed === undefined) {
    throw new Error("Invalid push subscription payload");
  }
  return parsed;
};

export const isPushSubscriptionAddedEvent = (event: Event | EventInput): boolean =>
  String(event.type) === PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE;

export const toRetryPolicyWithDefaults = (
  retryPolicy: PushSubscriptionRetryPolicy | undefined,
): PushSubscriptionRetryPolicy => ({
  ...DEFAULT_RETRY_POLICY,
  ...(retryPolicy ?? {}),
});

export const toRetrySchedule = (
  policy: PushSubscriptionRetrySchedule,
): Schedule.Schedule<unknown> =>
  policy.type === "fixed"
    ? Schedule.fixed(Duration.millis(policy.intervalMs))
    : Schedule.exponential(Duration.millis(policy.baseMs), policy.factor).pipe(
        Schedule.whileOutput((delay) =>
          policy.maxMs === undefined
            ? true
            : Duration.lessThanOrEqualTo(delay, Duration.millis(policy.maxMs)),
        ),
      );
