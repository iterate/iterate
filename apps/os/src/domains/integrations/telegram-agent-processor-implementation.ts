// Implements the "telegram-agent" processor on itx — the Telegram sibling of
// slack-agent-processor-implementation.ts. Emitted event types, payloads, and
// idempotency keys are stable wire formats.
//
// Side-effect policy mirrors the Slack agent processor: the agent-input append
// runs inside `blockProcessorWhile` (a failed append holds the checkpoint and
// replays), and the Telegram-facing "typing…" chat action is best-effort — a
// failed sendChatAction must never wedge the checkpoint (the host dep already
// swallows errors; see agent-durable-object.ts).

import { stringify as stringifyYaml } from "yaml";
import { StreamProcessor } from "../streams/stream-processor.ts";
import { readRecord, readString } from "./utils.ts";
import {
  TelegramAgentProcessorContract,
  type TelegramAgentProcessorState,
} from "./telegram-agent-processor-contract.ts";

export class TelegramAgentProcessor extends StreamProcessor<
  TelegramAgentProcessorContract,
  {
    /** Best-effort UX side effects only (the typing chat action) — the
     * agent's actual REPLY goes through itx.integrations.telegram in its
     * script, which fails loudly on its own. */
    callTelegramApi?(method: string, body: Record<string, unknown>): Promise<void>;
  }
> {
  readonly contract = TelegramAgentProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<
    StreamProcessor<TelegramAgentProcessorContract>["reduce"]
  >[0]): TelegramAgentProcessorState {
    if (event.type !== "events.iterate.com/telegram/webhook-received") return state;
    const target = telegramUpdateTarget(event.payload.body);
    if (target == null) return state;
    return {
      ...state,
      botId: readString(event.payload.botId) ?? state.botId,
      chatId: target.chatId,
      ...(target.messageThreadId === undefined ? {} : { messageThreadId: target.messageThreadId }),
    };
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

        // Human messages and button presses wake the agent; everything else
        // (edits, membership changes, channel posts by anonymous admins, …)
        // is recorded as context without triggering an LLM turn.
        const triggers = target?.kind === "message" || target?.kind === "callback_query";
        blockProcessorWhile(async () => {
          await append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `telegram-agent:webhook-to-agent-input:${event.offset}`,
            payload: {
              content: telegramWebhookAgentInput(event.payload),
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

function telegramWebhookAgentInput(payload: unknown) {
  const lines = [
    "`events.iterate.com/telegram/webhook-received` event received",
    "",
    "```yaml",
    stringifyYaml(payload).trimEnd(),
    "```",
  ];
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
export function telegramMediaPlaceholders(payload: unknown): string[] {
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
  messageThreadId?: string;
};

/** The chat/sender coordinates of one raw update — what the transcription
 * gates and the typing action need. Null when the update carries no chat. */
export function telegramUpdateTarget(body: unknown): TelegramUpdateTarget | null {
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
    return {
      chatId,
      fromIsBot: from?.is_bot === true,
      kind,
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
