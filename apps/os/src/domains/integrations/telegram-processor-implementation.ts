// Implements the "telegram" webhook-router processor on itx — the Telegram
// sibling of slack-processor-implementation.ts. Emitted event types, payloads,
// and idempotency keys are stable wire formats.

import { StreamProcessor, type EmittedInput } from "iterate/processors";
import {
  agentCreationForPath,
  telegramAgentSystemPrompt,
  TELEGRAM_AGENT_SYSTEM_PROMPT_REVISION,
} from "../agents/agent-defaults.ts";
import { TelegramAgentProcessorContract } from "./telegram-agent-processor-contract.ts";
import {
  coerceTelegramId,
  readRecord,
  telegramChatStreamPath,
  webhookAckIsFresh,
} from "./utils.ts";
import {
  TelegramProcessorContract,
  type TelegramProcessorState,
} from "./telegram-processor-contract.ts";

/** The forwarded-payload annotation for an update that replies to an earlier
 * message: which thread that message belongs to, and how we know. The agent
 * transcription renders it; routing NEVER acts on it. */
type TelegramReplyHint = {
  resolvedBy: "reply-date" | "sent-claim";
  sessionPath: string;
};

type TelegramProcessorDeps = {
  now(): number;
  sendTelegramMessage(input: {
    body: Record<string, unknown>;
    connection: string;
  }): Promise<unknown>;
  telegramAccessSettingsUrl(input: { connection: string; projectId: string }): Promise<string>;
};

export class TelegramProcessor extends StreamProcessor<
  TelegramProcessorContract,
  TelegramProcessorDeps
> {
  readonly contract = TelegramProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<TelegramProcessorContract>["reduce"]>[0]): TelegramProcessorState {
    switch (event.type) {
      case "events.iterate.com/telegram/created":
        if (state.birthCertificate !== null) {
          throw new Error("Telegram processor received more than one telegram/created event");
        }
        return { ...state, birthCertificate: event.payload };
      case "events.iterate.com/telegram/access-configured":
        return {
          ...state,
          accessPolicyConfigured: true,
          allowedUserIds: [...new Set(event.payload.allowedUserIds)],
          // A version refold must reconstruct pre-allowlist `/new` history,
          // otherwise deploying access control silently sends every existing
          // chat back to session zero. On the first explicit policy, retain
          // only sessions started by users the owner has now authorized.
          sessionsByChat: state.accessPolicyConfigured
            ? state.sessionsByChat
            : filterTelegramSessionsByAllowedUsers(
                state.sessionsByChat,
                event.payload.allowedUserIds,
              ),
        };
      case "events.iterate.com/telegram/webhook-received": {
        // `/new` starts a session: fold it straight off the webhook — the
        // webhook event itself is the session-start fact, so replay rebuilds
        // the exact same thread model with no extra event type.
        const connection = state.birthCertificate?.config.connection;
        if (connection === undefined) return state;
        const senderId = telegramSenderIdFromUpdate(event.payload.body);
        if (senderId === undefined) return state;
        if (state.accessPolicyConfigured && !state.allowedUserIds.includes(senderId)) return state;
        const sessionStart = telegramSessionStartFromUpdate(event.payload.body, {
          connection,
          senderId,
        });
        if (sessionStart === null) return state;
        const existing = state.sessionsByChat[sessionStart.chatKey] ?? [];
        const latest = existing.at(-1);
        // (date, message_id) ordering: same-second /new pairs are ordered by
        // message_id (strictly increasing per chat); an out-of-order or
        // duplicate delivery must not roll the live session backwards.
        if (
          latest !== undefined &&
          (latest.date > sessionStart.date ||
            (latest.date === sessionStart.date && latest.messageId >= sessionStart.messageId))
        ) {
          return state;
        }
        return {
          ...state,
          sessionsByChat: {
            ...state.sessionsByChat,
            [sessionStart.chatKey]: [
              ...existing,
              {
                date: sessionStart.date,
                messageId: sessionStart.messageId,
                senderId: sessionStart.senderId,
                sessionPath: sessionStart.sessionPath,
              },
            ],
          },
        };
      }
      case "events.iterate.com/telegram/message-sent": {
        // The journaled-send claim (cross-posted here by the telegram-agent
        // effect): bot message_id → the session stream its request lived on,
        // so replies to bot messages resolve to their exact thread.
        const { chatId, messageId, sessionPath } = event.payload;
        if (chatId === undefined || sessionPath === undefined) return state;
        return {
          ...state,
          sentMessages: {
            ...state.sentMessages,
            [`${chatId}:${messageId}`]: { sessionPath },
          },
        };
      }
      default:
        return state;
    }
  }

  protected override processEvent({
    appendTo,
    blockProcessorWhile,
    event,
    runInBackground,
    state,
  }: Parameters<StreamProcessor<TelegramProcessorContract>["processEvent"]>[0]): undefined {
    // Event-less at-head pass: this processor has no at-head work.
    if (event === null) return;
    if (event.type === "events.iterate.com/telegram/created") return;
    const connection = state.birthCertificate?.config.connection;
    if (connection === undefined) return;
    if (event.type !== "events.iterate.com/telegram/webhook-received") return;

    // The router deliberately does not decide whether an update is meaningful
    // to the agent. Its only job is: which chat does this update belong to?
    // Chat-less updates (inline queries, poll results, …) are dropped — v1
    // handles chat-scoped updates only.
    const target = telegramChatFromUpdate(event.payload.body);
    if (target == null) return;

    const senderId = telegramSenderIdFromUpdate(event.payload.body);
    if (senderId === undefined) return;
    if (!state.allowedUserIds.includes(senderId)) {
      // Denial is deterministic processor work: no agent stream, context, or
      // LLM exists for an unauthorized sender. Only ordinary messages receive
      // the handoff; service updates and button callbacks are denied silently.
      if (
        readRecord(readRecord(event.payload.body)?.message) !== null &&
        webhookAckIsFresh(event, this.deps.now())
      ) {
        // The handoff is useful but not an authorization obligation. A user
        // may have blocked the bot or Telegram may reject this chat; that
        // must not wedge the connection router and hold later allowed users
        // behind an undeliverable denial.
        runInBackground(async () => {
          if (this.projectId === null) {
            throw new Error("Telegram router cannot build access settings without a project id");
          }
          const settingsUrl = await this.deps.telegramAccessSettingsUrl({
            connection,
            projectId: this.projectId,
          });
          await this.deps.sendTelegramMessage({
            connection,
            body: {
              chat_id: coerceTelegramId(target.chatId),
              ...(target.messageThreadId === undefined
                ? {}
                : { message_thread_id: coerceTelegramId(target.messageThreadId) }),
              text: telegramAccessDeniedMessage({ settingsUrl, userId: senderId }),
            },
          });
        });
      }
      return;
    }

    // Everything routes to the chat's LATEST session — `state` is post-reduce,
    // so a `/new` update routes ITSELF (and its trailing text) into the fresh
    // session it just started. No `/new` yet = session zero, the bare v1 path.
    const chatKey = telegramChatKey(target);
    const sessions = state.sessionsByChat[chatKey] ?? [];
    const streamPath =
      sessions.at(-1)?.sessionPath ??
      telegramChatStreamPath({
        ...target,
        connection,
      });

    // reply_to is a HINT, not a routing rule: annotate which thread the
    // replied-to message belongs to and let the agent decide what to do.
    const replyHint = resolveTelegramReplyHint({
      body: event.payload.body,
      chatId: target.chatId,
      connection,
      routedStreamPath: streamPath,
      sessions,
      sentMessages: state.sentMessages,
      target,
    });

    // Durable obligation, NOT best-effort: this forward is the only copy of
    // the Telegram message on its way to the agent. `blockProcessorWhile`
    // holds the checkpoint on failure so the host replays this webhook until
    // it lands; the idempotency key derives from the source event, so the
    // replay dedupes instead of double-forwarding.
    blockProcessorWhile(async () => {
      if (this.projectId === null) {
        throw new Error("Telegram router cannot create a project agent without a project id");
      }
      await appendTo(
        streamPath,
        ...telegramAgentCreationEvents({
          chatId: target.chatId,
          connection,
          messageThreadId: target.messageThreadId,
          path: streamPath,
          projectId: this.projectId,
        }),
        {
          type: "events.iterate.com/telegram/webhook-received",
          idempotencyKey: `telegram:forward-webhook:${event.offset}`,
          payload: { ...event.payload, ...(replyHint === null ? {} : { replyHint }) },
        },
      );
    });
  }
}

function telegramAgentCreationEvents(input: {
  chatId: string;
  connection: string;
  messageThreadId?: string;
  path: string;
  projectId: string;
}): EmittedInput<TelegramProcessorContract>[] {
  const creation = agentCreationForPath({
    agentPath: input.path,
    projectId: input.projectId,
    platformSystemPrompt: {
      content: telegramAgentSystemPrompt({
        agentPath: input.path,
        chatId: input.chatId,
        connection: input.connection,
      }),
      id: "telegram",
      revision: TELEGRAM_AGENT_SYSTEM_PROMPT_REVISION,
    },
    sibling: {
      birthCertificate: TelegramAgentProcessorContract.buildEvent({
        type: "events.iterate.com/telegram-agent/created",
        idempotencyKey: `telegram-agent/created:${input.projectId}:${input.path}`,
        payload: {
          config: {
            chatId: input.chatId,
            connection: input.connection,
            ...(input.messageThreadId === undefined
              ? {}
              : { messageThreadId: input.messageThreadId }),
          },
        },
      }),
      processorSlug: TelegramAgentProcessorContract.slug,
    },
  });
  return creation.events satisfies EmittedInput<TelegramProcessorContract>[];
}

/** The chat-scoped part of a routed stream path (`chat-{id}` or
 * `chat-{id}/topic-{tid}`) — the sessionsByChat key. */
function telegramChatKey(target: { chatId: string; messageThreadId?: string }): string {
  return target.messageThreadId === undefined
    ? `chat-${target.chatId}`
    : `chat-${target.chatId}/topic-${target.messageThreadId}`;
}

/**
 * The `/new` command in a message's text, or null. Telegram sends group-chat
 * commands as `/new@BotUsername`; trailing text after the command becomes the
 * fresh session's first message.
 */
export function telegramNewCommand(text: unknown): { trailingText: string | null } | null {
  if (typeof text !== "string") return null;
  const match = /^\/new(?:@\S+)?(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (match === null) return null;
  const trailingText = match[1]?.trim() || null;
  return { trailingText };
}

/**
 * The session one `/new` message starts: keyed by chat, named by the message's
 * `date` (unix seconds), ordered by `(date, message_id)`. Null for anything
 * that is not a human-sent `/new` message with a chat.
 */
function telegramSessionStartFromUpdate(
  body: unknown,
  input: { connection: string; senderId: string },
): {
  chatKey: string;
  date: number;
  messageId: number;
  senderId: string;
  sessionPath: string;
} | null {
  const update = readRecord(body);
  const message = readRecord(update?.message);
  if (message == null) return null;
  if (readRecord(message.from)?.is_bot === true) return null;
  if (telegramNewCommand(message.text) === null) return null;
  const target = telegramChatFromUpdate(body);
  const date = message.date;
  const messageId = message.message_id;
  if (target == null || typeof date !== "number" || typeof messageId !== "number") return null;
  return {
    chatKey: telegramChatKey(target),
    date,
    messageId,
    senderId: input.senderId,
    sessionPath: telegramChatStreamPath({
      ...target,
      connection: input.connection,
      session: String(date),
    }),
  };
}

function filterTelegramSessionsByAllowedUsers(
  sessionsByChat: TelegramProcessorState["sessionsByChat"],
  allowedUserIds: string[],
): TelegramProcessorState["sessionsByChat"] {
  const allowed = new Set(allowedUserIds);
  return Object.fromEntries(
    Object.entries(sessionsByChat).flatMap(([chatKey, sessions]) => {
      const retained = sessions.filter((session) => allowed.has(session.senderId));
      return retained.length === 0 ? [] : [[chatKey, retained]];
    }),
  );
}

/**
 * Which thread does the replied-to message belong to? Bot messages resolve
 * EXACTLY from the folded send claims; user messages fall back to "latest
 * session started at or before the replied-to message" (compared by
 * `(date, message_id)` — `reply_to_message` embeds the original including its
 * `date`, so no lookup is needed); older than the first session = session
 * zero. Returns null when the update is not a reply, when the reply is just
 * the forum-topic starter (Telegram sets reply_to_message on every topic
 * message), or when the referenced thread IS the routing destination (a plain
 * in-thread reply — the hint would be noise).
 */
function resolveTelegramReplyHint(input: {
  body: unknown;
  chatId: string;
  connection: string;
  routedStreamPath: string;
  sessions: readonly { date: number; messageId: number; sessionPath: string }[];
  sentMessages: Record<string, { sessionPath: string }>;
  target: { chatId: string; messageThreadId?: string };
}): TelegramReplyHint | null {
  const update = readRecord(input.body);
  const message = readRecord(update?.message) ?? readRecord(update?.edited_message);
  const repliedTo = readRecord(message?.reply_to_message);
  if (message == null || repliedTo == null) return null;
  const repliedToMessageId = repliedTo.message_id;
  if (typeof repliedToMessageId !== "number") return null;
  // Forum quirk: every topic message "replies to" the topic-creation service
  // message; that is threading plumbing, not a human reply gesture.
  if (
    input.target.messageThreadId !== undefined &&
    String(repliedToMessageId) === input.target.messageThreadId
  ) {
    return null;
  }

  const hint = ((): TelegramReplyHint => {
    const claim = input.sentMessages[`${input.chatId}:${repliedToMessageId}`];
    if (readRecord(repliedTo.from)?.is_bot === true && claim !== undefined) {
      return { resolvedBy: "sent-claim", sessionPath: claim.sessionPath };
    }
    const repliedToDate = typeof repliedTo.date === "number" ? repliedTo.date : 0;
    const containing = [...input.sessions]
      .reverse()
      .find(
        (session) =>
          session.date < repliedToDate ||
          (session.date === repliedToDate && session.messageId <= repliedToMessageId),
      );
    return {
      resolvedBy: "reply-date",
      sessionPath:
        containing?.sessionPath ??
        // Older than the first /new: pre-session history, i.e. session zero.
        telegramChatStreamPath({ ...input.target, connection: input.connection }),
    };
  })();

  // A reply whose thread is where the message routes anyway needs no hint.
  return hint.sessionPath === input.routedStreamPath ? null : hint;
}

/**
 * The chat one Telegram update belongs to, as routed-stream-path inputs. Reads
 * the chat off whichever update container carries one (message, edits, channel
 * posts, callback queries, membership updates); `messageThreadId` is set only
 * for forum-topic messages (`is_topic_message`), where one supergroup hosts
 * many parallel topics that must not share an agent. Null when the update has
 * no chat at all.
 */
function telegramChatFromUpdate(
  body: unknown,
): { chatId: string; messageThreadId?: string } | null {
  const update = readRecord(body);
  if (update == null) return null;
  const container =
    readRecord(update.message) ??
    readRecord(update.edited_message) ??
    readRecord(update.channel_post) ??
    readRecord(update.edited_channel_post) ??
    readRecord(readRecord(update.callback_query)?.message) ??
    readRecord(update.my_chat_member) ??
    readRecord(update.chat_member) ??
    readRecord(update.chat_join_request);
  const chatId = readTelegramId(readRecord(container?.chat)?.id);
  if (chatId == null) return null;
  const messageThreadId =
    container?.is_topic_message === true ? readTelegramId(container.message_thread_id) : undefined;
  return { chatId, ...(messageThreadId === undefined ? {} : { messageThreadId }) };
}

/** Telegram ids arrive as JSON integers (possibly negative, up to 52 bits);
 * stringified for path segments and directory keys. */
function readTelegramId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && value !== "") return value;
  return undefined;
}

/** The human who caused one update. This identity, not the chat, is the
 * authorization principal: a permitted group must not grant every member
 * project access. */
function telegramSenderIdFromUpdate(body: unknown): string | undefined {
  const update = readRecord(body);
  const sender =
    readRecord(readRecord(update?.message)?.from) ||
    readRecord(readRecord(update?.edited_message)?.from) ||
    readRecord(readRecord(update?.channel_post)?.from) ||
    readRecord(readRecord(update?.edited_channel_post)?.from) ||
    readRecord(readRecord(update?.callback_query)?.from) ||
    readRecord(readRecord(update?.my_chat_member)?.from) ||
    readRecord(readRecord(update?.chat_member)?.from) ||
    readRecord(readRecord(update?.chat_join_request)?.from);
  if (sender?.is_bot === true) return undefined;
  return readTelegramId(sender?.id);
}

function telegramAccessDeniedMessage(input: { settingsUrl: string; userId: string }): string {
  return [
    "Access denied. This Telegram account is not allowed to use this Iterate project.",
    `Ask a project owner to add Telegram user ID ${input.userId} to this bot's allowlist:`,
    input.settingsUrl,
    "You can forward this message to them.",
  ].join("\n\n");
}
