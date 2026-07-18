import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { ProjectProcessorContract } from "../projects/project-processor-contract.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
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
    CoreProcessorContract,
  ],
  stateSchema: z.object({
    birthCertificate: z
      .object({ config: z.object({}) })
      .nullable()
      .default(null),
  }),
  events: {},
  consumes: [
    "events.iterate.com/notification/created",
    "events.iterate.com/project/human-approval-requested",
  ],
  emits: [
    "events.iterate.com/notification/requested",
    "events.iterate.com/stream/subscription-configured",
  ],
});

export type NotificationProcessorContract = typeof NotificationProcessorContract;
