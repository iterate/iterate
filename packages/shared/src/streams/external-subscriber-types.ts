import { z } from "zod";
import { Callable, FetchCallable } from "@iterate-com/shared/callable/descriptor-types.ts";
import {
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
  EventTypeSchema,
} from "./event-base-types.ts";
import { STREAM_SUBSCRIPTION_CONFIGURED_TYPE } from "./core-event-types.ts";
import { JsonataExpression } from "./jsonata-expression.ts";

const ExternalSubscriberBase = z.strictObject({
  slug: z.string().trim().min(1),
  /**
   * Subscription state stores a Callable instead of a URL so stream replay only
   * needs JSON data. At delivery time the stream Durable Object supplies live
   * authority through CallableContext. OS processor subscriptions use env
   * Durable Object namespace bindings; webhook and websocket subscribers may
   * still use the broader Callable forms supported by the shared runtime.
   */
  callable: Callable,
  /**
   * These stay subscription-level concerns. `jsonataFilter` decides which
   * committed stream events are delivered, and `jsonataTransform` preserves the
   * existing webhook payload behavior before the target Callable is invoked.
   */
  jsonataFilter: JsonataExpression.optional(),
  jsonataTransform: JsonataExpression.optional(),
  eventTypes: z.array(EventTypeSchema).optional(),
});

export const ExternalWebsocketSubscriber = z.strictObject({
  ...ExternalSubscriberBase.shape,
  callable: FetchCallable,
  type: z.literal("websocket"),
});
export type ExternalWebsocketSubscriber = z.infer<typeof ExternalWebsocketSubscriber>;

const ExternalWebhookSubscriber = z.strictObject({
  ...ExternalSubscriberBase.shape,
  type: z.literal("webhook"),
});
type ExternalWebhookSubscriber = z.infer<typeof ExternalWebhookSubscriber>;

const ExternalCallableSubscriber = z.strictObject({
  ...ExternalSubscriberBase.shape,
  type: z.literal("callable"),
});
type ExternalCallableSubscriber = z.infer<typeof ExternalCallableSubscriber>;

export const ExternalSubscriber = z.union([
  ExternalWebsocketSubscriber,
  ExternalWebhookSubscriber,
  ExternalCallableSubscriber,
]);
export type ExternalSubscriber = z.infer<typeof ExternalSubscriber>;

export const StreamSubscriptionConfiguredEventInput = GenericEventInputBase.extend({
  type: z.literal(STREAM_SUBSCRIPTION_CONFIGURED_TYPE),
  payload: ExternalSubscriber,
});
export const StreamSubscriptionConfiguredEvent = GenericEventBase.extend(
  StreamSubscriptionConfiguredEventInput.pick({ type: true, payload: true }).shape,
);
export type StreamSubscriptionConfiguredEventInput = z.infer<
  typeof StreamSubscriptionConfiguredEventInput
>;
export type StreamSubscriptionConfiguredEvent = z.infer<typeof StreamSubscriptionConfiguredEvent>;

export const ExternalSubscriberState = z.object({
  subscribersBySlug: z.record(z.string(), ExternalSubscriber),
});
export type ExternalSubscriberState = z.infer<typeof ExternalSubscriberState>;
