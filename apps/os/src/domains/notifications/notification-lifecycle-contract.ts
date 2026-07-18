import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";

/** Shared lifecycle vocabulary so project bootstrap can create the facet
 * without depending on its project-event policy contract. */
export const NotificationLifecycleContract = defineProcessorContract({
  slug: "notification-lifecycle",
  version: "0.1.0",
  description: "Notification-policy facet lifecycle vocabulary.",
  stateSchema: z.object({}),
  events: {
    "events.iterate.com/notification/created": {
      description: "Birth certificate for the project's notification-policy facet.",
      payloadSchema: z.object({ config: z.object({}) }),
    },
  },
  consumes: [],
  emits: [],
});
