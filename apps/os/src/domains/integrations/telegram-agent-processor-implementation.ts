// Implements the "telegram-agent" processor on itx — the Telegram sibling of
// slack-agent-processor-implementation.ts. Emitted event types, payloads, and
// idempotency keys are stable wire formats.
//
// Side-effect policy mirrors the Slack agent processor (refold-safety
// included, #1807):
// - The agent-context append runs inside `blockProcessorWhile` (a failed append
//   holds the checkpoint and replays). It ALWAYS runs — late webhooks still
//   reach the agent — and dedupes on its idempotency key across a refold.
// - The "typing…" chat action is a user-visible ACK ("we just heard you"),
//   so it fires only for FRESH webhooks (webhookAckIsFresh): a state-schema
//   deploy discards the checkpoint and refolds the whole journal, and typing
//   on months-old messages would be a rate-limit burst. The arrival typing
//   stays per-event (gated); the "still working" typing repaint moved to
//   `processEventBatch` — latest lifecycle fact only, at-head, once — because
//   per-event `blockProcessorWhile` closures run concurrently within a batch
//   (a real pre-existing race) and a refold would replay every historical
//   status flip.
// - The journaled send (`telegram/send-requested` → Bot API → `message-sent`
//   marker + connection-stream claim) is a DURABLE OBLIGATION, NOT an ack, so
//   it is NOT freshness-gated: it must retry until marked. It is inherently
//   refold-safe — a replayed request finds its journal marker and skips the
//   re-send (the marker + claim appends dedupe on their idempotency keys). The
//   accepted caveat: a crash BETWEEN the Bot API call and the marker append
//   re-sends on retry (Telegram's sendMessage has no idempotency key; the
//   journal is exactly-once, the send is at-least-once).

import { stringify as stringifyYaml } from "yaml";
import { StreamProcessor } from "../streams/stream-processor.ts";
import type { StreamEvent } from "../streams/schemas.ts";
import {
  integrationConnectionStreamPath,
  readRecord,
  readString,
  telegramChatIdFromAgentPath,
  telegramConnectionFromAgentPath,
  telegramTopicIdFromAgentPath,
  webhookAckIsFresh,
} from "./utils.ts";
import { telegramNewCommand } from "./telegram-processor-implementation.ts";
import {
  TelegramAgentProcessorContract,
  type TelegramAgentProcessorState,
} from "./telegram-agent-processor-contract.ts";

/** The fixed `/new` acknowledgement — a processor-level message, deliberately
 * not an agent greeting (no LLM turn for a bare `/new`). */
export const TELEGRAM_NEW_SESSION_ACK_TEXT = "Started a fresh thread.";

type TelegramAgentProcessorDeps = {
  /** The host stream's own path
   * (`/agents/telegram/<connection>/chat-<chatId>[...]`) — the chat id, forum
   * topic, and connection the send effect needs all derive from it. */
  agentPath: string;
  /** Best-effort UX side effects only (the typing chat action) — failures are
   * swallowed by the host dep and must never wedge the checkpoint. */
  callTelegramApi?(method: string, body: Record<string, unknown>): Promise<void>;
  /** The journaled send effect: deliver one sendMessage body and return
   * Telegram's message_id. MUST throw on failure — the send obligation relies
   * on the thrown error holding the checkpoint for retry. */
  sendTelegramMessage?(body: Record<string, unknown>): Promise<{ messageId: number }>;
  /** Injectable clock for the ack freshness gate (defaults to Date.now). */
  now?: () => number;
};

export class TelegramAgentProcessor extends StreamProcessor<
  TelegramAgentProcessorContract,
  TelegramAgentProcessorDeps
> {
  readonly contract = TelegramAgentProcessorContract;

  /** A typing-worthy lifecycle fact seen in a batch that was NOT at head, so
   * the next at-head batch repaints it (mirrors slack-agent's status carry). */
  #unpaintedTypingFact: StreamEvent | undefined;

  protected override reduce({
    event,
    state,
  }: Parameters<
    StreamProcessor<TelegramAgentProcessorContract>["reduce"]
  >[0]): TelegramAgentProcessorState {
    switch (event.type) {
      case "events.iterate.com/telegram/webhook-received": {
        const target = telegramUpdateTarget(event.payload.body);
        if (target == null) return state;
        return {
          ...state,
          botId: readString(event.payload.botId) ?? state.botId,
          chatId: target.chatId,
          ...(target.messageThreadId === undefined
            ? {}
            : { messageThreadId: target.messageThreadId }),
          // Half of the deterministic reply_to_message_id rule: the newest
          // human message on this session.
          ...(target.kind === "message" && !target.fromIsBot && target.messageId !== undefined
            ? { latestInboundMessageId: target.messageId }
            : {}),
        };
      }
      case "events.iterate.com/agent/llm-request-requested":
        // The other half: snapshot which message this LLM turn is answering.
        return state.latestInboundMessageId === undefined
          ? state
          : { ...state, answeringMessageId: state.latestInboundMessageId };
      default:
        return state;
    }
  }

  protected override processEvent({
    append,
    appendTo,
    blockProcessorWhile,
    event,
    state,
  }: Parameters<StreamProcessor<TelegramAgentProcessorContract>["processEvent"]>[0]): undefined {
    switch (event.type) {
      case "events.iterate.com/telegram/webhook-received": {
        const target = telegramUpdateTarget(event.payload.body);
        // Never react to bot-authored updates — our own bot's messages come
        // back through the webhook, and answering them is a feedback loop.
        if (target?.fromIsBot === true) return;

        const messageText = readRecord(readRecord(event.payload.body)?.message)?.text;
        if (target?.kind === "message" && isTelegramDebugCommand(messageText)) {
          // /debug mirrors Slack's !debug: compiled straight to a script
          // execution — no LLM turn, no agent context item. The script posts the
          // debug dump back through the journaled send pair on THIS session
          // stream, so it lands in the right thread with provenance like the
          // /new ack. (Slack's general !<expression> compiler is deliberately
          // NOT ported — /debug only for now.)
          blockProcessorWhile(async () => {
            await append({
              type: "events.iterate.com/capability-host/script-execution-requested",
              idempotencyKey: `telegram-agent:debug-command:${event.offset}`,
              payload: {
                code: compileTelegramDebugScript(this.deps.agentPath),
                executionId: `telegram-debug-command-${event.offset}`,
              },
            });
          });
          return;
        }

        const newCommand = target?.kind === "message" ? telegramNewCommand(messageText) : null;

        // Human messages and button presses wake the agent; everything else
        // (edits, membership changes, channel posts by anonymous admins, …)
        // is recorded as context without triggering an LLM turn. A bare /new
        // does not wake the agent either — its acknowledgement is the fixed
        // processor-level message below, not an agent greeting.
        const triggers =
          newCommand !== null
            ? newCommand.trailingText !== null
            : target?.kind === "message" || target?.kind === "callback_query";
        blockProcessorWhile(async () => {
          if (newCommand !== null) {
            // The fixed acknowledgement rides the journaled send pair, so it
            // is delivered with the same obligation semantics as any reply —
            // and lands in the chat before the agent's answer to any trailing
            // text (its request precedes the triggering input).
            await append({
              type: "events.iterate.com/telegram/send-requested",
              idempotencyKey: `telegram-agent:new-session-ack:${event.offset}`,
              payload: { text: TELEGRAM_NEW_SESSION_ACK_TEXT },
            });
          }
          // Telegram's normalized content is application-supplied developer
          // context; actor and refs preserve the untrusted sender and source.
          // The sender's location depends on the update kind: messages carry
          // message.from, button presses callback_query.from, edits
          // edited_message.from.
          const update = readRecord(event.payload.body);
          const sender =
            readRecord(readRecord(update?.message)?.from) ??
            readRecord(readRecord(update?.callback_query)?.from) ??
            readRecord(readRecord(update?.edited_message)?.from);
          const senderId = sender?.id;
          const senderUsername = readString(sender?.username);
          await append({
            type: "events.iterate.com/agents/context-added",
            idempotencyKey: `telegram-agent:webhook-to-agent-context:${event.offset}`,
            payload: {
              role: "developer",
              content: telegramWebhookAgentInput(event.payload, { newCommand }),
              actor: {
                type: "telegram",
                ...(typeof senderId === "number" || typeof senderId === "string"
                  ? { userId: String(senderId) }
                  : {}),
                ...(senderUsername == null ? {} : { username: senderUsername }),
              },
              refs: [
                {
                  type: "event",
                  streamPath: event.path,
                  offset: event.offset,
                  eventType: event.type,
                },
              ],
              ...(triggers ? {} : { llmRequestPolicy: { behaviour: "dont-trigger-request" } }),
            },
          });
          // After the input committed (never before — the typing indicator
          // must not signal receipt of a message that could still be lost),
          // show "typing…" so the human knows the bot heard them. Freshness-
          // gated: a refold must not re-type on historical messages.
          if (
            triggers &&
            target != null &&
            webhookAckIsFresh(event, (this.deps.now ?? Date.now)())
          ) {
            await this.#sendTyping(target);
          }
        });
        return;
      }
      case "events.iterate.com/telegram/send-requested": {
        // The send obligation: deliver, then mark. Everything under
        // blockProcessorWhile so any failure holds the checkpoint and the
        // host replays this request until a marker exists.
        blockProcessorWhile(async () => {
          const sessionPath = this.deps.agentPath;
          const chatId = state.chatId ?? telegramChatIdFromAgentPath(sessionPath);
          if (chatId === null) {
            throw new Error(
              `telegram-agent send-requested on a stream whose path carries no chat id: ${sessionPath}`,
            );
          }

          // Replay safety: a marker for this request means the send already
          // happened — never re-send a satisfied obligation. (A crash BEFORE
          // the marker re-sends; that is the accepted at-least-once caveat.)
          const existingMarker = await this.#findSentMarker(event.offset);
          const messageId =
            existingMarker?.messageId ?? (await this.#deliver({ chatId, event, state }));

          await append({
            type: "events.iterate.com/telegram/message-sent",
            idempotencyKey: `telegram-agent:message-sent:${event.offset}`,
            payload: { messageId, requestOffset: event.offset },
          });
          // The provenance claim on the CONNECTION stream: the router folds
          // message_id → sessionPath from it, making reply hints exact for
          // bot messages. Idempotency-keyed, so a crash between marker and
          // claim replays into a single claim.
          const connection = telegramConnectionFromAgentPath(sessionPath);
          if (connection !== null) {
            await appendTo(integrationConnectionStreamPath("telegram", connection), {
              type: "events.iterate.com/telegram/message-sent",
              idempotencyKey: `telegram:sent-claim:${sessionPath}:${event.offset}`,
              payload: {
                chatId,
                messageId,
                request: { offset: event.offset, stream: sessionPath },
                sessionPath,
              },
            });
          }
        });
        return;
      }
      // llm-request-requested / script-execution-requested drive the "still
      // working" typing repaint — handled once per batch in processEventBatch
      // (below), not per-event, so a refold cannot replay every historical
      // flip and concurrent per-event closures cannot race.
      default:
        return;
    }
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<TelegramAgentProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    await super.processEventBatch(args);
    // The "still working" typing indicator auto-expires after ~5s; one repaint
    // per batch keeps it roughly alive while the agent works. Repaint the
    // LATEST typing-worthy fact in the batch (an earlier one is already stale),
    // carried across non-at-head batches so a lagging fold still paints once it
    // catches up.
    const latest =
      args.reducedEvents.findLast(({ event }) => isTelegramTypingLifecycleFact(event))?.event ??
      this.#unpaintedTypingFact;
    if (args.checkpointOffset < args.streamMaxOffset) {
      this.#unpaintedTypingFact = latest;
      return;
    }
    this.#unpaintedTypingFact = undefined;
    if (latest == null || !webhookAckIsFresh(latest, (this.deps.now ?? Date.now)())) return;
    const { chatId, messageThreadId } = args.state;
    if (chatId == null) return;
    args.blockProcessorWhile(async () => {
      await this.#sendTyping({ chatId, messageThreadId });
    });
  }

  /** Deliver one send-requested to the Bot API; returns Telegram's message_id. */
  async #deliver(input: {
    chatId: string;
    event: { offset: number; payload: Record<string, unknown> };
    state: TelegramAgentProcessorState;
  }): Promise<number> {
    if (this.deps.sendTelegramMessage == null) {
      // Loud, not skipped: a send obligation with no delivery dep is a
      // misconfiguration; dropping it would silently eat the reply.
      throw new Error(
        "telegram-agent has no sendTelegramMessage dep; cannot satisfy send-requested",
      );
    }
    const topicId = telegramTopicIdFromAgentPath(this.deps.agentPath);
    // The deterministic reply_to_message_id rule (unless the request already
    // chose one): quote the message this turn is answering ONLY when newer
    // messages have arrived since — quoting the latest message is noise,
    // quoting a stale one disambiguates.
    const { answeringMessageId, latestInboundMessageId } = input.state;
    const replyTo =
      input.event.payload.reply_to_message_id !== undefined
        ? undefined
        : answeringMessageId !== undefined && answeringMessageId !== latestInboundMessageId
          ? answeringMessageId
          : undefined;
    // Journaled sends are THREAD-BOUND: the stream's identity always wins over
    // payload-supplied chat_id/message_thread_id. Not a capability boundary
    // (the raw itx.integrations.telegram sendMessage can post anywhere) — a
    // provenance one: the message-sent claim below records THIS stream as the
    // message's thread, and a send that actually went elsewhere would poison
    // reply hints and the reply_to comparison. Forced rather than rejected: a
    // permanently-invalid request must not wedge the obligation retry loop.
    // reply_to_message_id stays caller-overridable (it is within-chat).
    const {
      chat_id: _ignoredChatId,
      message_thread_id: _ignoredThreadId,
      ...payloadRest
    } = input.event.payload;
    const { messageId } = await this.deps.sendTelegramMessage({
      ...(replyTo === undefined ? {} : { reply_to_message_id: replyTo }),
      ...payloadRest,
      chat_id: coerceTelegramId(input.chatId),
      ...(topicId === null ? {} : { message_thread_id: coerceTelegramId(topicId) }),
    });
    return messageId;
  }

  /** The message-sent marker satisfying the send-requested at `requestOffset`,
   * read from the journal (markers land AFTER their request, so folded state
   * can never see them while replaying the request itself). */
  async #findSentMarker(requestOffset: number): Promise<{ messageId: number } | null> {
    let afterOffset = requestOffset;
    for (;;) {
      const page = await this.stream.getEvents({
        afterOffset,
        eventTypes: ["events.iterate.com/telegram/message-sent"],
        limit: 500,
      });
      for (const event of page) {
        const payload = readRecord(event.payload);
        if (payload?.requestOffset === requestOffset && typeof payload.messageId === "number") {
          return { messageId: payload.messageId };
        }
      }
      if (page.length < 500) return null;
      afterOffset = page.at(-1)!.offset;
    }
  }

  async #sendTyping(target: { chatId: string; messageThreadId?: string }) {
    if (this.deps.callTelegramApi == null) return;
    await this.deps.callTelegramApi("sendChatAction", {
      action: "typing",
      chat_id: coerceTelegramId(target.chatId),
      ...(target.messageThreadId === undefined
        ? {}
        : { message_thread_id: coerceTelegramId(target.messageThreadId) }),
    });
  }
}

/** Ids ride stream paths and state as strings; the Bot API wants the original
 * integers back where they were integers. */
function coerceTelegramId(id: string): number | string {
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) ? numeric : id;
}

/** Events that mean "the agent is working now", driving the typing repaint. */
function isTelegramTypingLifecycleFact(event: { type: string }): boolean {
  return (
    event.type === "events.iterate.com/agent/llm-request-requested" ||
    event.type === "events.iterate.com/capability-host/script-execution-requested"
  );
}

/** A message of exactly `/debug` (Telegram appends `@BotUsername` in groups). */
function isTelegramDebugCommand(text: unknown): boolean {
  return typeof text === "string" && /^\/debug(?:@\S+)?$/.test(text.trim());
}

/**
 * The /debug script, mirroring Slack's !debug (compileBangCommand in
 * slack-agent-processor-implementation.ts): run itx.debug() and post the
 * result into the chat via the journaled send on this session stream.
 * Telegram caps message text at 4096 chars, so the dump truncates safely.
 */
function compileTelegramDebugScript(sessionPath: string): string {
  return [
    "async (itx) => {",
    "  const debug = await itx.debug();",
    "  const text = `Debug info:\n${debug}`;",
    "  const limit = 4096;",
    "  const truncated = text.length > limit ? `${text.slice(0, limit - 12)}\n…truncated` : text;",
    `  await itx.streams.get(${JSON.stringify(sessionPath)}).append({`,
    '    type: "events.iterate.com/telegram/send-requested",',
    "    payload: { text: truncated },",
    "  });",
    "}",
  ].join("\n");
}

function telegramWebhookAgentInput(
  payload: unknown,
  options: { newCommand: { trailingText: string | null } | null },
) {
  const lines = ["`events.iterate.com/telegram/webhook-received` event received"];
  // The reply hint leads, ABOVE the YAML dump — trailing a wall of YAML it
  // gets skimmed past (observed live: the agent explored the repo instead of
  // reading the hinted thread, then claimed the history was unavailable).
  const replyHint = readRecord(readRecord(payload)?.replyHint);
  const replyHintPath = readString(replyHint?.sessionPath);
  if (replyHintPath !== undefined) {
    lines.push(
      "",
      // The taught read is FILTERED to the two conversation event types — an
      // unfiltered getEvents returns the OLDEST raw events (subscriber/llm
      // plumbing), which is how a live agent failed to recover a thread.
      `IMPORTANT: this message REPLIES to a message from a different thread: ${replyHintPath} (resolved by ${readString(replyHint?.resolvedBy) ?? "unknown"}). Before answering — and before any other exploration — read that thread's transcript: await itx.streams.get(${JSON.stringify(replyHintPath)}).getEvents({ eventTypes: ["events.iterate.com/telegram/webhook-received", "events.iterate.com/telegram/send-requested"] }) (user text is in payload.body.message.text, your earlier replies in payload.text; if exactly 500 events come back, repeat with afterOffset: events.at(-1).offset to reach the recent end). Then answer in THAT thread by appending your send request to that stream instead of this one, or answer here — your judgement, but only after reading it.`,
    );
  }
  lines.push("", "```yaml", stringifyYaml(payload).trimEnd(), "```");
  if (options.newCommand !== null) {
    lines.push(
      "",
      options.newCommand.trailingText === null
        ? "The user started a fresh thread with /new. This session's transcript starts here; earlier conversation lives in the previous session streams."
        : `The user started a fresh thread with /new — treat the text after /new as their first message in this new conversation: ${JSON.stringify(options.newCommand.trailingText)}`,
    );
  }
  const placeholders = telegramMediaPlaceholders(payload);
  if (placeholders.length > 0) {
    lines.push(
      "",
      `Media in this message (not directly viewable in v1 — reply accordingly if asked about it): ${placeholders.join(" ")}`,
    );
  }
  return lines.join("\n");
}

/** Bracketed placeholders for the media a message carries — the v1 stand-in
 * for actually downloading Telegram files. */
function telegramMediaPlaceholders(payload: unknown): string[] {
  const update = readRecord(readRecord(payload)?.body);
  const message =
    readRecord(update?.message) ??
    readRecord(update?.edited_message) ??
    readRecord(update?.channel_post);
  if (message == null) return [];
  const mediaKinds: Array<[key: string, placeholder: string]> = [
    ["photo", "[photo]"],
    ["voice", "[voice message]"],
    ["audio", "[audio]"],
    ["video", "[video]"],
    ["video_note", "[video note]"],
    ["sticker", "[sticker]"],
    ["document", "[document]"],
    ["animation", "[animation]"],
    ["location", "[location]"],
    ["contact", "[contact]"],
    ["poll", "[poll]"],
    ["venue", "[venue]"],
  ];
  return mediaKinds.filter(([key]) => message[key] != null).map(([, placeholder]) => placeholder);
}

type TelegramUpdateTarget = {
  chatId: string;
  fromIsBot: boolean;
  kind: "callback_query" | "channel_post" | "chat_member" | "edited_message" | "message" | "other";
  messageId?: number;
  messageThreadId?: string;
};

/** The chat/sender coordinates of one raw update — what the transcription
 * gates, the typing action, and the reply_to rule need. Null when the update
 * carries no chat. */
function telegramUpdateTarget(body: unknown): TelegramUpdateTarget | null {
  const update = readRecord(body);
  if (update == null) return null;
  const containers: Array<[kind: TelegramUpdateTarget["kind"], value: unknown]> = [
    ["message", update.message],
    ["edited_message", update.edited_message],
    ["channel_post", update.channel_post],
    ["callback_query", readRecord(update.callback_query)?.message],
    ["chat_member", update.my_chat_member],
    ["chat_member", update.chat_member],
    ["other", update.chat_join_request],
  ];
  for (const [kind, value] of containers) {
    const container = readRecord(value);
    const chatId = readTelegramId(readRecord(container?.chat)?.id);
    if (container == null || chatId == null) continue;
    // The ACTOR: for callback queries it is the button presser (on the update,
    // not the message — the message's `from` is the bot that posted it).
    const from =
      kind === "callback_query"
        ? readRecord(readRecord(update.callback_query)?.from)
        : readRecord(container.from);
    const messageThreadId =
      container.is_topic_message === true ? readTelegramId(container.message_thread_id) : undefined;
    const messageId = container.message_id;
    return {
      chatId,
      fromIsBot: from?.is_bot === true,
      kind,
      ...(typeof messageId === "number" ? { messageId } : {}),
      ...(messageThreadId === undefined ? {} : { messageThreadId }),
    };
  }
  return null;
}

function readTelegramId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && value !== "") return value;
  return undefined;
}
