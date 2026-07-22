// The notification processor CONTRACT. It owns NO event types of its own:
// its whole vocabulary is borrowed through `processorDeps` — the project
// contract's `project/human-approval-requested` (what it reacts to), the
// lifecycle catalog's `notification/created` (its birth certificate), and
// the intent catalog's `notification/requested` (what it emits). Delivery
// channels consume the intent through NotificationIntentContract; they never
// import this contract.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { ProjectProcessorContract } from "../projects/project-processor-contract.ts";
import { NotificationIntentContract } from "./notification-intent-contract.ts";
import { NotificationLifecycleContract } from "./notification-lifecycle-contract.ts";

export const NotificationProcessorContract = defineProcessorContract({
  slug: "notification",
  version: "0.1.0",
  description:
    "Turns project domain facts into channel-neutral notification intents; channel processors own recipient resolution and delivery.",
  processorDeps: [
    ProjectProcessorContract,
    NotificationIntentContract,
    NotificationLifecycleContract,
  ],
  stateSchema: z.object({
    birthCertificate: z
      .object({
        config: z
          .object({})
          .meta({ description: "Reserved for birth-time configuration; empty today." }),
      })
      .nullable()
      .default(null)
      .meta({
        description:
          "Existence marker: null until notification/created reduces. The processor's only " +
          "state — every intent it emits derives from the triggering event alone.",
      }),
  }),
  events: {},
  consumes: [
    "events.iterate.com/notification/created",
    "events.iterate.com/project/human-approval-requested",
  ],
  emits: ["events.iterate.com/notification/requested"],
});

export type NotificationProcessorContract = typeof NotificationProcessorContract;
