import { stringify as stringifyYaml } from "yaml";
import { isIdempotencyConflict, StreamProcessor } from "iterate/processors";
import type { ConsumedEvent, ProcessEventArgs, ReduceArgs, StreamEvent } from "iterate/processors";
import { DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS } from "../capability-host/capability-host-processor-contract.ts";
import {
  coerceTelegramId,
  integrationConnectionStreamPath,
  readRecord,
  readString,
  webhookAckIsFresh,
} from "./utils.ts";
import { telegramNewCommand } from "./telegram-processor-implementation.ts";
import {
  TelegramAgentProcessorContract,
  type TelegramAgentProcessorState,
} from "./telegram-agent-processor-contract.ts";

/**
 * The "telegram-agent" processor for one routed Telegram agent stream (one
 * chat session) — the Telegram sibling of SlackAgentProcessor. Emitted event
 * types, payloads, and idempotency keys are stable wire formats.
 *
 * HOW IT WORKS, end to end:
 *
 * The upstream `telegram` router has already forwarded this session's raw
 * webhook updates here. This processor owns the Telegram-specific in-chat
 * behavior, three lanes with three deliberately different guarantees:
 *
 * TRANSCRIPTION (per-event, `blockProcessorWhile`): each forwarded
 * `telegram/webhook-received` becomes an `agents/context-added` item — the
 * message's only copy on its way to the agent, so a failed append holds the
 * checkpoint and the frame replays (the idempotency key dedupes the re-run).
 * Bot-authored updates are ignored entirely (answering our own bot's echoes
 * is a feedback loop). Human messages and button presses trigger an LLM turn;
 * edits, membership changes and the like are recorded without one. `/new` is
 * acknowledged with a FIXED processor-level message riding the journaled send
 * pair (not an agent greeting — a bare `/new` wakes no LLM), and `/debug`
 * compiles straight to a capability-host script execution that posts the dump
 * back through the journaled send on this stream (no LLM turn, no context
 * item; mirrors Slack's !debug — the general !<expression> compiler is
 * deliberately NOT ported). Reply hints the router attached are rendered
 * ABOVE the YAML dump with an imperative read-that-thread-first instruction.
 *
 * THE JOURNALED SEND (per-event, `blockProcessorWhile`): consuming
 * `telegram/send-requested` OBLIGES delivery — Bot API sendMessage, then the
 * `telegram/message-sent` marker here plus the provenance claim on the
 * connection stream (the router reduces it so replies to bot messages resolve
 * to their exact thread). A request without a marker is an unmet obligation:
 * a crash holds the checkpoint and the frame replays; a replayed request
 * whose marker already exists skips the re-send (a crash BETWEEN the Bot API
 * call and the marker re-sends — the accepted at-least-once caveat, since
 * sendMessage has no idempotency key; the stream is exactly-once, the send is
 * not). Sends are thread-bound: the stream's chat coordinates always win over
 * payload-supplied ones, and reply_to_message_id defaults to the message this
 * turn is answering exactly when newer messages have arrived since.
 *
 * TYPING (best-effort, freshness-gated): the arrival "typing…" fires inside
 * the transcription blocker AFTER the context item committed (the indicator
 * must not signal receipt of a message that could still be lost), only for
 * FRESH webhooks — a reducer-version replay of months-old messages must not
 * re-type (a rate-limit burst, #1807). The "still working" repaint runs once
 * per at-head pass as a droppable background attempt: per event we only
 * remember the LATEST typing-worthy fact (`agent/llm-request-requested`,
 * `capability-host/script-run-requested`), carried across behind-head frames,
 * and the at-head pass paints it if still fresh. Nothing recovers a dropped
 * repaint — the indicator auto-expires in ~5s and the next lifecycle fact
 * repaints anyway.
 */
export class TelegramAgentProcessor extends StreamProcessor<
  TelegramAgentProcessorContract,
  TelegramAgentProcessorDeps
> {
  readonly contract = TelegramAgentProcessorContract;

  /** A typing-worthy lifecycle fact seen in a batch that was NOT at head, so
   * the next at-head pass repaints it (mirrors slack-agent's status carry).
   * In-memory: dies with the incarnation, and that is fine — typing is
   * cosmetic. */
  #unpaintedTypingFact: StreamEvent | undefined;

  // ------------------------------------------------------------ processEvent
  // Lanes, chosen here at the dispatch site: the transcription and the
  // journaled send are per-event consequences (the event is delivered once —
  // a lost append loses the message or the reply forever), so they block; the
  // at-head typing repaint is a freshness-gated cosmetic ack whose dropped
  // attempt nothing needs to recover, so it rides `runInBackground`.
  protected override processEvent(
    args: ProcessEventArgs<TelegramAgentProcessorContract>,
  ): undefined {
    const { append, appendTo, blockProcessorWhile, delivery, event, runInBackground, state } = args;
    if (!state.birthCertificate) return;
    const { chatId, connection, messageThreadId } = state.birthCertificate.config;
    switch (event?.type) {
      case "events.iterate.com/telegram/webhook-received": {
        const target = telegramUpdateTarget(event.payload.body);
        // Never react to bot-authored updates — our own bot's messages come
        // back through the webhook, and answering them is a feedback loop.
        if (target?.fromIsBot === true) break;
        const messageText = readRecord(readRecord(event.payload.body)?.message)?.text;
        if (target?.kind === "message" && isTelegramDebugCommand(messageText)) {
          blockProcessorWhile(() => this.#requestDebugScript({ append, event }));
          break;
        }
        const newCommand = target?.kind === "message" ? telegramNewCommand(messageText) : null;
        // Human messages and button presses wake the agent; everything else
        // (edits, membership changes, channel posts by anonymous admins, …)
        // is recorded as context without triggering an LLM turn. A bare /new
        // does not wake the agent either — its acknowledgement is the fixed
        // processor-level message, not an agent greeting.
        const triggers = newCommand
          ? !!newCommand.trailingText
          : target?.kind === "message" || target?.kind === "callback_query";
        blockProcessorWhile(() =>
          this.#transcribeWebhook({ append, connection, event, newCommand, target, triggers }),
        );
        break;
      }
      case "events.iterate.com/telegram/send-requested": {
        blockProcessorWhile(() =>
          this.#satisfySendObligation({
            answeringMessageId: state.answeringMessageId,
            append,
            appendTo,
            chatId,
            connection,
            event,
            latestInboundMessageId: state.latestInboundMessageId,
            messageThreadId,
          }),
        );
        break;
      }
      case "events.iterate.com/agent/llm-request-requested":
      case "events.iterate.com/capability-host/script-run-requested":
        // "The agent is working now" — remembered, not painted: the repaint
        // runs once per at-head pass (below), never per event, so a replay
        // of history cannot re-run every historical flip and behind-head
        // frames carry the fact instead of painting stale. Latest wins — an
        // earlier unpainted fact is already stale.
        this.#unpaintedTypingFact = event;
        break;
      // telegram-agent/created matters through reduce only.
    }
    // The at-head typing repaint: after the per-event switch (so a
    // typing-worthy head event has already landed in the memo), once per
    // at-head pass. A droppable attempt — a lost repaint costs ~5s of
    // indicator, and the next lifecycle fact repaints anyway.
    if (delivery.caughtUp) {
      runInBackground(() => this.#repaintTypingAtHead(state));
    }
  }

  /**
   * Compile `/debug` straight to a capability-host script execution — no LLM
   * turn, no agent context item. The script posts the debug dump back through
   * the journaled send pair on THIS session stream, so it lands in the right
   * thread with provenance like the /new ack.
   */
  async #requestDebugScript(input: {
    append: ProcessEventArgs<TelegramAgentProcessorContract>["append"];
    event: ConsumedEvent<TelegramAgentProcessorContract>;
  }): Promise<void> {
    const { append, event } = input;
    // Deterministic body: expiresAt anchors to the webhook's createdAt,
    // never to `now` — an at-least-once redelivery re-appends the identical
    // request and dedupes on the key (a now-stamped expiry would make the
    // re-append a same-key CONFLICT and wedge the frame forever). The
    // race-tolerant append additionally covers replays over streams whose
    // committed request predates this anchoring.
    await this.#appendUnlessLostIdempotencyRace(append, {
      type: "events.iterate.com/capability-host/script-run-requested",
      idempotencyKey: `telegram-agent:debug-command:${event.offset}`,
      payload: {
        code: compileTelegramDebugScript(this.path),
        executionId: `telegram-debug-command-${event.offset}`,
        expiresAt: Date.parse(event.createdAt) + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS,
      },
    });
  }

  /**
   * Transcribe one forwarded webhook into agent context (plus the fixed `/new`
   * acknowledgement), then — only after the input committed — the freshness-
   * gated arrival "typing…".
   */
  async #transcribeWebhook(input: {
    append: ProcessEventArgs<TelegramAgentProcessorContract>["append"];
    connection: string;
    event: Extract<
      ConsumedEvent<TelegramAgentProcessorContract>,
      { type: "events.iterate.com/telegram/webhook-received" }
    >;
    newCommand: { trailingText: string | null } | null;
    target: TelegramUpdateTarget | null;
    triggers: boolean;
  }): Promise<void> {
    const { append, connection, event, newCommand, target, triggers } = input;
    if (newCommand) {
      // The fixed acknowledgement rides the journaled send pair, so it is
      // delivered with the same obligation semantics as any reply — and
      // lands in the chat before the agent's answer to any trailing text
      // (its request precedes the triggering input).
      await append({
        type: "events.iterate.com/telegram/send-requested",
        idempotencyKey: `telegram-agent:new-session-ack:${event.offset}`,
        payload: { text: TELEGRAM_NEW_SESSION_ACK_TEXT },
      });
    }
    // Telegram's normalized content is application-supplied developer
    // context; actor and refs preserve the untrusted sender and source. The
    // sender's location depends on the update kind: messages carry
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
          ...((typeof senderId === "number" || typeof senderId === "string") && {
            userId: String(senderId),
          }),
          ...(!senderUsername ? {} : { username: senderUsername }),
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
    // After the input committed (never before — the typing indicator must
    // not signal receipt of a message that could still be lost), show
    // "typing…" so the human knows the bot heard them. Freshness-gated: a
    // replay must not re-type on historical messages.
    if (triggers && target && webhookAckIsFresh(event, (this.deps.now ?? Date.now)())) {
      await this.#sendTyping(connection, target);
    }
  }

  /** The send obligation: deliver one send-requested to the Bot API, then
   * mark it here and claim it on the connection stream. */
  async #satisfySendObligation(input: {
    answeringMessageId: number | undefined;
    append: ProcessEventArgs<TelegramAgentProcessorContract>["append"];
    appendTo: ProcessEventArgs<TelegramAgentProcessorContract>["appendTo"];
    chatId: string;
    connection: string;
    event: Extract<
      ConsumedEvent<TelegramAgentProcessorContract>,
      { type: "events.iterate.com/telegram/send-requested" }
    >;
    latestInboundMessageId: number | undefined;
    messageThreadId: string | undefined;
  }): Promise<void> {
    const { append, appendTo, chatId, connection, event } = input;
    const sessionPath = this.path;

    // Replay safety: a marker for this request means the send already
    // happened — never re-send a satisfied obligation. (A crash BEFORE the
    // marker re-sends; that is the accepted at-least-once caveat.)
    const existingMarker = await this.#findSentMarker(event.offset);
    const messageId = existingMarker?.messageId ?? (await this.#deliver(input));

    await append({
      type: "events.iterate.com/telegram/message-sent",
      idempotencyKey: `telegram-agent:message-sent:${event.offset}`,
      payload: { messageId, requestOffset: event.offset },
    });
    // The provenance claim on the CONNECTION stream: the router reduces
    // message_id → sessionPath from it, making reply hints exact for bot
    // messages. Idempotency-keyed, so a crash between marker and claim
    // replays into a single claim.
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

  /**
   * The at-head typing repaint. The "still working" typing indicator
   * auto-expires after ~5s; one repaint per at-head pass keeps it roughly
   * alive while the agent works, painted from the latest typing-worthy fact
   * seen since the last pass ("once at head, latest wins" — behind-head
   * frames only accumulate the memo). The memo is read and cleared FIRST,
   * unconditionally: a stale fact must not survive into the next pass just
   * because this one skipped painting.
   */
  async #repaintTypingAtHead(state: TelegramAgentProcessorState): Promise<void> {
    const latest = this.#unpaintedTypingFact;
    this.#unpaintedTypingFact = undefined;
    if (!latest || !webhookAckIsFresh(latest, (this.deps.now ?? Date.now)())) return;
    if (!state.birthCertificate) return;
    const { chatId, messageThreadId } = state;
    if (!chatId) return;
    await this.#sendTyping(state.birthCertificate.config.connection, {
      chatId,
      messageThreadId,
    });
  }

  /** Deliver one send-requested to the Bot API; returns Telegram's message_id. */
  async #deliver(input: {
    answeringMessageId: number | undefined;
    chatId: string;
    connection: string;
    event: { offset: number; payload: Record<string, unknown> };
    latestInboundMessageId: number | undefined;
    messageThreadId: string | undefined;
  }): Promise<number> {
    if (!this.deps.sendTelegramMessage) {
      // Loud, not skipped: a send obligation with no delivery dep is a
      // misconfiguration; dropping it would silently eat the reply.
      throw new Error(
        "telegram-agent has no sendTelegramMessage dep; cannot satisfy send-requested",
      );
    }
    // The deterministic reply_to_message_id rule (unless the request already
    // chose one): quote the message this turn is answering ONLY when newer
    // messages have arrived since — quoting the latest message is noise,
    // quoting a stale one disambiguates.
    const { answeringMessageId, latestInboundMessageId } = input;
    const replyTo = input.event.payload.reply_to_message_id
      ? undefined
      : Number.isFinite(answeringMessageId) && answeringMessageId !== latestInboundMessageId
        ? answeringMessageId
        : undefined;
    // Journaled sends are THREAD-BOUND: the stream's identity always wins over
    // payload-supplied chat_id/message_thread_id. Not a capability boundary
    // (the raw itx.integrations.telegram sendMessage can post anywhere) — a
    // provenance one: the message-sent claim records THIS stream as the
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
      body: {
        ...(!Number.isFinite(replyTo) ? {} : { reply_to_message_id: replyTo }),
        ...payloadRest,
        chat_id: coerceTelegramId(input.chatId),
        ...(!input.messageThreadId
          ? {}
          : { message_thread_id: coerceTelegramId(input.messageThreadId) }),
      },
      connection: input.connection,
    });
    return messageId;
  }

  /** The message-sent marker satisfying the send-requested at `requestOffset`,
   * read from the stream (markers land AFTER their request, so reduced state
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

  async #sendTyping(connection: string, target: { chatId: string; messageThreadId?: string }) {
    if (!this.deps.callTelegramApi) return;
    await this.deps.callTelegramApi({
      body: {
        action: "typing",
        chat_id: coerceTelegramId(target.chatId),
        ...(!target.messageThreadId
          ? {}
          : { message_thread_id: coerceTelegramId(target.messageThreadId) }),
      },
      connection,
      method: "sendChatAction",
    });
  }

  /**
   * Append tolerating a lost idempotency race: the stream rejects a same-key
   * append with a different body, and losing that race is success — the
   * consequence is already committed under the key (here: a legacy /debug
   * request whose committed expiry was stamped with delivery-time `now`
   * before it was anchored to the webhook's createdAt).
   */
  async #appendUnlessLostIdempotencyRace(
    append: ProcessEventArgs<TelegramAgentProcessorContract>["append"],
    ...events: Parameters<ProcessEventArgs<TelegramAgentProcessorContract>["append"]>
  ): Promise<void> {
    try {
      await append(...events);
    } catch (error) {
      if (!isIdempotencyConflict(error)) throw error;
    }
  }

  // ------------------------------------------------------------------ reduce
  protected override reduce(
    args: ReduceArgs<TelegramAgentProcessorContract>,
  ): TelegramAgentProcessorState {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/telegram-agent/created":
        if (state.birthCertificate) return state;
        return {
          ...state,
          birthCertificate: event.payload,
          chatId: event.payload.config.chatId,
          ...(!event.payload.config.messageThreadId
            ? {}
            : { messageThreadId: event.payload.config.messageThreadId }),
        };
      case "events.iterate.com/telegram/webhook-received": {
        const target = telegramUpdateTarget(event.payload.body);
        if (!target) return state;
        return {
          ...state,
          botId: readString(event.payload.botId) ?? state.botId,
          chatId: target.chatId,
          ...(!target.messageThreadId ? {} : { messageThreadId: target.messageThreadId }),
          // Half of the deterministic reply_to_message_id rule: the newest
          // human message on this session.
          ...(target.kind === "message" &&
            !target.fromIsBot &&
            Number.isFinite(target.messageId) && { latestInboundMessageId: target.messageId }),
        };
      }
      case "events.iterate.com/agent/llm-request-requested":
        // The other half: snapshot which message this LLM turn is answering.
        return !Number.isFinite(state.latestInboundMessageId)
          ? state
          : { ...state, answeringMessageId: state.latestInboundMessageId };
      default:
        return state;
    }
  }
}

// -----------------------------------------------------------------------------
// Injected dependencies.
// -----------------------------------------------------------------------------

type TelegramAgentProcessorDeps = {
  /** Best-effort UX side effects only (the typing chat action) — failures are
   * swallowed by the host dep and must never wedge the checkpoint. */
  callTelegramApi?(input: {
    body: Record<string, unknown>;
    connection: string;
    method: string;
  }): Promise<void>;
  /** The journaled send effect: deliver one sendMessage body and return
   * Telegram's message_id. MUST throw on failure — the send obligation relies
   * on the thrown error holding the checkpoint for retry. */
  sendTelegramMessage?(input: {
    body: Record<string, unknown>;
    connection: string;
  }): Promise<{ messageId: number }>;
  /** Injectable clock for the ack freshness gates (defaults to Date.now). */
  now?: () => number;
};

// -----------------------------------------------------------------------------
// Pure helpers.
// -----------------------------------------------------------------------------

/** The fixed `/new` acknowledgement — a processor-level message, deliberately
 * not an agent greeting (no LLM turn for a bare `/new`). */
export const TELEGRAM_NEW_SESSION_ACK_TEXT = "Started a fresh thread.";

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
  if (replyHintPath) {
    lines.push(
      "",
      // The taught read is FILTERED to the two conversation event types — an
      // unfiltered getEvents returns the OLDEST raw events (connection and LLM
      // plumbing), which is how a live agent failed to recover a thread.
      `IMPORTANT: this message REPLIES to a message from a different thread: ${replyHintPath} (resolved by ${readString(replyHint?.resolvedBy) ?? "unknown"}). Before answering — and before any other exploration — read that thread's transcript: await itx.streams.get(${JSON.stringify(replyHintPath)}).getEvents({ eventTypes: ["events.iterate.com/telegram/webhook-received", "events.iterate.com/telegram/send-requested"] }) (user text is in payload.body.message.text, your earlier replies in payload.text; if exactly 500 events come back, repeat with afterOffset: events.at(-1).offset to reach the recent end). Then answer in THAT thread by appending your send request to that stream instead of this one, or answer here — your judgement, but only after reading it.`,
    );
  }
  lines.push("", "```yaml", stringifyYaml(payload).trimEnd(), "```");
  if (options.newCommand) {
    lines.push(
      "",
      !options.newCommand.trailingText
        ? "The user started a fresh thread with /new. This session's transcript starts here; earlier conversation lives in the previous session streams."
        : `The user started a fresh thread with /new — treat the text after /new as their first message in this new conversation: ${JSON.stringify(options.newCommand.trailingText)}`,
    );
  }
  const placeholders = telegramMediaPlaceholders(payload);
  if (placeholders.length > 0) {
    lines.push(
      "",
      `Media in this message (file_id is in the raw payload): ${placeholders.join(" ")}`,
    );
  }
  return lines.join("\n");
}

/** Bracketed hints for the media a message carries; the raw payload retains
 * the file ids the agent can download through token-safe project egress. */
function telegramMediaPlaceholders(payload: unknown): string[] {
  const update = readRecord(readRecord(payload)?.body);
  const message =
    readRecord(update?.message) ??
    readRecord(update?.edited_message) ??
    readRecord(update?.channel_post);
  if (!message) return [];
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
  return mediaKinds.filter(([key]) => !!message[key]).map(([, placeholder]) => placeholder);
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
  if (!update) return null;
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
    if (!container || !chatId) continue;
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
      ...(typeof messageId === "number" && { messageId }),
      ...(!messageThreadId ? {} : { messageThreadId }),
    };
  }
  return null;
}

function readTelegramId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && value !== "") return value;
  return undefined;
}
