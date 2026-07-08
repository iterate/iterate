// Implements the "telegram" webhook-router processor on itx — the Telegram
// sibling of slack-processor-implementation.ts. Emitted event types, payloads,
// and idempotency keys are stable wire formats.

import { StreamProcessor } from "../streams/stream-processor.ts";
import { readRecord, telegramChatStreamPath } from "./utils.ts";
import {
  TelegramProcessorContract,
  type TelegramProcessorState,
} from "./telegram-processor-contract.ts";

type TelegramProcessorDeps = {
  /**
   * The named connection this router serves — a projection of the host DO's
   * own name (`/integrations/telegram/{connection}`), not folded state, so it
   * is total from the first webhook and independent of event ordering. Null
   * when the host is not a connection stream — reachable only if a telegram
   * subscription is mis-armed on some other stream, which processEvent treats
   * as a loud error rather than a silent drop (the Slack 2026-06-15 lesson).
   */
  connection: string | null;
};

export class TelegramProcessor extends StreamProcessor<
  TelegramProcessorContract,
  TelegramProcessorDeps
> {
  readonly contract = TelegramProcessorContract;

  protected override reduce({
    state,
  }: Parameters<StreamProcessor<TelegramProcessorContract>["reduce"]>[0]): TelegramProcessorState {
    // Stateless by design: a Telegram update's destination is a pure function
    // of its chat, so there is no routing table to fold.
    return state;
  }

  protected override processEvent({
    blockProcessorWhile,
    event,
  }: Parameters<StreamProcessor<TelegramProcessorContract>["processEvent"]>[0]): undefined {
    if (event.type !== "events.iterate.com/telegram/webhook-received") return;

    if (this.deps.connection === null) {
      // A telegram subscription armed on a non-connection stream is a
      // misconfiguration, not a routable state: throwing holds the checkpoint
      // and keeps the webhook replayable instead of silently dropping the
      // only copy of the message.
      throw new Error(
        "telegram router woke on a stream whose path carries no connection; expected /integrations/telegram/{connection}",
      );
    }

    // The router deliberately does not decide whether an update is meaningful
    // to the agent. Its only job is: which chat does this update belong to?
    // Chat-less updates (inline queries, poll results, …) are dropped — v1
    // handles chat-scoped updates only.
    const target = telegramChatFromUpdate(event.payload.body);
    if (target == null) return;

    const streamPath = telegramChatStreamPath({ ...target, connection: this.deps.connection });

    // Durable obligation, NOT best-effort: this forward is the only copy of
    // the Telegram message on its way to the agent. `blockProcessorWhile`
    // holds the checkpoint on failure so the host replays this webhook until
    // it lands; the idempotency key derives from the source event, so the
    // replay dedupes instead of double-forwarding.
    blockProcessorWhile(async () => {
      await this.stream.at(streamPath).append({
        type: "events.iterate.com/telegram/webhook-received",
        idempotencyKey: `telegram:forward-webhook:${event.offset}`,
        payload: event.payload,
      });
    });
  }
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
