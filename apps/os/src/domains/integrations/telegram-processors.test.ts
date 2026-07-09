// The Telegram router + agent processor pair, mirrored from
// slack-processors.test.ts: an in-memory stream network, real processors, no
// module mocks. Helpers live at the bottom of the file.

import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "../streams/schemas.ts";
import type { Stream } from "../../itx-api.generated.ts";
import { telegramAgentSystemPrompt } from "../agents/agent-defaults.ts";
import { TelegramProcessor } from "./telegram-processor-implementation.ts";
import {
  TELEGRAM_NEW_SESSION_ACK_TEXT,
  TelegramAgentProcessor,
} from "./telegram-agent-processor-implementation.ts";

const BOT_ID = "7000001";
const CONNECTION = "mishas-helper-bot";
const CHAT_ID = 42424242;

describe("TelegramProcessor (webhook router)", () => {
  it("forwards a private-chat message to the chat's agent stream, verbatim", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get(`/integrations/telegram/${CONNECTION}`);
    const processor = new TelegramProcessor({ stream, connection: CONNECTION });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });

    const routed = network.eventsAt(`/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`);
    expect(routed.map((event) => event.type)).toEqual([
      "events.iterate.com/telegram/webhook-received",
    ]);
    expect(routed[0]!.payload).toEqual(humanMessageWebhookPayload({}));
  });

  it("routes forum-topic messages to a per-topic stream, negative group ids verbatim", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get(`/integrations/telegram/${CONNECTION}`);
    const processor = new TelegramProcessor({ stream, connection: CONNECTION });
    const cursors = new Map<object, number>();

    const payload = humanMessageWebhookPayload({ chatId: -1004242, chatType: "supergroup" });
    const message = payload.body.message as Record<string, unknown>;
    message.is_topic_message = true;
    message.message_thread_id = 77;
    await stream.append({ type: "events.iterate.com/telegram/webhook-received", payload });
    await deliverNewEvents({ cursors, processor, stream });

    // The sign is significant (chat 1004242 and supergroup -1004242 must not
    // collide), so the id is used verbatim, minus and all.
    expect(network.eventsAt(`/agents/telegram/${CONNECTION}/chat--1004242/topic-77`)).toHaveLength(
      1,
    );
  });

  it("drops chat-less updates (inline queries) without creating any stream", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get(`/integrations/telegram/${CONNECTION}`);
    const processor = new TelegramProcessor({ stream, connection: CONNECTION });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: {
        botId: BOT_ID,
        body: {
          update_id: 5,
          inline_query: { id: "q1", from: { id: 7, is_bot: false }, query: "cats" },
        },
      },
    });
    await deliverNewEvents({ cursors, processor, stream });

    expect(network.streams.size).toBe(1); // nothing forwarded anywhere
  });

  it("ignores connected/disconnected lifecycle facts (status is a journal fold, not router state)", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get(`/integrations/telegram/${CONNECTION}`);
    const processor = new TelegramProcessor({ stream, connection: CONNECTION });
    const cursors = new Map<object, number>();

    await stream.append(
      {
        type: "events.iterate.com/telegram/connected",
        payload: { botId: BOT_ID, connection: CONNECTION, projectId: "prj_1" },
      },
      {
        type: "events.iterate.com/telegram/disconnected",
        payload: { botId: BOT_ID, projectId: "prj_1" },
      },
    );
    await deliverNewEvents({ cursors, processor, stream });
    expect(processor.state).toEqual({ sessionsByChat: {}, sentMessages: {} });
    expect(network.streams.size).toBe(1);
  });

  it("errors loudly instead of routing when the host stream carries no connection", async () => {
    const network = new MemoryStreamNetwork();
    // A mis-armed subscription: telegram router woken on a non-connection path.
    const stream = network.get("/integrations/telegram");
    const processor = new TelegramProcessor({ stream, connection: null });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    // Throwing (not dropping) holds the checkpoint so the webhook stays
    // replayable — the Slack 2026-06-15 outage shape.
    await expect(deliverNewEvents({ cursors, processor, stream })).rejects.toThrow(/no connection/);
    expect(network.streams.size).toBe(1);
  });

  it("replays the webhook when the forward append fails instead of dropping it", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get(`/integrations/telegram/${CONNECTION}`);
    const routed = network.get(`/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`);
    const originalRoutedAppend = routed.append.bind(routed);
    let failNextForward = true;
    routed.append = async (...inputs: StreamEventInput[]) => {
      if (failNextForward) {
        failNextForward = false;
        throw new Error("cold StreamsCapability RPC failed");
      }
      return originalRoutedAppend(...inputs);
    };
    const processor = new TelegramProcessor({ stream, connection: CONNECTION });
    const [webhook] = await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });

    // First delivery: the forward throws. ingest MUST reject and the
    // checkpoint MUST hold — otherwise the message is gone for good.
    await expect(processor.ingest({ events: [webhook!], streamMaxOffset: 1 })).rejects.toThrow(
      /StreamsCapability/,
    );
    expect(processor.checkpointOffset).toBe(0);
    expect(routed.events).toHaveLength(0);

    // The host replays the same webhook from the un-advanced checkpoint; the
    // forward now succeeds and the checkpoint advances.
    await processor.ingest({ events: [webhook!], streamMaxOffset: 1 });
    expect(processor.checkpointOffset).toBe(1);
    expect(routed.events).toHaveLength(1);

    // A second replay dedupes on the forward's idempotency key.
    await processor.ingest({ events: [webhook!], streamMaxOffset: 1 });
    expect(routed.events).toHaveLength(1);
  });

  it("/new rotates the chat to a fresh session stream; /new itself routes into it", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get(`/integrations/telegram/${CONNECTION}`);
    const processor = new TelegramProcessor({ stream, connection: CONNECTION });
    const cursors = new Map<object, number>();
    const sessionZero = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`;

    await stream.append(
      // Pre-/new history is session zero: the bare chat path, exactly v1.
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({ date: 1000, messageId: 1, text: "old world" }),
      },
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({ date: 2000, messageId: 2, text: "/new" }),
      },
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({ date: 2500, messageId: 3, text: "new world" }),
      },
    );
    await deliverNewEvents({ cursors, processor, stream });

    expect(network.eventsAt(sessionZero)).toHaveLength(1);
    // The /new message AND everything after it land in the session stream.
    const session = network.eventsAt(`${sessionZero}/session-2000`);
    expect(session).toHaveLength(2);
    expect(session.map((event) => (event.payload as { body: any }).body.message.text)).toEqual([
      "/new",
      "new world",
    ]);
  });

  it("orders same-second /new pairs by message_id and never rolls the session backwards", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get(`/integrations/telegram/${CONNECTION}`);
    const processor = new TelegramProcessor({ stream, connection: CONNECTION });
    const cursors = new Map<object, number>();

    await stream.append(
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({ date: 3000, messageId: 10, text: "/new" }),
      },
      // Same unix second, higher message_id: the tie-break keeps this one as
      // the live session start (same path — date-named).
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({ date: 3000, messageId: 11, text: "/new again" }),
      },
    );
    await deliverNewEvents({ cursors, processor, stream });
    expect(processor.state.sessionsByChat[`chat-${CHAT_ID}`]).toMatchObject([
      { date: 3000, messageId: 10 },
      { date: 3000, messageId: 11 },
    ]);

    // A duplicate/out-of-order replay of the earlier /new must not win.
    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({
        date: 3000,
        messageId: 10,
        text: "/new",
        updateId: 42,
      }),
    });
    await deliverNewEvents({ cursors, processor, stream });
    expect(processor.state.sessionsByChat[`chat-${CHAT_ID}`]!.at(-1)).toMatchObject({
      messageId: 11,
    });
  });

  it("group-chat /new@BotName and trailing text both rotate the session", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get(`/integrations/telegram/${CONNECTION}`);
    const processor = new TelegramProcessor({ stream, connection: CONNECTION });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({
        date: 4000,
        messageId: 20,
        text: "/new@MishasHelperBot let's plan a trip",
      }),
    });
    await deliverNewEvents({ cursors, processor, stream });
    expect(
      network.eventsAt(`/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-4000`),
    ).toHaveLength(1);
  });

  it("annotates replies to bot messages with the EXACT thread from the sent claim", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get(`/integrations/telegram/${CONNECTION}`);
    const processor = new TelegramProcessor({ stream, connection: CONNECTION });
    const cursors = new Map<object, number>();
    const oldSession = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-1000`;

    await stream.append(
      // The telegram-agent send effect cross-posts this claim after each
      // journaled send: bot message 500 came from the session-1000 thread.
      {
        type: "events.iterate.com/telegram/message-sent",
        payload: {
          chatId: String(CHAT_ID),
          messageId: 500,
          request: { offset: 3, stream: oldSession },
          sessionPath: oldSession,
        },
      },
      // A /new later rotated the chat…
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({ date: 5000, messageId: 30, text: "/new" }),
      },
      // …and now the human replies to the OLD bot message.
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({
          date: 6000,
          messageId: 31,
          replyToMessage: {
            message_id: 500,
            from: { id: 999, is_bot: true, first_name: "iterate" },
            date: 900,
            text: "Here's that report",
          },
          text: "actually, one more question about this",
        }),
      },
    );
    await deliverNewEvents({ cursors, processor, stream });

    // Routing is untouched (latest session); the hint names the old thread.
    const session = network.eventsAt(`/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-5000`);
    expect(session).toHaveLength(2);
    expect(session[1]!.payload).toMatchObject({
      replyHint: { resolvedBy: "sent-claim", sessionPath: oldSession },
    });
  });

  it("falls back to the reply date for user messages: containing session, or session zero when older than the first /new", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get(`/integrations/telegram/${CONNECTION}`);
    const processor = new TelegramProcessor({ stream, connection: CONNECTION });
    const cursors = new Map<object, number>();
    const chatPath = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`;

    const userMessage = (messageId: number, date: number) => ({
      message_id: messageId,
      from: { id: 555, is_bot: false, first_name: "Misha" },
      date,
      text: `message ${messageId}`,
    });
    await stream.append(
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({ date: 1000, messageId: 40, text: "/new" }),
      },
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({ date: 2000, messageId: 42, text: "/new" }),
      },
      // Reply to a user message dated INSIDE the first session (1000..2000).
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({
          date: 3000,
          messageId: 43,
          replyToMessage: userMessage(41, 1500),
          text: "re: that",
        }),
      },
      // Reply to a user message OLDER than the first /new → session zero.
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({
          date: 3001,
          messageId: 44,
          replyToMessage: userMessage(39, 500),
          text: "re: ancient",
        }),
      },
      // Reply to a message in the CURRENT session → no hint (it would be noise).
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({
          date: 3002,
          messageId: 45,
          replyToMessage: userMessage(43, 3000),
          text: "re: current",
        }),
      },
    );
    await deliverNewEvents({ cursors, processor, stream });

    const latestSession = network.eventsAt(`${chatPath}/session-2000`);
    const [, replyInside, replyAncient, replyCurrent] = latestSession;
    expect(replyInside!.payload).toMatchObject({
      replyHint: { resolvedBy: "reply-date", sessionPath: `${chatPath}/session-1000` },
    });
    expect(replyAncient!.payload).toMatchObject({
      replyHint: { resolvedBy: "reply-date", sessionPath: chatPath },
    });
    expect(replyCurrent!.payload).not.toHaveProperty("replyHint");
  });
});

describe("TelegramAgentProcessor", () => {
  it("turns a routed human message into triggering agent input, then shows typing", async () => {
    const { calls, cursors, processor, stream, telegramCalls } = setup();

    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({ text: "hello agent" }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(inputs).toHaveLength(1);
    const payload = inputs[0]!.payload as { content: string; llmRequestPolicy?: unknown };
    expect(payload.content).toContain("telegram/webhook-received");
    expect(payload.content).toContain("hello agent");
    // The contract default (triggering) policy applies.
    expect(payload.llmRequestPolicy).toEqual({ behaviour: "after-current-request" });

    // The typing action fired for the chat, AFTER the input committed.
    expect(telegramCalls).toEqual([
      { method: "sendChatAction", body: { action: "typing", chat_id: CHAT_ID } },
    ]);
    expect(calls).toEqual([
      "append:events.iterate.com/telegram/webhook-received", // the test's own seed
      "append:events.iterate.com/agent/input-added",
      "telegram:sendChatAction",
    ]);

    expect(processor.state).toMatchObject({ botId: BOT_ID, chatId: String(CHAT_ID) });
  });

  it("ignores bot-authored updates entirely (no input, no typing)", async () => {
    const { cursors, processor, stream, telegramCalls } = setup();

    const payload = humanMessageWebhookPayload({});
    (payload.body.message as Record<string, unknown>).from = {
      id: 999,
      is_bot: true,
      first_name: "iterate",
    };
    await stream.append({ type: "events.iterate.com/telegram/webhook-received", payload });
    await deliverNewEvents({ cursors, processor, stream });

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agent/input-added"),
    ).toHaveLength(0);
    expect(telegramCalls).toHaveLength(0);
  });

  it("records message edits as non-triggering input without typing", async () => {
    const { cursors, processor, stream, telegramCalls } = setup();

    const payload = humanMessageWebhookPayload({ text: "edited!" });
    const body = payload.body as Record<string, unknown>;
    body.edited_message = body.message;
    delete body.message;
    await stream.append({ type: "events.iterate.com/telegram/webhook-received", payload });
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
    expect(telegramCalls).toHaveLength(0);
  });

  it("treats callback queries (button presses) as triggering input from the presser", async () => {
    const { cursors, processor, stream } = setup();

    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: {
        botId: BOT_ID,
        body: {
          update_id: 6,
          callback_query: {
            id: "cbq1",
            from: { id: 7, is_bot: false, first_name: "Misha" },
            data: "approve",
            // The embedded message was posted by OUR bot — is_bot on it must
            // not suppress the human's button press.
            message: {
              message_id: 2,
              from: { id: 999, is_bot: true },
              chat: { id: CHAT_ID, type: "private" },
              text: "Approve?",
            },
          },
        },
      },
    });
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(inputs).toHaveLength(1);
    const payload = inputs[0]!.payload as { content: string; llmRequestPolicy?: unknown };
    expect(payload.content).toContain("approve");
    expect(payload.llmRequestPolicy).toEqual({ behaviour: "after-current-request" });
  });

  it("transcribes media as bracketed placeholders", async () => {
    const { cursors, processor, stream } = setup();

    const payload = humanMessageWebhookPayload({});
    const message = payload.body.message as Record<string, unknown>;
    delete message.text;
    message.photo = [{ file_id: "photo-1", width: 90, height: 90 }];
    message.caption = "look at this";
    await stream.append({ type: "events.iterate.com/telegram/webhook-received", payload });
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(inputs).toHaveLength(1);
    expect((inputs[0]!.payload as { content: string }).content).toContain("[photo]");
  });

  it("re-sends the typing action while the LLM works, with the chat id from state", async () => {
    const { cursors, processor, stream, telegramCalls } = setup();

    // Establish chat context first.
    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });
    telegramCalls.length = 0;

    await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", provider: "openai-ws", requestId: "llm-request:1" },
    });
    await deliverNewEvents({ cursors, processor, stream });
    // chat_id goes back as the integer Telegram issued.
    expect(telegramCalls).toEqual([
      { method: "sendChatAction", body: { action: "typing", chat_id: CHAT_ID } },
    ]);
  });

  it("never sends typing before any webhook established the chat", async () => {
    const { cursors, processor, stream, telegramCalls } = setup();

    await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", provider: "openai-ws", requestId: "llm-request:1" },
    });
    await deliverNewEvents({ cursors, processor, stream });
    expect(telegramCalls).toHaveLength(0);
  });

  it("refold safety (#1807): a full replay re-transcribes and re-sends but never re-types stale messages", async () => {
    // A state-schema deploy discards the checkpoint and refolds the WHOLE
    // journal. The durable lanes (agent input, the journaled send) must
    // re-run/dedupe, but the user-visible typing acks are stale — re-typing
    // months-old messages is a rate-limit burst. `now` far in the future
    // makes every event's ~epoch timestamp stale.
    const { cursors, processor, stream, telegramCalls, sentMessages } = setup({
      now: () => 999_999_999_999,
    });

    await stream.append(
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({ text: "hello from the past" }),
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "gpt-test", provider: "openai-ws", requestId: "llm-request:1" },
      },
      { type: "events.iterate.com/telegram/send-requested", payload: { text: "an old reply" } },
    );
    await deliverNewEvents({ cursors, processor, stream });

    // Durable lanes ran: the message reached the agent, and the reply was
    // delivered (its journal marker is absent on this first pass).
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agent/input-added"),
    ).toHaveLength(1);
    expect(sentMessages).toEqual([{ chat_id: CHAT_ID, text: "an old reply" }]);
    // But NO typing ack (arrival OR "still working") on a stale replay.
    expect(telegramCalls.filter((call) => call.method === "sendChatAction")).toHaveLength(0);
  });

  it("carries an unpainted typing fact across a non-at-head batch to the next at-head one", async () => {
    const { cursors, processor, stream, telegramCalls } = setup();
    // Establish the chat.
    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });
    telegramCalls.length = 0;

    const [llm] = await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", provider: "openai-ws", requestId: "llm-request:1" },
    });
    // Deliver the lifecycle fact while the batch is BEHIND head (a lagging
    // fold): no repaint yet, the fact is remembered.
    await processor.ingest({ events: [llm!], streamMaxOffset: stream.events.length + 5 });
    expect(telegramCalls).toHaveLength(0);

    // The fold catches up: the next batch reaches head (its own event is an
    // unconsumed stream fact, so the carried lifecycle fact is what paints).
    const [woken] = await stream.append({
      type: "events.iterate.com/stream/woken",
      payload: { reason: "catch-up" },
    });
    await processor.ingest({ events: [woken!], streamMaxOffset: stream.events.length });
    expect(telegramCalls).toEqual([
      { method: "sendChatAction", body: { action: "typing", chat_id: CHAT_ID } },
    ]);
  });

  it("delivers a send-requested, marks it, and claims the message on the connection stream", async () => {
    const agentPath = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-5000`;
    const { cursors, network, processor, sentMessages, stream } = setup({ agentPath });

    const [request] = await stream.append({
      type: "events.iterate.com/telegram/send-requested",
      payload: { text: "hello from the agent" },
    });
    await deliverNewEvents({ cursors, processor, stream });

    // chat_id came from the stream path — the agent only supplied text.
    expect(sentMessages).toEqual([{ chat_id: CHAT_ID, text: "hello from the agent" }]);

    // The marker satisfies the obligation on the session stream…
    const markers = stream.events.filter(
      (event) => event.type === "events.iterate.com/telegram/message-sent",
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]!.payload).toEqual({ messageId: 9001, requestOffset: request!.offset });

    // …and the claim on the connection stream gives the router provenance.
    const claims = network.eventsAt(`/integrations/telegram/${CONNECTION}`);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.payload).toEqual({
      chatId: String(CHAT_ID),
      messageId: 9001,
      request: { offset: request!.offset, stream: agentPath },
      sessionPath: agentPath,
    });
  });

  it("holds the checkpoint when delivery fails, then retries into exactly one marker", async () => {
    const { cursors, processor, sendFailures, sentMessages, stream } = setup();
    sendFailures.push(new Error("telegram is down"));

    const [request] = await stream.append({
      type: "events.iterate.com/telegram/send-requested",
      payload: { text: "must arrive" },
    });

    // Unmet obligation: the batch rejects and the checkpoint holds, so the
    // host replays this request until a marker exists.
    await expect(deliverNewEvents({ cursors, processor, stream })).rejects.toThrow(
      /telegram is down/,
    );
    expect(processor.checkpointOffset).toBe(0);
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/telegram/message-sent"),
    ).toHaveLength(0);

    // Replay: the send goes through this time — one send, one marker.
    await processor.ingest({ events: [request!], streamMaxOffset: stream.events.length });
    expect(sentMessages).toHaveLength(1);
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/telegram/message-sent"),
    ).toHaveLength(1);
  });

  it("forces the stream's chat over a payload-supplied chat_id/message_thread_id (thread-bound sends)", async () => {
    const agentPath = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`;
    const { cursors, network, processor, sentMessages, stream } = setup({ agentPath });

    await stream.append({
      type: "events.iterate.com/telegram/send-requested",
      // A confused (or mischievous) agent aims the journaled send at another
      // chat. Not a capability boundary — raw sendMessage can post anywhere —
      // but the claim below records THIS stream as the message's thread, so
      // the delivery must actually go here: path identity wins, payload's
      // chat coordinates are ignored (reply_to_message_id stays overridable).
      payload: { chat_id: 999999, message_thread_id: 55, reply_to_message_id: 7, text: "hi" },
    });
    await deliverNewEvents({ cursors, processor, stream });

    expect(sentMessages).toEqual([
      { chat_id: CHAT_ID, reply_to_message_id: 7, text: "hi" }, // no message_thread_id: the path has no topic
    ]);
    const claims = network.eventsAt(`/integrations/telegram/${CONNECTION}`);
    expect(claims[0]!.payload).toMatchObject({ chatId: String(CHAT_ID), sessionPath: agentPath });
  });

  it("never re-sends a MARKED request on replay (the crash-after-marker case)", async () => {
    const { cursors, processor, sentMessages, stream } = setup();

    const [request] = await stream.append({
      type: "events.iterate.com/telegram/send-requested",
      payload: { text: "already delivered" },
    });
    await deliverNewEvents({ cursors, processor, stream });
    expect(sentMessages).toHaveLength(1);

    // Simulate a crash after the marker landed but before the checkpoint
    // advanced: the host replays the request. The journal shows the marker,
    // so the send must NOT fire again (the marker is what "satisfied" means).
    await processor.ingest({ events: [request!], streamMaxOffset: stream.events.length });
    expect(sentMessages).toHaveLength(1);
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/telegram/message-sent"),
    ).toHaveLength(1);
  });

  it("quotes the answered message only when newer messages arrived since (deterministic reply_to)", async () => {
    const { cursors, processor, sentMessages, stream } = setup();

    // Turn 1: message 10 → LLM turn → send. Message 10 is still the latest
    // inbound, so quoting it would be noise: no reply_to_message_id.
    await stream.append(
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({ messageId: 10, text: "first question" }),
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "gpt-test", provider: "openai-ws", requestId: "llm-request:1" },
      },
      { type: "events.iterate.com/telegram/send-requested", payload: { text: "answer to 10" } },
    );
    await deliverNewEvents({ cursors, processor, stream });
    expect(sentMessages.at(-1)).not.toHaveProperty("reply_to_message_id");

    // Turn 2: message 11 starts a turn, then message 12 arrives BEFORE the
    // agent's send. The answer is now stale-positioned: quote message 11.
    await stream.append(
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({ messageId: 11, text: "second question" }),
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "gpt-test", provider: "openai-ws", requestId: "llm-request:2" },
      },
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({ messageId: 12, text: "and another thing" }),
      },
      { type: "events.iterate.com/telegram/send-requested", payload: { text: "answer to 11" } },
    );
    await deliverNewEvents({ cursors, processor, stream });
    expect(sentMessages.at(-1)).toMatchObject({ reply_to_message_id: 11, text: "answer to 11" });

    // An explicit reply_to_message_id from the agent always wins.
    await stream.append({
      type: "events.iterate.com/telegram/send-requested",
      payload: { reply_to_message_id: 10, text: "explicitly quoting 10" },
    });
    await deliverNewEvents({ cursors, processor, stream });
    expect(sentMessages.at(-1)).toMatchObject({ reply_to_message_id: 10 });
  });

  it("acknowledges a bare /new with the fixed message and no LLM turn", async () => {
    const { cursors, processor, sentMessages, stream } = setup();

    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({ text: "/new" }),
    });
    await deliverNewEvents({ cursors, processor, stream });
    // The ack's send-requested landed during the batch; the host wakes again
    // to deliver it (second pass here).
    await deliverNewEvents({ cursors, processor, stream });

    // The ack rides the journaled send pair (delivered + marked)…
    expect(sentMessages).toEqual([{ chat_id: CHAT_ID, text: TELEGRAM_NEW_SESSION_ACK_TEXT }]);
    // …and the transcript records the /new WITHOUT waking the agent.
    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
  });

  it("treats '/new trailing text' as the fresh session's first (triggering) message", async () => {
    const { cursors, processor, sentMessages, stream } = setup({
      agentPath: `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-6000`,
    });

    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({ date: 6000, text: "/new plan my week" }),
    });
    await deliverNewEvents({ cursors, processor, stream });
    // Second pass: the host wakes again for the ack's send-requested.
    await deliverNewEvents({ cursors, processor, stream });

    expect(sentMessages).toEqual([{ chat_id: CHAT_ID, text: TELEGRAM_NEW_SESSION_ACK_TEXT }]);
    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(inputs).toHaveLength(1);
    const payload = inputs[0]!.payload as { content: string; llmRequestPolicy?: unknown };
    expect(payload.content).toContain('"plan my week"');
    expect(payload.llmRequestPolicy).toEqual({ behaviour: "after-current-request" });

    // Ordering: the fixed ack's request precedes the triggering input, so the
    // acknowledgement lands in the chat before the agent's answer.
    const types = stream.events.map((event) => event.type);
    expect(types.indexOf("events.iterate.com/telegram/send-requested")).toBeLessThan(
      types.indexOf("events.iterate.com/agent/input-added"),
    );
  });

  it("compiles /debug into a script execution (no LLM turn) that posts via the journaled send", async () => {
    const agentPath = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-8000`;
    const { cursors, processor, stream } = setup({ agentPath });

    // Telegram appends @BotUsername to commands in group chats.
    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({ text: "/debug@MishasHelperBot" }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    const scripts = stream.events.filter(
      (event) => event.type === "events.iterate.com/capability-host/script-execution-requested",
    );
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({
      idempotencyKey: "telegram-agent:debug-command:1",
      payload: { executionId: "telegram-debug-command-1" },
    });
    const code = (scripts[0]!.payload as { code: string }).code;
    expect(code).toContain("await itx.debug()");
    // The result posts through the journaled send pair on THIS session
    // stream — right thread, full provenance, like the /new ack.
    expect(code).toContain(`itx.streams.get("${agentPath}")`);
    expect(code).toContain("events.iterate.com/telegram/send-requested");
    // Telegram caps messages at 4096 chars; the dump truncates safely.
    expect(code).toContain("…truncated");
    // No LLM turn and no agent input — the command IS the whole handling.
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agent/input-added"),
    ).toHaveLength(0);
  });

  it("renders the router's reply hint in the transcription with the referenced stream path", async () => {
    const { cursors, processor, stream } = setup({
      agentPath: `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-7000`,
    });
    const oldSession = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-1000`;

    const payload = humanMessageWebhookPayload({
      replyToMessage: { message_id: 500, from: { id: 999, is_bot: true }, date: 900, text: "hi" },
      text: "one more question about this",
    }) as Record<string, unknown>;
    payload.replyHint = { resolvedBy: "sent-claim", sessionPath: oldSession };
    await stream.append({ type: "events.iterate.com/telegram/webhook-received", payload });
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(inputs).toHaveLength(1);
    const content = (inputs[0]!.payload as { content: string }).content;
    expect(content).toContain(`REPLIES to a message from a different thread: ${oldSession}`);
    // The taught read is FILTERED to the conversation event types — an
    // unfiltered getEvents returns the oldest raw events (subscriber/llm
    // plumbing), which is how a live agent failed to recover the history.
    expect(content).toContain(
      `await itx.streams.get("${oldSession}").getEvents({ eventTypes: ["events.iterate.com/telegram/webhook-received", "events.iterate.com/telegram/send-requested"] })`,
    );
    // Imperative and LEADING: the hint sits above the YAML dump (trailing it,
    // the live agent skimmed past and explored the repo instead).
    expect(content.indexOf("IMPORTANT: this message REPLIES")).toBeLessThan(
      content.indexOf("```yaml"),
    );
    expect(content).toContain("Before answering");
  });

  it("the taught filtered read returns exactly the two-sided transcript of a real-shaped thread", async () => {
    // Seed an old session stream the way a live one accumulates: plumbing
    // noise interleaved with the conversation. The exact call the hint and
    // system prompt teach must surface ONLY the user/bot exchange.
    const network = new MemoryStreamNetwork();
    const oldSession = network.get(`/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-1000`);
    await oldSession.append(
      { type: "events.iterate.com/stream/subscriber-connected", payload: {} },
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: humanMessageWebhookPayload({ text: "what's the wifi password?" }),
      },
      { type: "events.iterate.com/agent/input-added", payload: { content: "transcribed..." } },
      { type: "events.iterate.com/agent/llm-request-requested", payload: { requestId: "r1" } },
      {
        type: "events.iterate.com/telegram/send-requested",
        payload: { text: "It's hunter2." },
      },
      { type: "events.iterate.com/telegram/message-sent", payload: { messageId: 9001 } },
    );

    const transcript = await oldSession.getEvents({
      eventTypes: [
        "events.iterate.com/telegram/webhook-received",
        "events.iterate.com/telegram/send-requested",
      ],
    });
    expect(
      transcript.map((event) => {
        const payload = event.payload as { body?: { message?: { text?: string } }; text?: string };
        return payload.body?.message?.text ?? payload.text;
      }),
    ).toEqual(["what's the wifi password?", "It's hunter2."]);
  });
});

describe("telegramAgentSystemPrompt", () => {
  it("routes replies through the journaled send on the agent's own stream", () => {
    const agentPath = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-5000`;
    const prompt = telegramAgentSystemPrompt({
      agentPath,
      chatId: String(CHAT_ID),
      connection: CONNECTION,
    });
    expect(prompt).toContain(
      `itx.streams.get("${agentPath}").append({ type: "events.iterate.com/telegram/send-requested"`,
    );
    expect(prompt).toContain(`this chat's id is ${CHAT_ID}`);
    expect(prompt).toContain("Never use itx.chat.sendMessage");
    // Threading guidance: /new sessions + reply hints (read / cross-post /
    // answer in place) — imperative, with the FILTERED transcript read (an
    // unfiltered getEvents pages through plumbing noise, not conversation).
    expect(prompt).toContain("/new");
    expect(prompt).toContain("READ the referenced thread FIRST");
    expect(prompt).toContain(
      'getEvents({ eventTypes: ["events.iterate.com/telegram/webhook-received", "events.iterate.com/telegram/send-requested"] })',
    );
    expect(prompt).toContain("your judgement");
    // Arbitrary Bot API methods remain available as immediate calls.
    expect(prompt).toContain(`itx.integrations.telegram["${CONNECTION}"]`);
    // v1 media limitation is stated so the agent doesn't hallucinate vision.
    expect(prompt).toContain("[photo]");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanMessageWebhookPayload(input: {
  chatId?: number;
  chatType?: string;
  date?: number;
  messageId?: number;
  replyToMessage?: Record<string, unknown>;
  text?: string;
  updateId?: number;
}) {
  return {
    botId: BOT_ID,
    body: {
      update_id: input.updateId ?? 100001,
      message: {
        message_id: input.messageId ?? 1,
        from: { id: 555, is_bot: false, first_name: "Misha", username: "misha" },
        chat: { id: input.chatId ?? CHAT_ID, type: input.chatType ?? "private" },
        date: input.date ?? 1_760_000_000,
        text: input.text ?? "hello agent",
        ...(input.replyToMessage === undefined ? {} : { reply_to_message: input.replyToMessage }),
      },
    },
  };
}

function setup(input: { agentPath?: string; now?: () => number } = {}) {
  const network = new MemoryStreamNetwork();
  const agentPath = input.agentPath ?? `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`;
  const stream = network.get(agentPath);
  const telegramCalls: Array<{ body: Record<string, unknown>; method: string }> = [];
  const sentMessages: Array<Record<string, unknown>> = [];
  // Errors queued here fail the next sendTelegramMessage call — the send
  // obligation tests use it to simulate a crash before the marker.
  const sendFailures: Error[] = [];
  // Record appends and Telegram API calls into one list to pin their order:
  // the agent input must be durable before the typing action signals receipt.
  const calls: string[] = [];
  const originalAppend = stream.append.bind(stream);
  stream.append = async (...inputs: StreamEventInput[]) => {
    calls.push(...inputs.map((input) => `append:${input.type}`));
    return originalAppend(...inputs);
  };
  const processor = new TelegramAgentProcessor({
    stream,
    agentPath,
    // MemoryStream stamps events at ~epoch (ms 1, 2, 3…); a clock just past
    // that keeps the ack freshness gate (#1807) open by default. Stale-gate
    // tests pass a `now` far in the future.
    now: input.now ?? (() => 60_000),
    callTelegramApi: async (method, body) => {
      calls.push(`telegram:${method}`);
      telegramCalls.push({ body, method });
    },
    sendTelegramMessage: async (body) => {
      const failure = sendFailures.shift();
      if (failure !== undefined) throw failure;
      calls.push("telegram:sendMessage");
      sentMessages.push(body);
      return { messageId: 9000 + sentMessages.length };
    },
  });
  const cursors = new Map<object, number>();
  return { calls, cursors, network, processor, sendFailures, sentMessages, stream, telegramCalls };
}

/**
 * In-memory network of streams keyed by path, so router tests can observe the
 * cross-stream forwards (`stream.at(path).append(...)`) next to same-stream
 * appends. Same shape as slack-processors.test.ts.
 */
class MemoryStreamNetwork {
  readonly streams = new Map<string, MemoryStream>();

  get(path: string): MemoryStream {
    let stream = this.streams.get(path);
    if (stream === undefined) {
      stream = new MemoryStream(this, path);
      this.streams.set(path, stream);
    }
    return stream;
  }

  eventsAt(path: string): StreamEvent[] {
    return this.streams.get(path)?.events ?? [];
  }
}

class MemoryStream implements Stream {
  events: StreamEvent[] = [];

  async kill(): Promise<void> {}

  async __describe() {
    return { instructions: "in-memory test stream", types: "", children: {} };
  }

  constructor(
    readonly network: MemoryStreamNetwork,
    readonly path: string,
  ) {}

  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    return inputs.map((input) => {
      const existing =
        input.idempotencyKey === undefined
          ? undefined
          : this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) return existing;
      const event: StreamEvent = {
        ...input,
        createdAt: new Date(this.events.length + 1).toISOString(),
        offset: this.events.length + 1,
        path: this.path,
      };
      this.events.push(event);
      return event;
    });
  }

  at(path: string): Stream {
    return this.network.get(path);
  }

  async getEvent(): Promise<StreamEvent | undefined> {
    return undefined;
  }

  async getEvents(input: Parameters<Stream["getEvents"]>[0] = {}): Promise<StreamEvent[]> {
    const { afterOffset = 0, limit = 500 } = input;
    const beforeOffset = input.beforeOffset ?? Number.MAX_SAFE_INTEGER;
    return this.events
      .filter((event) => event.offset > afterOffset)
      .filter((event) => event.offset < beforeOffset)
      .filter(
        (event) =>
          input.eventTypes === undefined ||
          input.eventTypes.includes("*") ||
          input.eventTypes.includes(event.type),
      )
      .slice(0, limit);
  }

  readEvents(input: Parameters<Stream["readEvents"]>[0] = {}) {
    let afterOffset = input.afterOffset ?? 0;
    return {
      next: async () => {
        const page = await this.getEvents({ ...input, afterOffset });
        afterOffset = page.at(-1)?.offset ?? afterOffset;
        return page;
      },
      [Symbol.dispose]() {},
    };
  }

  async waitForEvent(): Promise<StreamEvent> {
    throw new Error("MemoryStream does not implement waitForEvent().");
  }

  async getProcessorRuntimeState(): Promise<null> {
    return null;
  }

  async runtimeState() {
    return { coreProcessorState: null, runtime: { connections: {}, subscriptions: {} } };
  }

  async subscribe(): Promise<never> {
    throw new Error("MemoryStream does not implement subscribe().");
  }

  async ingest(): Promise<never> {
    throw new Error("MemoryStream does not implement ingest().");
  }

  async crossPostTo(): Promise<never> {
    throw new Error("MemoryStream does not implement crossPostTo().");
  }

  async removeCrossPost(): Promise<never> {
    throw new Error("MemoryStream does not implement removeCrossPost().");
  }
}

type ProcessorLike = {
  ingest(input: { events: readonly StreamEvent[]; streamMaxOffset: number }): Promise<void>;
};

async function deliverNewEvents(input: {
  cursors: Map<object, number>;
  processor: ProcessorLike;
  stream: MemoryStream;
}) {
  const cursor = input.cursors.get(input.processor) ?? 0;
  const events = input.stream.events.slice(cursor);
  input.cursors.set(input.processor, input.stream.events.length);
  if (events.length === 0) return;
  await input.processor.ingest({ events, streamMaxOffset: input.stream.events.length });
}
