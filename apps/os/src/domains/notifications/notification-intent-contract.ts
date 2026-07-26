// Shared vocabulary for notification PRODUCERS and DELIVERY CHANNELS: the one
// channel-neutral `notification/requested` intent. It is a contract
// DEPENDENCY, never a separately hosted processor — the notification
// processor emits the intent, and each channel (the device processor's
// cross-post subscription today) consumes it and reaches into this contract
// for the pieces it needs (`NotificationIntentContract.events[...]
// .payloadSchema`, `.shape.destination`), so producer and channels can never
// drift apart.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";

export const NotificationIntentContract = defineProcessorContract({
  slug: "notification-intent",
  version: "0.1.0",
  description:
    "Channel-neutral project notification intent vocabulary, shared by producers (the " +
    "notification processor) and delivery channels (device push). A contract dependency, " +
    "not a hosted processor.",
  stateSchema: z.object({}),
  events: {
    "events.iterate.com/notification/requested": {
      description:
        "One channel-neutral notification intent. Delivery channels independently resolve the " +
        "audience to concrete recipients and journal their own delivery outcomes on their own " +
        "streams; the intent carries no channel detail at all.",
      payloadSchema: z.strictObject({
        audience: z
          .strictObject({
            kind: z
              .literal("project")
              .meta({ description: "Everyone enrolled on the project — the only audience today." }),
          })
          .meta({
            description:
              "Who should be notified, in channel-neutral terms; each channel resolves it to " +
              "its own recipients (the device processor: every enrolled device).",
          }),
        body: z
          .string()
          .trim()
          .min(1)
          .max(4_000)
          .meta({
            description:
              "Notification body text. Bounded so every channel can carry it verbatim (Expo " +
              "caps total push payload size).",
          }),
        destination: z
          .discriminatedUnion("kind", [
            z
              .strictObject({ kind: z.literal("project") })
              .meta({ description: "The project home screen." }),
            z
              .strictObject({
                kind: z.literal("approvals"),
                approvalRequestEventOffset: z
                  .number()
                  .int()
                  .positive()
                  .meta({
                    description:
                      "The held approval batch's identity: the offset of its " +
                      "project/human-approval-requested event on the project root stream.",
                  }),
              })
              .meta({ description: "The approvals screen, focused on one held approval batch." }),
            z
              .strictObject({
                kind: z.literal("agent-chat"),
                path: z
                  .string()
                  .startsWith("/agents/")
                  .meta({ description: "The agent's stream path." }),
              })
              .meta({ description: "One agent's chat view." }),
          ])
          .meta({
            description:
              "Where the client navigates when the user opens the notification. The device " +
              "processor reuses this exact union in its own request shape (reached through " +
              "this contract), so a tap deep-links identically on every channel.",
          }),
        expiresAt: z
          .number()
          .int()
          .positive()
          .meta({
            description:
              "Epoch-ms deadline stamped by the producer for the WHOLE intent: past it a " +
              "channel must not deliver — surfacing a lapsed approval prompt is worse than " +
              "staying silent.",
          }),
        title: z.string().trim().min(1).max(200).meta({ description: "Notification title line." }),
      }),
    },
  },
  consumes: [],
  emits: [],
});
