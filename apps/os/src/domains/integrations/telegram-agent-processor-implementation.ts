// Implements the "telegram-agent" processor on itx — the Telegram sibling of
// slack-agent-processor-implementation.ts. Emitted event types, payloads, and
// idempotency keys are stable wire formats.
//
// Side-effect policy mirrors the Slack agent processor, with one addition:
// - The agent-input append runs inside `blockProcessorWhile` (a failed append
//   holds the checkpoint and replays).
// - The Telegram-facing "typing…" chat action is best-effort — a failed
//   sendChatAction must never wedge the checkpoint (the host dep already
//   swallows errors; see agent-durable-object.ts).
// - The journaled send (`telegram/send-requested` → Bot API → `message-sent`
//   marker + connection-stream claim) is a DURABLE OBLIGATION: it runs under
//   `blockProcessorWhile` through a dep that throws on failure, so a crash
//   holds the checkpoint and the request is retried until marked. A replayed
//   request first checks the journal for its marker — marked requests never
//   re-send. The accepted caveat: a crash BETWEEN the Bot API call and the
//   marker append re-sends on retry (Telegram's sendMessage has no
//   idempotency key; the journal is exactly-once, the send is at-least-once).

import { stringify as stringifyYaml } from "yaml";
import { StreamProcessor } from "../streams/stream-processor.ts";
import {
  integrationConnectionStreamPath,
  readRecord,
  readString,
  telegramChatIdFromAgentPath,
  telegramConnectionFromAgentPath,
  telegramTopicIdFromAgentPath,
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
};

export class TelegramAgentProcessor extends StreamProcessor<
  TelegramAgentProcessorContract,
  TelegramAgentProcessorDeps
> {
  readonly contract = TelegramAgentProcessorContract;

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

        const newCommand =
          target?.kind === "message"
            ? telegramNewCommand(readRecord(readRecord(event.payload.body)?.message)?.text)
            : null;

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
          await append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `telegram-agent:webhook-to-agent-input:${event.offset}`,
            payload: {
              content: telegramWebhookAgentInput(event.payload, { newCommand }),
              ...(triggers ? {} : { llmRequestPolicy: { behaviour: "dont-trigger-request" } }),
            },
          });
          // After the input committed (never before — the typing indicator
          // must not signal receipt of a message that could still be lost),
          // show "typing…" so the human knows the bot heard them.
          if (triggers && target != null) await this.#sendTyping(target);
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
            await this.stream.at(integrationConnectionStreamPath("telegram", connection)).append({
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
      case "events.iterate.com/agent/llm-request-requested":
      case "events.iterate.com/capability-host/script-execution-requested": {
        // Telegram's typing indicator auto-expires after ~5s; re-sending it on
        // each LLM/tool hop keeps it roughly alive while the agent works.
        const { chatId, messageThreadId } = state;
        if (chatId == null) return;
        blockProcessorWhile(async () => {
          await this.#sendTyping({ chatId, messageThreadId });
        });
        return;
      }
      default:
        return;
    }
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
    const { messageId } = await this.deps.sendTelegramMessage({
      chat_id: coerceTelegramId(input.chatId),
      ...(topicId === null ? {} : { message_thread_id: coerceTelegramId(topicId) }),
      ...(replyTo === undefined ? {} : { reply_to_message_id: replyTo }),
      ...input.event.payload,
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

function telegramWebhookAgentInput(
  payload: unknown,
  options: { newCommand: { trailingText: string | null } | null },
) {
  const lines = [
    "`events.iterate.com/telegram/webhook-received` event received",
    "",
    "```yaml",
    stringifyYaml(payload).trimEnd(),
    "```",
  ];
  if (options.newCommand !== null) {
    lines.push(
      "",
      options.newCommand.trailingText === null
        ? "The user started a fresh thread with /new. This session's transcript starts here; earlier conversation lives in the previous session streams."
        : `The user started a fresh thread with /new — treat the text after /new as their first message in this new conversation: ${JSON.stringify(options.newCommand.trailingText)}`,
    );
  }
  const replyHint = readRecord(readRecord(payload)?.replyHint);
  const replyHintPath = readString(replyHint?.sessionPath);
  if (replyHintPath !== undefined) {
    lines.push(
      "",
      `This message REPLIES to a message from a different thread: ${replyHintPath} (resolved by ${readString(replyHint?.resolvedBy) ?? "unknown"}). You can read that thread for context (await itx.streams.get(${JSON.stringify(replyHintPath)}).getEvents({ limit: 50 })), answer in THAT thread by appending your send request to that stream instead of this one, or simply answer here — your judgement.`,
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
