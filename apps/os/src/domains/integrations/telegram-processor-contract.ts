// Contract for the "telegram" webhook-router processor mounted on each
// per-project `/integrations/telegram/{connection}` stream — the Telegram
// sibling of SlackProcessorContract. Self-contained: the state schema and the
// event vocabulary are spelled inline; the ONE schema the contract uses twice
// (the router's birth certificate) is a hoisted function below the contract,
// so the contract still opens the file. This contract also OWNS the
// `telegram-agent/created` payload (the facet birth certificate the router
// emits onto agent streams) — the telegram-agent contract reaches through
// `TelegramProcessorContract.events[...]` for it instead of a second export.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";

export const TelegramProcessorContract = defineProcessorContract({
  slug: "telegram",
  version: "0.4.0",
  description: "Routes raw Telegram webhook updates into Telegram-backed agent streams.",
  stateSchema: z.object({
    birthCertificate: telegramRouterBirthCertificateSchema()
      .nullable()
      .default(null)
      .meta({
        description:
          "Existence marker: null until telegram/created reduces. Names the bot connection " +
          "this router serves; the router forwards nothing before it.",
      }),
    accessPolicyConfigured: z
      .boolean()
      .default(false)
      .meta({
        description:
          "False only while replaying a legacy stream that predates access-policy events. The " +
          "FIRST access-configured event filters the reconstructed session history to newly " +
          "authorized senders; subsequent policy edits do not erase sessions created while " +
          "those senders were authorized.",
      }),
    allowedUserIds: z
      .array(z.string())
      .default([])
      .meta({
        description:
          "Telegram user ids authorized to reach project agents through this bot connection. " +
          "Empty is deliberately deny-all.",
      }),
    sessionsByChat: z
      .record(
        z.string().meta({
          description:
            "The chat-scoped path suffix: `chat-{chatId}` or `chat-{chatId}/topic-{threadId}`.",
        }),
        z.array(
          z.object({
            date: z.number().meta({
              description:
                "The /new message's `date` (unix seconds) — the session's name and its primary " +
                "ordering key. Same-second ties are broken by messageId.",
            }),
            messageId: z.number().meta({
              description:
                "The /new message's message_id — strictly increasing per chat, the tie-break " +
                "for same-second /new pairs.",
            }),
            senderId: z.string().meta({
              description:
                "The Telegram user id that sent the /new — the authorization principal the " +
                "first access policy filters legacy history by.",
            }),
            sessionPath: z.string().meta({
              description: "The routed session stream this /new started.",
            }),
          }),
        ),
      )
      .default({})
      .meta({
        description:
          "Per-chat /new session starts, oldest first, reduced straight off the webhook events " +
          "on this stream (the webhook IS the session-start fact — replay rebuilds the exact " +
          "same thread model with no extra event type). The last entry is the live session " +
          "every update routes to; the history serves reply-date fallback resolution ('latest " +
          "session started at or before the replied-to date'). A chat with no /new yet routes " +
          "to the bare chat path — session zero, the v1 shape.",
      }),
    sentMessages: z
      .record(
        z.string().meta({ description: "`{chatId}:{messageId}` of one bot-sent message." }),
        z.object({
          sessionPath: z.string().meta({
            description: "The session stream the message's send-requested lived on.",
          }),
        }),
      )
      .default({})
      .meta({
        description:
          "Bot-message provenance, reduced from the message-sent claims the telegram-agent " +
          "processor cross-posts here after each journaled send. Replies to bot messages get " +
          "EXACT thread hints from this map; replies to user messages fall back to the " +
          "sessionsByChat date ordering.",
      }),
  }),
  events: {
    "events.iterate.com/telegram/created": {
      description: "Birth certificate for this Telegram webhook router.",
      payloadSchema: telegramRouterBirthCertificateSchema(),
    },
    "events.iterate.com/telegram/access-configured": {
      description:
        "Replaces the Telegram user-id allowlist for this bot connection. Empty denies every inbound user.",
      payloadSchema: z.object({
        allowedUserIds: z
          .array(z.string().trim().regex(/^\d+$/, "Telegram user IDs contain digits only"))
          .transform((ids) => [...new Set(ids)])
          .meta({
            description:
              "The complete replacement allowlist: Telegram user ids (digits only), " +
              "deduplicated on parse. The sender's identity — not the chat — is the " +
              "authorization principal.",
          }),
      }),
    },
    "events.iterate.com/telegram-agent/created": {
      description: "Birth certificate for the Telegram facet on an agent stream.",
      payloadSchema: z.object({
        config: z
          .object({
            connection: z.string().meta({
              description: "The named bot connection the session's messages ride.",
            }),
            chatId: z.string().meta({
              description:
                "The Telegram chat this agent stream is bound to (negative for groups/channels).",
            }),
            messageThreadId: z.string().optional().meta({
              description: "The forum-topic thread id, for supergroup topic sessions only.",
            }),
          })
          .meta({
            description: "The immutable chat coordinates every journaled send is forced to.",
          }),
      }),
    },
    "events.iterate.com/telegram/webhook-received": {
      description:
        "Raw Telegram Update, appended by the webhook door to `/integrations/telegram/{connection}` and forwarded (plus `replyHint` when the update replies to an earlier message) to routed chat/session streams. `botId` is the receiving bot's numeric id (the webhook path segment).",
      payloadSchema: z
        .object({
          body: z
            .record(z.string(), z.unknown())
            .meta({ description: "The Telegram Update object, verbatim." }),
          botId: z.string().meta({
            description: "The receiving bot's numeric id (the webhook path segment).",
          }),
        })
        .loose(),
    },
    "events.iterate.com/telegram/message-sent": {
      description:
        "One journaled send delivered to Telegram. On the session stream it is the effect marker satisfying the send-requested at `requestOffset`; on the connection stream it is the provenance claim (`messageId`, `chatId`, `sessionPath`, `request`) the router reduces so replies to bot messages resolve to their exact thread.",
      payloadSchema: z
        .object({
          messageId: z
            .number()
            .meta({ description: "Telegram's message_id for the sent message." }),
          chatId: z.string().optional().meta({
            description: "The chat the message went to (present on connection-stream claims).",
          }),
          requestOffset: z.number().optional().meta({
            description:
              "On session-stream markers: the offset of the send-requested this send satisfies.",
          }),
          request: z
            .object({
              offset: z.number().meta({ description: "The send-requested event's offset." }),
              stream: z.string().meta({ description: "The session stream it lives on." }),
            })
            .optional()
            .meta({
              description:
                "On connection-stream claims: the coordinates of the satisfied send-requested.",
            }),
          sessionPath: z.string().optional().meta({
            description:
              "On connection-stream claims: the session stream — what reply hints resolve to.",
          }),
        })
        .loose(),
    },
  },
  consumes: [
    "events.iterate.com/telegram/created",
    "events.iterate.com/telegram/access-configured",
    "events.iterate.com/telegram/webhook-received",
    "events.iterate.com/telegram/message-sent",
  ],
  processorDeps: [AgentProcessorContract, CapabilityHostProcessorContract, CoreProcessorContract],
  emits: [
    "events.iterate.com/agent/created",
    "events.iterate.com/agent/binding-set",
    "events.iterate.com/agent/configured",
    "events.iterate.com/agents/context-added",
    "events.iterate.com/capability-host/created",
    "events.iterate.com/capability-host/capability-provided",
    "events.iterate.com/telegram-agent/created",
    "events.iterate.com/telegram/webhook-received",
    "events.iterate.com/stream/subscription-configured",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<TelegramProcessorContract>`,
 * `ConsumedEvent<TelegramProcessorContract>`.
 */
export type TelegramProcessorContract = typeof TelegramProcessorContract;

export type TelegramProcessorState = z.output<typeof TelegramProcessorContract.stateSchema>;

/** The router's birth certificate — the ONE schema this contract uses twice
 * (the state's existence marker and the telegram/created payload), hoisted as
 * a function so the contract can still open the file. */
function telegramRouterBirthCertificateSchema() {
  return z.object({
    config: z
      .object({
        connection: z.string().meta({
          description:
            "The named bot connection this router serves — the {connection} segment of its " +
            "own /integrations/telegram/{connection} stream path.",
        }),
      })
      .meta({ description: "Immutable connection coordinates." }),
  });
}
