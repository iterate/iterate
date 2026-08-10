// Contract for the "chat-reply-notify" processor: a sibling on plain chat
// agent streams (mobile + web threads created through agents.create) that
// turns "the agent replied to a user turn" into ONE channel-neutral
// `notification/requested` intent on the project root stream — the push you
// get when you message a chat and leave before the reply lands. It owns its
// own birth certificate (`chat-reply-notify/created` — appended by the
// generic agent creation batch in rpc-targets, which has no upstream router
// contract); everything else resolves through `processorDeps`: the agent
// contract's message events (what it reacts to) and the intent catalog's
// `notification/requested` (what it emits). Delivery and suppression are the
// device processor's job — see agent-reply-presented-contract.ts for the
// "already on screen" claim this producer's intents are matched against.

import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/processors";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { NotificationIntentContract } from "./notification-intent-contract.ts";

export const ChatReplyNotifyProcessorContract = defineProcessorContract({
  slug: "chat-reply-notify",
  version: "0.1.0",
  description:
    "Turns an agent's chat reply to a user-authored turn into one notification/requested " +
    "intent on the project root stream, addressed to the user who sent the turn.",
  processorDeps: [AgentProcessorContract, NotificationIntentContract],
  stateSchema: z.object({
    birthCertificate: z
      .strictObject({
        config: z
          .strictObject({})
          .meta({ description: "Reserved for birth-time configuration; empty today." }),
      })
      .nullable()
      .default(null)
      .meta({ description: "Existence marker: null until chat-reply-notify/created reduces." }),
    pendingTurn: z
      .strictObject({
        messageOffset: z
          .number()
          .int()
          .positive()
          .meta({ description: "Offset of the turn's newest user-authored context item." }),
        userId: z
          .string()
          .nullable()
          .meta({
            description:
              "The sender (the message actor's stamped userId), or null when the message " +
              "carried no user identity — a null sender still notifies, but project-wide.",
          }),
      })
      .nullable()
      .default(null)
      .meta({
        description:
          "The user turn the agent still owes a visible reply, or null. Consecutive user " +
          "messages collapse into one turn (latest identity wins); the reply that closes " +
          "the turn is the one that notifies, so multi-message agent turns yield ONE push.",
      }),
    notifiableReply: z
      .strictObject({
        replyEventOffset: z
          .number()
          .int()
          .positive()
          .meta({ description: "The agents/web-message-sent offset that closed the turn." }),
        userId: z
          .string()
          .nullable()
          .meta({ description: "The closed turn's sender, carried over from pendingTurn." }),
      })
      .nullable()
      .default(null)
      .meta({
        description:
          "Stamped by reduce when a reply closes an open turn; the per-event lane emits the " +
          "intent for exactly the event whose offset matches, so replays re-derive the same " +
          "append (idempotency-keyed) and replies without an open turn emit nothing.",
      }),
    title: z
      .string()
      .nullable()
      .default(null)
      .meta({
        description:
          "The agent's human-readable title, folded from agent/summary-updated patches " +
          "(null cleared or never set) — the push notification's title line.",
      }),
  }),
  events: {
    "events.iterate.com/chat-reply-notify/created": {
      description:
        "Birth certificate: this agent stream's replies to user turns produce push intents. " +
        "Appended by the generic agent creation batch (rpc-targets agents.create), never by " +
        "integration routers — Slack/Telegram/Email threads notify in-channel instead.",
      payloadSchema: z.strictObject({
        config: z
          .strictObject({})
          .meta({ description: "Reserved for birth-time configuration; empty today." }),
      }),
    },
  },
  consumes: [
    "events.iterate.com/chat-reply-notify/created",
    "events.iterate.com/agents/context-added",
    "events.iterate.com/agents/web-message-sent",
    "events.iterate.com/agent/summary-updated",
  ],
  emits: ["events.iterate.com/notification/requested"],
});

export type ChatReplyNotifyProcessorContract = typeof ChatReplyNotifyProcessorContract;

export type ChatReplyNotifyProcessorState = ProcessorState<ChatReplyNotifyProcessorContract>;
