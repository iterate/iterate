// The notification processor CONTRACT. It owns NO event types of its own:
// its whole vocabulary is borrowed through `processorDeps` — the project
// contract's `project/human-approval-requested` plus its grant/reject/settle
// resolutions (what it reacts to), the lifecycle catalog's
// `notification/created` (its birth certificate), and the intent catalog's
// `notification/requested` (what it emits — AND consumes back, so a fired
// Approval Group push closes its own debounce window in the fold). Delivery
// channels consume the intent through NotificationIntentContract; they never
// import this contract.

import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/processors";
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
          "Existence marker: null until notification/created reduces. Every intent the " +
          "processor emits derives from the triggering event alone, EXCEPT the Approval Group " +
          "debounce below.",
      }),
    approvalGroups: z
      .record(
        z.string(),
        z.object({
          members: z
            .record(
              z.string(),
              z.object({
                host: z.string().meta({
                  description:
                    "Host of the held request's target (unparseable custom-rule URLs verbatim) " +
                    "— the only request detail the summary push body ever carries.",
                }),
                ruleKey: z.string().meta({ description: "The rule that caught the request." }),
                ruleDescription: z
                  .string()
                  .meta({
                    description: "The matched rule's explanation, snapshotted at gate time.",
                  }),
                expiresAtMs: z.number().meta({
                  description: "Epoch-ms copy of the hold's own expiry horizon, never `now`.",
                }),
                resolved: z.boolean().meta({
                  description:
                    "True once any grant/reject/settle referenced this hold — a human (or the " +
                    "expiry sweep) acted, so the summary push must not count it as waiting.",
                }),
              }),
            )
            .meta({
              description:
                "Held requests of this Script Execution, keyed by the offset of their " +
                "human-approval-requested event (the hold's identity).",
            }),
          window: z
            .object({
              firstHeldOffset: z
                .number()
                .int()
                .positive()
                .meta({
                  description:
                    "Offset of the hold that opened this window — the window's identity inside " +
                    "the summary push's idempotency key, so a post-push straggler window gets a " +
                    "fresh key.",
                }),
              opensAtMs: z
                .number()
                .meta({ description: "Epoch-ms createdAt of the opening hold." }),
              lastHeldAtMs: z.number().meta({
                description: "Epoch-ms createdAt of the newest hold extending the window.",
              }),
            })
            .nullable()
            .meta({
              description:
                "The un-fired debounce window, or null once its summary push reduced (or none " +
                "is owed). Fire time derives as min(lastHeldAtMs + window, opensAtMs + cap).",
            }),
          notifiedThroughOffset: z
            .number()
            .int()
            .nonnegative()
            .meta({
              description:
                "Highest member offset covered by a fired summary push — observability breadcrumb " +
                "for which holds have been announced.",
            }),
        }),
      )
      .default({})
      .meta({
        description:
          "THE documented exception to stateless-per-event: per-Script-Execution Approval " +
          "Group debounce state (ADR 0006), keyed by executionId. Entries are pruned once " +
          "every member is resolved or expired.",
      }),
  }),
  events: {},
  consumes: [
    "events.iterate.com/notification/created",
    "events.iterate.com/notification/requested",
    "events.iterate.com/project/human-approval-requested",
    "events.iterate.com/project/human-approval-granted",
    "events.iterate.com/project/human-approval-rejected",
    "events.iterate.com/project/human-approval-settled",
  ],
  emits: ["events.iterate.com/notification/requested"],
});

export type NotificationProcessorContract = typeof NotificationProcessorContract;

export type NotificationProcessorState = ProcessorState<NotificationProcessorContract>;
