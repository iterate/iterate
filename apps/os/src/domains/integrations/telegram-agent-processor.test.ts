// The telegram-agent processor's executable spec, on the generic step harness
// from iterate/processors/testing: the REAL StreamProcessorRunner over a
// MemoryStreamNetwork (so the connection-stream provenance claims are
// observable next to same-stream appends), virtual time for the typing
// freshness gates, and production idempotency semantics (a same-key append
// with a different body is REJECTED). The Bot API fakes (sendMessage for the
// journaled send, sendChatAction for typing) are wired in createProcessor;
// one shared `calls` list records appends and vendor calls in order, so the
// context-must-commit-before-typing contract is pinned.

import { describe, expect, it } from "vitest";
import type { ConsumedInput, StreamEvent, StreamEventInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStreamNetwork,
} from "iterate/processors/testing";
import { DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS } from "../capability-host/capability-host-processor-contract.ts";
import {
  TELEGRAM_NEW_SESSION_ACK_TEXT,
  TelegramAgentProcessor,
} from "./telegram-agent-processor-implementation.ts";
import type { TelegramAgentProcessorContract } from "./telegram-agent-processor-contract.ts";

type AgentEventInput = ConsumedInput<TelegramAgentProcessorContract>;

const BOT_ID = "7000001";
const CONNECTION = "mishas-helper-bot";
const CHAT_ID = 42424242;
const CHAT_PATH = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`;
const CONNECTION_PATH = `/integrations/telegram/${CONNECTION}`;

const AGENT_BORN = {
  type: "events.iterate.com/telegram-agent/created",
  payload: { config: { chatId: String(CHAT_ID), connection: CONNECTION } },
} satisfies AgentEventInput;

/** A journaled LLM turn start — what the agent processor emits; here it only
 * matters as a typing-worthy lifecycle fact and the reply_to snapshot. */
function llmRequested(requestId: string): AgentEventInput {
  return {
    type: "events.iterate.com/agent/llm-request-requested",
    payload: { model: "gpt-test", requestId },
  };
}

function humanMessageWebhookPayload(input: {
  chatId?: number;
  date?: number;
  messageId?: number;
  replyToMessage?: Record<string, unknown>;
  text?: string;
  userId?: number;
}) {
  return {
    botId: BOT_ID,
    body: {
      update_id: 100001,
      message: {
        message_id: input.messageId ?? 1,
        from: {
          id: input.userId ?? 555,
          is_bot: false,
          first_name: "Misha",
          username: "misha",
        },
        chat: { id: input.chatId ?? CHAT_ID, type: "private" },
        date: input.date ?? 1_760_000_000,
        text: input.text ?? "hello agent",
        ...(input.replyToMessage === undefined ? {} : { reply_to_message: input.replyToMessage }),
      },
    },
  };
}

function webhook(payload: ReturnType<typeof humanMessageWebhookPayload>): AgentEventInput {
  return { type: "events.iterate.com/telegram/webhook-received", payload };
}

function contextAddedEvents(h: { events: (type?: string) => StreamEvent[] }) {
  return h.events("events.iterate.com/agents/context-added");
}

/**
 * The generic harness plus the Bot API fakes for one routed agent stream.
 * The substrate stream comes from a MemoryStreamNetwork sharing the virtual
 * clock, so the connection-stream claims are observable. Errors queued on
 * `sendFailures` fail the next sendMessage call (the send-obligation tests
 * simulate a Telegram outage with them). Pass a previous harness's substrate
 * (+ network) with a fresh progress store to replay the same stream from
 * offset zero — the refold recipe.
 */
function makeAgentHarness(
  input: {
    agentPath?: string;
    clock?: { now: number };
    network?: MemoryStreamNetwork;
    progress?: ReturnType<typeof makeMemoryProgressStore>;
  } = {},
) {
  const agentPath = input.agentPath ?? CHAT_PATH;
  const clock = input.clock ?? { now: Date.parse("2026-07-09T12:00:00Z") };
  const network = input.network ?? new MemoryStreamNetwork(() => clock.now);
  const stream = network.get(agentPath);
  const telegramCalls: { body: Record<string, unknown>; method: string }[] = [];
  const sentMessages: Record<string, unknown>[] = [];
  const sendFailures: Error[] = [];
  // Appends and Telegram API calls in one ordered list: the agent context
  // must be durable BEFORE the typing action signals receipt.
  const calls: string[] = [];
  const originalAppend = stream.append.bind(stream);
  stream.append = async (...inputs: StreamEventInput[]) => {
    calls.push(...inputs.map((event) => `append:${event.type}`));
    return originalAppend(...inputs);
  };
  const harness = makeProcessorHarness<TelegramAgentProcessorContract>({
    createProcessor: (deps) =>
      new TelegramAgentProcessor({
        ...deps,
        callTelegramApi: async ({ body, method }) => {
          calls.push(`telegram:${method}`);
          telegramCalls.push({ body, method });
        },
        sendTelegramMessage: async ({ body }) => {
          const failure = sendFailures.shift();
          if (failure !== undefined) throw failure;
          calls.push("telegram:sendMessage");
          sentMessages.push(body);
          return { messageId: 9000 + sentMessages.length };
        },
      }),
    substrate: { clock, stream, progress: input.progress ?? makeMemoryProgressStore() },
  });
  return { ...harness, calls, network, sendFailures, sentMessages, telegramCalls };
}

describe("TelegramAgentProcessor", () => {
  it("throws when a second Telegram-agent birth certificate is reduced", async () => {
    const h = makeAgentHarness();
    await h.play(["append", AGENT_BORN]);

    await expect(h.append(AGENT_BORN)).rejects.toThrow(
      "more than one telegram-agent/created event",
    );
  });

  it("turns a routed human message into triggering agent context, then shows typing", async () => {
    const h = makeAgentHarness();
    await h.play([
      "append",
      AGENT_BORN,
      webhook(humanMessageWebhookPayload({ text: "hello agent" })),
    ]);

    const inputs = contextAddedEvents(h);
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
          streamPath: CHAT_PATH,
          offset: 2,
          eventType: "events.iterate.com/telegram/webhook-received",
        },
      ],
    });
    expect(payload.content).toContain("telegram/webhook-received");
    expect(payload.content).toContain("hello agent");
    // The contract default (triggering) policy applies.
    expect(payload.llmRequestPolicy).toEqual({ behaviour: "after-current-request" });

    // The typing action fired for the chat, AFTER the input committed —
    // the indicator must not signal receipt of a message that could still
    // be lost. chat_id goes back as the integer Telegram issued.
    expect(h.telegramCalls).toEqual([
      { method: "sendChatAction", body: { action: "typing", chat_id: CHAT_ID } },
    ]);
    expect(h.calls).toEqual([
      "append:events.iterate.com/telegram-agent/created",
      "append:events.iterate.com/telegram/webhook-received",
      "append:events.iterate.com/agents/context-added",
      "telegram:sendChatAction",
    ]);

    expect(h.state()).toMatchObject({ botId: BOT_ID, chatId: String(CHAT_ID) });
  });

  it("ignores bot-authored updates entirely (no input, no typing)", async () => {
    const h = makeAgentHarness();
    const payload = humanMessageWebhookPayload({});
    (payload.body.message as Record<string, unknown>).from = {
      id: 999,
      is_bot: true,
      first_name: "iterate",
    };
    await h.play(["append", AGENT_BORN, webhook(payload)]);

    expect(contextAddedEvents(h)).toHaveLength(0);
    expect(h.telegramCalls).toHaveLength(0);
  });

  it("records message edits as non-triggering input without typing", async () => {
    const h = makeAgentHarness();
    const payload = humanMessageWebhookPayload({ text: "edited!" });
    const body = payload.body as Record<string, unknown>;
    body.edited_message = body.message;
    delete body.message;
    await h.play(["append", AGENT_BORN, webhook(payload)]);

    const inputs = contextAddedEvents(h);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
    expect(h.telegramCalls).toHaveLength(0);
  });

  it("treats callback queries (button presses) as triggering input from the presser", async () => {
    const h = makeAgentHarness();
    await h.play([
      "append",
      AGENT_BORN,
      {
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
      },
    ]);

    const inputs = contextAddedEvents(h);
    expect(inputs).toHaveLength(1);
    const payload = inputs[0]!.payload as { content: string; llmRequestPolicy?: unknown };
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
          streamPath: CHAT_PATH,
          offset: 2,
          eventType: "events.iterate.com/telegram/webhook-received",
        },
      ],
    });
  });

  it("transcribes media as bracketed placeholders", async () => {
    const h = makeAgentHarness();
    const payload = humanMessageWebhookPayload({});
    const message = payload.body.message as Record<string, unknown>;
    delete message.text;
    message.photo = [{ file_id: "photo-1", width: 90, height: 90 }];
    message.caption = "look at this";
    await h.play(["append", AGENT_BORN, webhook(payload)]);

    const inputs = contextAddedEvents(h);
    expect(inputs).toHaveLength(1);
    const content = (inputs[0]!.payload as { content: string }).content;
    expect(content).toContain("[photo]");
    expect(content).toContain("file_id: photo-1");
    expect(content).toContain("file_id is in the raw payload");
    expect(content).not.toContain("not directly viewable");
  });

  it("re-sends the typing action while the LLM works, with the chat id from state", async () => {
    const h = makeAgentHarness();
    await h.play(["append", AGENT_BORN, webhook(humanMessageWebhookPayload({}))]);
    h.telegramCalls.length = 0;

    await h.play(["append", llmRequested("llm-request:1")]);
    expect(h.telegramCalls).toEqual([
      { method: "sendChatAction", body: { action: "typing", chat_id: CHAT_ID } },
    ]);
  });

  it("uses the explicit birth certificate as the typing target before any webhook", async () => {
    const h = makeAgentHarness();
    await h.play(["append", AGENT_BORN], ["append", llmRequested("llm-request:1")]);

    expect(h.telegramCalls).toEqual([
      { method: "sendChatAction", body: { action: "typing", chat_id: CHAT_ID } },
    ]);
  });

  it("refold safety (#1807): a full replay re-transcribes and re-sends but never re-types stale messages", async () => {
    // A state-schema deploy discards the checkpoint and refolds the WHOLE
    // stream. Seed the stream the way history accumulates (no processor yet),
    // then move the clock an hour past every stamp and let a fresh
    // incarnation catch up from offset zero. The durable lanes (agent
    // context, the journaled send) must run; the user-visible typing acks are
    // stale — re-typing months-old messages is a rate-limit burst.
    const clock = { now: Date.parse("2026-07-09T12:00:00Z") };
    const network = new MemoryStreamNetwork(() => clock.now);
    const stream = network.get(CHAT_PATH);
    await stream.append(
      AGENT_BORN,
      webhook(humanMessageWebhookPayload({ text: "hello from the past" })),
      llmRequested("llm-request:1"),
      { type: "events.iterate.com/telegram/send-requested", payload: { text: "an old reply" } },
    );
    clock.now += 60 * 60_000; // well past the typing freshness horizon

    const h = makeAgentHarness({ clock, network });
    await h.settle();

    // Durable lanes ran: the message reached the agent, and the reply was
    // delivered (its stream marker was absent, so the obligation is NOT
    // freshness-gated).
    expect(contextAddedEvents(h)).toHaveLength(1);
    expect(h.sentMessages).toEqual([{ chat_id: CHAT_ID, text: "an old reply" }]);
    // But NO typing ack (arrival OR "still working") on a stale replay.
    expect(h.telegramCalls.filter((call) => call.method === "sendChatAction")).toHaveLength(0);

    // A SECOND full replay (fresh cursor, marker now present) leaves the
    // stream byte-identical: the transcription dedupes on its key and the
    // marked send is never re-sent.
    const journalledOffsets = h.events().map((row) => row.offset);
    const replay = makeAgentHarness({ clock, network, progress: makeMemoryProgressStore() });
    await replay.settle();
    expect(replay.events().map((row) => row.offset)).toEqual(journalledOffsets);
    expect(replay.sentMessages).toEqual([]);
    expect(replay.telegramCalls).toHaveLength(0);
  });

  it("carries an unpainted typing fact across a behind-head frame to the at-head repaint", async () => {
    // Both events land in ONE batch: the lifecycle fact is delivered BEHIND
    // the head (only the batch's last event carries `caughtUp`), and the
    // frame that reaches head carries no typing-worthy fact of its own — a
    // bot-authored webhook, consumed but inert. The carried fact paints
    // exactly once at head, never per behind frame.
    const h = makeAgentHarness();
    await h.play(["append", AGENT_BORN, webhook(humanMessageWebhookPayload({}))]);
    h.telegramCalls.length = 0;

    const botEcho = humanMessageWebhookPayload({ messageId: 2 });
    (botEcho.body.message as Record<string, unknown>).from = {
      id: 999,
      is_bot: true,
      first_name: "iterate",
    };
    await h.play(["append", llmRequested("llm-request:1"), webhook(botEcho)]);

    expect(h.telegramCalls).toEqual([
      { method: "sendChatAction", body: { action: "typing", chat_id: CHAT_ID } },
    ]);
  });

  it("delivers a send-requested, marks it, and claims the message on the connection stream", async () => {
    const agentPath = `${CHAT_PATH}/session-5000`;
    const h = makeAgentHarness({ agentPath });
    await h.play([
      "append",
      AGENT_BORN,
      {
        type: "events.iterate.com/telegram/send-requested",
        payload: { text: "hello from the agent" },
      },
    ]);
    const request = h.events("events.iterate.com/telegram/send-requested")[0]!;

    // chat_id came from the stream path — the agent only supplied text.
    expect(h.sentMessages).toEqual([{ chat_id: CHAT_ID, text: "hello from the agent" }]);

    // The marker satisfies the obligation on the session stream…
    const markers = h.events("events.iterate.com/telegram/message-sent");
    expect(markers).toHaveLength(1);
    expect(markers[0]!.payload).toEqual({ messageId: 9001, requestOffset: request.offset });

    // …and the claim on the connection stream gives the router provenance.
    const claims = h.network.eventsAt(CONNECTION_PATH);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.payload).toEqual({
      chatId: String(CHAT_ID),
      messageId: 9001,
      request: { offset: request.offset, stream: agentPath },
      sessionPath: agentPath,
    });
  });

  it("holds the checkpoint when delivery fails, then retries into exactly one marker", async () => {
    const h = makeAgentHarness();
    await h.play(["append", AGENT_BORN]);
    h.sendFailures.push(new Error("telegram is down"));

    // Unmet obligation: the frame rejects and the cursor holds, so the next
    // pass replays this request until a marker exists.
    await expect(
      h.append({
        type: "events.iterate.com/telegram/send-requested",
        payload: { text: "must arrive" },
      }),
    ).rejects.toThrow(/telegram is down/);
    await expect(h.runner().snapshot()).resolves.toMatchObject({ offset: 1 });
    expect(h.events("events.iterate.com/telegram/message-sent")).toHaveLength(0);

    // Replay: the send goes through this time — one send, one marker.
    await h.settle();
    expect(h.sentMessages).toHaveLength(1);
    expect(h.events("events.iterate.com/telegram/message-sent")).toHaveLength(1);
  });

  it("forces the stream's chat over a payload-supplied chat_id/message_thread_id (thread-bound sends)", async () => {
    const h = makeAgentHarness();
    await h.play([
      "append",
      AGENT_BORN,
      {
        type: "events.iterate.com/telegram/send-requested",
        // A confused (or mischievous) agent aims the journaled send at another
        // chat. Not a capability boundary — raw sendMessage can post anywhere —
        // but the claim records THIS stream as the message's thread, so the
        // delivery must actually go here: path identity wins, the payload's
        // chat coordinates are ignored (reply_to_message_id stays overridable).
        payload: { chat_id: 999999, message_thread_id: 55, reply_to_message_id: 7, text: "hi" },
      },
    ]);

    expect(h.sentMessages).toEqual([
      { chat_id: CHAT_ID, reply_to_message_id: 7, text: "hi" }, // no message_thread_id: the path has no topic
    ]);
    const claims = h.network.eventsAt(CONNECTION_PATH);
    expect(claims[0]!.payload).toMatchObject({ chatId: String(CHAT_ID), sessionPath: CHAT_PATH });
  });

  it("never re-sends a MARKED request on replay (the crash-after-marker case)", async () => {
    const h = makeAgentHarness();
    await h.play([
      "append",
      AGENT_BORN,
      {
        type: "events.iterate.com/telegram/send-requested",
        payload: { text: "already delivered" },
      },
    ]);
    expect(h.sentMessages).toHaveLength(1);

    // Simulate a crash after the marker landed but before the cursor
    // advanced: a fresh incarnation (fresh progress store) replays the
    // request. The stream shows the marker, so the send must NOT fire again
    // (the marker is what "satisfied" means).
    const replay = makeAgentHarness({
      clock: h.clock,
      network: h.network,
      progress: makeMemoryProgressStore(),
    });
    await replay.settle();
    expect(replay.sentMessages).toHaveLength(0);
    expect(h.events("events.iterate.com/telegram/message-sent")).toHaveLength(1);
  });

  it("quotes the answered message only when newer messages arrived since (deterministic reply_to)", async () => {
    const h = makeAgentHarness();

    // Turn 1: message 10 → LLM turn → send. Message 10 is still the latest
    // inbound, so quoting it would be noise: no reply_to_message_id.
    await h.play([
      "append",
      AGENT_BORN,
      webhook(humanMessageWebhookPayload({ messageId: 10, text: "first question" })),
      llmRequested("llm-request:1"),
      { type: "events.iterate.com/telegram/send-requested", payload: { text: "answer to 10" } },
    ]);
    expect(h.sentMessages.at(-1)).not.toHaveProperty("reply_to_message_id");

    // Turn 2: message 11 starts a turn, then message 12 arrives BEFORE the
    // agent's send. The answer is now stale-positioned: quote message 11.
    await h.play([
      "append",
      webhook(humanMessageWebhookPayload({ messageId: 11, text: "second question" })),
      llmRequested("llm-request:2"),
      webhook(humanMessageWebhookPayload({ messageId: 12, text: "and another thing" })),
      { type: "events.iterate.com/telegram/send-requested", payload: { text: "answer to 11" } },
    ]);
    expect(h.sentMessages.at(-1)).toMatchObject({ reply_to_message_id: 11, text: "answer to 11" });

    // An explicit reply_to_message_id from the agent always wins.
    await h.play([
      "append",
      {
        type: "events.iterate.com/telegram/send-requested",
        payload: { reply_to_message_id: 10, text: "explicitly quoting 10" },
      },
    ]);
    expect(h.sentMessages.at(-1)).toMatchObject({ reply_to_message_id: 10 });
  });

  it("acknowledges a bare /new with the fixed message and no LLM turn", async () => {
    const h = makeAgentHarness();
    await h.play(["append", AGENT_BORN, webhook(humanMessageWebhookPayload({ text: "/new" }))]);

    // The ack rides the journaled send pair (delivered + marked)…
    expect(h.sentMessages).toEqual([{ chat_id: CHAT_ID, text: TELEGRAM_NEW_SESSION_ACK_TEXT }]);
    // …and the transcript records the /new WITHOUT waking the agent.
    const inputs = contextAddedEvents(h);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
  });

  it("treats '/new trailing text' as the fresh session's first (triggering) message", async () => {
    const h = makeAgentHarness({ agentPath: `${CHAT_PATH}/session-6000` });
    await h.play([
      "append",
      AGENT_BORN,
      webhook(humanMessageWebhookPayload({ date: 6000, text: "/new plan my week" })),
    ]);

    expect(h.sentMessages).toEqual([{ chat_id: CHAT_ID, text: TELEGRAM_NEW_SESSION_ACK_TEXT }]);
    const inputs = contextAddedEvents(h);
    expect(inputs).toHaveLength(1);
    const payload = inputs[0]!.payload as { content: string; llmRequestPolicy?: unknown };
    expect(payload.content).toContain('"plan my week"');
    expect(payload.llmRequestPolicy).toEqual({ behaviour: "after-current-request" });

    // Ordering: the fixed ack's request precedes the triggering input, so the
    // acknowledgement lands in the chat before the agent's answer.
    const types = h.events().map((event) => event.type);
    expect(types.indexOf("events.iterate.com/telegram/send-requested")).toBeLessThan(
      types.indexOf("events.iterate.com/agents/context-added"),
    );
  });

  it("compiles /debug into a script execution (no LLM turn) that posts via the journaled send", async () => {
    const agentPath = `${CHAT_PATH}/session-8000`;
    const h = makeAgentHarness({ agentPath });

    // Telegram appends @BotUsername to commands in group chats.
    await h.play([
      "append",
      AGENT_BORN,
      webhook(humanMessageWebhookPayload({ text: "/debug@MishasHelperBot" })),
    ]);

    const scripts = h.events("events.iterate.com/capability-host/script-run-requested");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({
      idempotencyKey: "telegram-agent:debug-command:2",
      payload: { executionId: "telegram-debug-command-2" },
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
    expect(contextAddedEvents(h)).toHaveLength(0);

    // The request body is DETERMINISTIC (expiresAt anchors to the webhook's
    // createdAt, never `now`), so an at-least-once replay long after the
    // clock moved re-appends the identical request and dedupes on the key —
    // a now-stamped expiry would be a same-key conflict wedging the frame.
    const command = h.events("events.iterate.com/telegram/webhook-received")[0]!;
    expect((scripts[0]!.payload as { expiresAt: number }).expiresAt).toBe(
      Date.parse(command.createdAt) + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS,
    );
    await h.advanceTime(60 * 60_000);
    const replay = makeAgentHarness({
      agentPath,
      clock: h.clock,
      network: h.network,
      progress: makeMemoryProgressStore(),
    });
    await replay.settle(); // a wedge would throw here
    expect(replay.events("events.iterate.com/capability-host/script-run-requested")).toHaveLength(
      1,
    );
  });

  it("renders the router's reply hint in the transcription with the referenced stream path", async () => {
    const h = makeAgentHarness({ agentPath: `${CHAT_PATH}/session-7000` });
    const oldSession = `${CHAT_PATH}/session-1000`;
    const payload = {
      ...humanMessageWebhookPayload({
        replyToMessage: { message_id: 500, from: { id: 999, is_bot: true }, date: 900, text: "hi" },
        text: "one more question about this",
      }),
      replyHint: { resolvedBy: "sent-claim", sessionPath: oldSession },
    };
    await h.play(["append", AGENT_BORN, webhook(payload)]);

    const inputs = contextAddedEvents(h);
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
    const oldSession = network.get(`${CHAT_PATH}/session-1000`);
    await oldSession.append(
      { type: "events.iterate.com/stream/subscriber-connected", payload: {} },
      webhook(humanMessageWebhookPayload({ text: "what's the wifi password?" })),
      {
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "developer",
          content: "transcribed...",
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
      { type: "events.iterate.com/agent/llm-request-requested", payload: { requestId: "r1" } },
      { type: "events.iterate.com/telegram/send-requested", payload: { text: "It's hunter2." } },
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
