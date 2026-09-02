// Shared vocabulary for notification PRODUCERS and DELIVERY CHANNELS: the one
// channel-neutral `notification/requested` intent. It is a contract
// DEPENDENCY, never a separately hosted processor — the notification
// processor emits the intent, and each channel (the device processor's
// copy subscription today) consumes it and reaches into this contract
// for the pieces it needs (`NotificationIntentContract.events[...]
// .payloadSchema`, `.shape.destination`), so producer and channels can never
// drift apart.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";

export const NotificationIntentContract = defineProcessorContract({
  slug: "notification-intent",
  // 0.2.0: optional top-level approvalRequestEventOffset (the suppression
  // handle for approval-batch intents on every destination kind).
  // 0.3.0: user-scoped audience ({kind:"user"}) and optional top-level
  // agentReplyEventOffset (the suppression handle for chat-reply intents).
  // 0.4.0: optional requests (the held batch's method+url pairs, in-journal
  // detail for in-app rows; push title/body stay host-only).
  version: "0.4.0",
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
        approvalRequestEventOffset: z
          .number()
          .int()
          .positive()
          .optional()
          .meta({
            description:
              "Set when the intent notifies about ONE held approval batch, whatever the " +
              "destination: the offset of its project/human-approval-requested event on the " +
              "project root stream. Top-level (not only inside the approvals destination) " +
              "because delivery channels match project/approval-presented claims against it — " +
              "a client already showing the batch suppresses the pending push — and agent-chat " +
              "destinations carry no batch identity of their own.",
          }),
        agentReplyEventOffset: z
          .number()
          .int()
          .positive()
          .optional()
          .meta({
            description:
              "Set when the intent notifies about ONE agent chat reply: the offset of its " +
              "agents/web-message-sent event on the AGENT stream named by the agent-chat " +
              "destination (offsets are per-stream, so the pair is the identity). Delivery " +
              "channels match project/agent-reply-presented claims against it — a client " +
              "already showing the reply suppresses the pending push.",
          }),
        audience: z
          .discriminatedUnion("kind", [
            z
              .strictObject({ kind: z.literal("project") })
              .meta({ description: "Everyone enrolled on the project." }),
            z
              .strictObject({
                kind: z.literal("user"),
                userId: z
                  .string()
                  .trim()
                  .min(1)
                  .meta({
                    description:
                      "The one user to notify — matched against each channel's own ownership " +
                      "record (the device processor: the enrollment's ownerId).",
                  }),
              })
              .meta({ description: "One user's enrolled channels only." }),
          ])
          .meta({
            description:
              "Who should be notified, in channel-neutral terms; each channel resolves it to " +
              "its own recipients (the device processor: every enrolled device, or only the " +
              "named user's devices).",
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
        requests: z
          .array(
            z.object({
              method: z.string(),
              // A plain string, matching the approval event's own shape:
              // custom hold rules can park free-text "URLs".
              url: z.string(),
            }),
          )
          .optional()
          .meta({
            description:
              "For approval-batch intents: the held requests, in batch order. In-journal " +
              "detail so in-app rows can say WHICH operations are held — never part of the " +
              "push title/body sent to vendors, which stay host-only because lock screens " +
              "leak.",
          }),
        title: z.string().trim().min(1).max(200).meta({ description: "Notification title line." }),
      }),
    },
  },
  consumes: [],
  emits: [],
});
