// Shared birth-certificate vocabulary for the notification-policy facet: the
// one `notification/created` event, split out so project bootstrap (which
// appends it) does not have to depend on the notification processor's full
// project-event policy contract. A contract DEPENDENCY, never a separately
// hosted processor.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";

export const NotificationLifecycleContract = defineProcessorContract({
  slug: "notification-lifecycle",
  version: "0.1.0",
  description:
    "Notification-policy facet lifecycle vocabulary: the birth certificate shared by " +
    "project bootstrap (which appends it) and the notification processor (which reduces " +
    "it). A contract dependency, not a hosted processor.",
  stateSchema: z.object({}),
  events: {
    "events.iterate.com/notification/created": {
      description:
        "Birth certificate for the project's notification-policy facet, appended on the " +
        "project root stream by project bootstrap (and backfilled once, idempotency-keyed " +
        "on the project id, onto projects born before the facet existed).",
      payloadSchema: z.object({
        config: z
          .object({})
          .meta({ description: "Reserved for birth-time configuration; empty today." }),
      }),
      examples: [
        {
          description:
            "Project bootstrap births the notification facet with the (currently empty) config.",
          payload: { config: {} },
        },
      ],
    },
  },
  consumes: [],
  emits: [],
});
