import { z } from "zod";
import {
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
} from "./event-base-types.ts";

const ExternalSubscriberBase = z.strictObject({
  slug: z.string().trim().min(1),
  callbackUrl: z.url(),
  jsonataFilter: z.string().trim().min(1).optional(),
  jsonataTransform: z.string().trim().min(1).optional(),
});

export const ExternalWebsocketSubscriber = ExternalSubscriberBase.extend({
  type: z.literal("websocket"),
});
export type ExternalWebsocketSubscriber = z.infer<typeof ExternalWebsocketSubscriber>;

export const ExternalWebhookSubscriber = ExternalSubscriberBase.extend({
  type: z.literal("webhook"),
});
export type ExternalWebhookSubscriber = z.infer<typeof ExternalWebhookSubscriber>;

export const ExternalSubscriber = z.discriminatedUnion("type", [
  ExternalWebsocketSubscriber,
  ExternalWebhookSubscriber,
]);
export type ExternalSubscriber = z.infer<typeof ExternalSubscriber>;

export const StreamSubscriptionConfiguredEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/subscription/configured"),
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
