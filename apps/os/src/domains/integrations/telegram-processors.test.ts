// The Telegram router + agent processor pair, mirrored from
// slack-processors.test.ts: an in-memory stream network, real processors, no
// module mocks. Helpers live at the bottom of the file.

import { describe, expect, test } from "vitest";
import type { StreamEventInput } from "../streams/schemas.ts";
import { telegramAgentSystemPrompt } from "../agents/agent-defaults.ts";
import { MemoryStreamNetwork, makeProcessorHarness } from "../streams/test-helpers.ts";
import { TelegramProcessor } from "./telegram-processor-implementation.ts";
import {
  TELEGRAM_BOT_ID as BOT_ID,
  TELEGRAM_CHAT_ID as CHAT_ID,
  telegramMessageWebhookPayload as humanMessageWebhookPayload,
} from "./webhook-fixtures.ts";
import {
  TELEGRAM_NEW_SESSION_ACK_TEXT,
  TelegramAgentProcessor,
} from "./telegram-agent-processor-implementation.ts";

const CONNECTION = "mishas-helper-bot";

describe("TelegramProcessor (webhook router)", () => {
  test("forwards a private-chat message to the chat's agent stream, verbatim", async () => {
    const { network, stream, deliver } = routerHarness();

    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();

    const routed = network.eventsAt(`/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`);
    expect(routed.map((event) => event.type)).toEqual([
      "events.iterate.com/telegram/webhook-received",
    ]);
    expect(routed[0]!.payload).toEqual(humanMessageWebhookPayload({}));
  });

  test("routes forum-topic messages to a per-topic stream, negative group ids verbatim", async () => {
    const { network, stream, deliver } = routerHarness();

    const payload = humanMessageWebhookPayload({ chatId: -1004242, chatType: "supergroup" });
    const message = payload.body.message as Record<string, unknown>;
    message.is_topic_message = true;
    message.message_thread_id = 77;
    await stream.append({ type: "events.iterate.com/telegram/webhook-received", payload });
    await deliver();

    // The sign is significant (chat 1004242 and supergroup -1004242 must not
    // collide), so the id is used verbatim, minus and all.
    expect(network.eventsAt(`/agents/telegram/${CONNECTION}/chat--1004242/topic-77`)).toHaveLength(
      1,
    );
  });

  test("drops chat-less updates (inline queries) without creating any stream", async () => {
    const { network, stream, deliver } = routerHarness();

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
    await deliver();

    expect(network.streams.size).toBe(1); // nothing forwarded anywhere
  });

  test("ignores connected/disconnected lifecycle facts (status is a journal fold, not router state)", async () => {
    const { network, stream, processor, deliver } = routerHarness();

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
    await deliver();
    expect(processor.state).toEqual({ sessionsByChat: {}, sentMessages: {} });
    expect(network.streams.size).toBe(1);
  });

  test("errors loudly instead of routing when the host stream carries no connection", async () => {
    // A mis-armed subscription: telegram router woken on a non-connection path.
    const { network, stream, deliver } = routerHarness({ connection: null });

    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    // Throwing (not dropping) holds the checkpoint so the webhook stays
    // replayable — the Slack 2026-06-15 outage shape.
    await expect(deliver()).rejects.toThrow(/no connection/);
    expect(network.streams.size).toBe(1);
  });

  test("replays the webhook when the forward append fails instead of dropping it", async () => {
    const { network, stream, processor } = routerHarness();
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

  test("/new rotates the chat to a fresh session stream; /new itself routes into it", async () => {
    const { network, stream, deliver } = routerHarness();
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
    await deliver();

    expect(network.eventsAt(sessionZero)).toHaveLength(1);
    // The /new message AND everything after it land in the session stream.
    const session = network.eventsAt(`${sessionZero}/session-2000`);
    expect(session).toHaveLength(2);
    expect(session.map((event) => (event.payload as { body: any }).body.message.text)).toEqual([
      "/new",
      "new world",
    ]);
  });

  test("orders same-second /new pairs by message_id and never rolls the session backwards", async () => {
    const { stream, processor, deliver } = routerHarness();

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
    await deliver();
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
    await deliver();
    expect(processor.state.sessionsByChat[`chat-${CHAT_ID}`]!.at(-1)).toMatchObject({
      messageId: 11,
    });
  });

  test("group-chat /new@BotName and trailing text both rotate the session", async () => {
    const { network, stream, deliver } = routerHarness();

    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({
        date: 4000,
        messageId: 20,
        text: "/new@MishasHelperBot let's plan a trip",
      }),
    });
    await deliver();
    expect(
      network.eventsAt(`/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-4000`),
    ).toHaveLength(1);
  });

  test("annotates replies to bot messages with the EXACT thread from the sent claim", async () => {
    const { network, stream, deliver } = routerHarness();
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
    await deliver();

    // Routing is untouched (latest session); the hint names the old thread.
    const session = network.eventsAt(`/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-5000`);
    expect(session).toHaveLength(2);
    expect(session[1]!.payload).toMatchObject({
      replyHint: { resolvedBy: "sent-claim", sessionPath: oldSession },
    });
  });

  test("falls back to the reply date for user messages: containing session, or session zero when older than the first /new", async () => {
    const { network, stream, deliver } = routerHarness();
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
    await deliver();

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
  test("turns a routed human message into triggering agent context, then shows typing", async () => {
    const { calls, deliver, processor, stream, telegramCalls } = setup();

    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({ text: "hello agent" }),
    });
    await deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    const payload = inputs[0]!.payload as {
      actor?: unknown;
      content: string;
      llmRequestPolicy?: unknown;
      refs?: unknown;
      role: string;
    };
    expect(payload).toMatchObject({
      role: "developer",
      actor: { type: "telegram", userId: "555", username: "misha" },
      refs: [
        {
          type: "event",
          streamPath: `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`,
          offset: 1,
          eventType: "events.iterate.com/telegram/webhook-received",
        },
      ],
    });
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
      "append:events.iterate.com/agents/context-added",
      "telegram:sendChatAction",
    ]);

    expect(processor.state).toMatchObject({ botId: BOT_ID, chatId: String(CHAT_ID) });
  });

  test("ignores bot-authored updates entirely (no input, no typing)", async () => {
    const { deliver, stream, telegramCalls } = setup();

    const payload = humanMessageWebhookPayload({});
    (payload.body.message as Record<string, unknown>).from = {
      id: 999,
      is_bot: true,
      first_name: "iterate",
    };
    await stream.append({ type: "events.iterate.com/telegram/webhook-received", payload });
    await deliver();

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/context-added"),
    ).toHaveLength(0);
    expect(telegramCalls).toHaveLength(0);
  });

  test("records message edits as non-triggering input without typing", async () => {
    const { deliver, stream, telegramCalls } = setup();

    const payload = humanMessageWebhookPayload({ text: "edited!" });
    const body = payload.body as Record<string, unknown>;
    body.edited_message = body.message;
    delete body.message;
    await stream.append({ type: "events.iterate.com/telegram/webhook-received", payload });
    await deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
    expect(telegramCalls).toHaveLength(0);
  });

  test("treats callback queries (button presses) as triggering input from the presser", async () => {
    const { deliver, stream } = setup();

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
    await deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    const payload = inputs[0]!.payload as {
      actor?: unknown;
      content: string;
      llmRequestPolicy?: unknown;
      refs?: unknown;
      role: string;
    };
    expect(payload.content).toContain("approve");
    expect(payload.llmRequestPolicy).toEqual({ behaviour: "after-current-request" });
    // The sender is the button PRESSER (callback_query.from), never the
    // bot that authored the embedded message.
    expect(payload).toMatchObject({
      role: "developer",
      actor: { type: "telegram", userId: "7" },
      refs: [
        {
          type: "event",
          streamPath: `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`,
          offset: 1,
          eventType: "events.iterate.com/telegram/webhook-received",
        },
      ],
    });
  });

  test("transcribes media as bracketed placeholders", async () => {
    const { deliver, stream } = setup();

    const payload = humanMessageWebhookPayload({});
    const message = payload.body.message as Record<string, unknown>;
    delete message.text;
    message.photo = [{ file_id: "photo-1", width: 90, height: 90 }];
    message.caption = "look at this";
    await stream.append({ type: "events.iterate.com/telegram/webhook-received", payload });
    await deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect((inputs[0]!.payload as { content: string }).content).toContain("[photo]");
  });

  test("re-sends the typing action while the LLM works, with the chat id from state", async () => {
    const { deliver, stream, telegramCalls } = setup();

    // Establish chat context first.
    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    telegramCalls.length = 0;

    await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", provider: "openai-ws", requestId: "llm-request:1" },
    });
    await deliver();
    // chat_id goes back as the integer Telegram issued.
    expect(telegramCalls).toEqual([
      { method: "sendChatAction", body: { action: "typing", chat_id: CHAT_ID } },
    ]);
  });

  test("never sends typing before any webhook established the chat", async () => {
    const { deliver, stream, telegramCalls } = setup();

    await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", provider: "openai-ws", requestId: "llm-request:1" },
    });
    await deliver();
    expect(telegramCalls).toHaveLength(0);
  });

  test("refold safety (#1807): a full replay re-transcribes and re-sends but never re-types stale messages", async () => {
    // A state-schema deploy discards the checkpoint and refolds the WHOLE
    // journal. The durable lanes (agent context, the journaled send) must
    // re-run/dedupe, but the user-visible typing acks are stale — re-typing
    // months-old messages is a rate-limit burst. `now` far in the future
    // makes every event's ~epoch timestamp stale.
    const { deliver, stream, telegramCalls, sentMessages } = setup({
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
    await deliver();

    // Durable lanes ran: the message reached the agent, and the reply was
    // delivered (its journal marker is absent on this first pass).
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/context-added"),
    ).toHaveLength(1);
    expect(sentMessages).toEqual([{ chat_id: CHAT_ID, text: "an old reply" }]);
    // But NO typing ack (arrival OR "still working") on a stale replay.
    expect(telegramCalls.filter((call) => call.method === "sendChatAction")).toHaveLength(0);
  });

  test("carries an unpainted typing fact across a non-at-head batch to the next at-head one", async () => {
    const { deliver, processor, stream, telegramCalls } = setup();
    // Establish the chat.
    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
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

  test("delivers a send-requested, marks it, and claims the message on the connection stream", async () => {
    const agentPath = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-5000`;
    const { deliver, network, sentMessages, stream } = setup({ agentPath });

    const [request] = await stream.append({
      type: "events.iterate.com/telegram/send-requested",
      payload: { text: "hello from the agent" },
    });
    await deliver();

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

  test("holds the checkpoint when delivery fails, then retries into exactly one marker", async () => {
    const { deliver, processor, sendFailures, sentMessages, stream } = setup();
    sendFailures.push(new Error("telegram is down"));

    const [request] = await stream.append({
      type: "events.iterate.com/telegram/send-requested",
      payload: { text: "must arrive" },
    });

    // Unmet obligation: the batch rejects and the checkpoint holds, so the
    // host replays this request until a marker exists.
    await expect(deliver()).rejects.toThrow(/telegram is down/);
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

  test("forces the stream's chat over a payload-supplied chat_id/message_thread_id (thread-bound sends)", async () => {
    const agentPath = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`;
    const { deliver, network, sentMessages, stream } = setup({ agentPath });

    await stream.append({
      type: "events.iterate.com/telegram/send-requested",
      // A confused (or mischievous) agent aims the journaled send at another
      // chat. Not a capability boundary — raw sendMessage can post anywhere —
      // but the claim below records THIS stream as the message's thread, so
      // the delivery must actually go here: path identity wins, payload's
      // chat coordinates are ignored (reply_to_message_id stays overridable).
      payload: { chat_id: 999999, message_thread_id: 55, reply_to_message_id: 7, text: "hi" },
    });
    await deliver();

    expect(sentMessages).toEqual([
      { chat_id: CHAT_ID, reply_to_message_id: 7, text: "hi" }, // no message_thread_id: the path has no topic
    ]);
    const claims = network.eventsAt(`/integrations/telegram/${CONNECTION}`);
    expect(claims[0]!.payload).toMatchObject({ chatId: String(CHAT_ID), sessionPath: agentPath });
  });

  test("never re-sends a MARKED request on replay (the crash-after-marker case)", async () => {
    const { deliver, processor, sentMessages, stream } = setup();

    const [request] = await stream.append({
      type: "events.iterate.com/telegram/send-requested",
      payload: { text: "already delivered" },
    });
    await deliver();
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

  test("quotes the answered message only when newer messages arrived since (deterministic reply_to)", async () => {
    const { deliver, sentMessages, stream } = setup();

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
    await deliver();
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
    await deliver();
    expect(sentMessages.at(-1)).toMatchObject({ reply_to_message_id: 11, text: "answer to 11" });

    // An explicit reply_to_message_id from the agent always wins.
    await stream.append({
      type: "events.iterate.com/telegram/send-requested",
      payload: { reply_to_message_id: 10, text: "explicitly quoting 10" },
    });
    await deliver();
    expect(sentMessages.at(-1)).toMatchObject({ reply_to_message_id: 10 });
  });

  test("acknowledges a bare /new with the fixed message and no LLM turn", async () => {
    const { deliver, sentMessages, stream } = setup();

    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({ text: "/new" }),
    });
    await deliver();
    // The ack's send-requested landed during the batch; the host wakes again
    // to deliver it (second pass here).
    await deliver();

    // The ack rides the journaled send pair (delivered + marked)…
    expect(sentMessages).toEqual([{ chat_id: CHAT_ID, text: TELEGRAM_NEW_SESSION_ACK_TEXT }]);
    // …and the transcript records the /new WITHOUT waking the agent.
    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
  });

  test("treats '/new trailing text' as the fresh session's first (triggering) message", async () => {
    const { deliver, sentMessages, stream } = setup({
      agentPath: `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-6000`,
    });

    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({ date: 6000, text: "/new plan my week" }),
    });
    await deliver();
    // Second pass: the host wakes again for the ack's send-requested.
    await deliver();

    expect(sentMessages).toEqual([{ chat_id: CHAT_ID, text: TELEGRAM_NEW_SESSION_ACK_TEXT }]);
    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    const payload = inputs[0]!.payload as { content: string; llmRequestPolicy?: unknown };
    expect(payload.content).toContain('"plan my week"');
    expect(payload.llmRequestPolicy).toEqual({ behaviour: "after-current-request" });

    // Ordering: the fixed ack's request precedes the triggering input, so the
    // acknowledgement lands in the chat before the agent's answer.
    const types = stream.events.map((event) => event.type);
    expect(types.indexOf("events.iterate.com/telegram/send-requested")).toBeLessThan(
      types.indexOf("events.iterate.com/agents/context-added"),
    );
  });

  test("compiles /debug into a script execution (no LLM turn) that posts via the journaled send", async () => {
    const agentPath = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-8000`;
    const { deliver, stream } = setup({ agentPath });

    // Telegram appends @BotUsername to commands in group chats.
    await stream.append({
      type: "events.iterate.com/telegram/webhook-received",
      payload: humanMessageWebhookPayload({ text: "/debug@MishasHelperBot" }),
    });
    await deliver();

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
    // No LLM turn and no agent context — the command IS the whole handling.
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/context-added"),
    ).toHaveLength(0);
  });

  test("renders the router's reply hint in the transcription with the referenced stream path", async () => {
    const { deliver, stream } = setup({
      agentPath: `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-7000`,
    });
    const oldSession = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-1000`;

    const payload = humanMessageWebhookPayload({
      replyToMessage: { message_id: 500, from: { id: 999, is_bot: true }, date: 900, text: "hi" },
      text: "one more question about this",
    }) as Record<string, unknown>;
    payload.replyHint = { resolvedBy: "sent-claim", sessionPath: oldSession };
    await stream.append({ type: "events.iterate.com/telegram/webhook-received", payload });
    await deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
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

  test("the taught filtered read returns exactly the two-sided transcript of a real-shaped thread", async () => {
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
      {
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "developer",
          content: "transcribed...",
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
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
  test("stitches the session path, chat id, and connection into the prompt", () => {
    const agentPath = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}/session-5000`;
    // A chat id distinct from the one inside agentPath, so its interpolation
    // is proven on its own and not satisfied by the path assertion.
    const prompt = telegramAgentSystemPrompt({
      agentPath,
      chatId: "777123",
      connection: CONNECTION,
    });
    // Structural invariants (parameter interpolation) only — the prose is
    // deliberately unpinned: docs/testing.md names prompt-copy pinning as an
    // antipattern, and the reply-hint behavior is proven on the processor
    // tests above.
    expect(prompt).toContain(agentPath);
    expect(prompt).toContain("777123");
    expect(prompt).toContain(CONNECTION);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Router-suite harness. The network clock is pinned to the epoch — see
 * `setup()` for why.
 */
function routerHarness(input: { connection?: string | null } = {}) {
  const connection = input.connection === undefined ? CONNECTION : input.connection;
  return makeProcessorHarness({
    path: connection === null ? "/integrations/telegram" : `/integrations/telegram/${connection}`,
    now: () => 0,
    build: ({ stream }) =>
      new TelegramProcessor({ stream, path: stream.path, projectId: null, connection }),
  });
}

function setup(input: { agentPath?: string; now?: () => number } = {}) {
  const agentPath = input.agentPath ?? `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`;
  const telegramCalls: Array<{ body: Record<string, unknown>; method: string }> = [];
  const sentMessages: Array<Record<string, unknown>> = [];
  // Errors queued here fail the next sendTelegramMessage call — the send
  // obligation tests use it to simulate a crash before the marker.
  const sendFailures: Error[] = [];
  // Record appends and Telegram API calls into one list to pin their order:
  // the agent context must be durable before the typing action signals receipt.
  const calls: string[] = [];
  const harness = makeProcessorHarness({
    path: agentPath,
    // The network clock is pinned to the epoch: the ack-freshness fixtures in
    // this file pair processor clocks of `now: () => 60_000` (fresh) and
    // `now: () => 999_999_999_999` (stale refold) against ~epoch createdAt
    // stamps. Wall-clock stamps would make the stale replay's events look
    // fresh and re-type months-old messages.
    now: () => 0,
    build: ({ stream }) => {
      const originalAppend = stream.append.bind(stream);
      stream.append = async (...inputs: StreamEventInput[]) => {
        calls.push(...inputs.map((input) => `append:${input.type}`));
        return originalAppend(...inputs);
      };
      return new TelegramAgentProcessor({
        stream,
        path: stream.path,
        projectId: null,
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
    },
  });
  return { ...harness, calls, sendFailures, sentMessages, telegramCalls };
}
