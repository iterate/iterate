import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { NotificationRequest } from "./types.ts";

/** Shared vocabulary for notification producers and delivery channels. It is
 * a contract dependency, not a separately hosted processor. */
export const NotificationIntentContract = defineProcessorContract({
  slug: "notification-intent",
  version: "0.1.0",
  description: "Channel-neutral project notification intent vocabulary.",
  stateSchema: z.object({}),
  events: {
    "events.iterate.com/notification/requested": {
      description:
        "One channel-neutral notification intent. Delivery channels independently resolve the audience and journal their outcomes.",
      payloadSchema: NotificationRequest,
    },
  },
  consumes: [],
  emits: [],
});
