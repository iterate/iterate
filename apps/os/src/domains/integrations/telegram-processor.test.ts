// The Telegram webhook ROUTER's executable spec, on the generic step harness
// from iterate/processors/testing: the REAL StreamProcessorRunner over a
// MemoryStreamNetwork (so cross-stream forwards are observable next to
// same-stream appends), virtual time for the notification freshness gates,
// and production idempotency semantics (a same-key append with a different
// body is REJECTED). The Bot API fakes (sendMessage for welcome/denial
// notifications, the access-settings URL) are the router's only vendor
// surface, wired in createProcessor.

import { describe, expect, it } from "vitest";
import type { ConsumedInput, StreamEventInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStreamNetwork,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import { telegramAgentSystemPrompt } from "../agents/agent-defaults.ts";
import {
  TELEGRAM_ACCESS_WELCOME_TEXT,
  TelegramProcessor,
} from "./telegram-processor-implementation.ts";
import { TelegramProcessorContract } from "./telegram-processor-contract.ts";
import { buildTelegramAccessSettingsUrl } from "./utils.ts";

type RouterEventInput = ConsumedInput<TelegramProcessorContract>;

const BOT_ID = "7000001";
const CONNECTION = "mishas-helper-bot";
const CHAT_ID = 42424242;
const ROUTER_PATH = `/integrations/telegram/${CONNECTION}`;
const CHAT_PATH = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`;
const SETTINGS_URL = `https://os.iterate.com/projects/acme/integrations?telegramAccess=${CONNECTION}`;

const ROUTER_CREATED = {
  type: "events.iterate.com/telegram/created",
  payload: { config: { connection: CONNECTION } },
} satisfies RouterEventInput;

/** The usual birth bundle: the router exists and user 555 is allowed. */
const NEW_ROUTER_EVENTS = [
  ROUTER_CREATED,
  {
    type: "events.iterate.com/telegram/access-configured",
    payload: { allowedUserIds: ["555"] },
  },
] satisfies RouterEventInput[];

function humanMessageWebhookPayload(input: {
  chatId?: number;
  chatType?: string;
  date?: number;
  messageId?: number;
  replyToMessage?: Record<string, unknown>;
  text?: string;
  updateId?: number;
  userId?: number;
}) {
  return {
    botId: BOT_ID,
    body: {
      update_id: input.updateId ?? 100001,
      message: {
        message_id: input.messageId ?? 1,
        from: {
          id: input.userId ?? 555,
          is_bot: false,
          first_name: "Misha",
          username: "misha",
        },
        chat: { id: input.chatId ?? CHAT_ID, type: input.chatType ?? "private" },
        date: input.date ?? 1_760_000_000,
        text: input.text ?? "hello agent",
        ...(input.replyToMessage && { reply_to_message: input.replyToMessage }),
      },
    },
  };
}

function webhook(payload: ReturnType<typeof humanMessageWebhookPayload>): RouterEventInput {
  return { type: "events.iterate.com/telegram/webhook-received", payload };
}

function webhooksAt(network: MemoryStreamNetwork, path: string) {
  return network
    .eventsAt(path)
    .filter((event) => event.type === "events.iterate.com/telegram/webhook-received");
}

/**
 * The generic harness plus the router's Bot API fakes. The substrate stream
 * comes from a MemoryStreamNetwork sharing the virtual clock, so forwards to
 * routed chat/session streams are observable and correctly timestamped. Pass
 * a previous harness's substrate (+ network) with a fresh progress store to
 * replay the same stream from offset zero — the refold recipe. Errors queued
 * on `notificationFailures` fail the next welcome/denial sendMessage calls
 * (they are best-effort background attempts and must never wedge routing).
 */
function makeRouterHarness(substrate?: HarnessSubstrate & { network: MemoryStreamNetwork }) {
  const clock = substrate?.clock ?? { now: Date.parse("2026-07-09T12:00:00Z") };
  const network = substrate?.network ?? new MemoryStreamNetwork(() => clock.now);
  const stream = substrate?.stream ?? network.get(ROUTER_PATH);
  const telegramCalls: { body: Record<string, unknown>; connection: string }[] = [];
  const notificationFailures: Error[] = [];
  const harness = makeProcessorHarness<TelegramProcessorContract>({
    createProcessor: (deps) =>
      new TelegramProcessor({
        ...deps,
        sendTelegramMessage: async (input) => {
          const failure = notificationFailures.shift();
          if (failure) throw failure;
          telegramCalls.push(input);
        },
        telegramAccessSettingsUrl: async () => SETTINGS_URL,
      }),
    substrate: {
      clock,
      stream,
      progress: substrate?.progress ?? makeMemoryProgressStore(TelegramProcessorContract),
    },
  });
  return { ...harness, network, notificationFailures, telegramCalls };
}

describe("TelegramProcessor (webhook router)", () => {
  it("ignores a second Telegram-router birth certificate during reduction", async () => {
    const h = makeRouterHarness();
    await h.play(["append", ...NEW_ROUTER_EVENTS]);
    await h.append(ROUTER_CREATED);
    expect(h.state().birthCertificate).toEqual(ROUTER_CREATED.payload);
  });

  it("forwards a private-chat message to the chat's agent stream, verbatim", async () => {
    const h = makeRouterHarness();
    await h.play(["append", ...NEW_ROUTER_EVENTS, webhook(humanMessageWebhookPayload({}))]);

    const allRouted = h.network.eventsAt(CHAT_PATH);
    expect(allRouted.slice(0, 7).map((event) => event.type)).toEqual([
      "events.iterate.com/agent/created",
      "events.iterate.com/agent/binding-set",
      "events.iterate.com/capability-host/created",
      "events.iterate.com/telegram-agent/created",
      "events.iterate.com/agent/configured",
      "events.iterate.com/agents/context-added",
      "events.iterate.com/capability-host/capability-provided",
    ]);
    expect(allRouted[1]!.payload).toEqual({
      type: "telegram_thread",
      chatId: String(CHAT_ID),
      connection: CONNECTION,
    });
    expect(
      allRouted.filter(
        (event) => event.type === "events.iterate.com/stream/subscription-configured",
      ),
    ).toHaveLength(4);
    expect(
      allRouted.find(
        (event) =>
          event.type === "events.iterate.com/agents/context-added" &&
          (event.payload as { key?: string }).key === "agent/system-prompt",
      ),
    ).toMatchObject({
      payload: {
        content: telegramAgentSystemPrompt({
          agentPath: CHAT_PATH,
          chatId: String(CHAT_ID),
          connection: CONNECTION,
        }),
        key: "agent/system-prompt",
        role: "system",
      },
    });
    const routed = webhooksAt(h.network, CHAT_PATH);
    expect(routed).toHaveLength(1);
    expect(routed[0]!.payload).toEqual(humanMessageWebhookPayload({}));
  });

  it("does not create an agent or forward a message from a user outside the allowlist", async () => {
    const h = makeRouterHarness();
    await h.play([
      "append",
      ROUTER_CREATED,
      {
        type: "events.iterate.com/telegram/access-configured",
        payload: { allowedUserIds: ["999"] },
      },
      webhook(humanMessageWebhookPayload({})),
    ]);

    expect(h.network.eventsAt(CHAT_PATH)).toEqual([]);
  });

  it("welcomes only users newly added by an access-configured event", async () => {
    const h = makeRouterHarness();
    await h.play(
      ["append", ROUTER_CREATED],
      [
        "append",
        {
          type: "events.iterate.com/telegram/access-configured",
          payload: { allowedUserIds: ["555"] },
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/telegram/access-configured",
          payload: { allowedUserIds: ["555", "777"] },
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/telegram/access-configured",
          payload: { allowedUserIds: ["777"] },
        },
      ],
    );

    expect(h.telegramCalls).toEqual([
      { connection: CONNECTION, body: { chat_id: 555, text: TELEGRAM_ACCESS_WELCOME_TEXT } },
      { connection: CONNECTION, body: { chat_id: 777, text: TELEGRAM_ACCESS_WELCOME_TEXT } },
    ]);
  });

  it("preserves allowed legacy /new history when the first access policy is configured", async () => {
    const h = makeRouterHarness();
    await h.play([
      "append",
      ROUTER_CREATED,
      // Legacy pre-allowlist history: two users started sessions.
      webhook(humanMessageWebhookPayload({ date: 1000, messageId: 1, text: "/new", userId: 555 })),
      webhook(humanMessageWebhookPayload({ date: 2000, messageId: 2, text: "/new", userId: 999 })),
      {
        type: "events.iterate.com/telegram/access-configured",
        payload: { allowedUserIds: ["555"] },
      },
    ]);

    expect(h.state().sessionsByChat[`chat-${CHAT_ID}`]).toEqual([
      {
        date: 1000,
        messageId: 1,
        senderId: "555",
        sessionPath: `${CHAT_PATH}/session-1000`,
      },
    ]);
  });

  it("does not let a denied /new command rotate an allowed user's live chat session", async () => {
    const h = makeRouterHarness();
    await h.play([
      "append",
      ...NEW_ROUTER_EVENTS,
      webhook(humanMessageWebhookPayload({ date: 1000, messageId: 1, text: "/new" })),
      {
        type: "events.iterate.com/telegram/access-configured",
        payload: { allowedUserIds: ["999"] },
      },
      webhook(humanMessageWebhookPayload({ date: 2000, messageId: 2, text: "/new" })),
    ]);

    expect(h.state().sessionsByChat[`chat-${CHAT_ID}`]).toEqual([
      {
        date: 1000,
        messageId: 1,
        senderId: "555",
        sessionPath: `${CHAT_PATH}/session-1000`,
      },
    ]);
  });

  it("denies updates without a human sender identity", async () => {
    const h = makeRouterHarness();
    const payload = humanMessageWebhookPayload({});
    delete (payload.body.message as Record<string, unknown>).from;
    await h.play(["append", ...NEW_ROUTER_EVENTS, webhook(payload)]);

    expect(h.network.eventsAt(CHAT_PATH)).toEqual([]);
  });

  it("tells a denied user which id an owner must add and links to this bot's access settings", async () => {
    const h = makeRouterHarness();
    await h.play([
      "append",
      ROUTER_CREATED,
      {
        type: "events.iterate.com/telegram/access-configured",
        payload: { allowedUserIds: [] },
      },
      webhook(humanMessageWebhookPayload({})),
    ]);

    expect(
      h.telegramCalls.filter(({ body }) => String(body.text).startsWith("Access denied.")),
    ).toEqual([
      {
        connection: CONNECTION,
        body: {
          chat_id: CHAT_ID,
          text: [
            "Access denied. This Telegram account is not allowed to use this iterate project.",
            "Ask a project owner to add Telegram user ID 555 to this bot's allowlist:",
            SETTINGS_URL,
            "You can forward this message to them.",
          ].join("\n\n"),
        },
      },
    ]);
  });

  it("sends a forum-topic denial back to the topic where the user wrote", async () => {
    const h = makeRouterHarness();
    const payload = humanMessageWebhookPayload({ chatId: -1004242, chatType: "supergroup" });
    const message = payload.body.message as Record<string, unknown>;
    message.is_topic_message = true;
    message.message_thread_id = 77;
    await h.play([
      "append",
      ROUTER_CREATED,
      {
        type: "events.iterate.com/telegram/access-configured",
        payload: { allowedUserIds: [] },
      },
      webhook(payload),
    ]);

    expect(
      h.telegramCalls.find(({ body }) => String(body.text).startsWith("Access denied."))?.body,
    ).toMatchObject({ chat_id: -1004242, message_thread_id: 77 });
  });

  it("does not block allowed traffic when best-effort access notifications fail", async () => {
    const h = makeRouterHarness();
    // Fail every notification this scenario produces (one denial, one
    // welcome): a user who blocked the bot must never wedge the router.
    h.notificationFailures.push(
      new Error("user blocked the bot"),
      new Error("user blocked the bot"),
    );
    await h.play([
      "append",
      ROUTER_CREATED,
      {
        type: "events.iterate.com/telegram/access-configured",
        payload: { allowedUserIds: [] },
      },
      webhook(humanMessageWebhookPayload({ messageId: 1, text: "denied" })),
      {
        type: "events.iterate.com/telegram/access-configured",
        payload: { allowedUserIds: ["555"] },
      },
      webhook(humanMessageWebhookPayload({ messageId: 2, text: "allowed" })),
    ]);

    expect(webhooksAt(h.network, CHAT_PATH)).toHaveLength(1);
  });

  it("routes forum-topic messages to a per-topic stream, negative group ids verbatim", async () => {
    const h = makeRouterHarness();
    const payload = humanMessageWebhookPayload({ chatId: -1004242, chatType: "supergroup" });
    const message = payload.body.message as Record<string, unknown>;
    message.is_topic_message = true;
    message.message_thread_id = 77;
    await h.play(["append", ...NEW_ROUTER_EVENTS, webhook(payload)]);

    // The sign is significant (chat 1004242 and supergroup -1004242 must not
    // collide), so the id is used verbatim, minus and all.
    expect(
      webhooksAt(h.network, `/agents/telegram/${CONNECTION}/chat--1004242/topic-77`),
    ).toHaveLength(1);
  });

  it("drops chat-less updates (inline queries) without creating any stream", async () => {
    const h = makeRouterHarness();
    await h.play([
      "append",
      ...NEW_ROUTER_EVENTS,
      {
        type: "events.iterate.com/telegram/webhook-received",
        payload: {
          botId: BOT_ID,
          body: {
            update_id: 5,
            inline_query: { id: "q1", from: { id: 7, is_bot: false }, query: "cats" },
          },
        },
      },
    ]);

    expect(h.network.streams.size).toBe(1); // nothing forwarded anywhere
  });

  it("ignores connected/disconnected lifecycle facts (status is a stream read, not router state)", async () => {
    const h = makeRouterHarness();
    await h.play(["append", ...NEW_ROUTER_EVENTS]);
    // Lifecycle facts are not in the router's consumed vocabulary — appended
    // raw, they must reduce to nothing: the router's whole state is its
    // thread model plus the access policy.
    await h.stream.append(
      {
        type: "events.iterate.com/telegram/connected",
        payload: { botId: BOT_ID, connection: CONNECTION, projectId: "prj_1" },
      },
      {
        type: "events.iterate.com/telegram/disconnected",
        payload: { botId: BOT_ID, projectId: "prj_1" },
      },
    );
    await h.settle();

    expect(h.state()).toEqual({
      accessPolicyConfigured: true,
      allowedUserIds: ["555"],
      birthCertificate: { config: { connection: CONNECTION } },
      sessionsByChat: {},
      sentMessages: {},
    });
    expect(h.network.streams.size).toBe(1);
  });

  it("does nothing before its explicit birth certificate", async () => {
    const h = makeRouterHarness();
    await h.play(["append", webhook(humanMessageWebhookPayload({}))]);

    expect(h.network.streams.size).toBe(1);
    expect(h.telegramCalls).toEqual([]);
  });

  it("replays the webhook when the forward append fails instead of dropping it", async () => {
    const h = makeRouterHarness();
    const routed = h.network.get(CHAT_PATH);
    const originalRoutedAppend = routed.append.bind(routed);
    let failNextForward = true;
    routed.append = async (...inputs: StreamEventInput[]) => {
      if (failNextForward) {
        failNextForward = false;
        throw new Error("cold StreamsCapability RPC failed");
      }
      return originalRoutedAppend(...inputs);
    };
    await h.play(["append", ...NEW_ROUTER_EVENTS]);
    await expect(h.runner().snapshot()).resolves.toMatchObject({ offset: 2 });

    // First delivery: the forward throws. The pass MUST reject and the
    // cursor MUST hold — otherwise the message is gone for good.
    await expect(h.append(webhook(humanMessageWebhookPayload({})))).rejects.toThrow(
      /StreamsCapability/,
    );
    await expect(h.runner().snapshot()).resolves.toMatchObject({ offset: 2 });
    expect(routed.events).toHaveLength(0);

    // The runner replays the same webhook from the un-advanced cursor; the
    // forward now succeeds and the cursor advances.
    await h.settle();
    await expect(h.runner().snapshot()).resolves.toMatchObject({ offset: 3 });
    const routedCount = routed.events.length;
    expect(routed.events.slice(0, 7).map((event) => event.type)).toEqual([
      "events.iterate.com/agent/created",
      "events.iterate.com/agent/binding-set",
      "events.iterate.com/capability-host/created",
      "events.iterate.com/telegram-agent/created",
      "events.iterate.com/agent/configured",
      "events.iterate.com/agents/context-added",
      "events.iterate.com/capability-host/capability-provided",
    ]);
    expect(routed.events.at(-1)?.type).toBe("events.iterate.com/telegram/webhook-received");

    // A full replay (a fresh cursor over the same stream) dedupes on the
    // forward's idempotency key.
    const replay = makeRouterHarness({
      clock: h.clock,
      network: h.network,
      progress: makeMemoryProgressStore(TelegramProcessorContract),
      stream: h.stream,
    });
    await replay.settle();
    expect(routed.events).toHaveLength(routedCount);
  });

  it("/new rotates the chat to a fresh session stream; /new itself routes into it", async () => {
    const h = makeRouterHarness();
    await h.play([
      "append",
      ...NEW_ROUTER_EVENTS,
      // Pre-/new history is session zero: the bare chat path, exactly v1.
      webhook(humanMessageWebhookPayload({ date: 1000, messageId: 1, text: "old world" })),
      webhook(humanMessageWebhookPayload({ date: 2000, messageId: 2, text: "/new" })),
      webhook(humanMessageWebhookPayload({ date: 2500, messageId: 3, text: "new world" })),
    ]);

    expect(webhooksAt(h.network, CHAT_PATH)).toHaveLength(1);
    // The /new message AND everything after it land in the session stream.
    const session = webhooksAt(h.network, `${CHAT_PATH}/session-2000`);
    expect(session).toHaveLength(2);
    expect(
      session.map(
        (event) => (event.payload as { body: { message: { text: string } } }).body.message.text,
      ),
    ).toEqual(["/new", "new world"]);
  });

  it("orders same-second /new pairs by message_id and never rolls the session backwards", async () => {
    const h = makeRouterHarness();
    await h.play([
      "append",
      ...NEW_ROUTER_EVENTS,
      webhook(humanMessageWebhookPayload({ date: 3000, messageId: 10, text: "/new" })),
      // Same unix second, higher message_id: the tie-break keeps this one as
      // the live session start (same path — date-named).
      webhook(humanMessageWebhookPayload({ date: 3000, messageId: 11, text: "/new again" })),
    ]);
    expect(h.state().sessionsByChat[`chat-${CHAT_ID}`]).toMatchObject([
      { date: 3000, messageId: 10 },
      { date: 3000, messageId: 11 },
    ]);

    // A duplicate/out-of-order replay of the earlier /new must not win.
    await h.play([
      "append",
      webhook(
        humanMessageWebhookPayload({ date: 3000, messageId: 10, text: "/new", updateId: 42 }),
      ),
    ]);
    expect(h.state().sessionsByChat[`chat-${CHAT_ID}`]!.at(-1)).toMatchObject({ messageId: 11 });
  });

  it("group-chat /new@BotName and trailing text both rotate the session", async () => {
    const h = makeRouterHarness();
    await h.play([
      "append",
      ...NEW_ROUTER_EVENTS,
      webhook(
        humanMessageWebhookPayload({
          date: 4000,
          messageId: 20,
          text: "/new@MishasHelperBot let's plan a trip",
        }),
      ),
    ]);

    expect(webhooksAt(h.network, `${CHAT_PATH}/session-4000`)).toHaveLength(1);
  });

  it("annotates replies to bot messages with the EXACT thread from the sent claim", async () => {
    const h = makeRouterHarness();
    const oldSession = `${CHAT_PATH}/session-1000`;
    await h.play([
      "append",
      ...NEW_ROUTER_EVENTS,
      // The telegram-agent send obligation copies this claim after each
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
      webhook(humanMessageWebhookPayload({ date: 5000, messageId: 30, text: "/new" })),
      // …and now the human replies to the OLD bot message.
      webhook(
        humanMessageWebhookPayload({
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
      ),
    ]);

    // Routing is untouched (latest session); the hint names the old thread.
    const session = webhooksAt(h.network, `${CHAT_PATH}/session-5000`);
    expect(session).toHaveLength(2);
    expect(session[1]!.payload).toMatchObject({
      replyHint: { resolvedBy: "sent-claim", sessionPath: oldSession },
    });
  });

  it("falls back to the reply date for user messages: containing session, or session zero when older than the first /new", async () => {
    const h = makeRouterHarness();
    const userMessage = (messageId: number, date: number) => ({
      message_id: messageId,
      from: { id: 555, is_bot: false, first_name: "Misha" },
      date,
      text: `message ${messageId}`,
    });
    await h.play([
      "append",
      ...NEW_ROUTER_EVENTS,
      webhook(humanMessageWebhookPayload({ date: 1000, messageId: 40, text: "/new" })),
      webhook(humanMessageWebhookPayload({ date: 2000, messageId: 42, text: "/new" })),
      // Reply to a user message dated INSIDE the first session (1000..2000).
      webhook(
        humanMessageWebhookPayload({
          date: 3000,
          messageId: 43,
          replyToMessage: userMessage(41, 1500),
          text: "re: that",
        }),
      ),
      // Reply to a user message OLDER than the first /new → session zero.
      webhook(
        humanMessageWebhookPayload({
          date: 3001,
          messageId: 44,
          replyToMessage: userMessage(39, 500),
          text: "re: ancient",
        }),
      ),
      // Reply to a message in the CURRENT session → no hint (it would be noise).
      webhook(
        humanMessageWebhookPayload({
          date: 3002,
          messageId: 45,
          replyToMessage: userMessage(43, 3000),
          text: "re: current",
        }),
      ),
    ]);

    const latestSession = webhooksAt(h.network, `${CHAT_PATH}/session-2000`);
    const [, replyInside, replyAncient, replyCurrent] = latestSession;
    expect(replyInside!.payload).toMatchObject({
      replyHint: { resolvedBy: "reply-date", sessionPath: `${CHAT_PATH}/session-1000` },
    });
    expect(replyAncient!.payload).toMatchObject({
      replyHint: { resolvedBy: "reply-date", sessionPath: CHAT_PATH },
    });
    expect(replyCurrent!.payload).not.toHaveProperty("replyHint");
  });

  it("refold: replaying the stream re-forwards deduped and re-sends NO stale welcome or denial", async () => {
    // THE refold test (docs/writing-stream-processors.md, "Refold safety"):
    // a state-schema deploy discards the checkpoint and replays the WHOLE
    // stream. The forward is a durable obligation — it re-runs and dedupes on
    // its idempotency key. The welcome and denial notifications are
    // user-visible acks, only meaningful near arrival — re-sending months-old
    // ones would spam users (and a burst is a rate-limit crash-loop).
    const h = makeRouterHarness();
    await h.play([
      "append",
      ...NEW_ROUTER_EVENTS,
      webhook(humanMessageWebhookPayload({ messageId: 1, text: "hi" })), // forwarded
      webhook(humanMessageWebhookPayload({ messageId: 2, text: "who dis", userId: 999 })), // denied
    ]);
    expect(h.telegramCalls).toHaveLength(2); // one welcome (555), one denial (999)
    const routedCount = h.network.eventsAt(CHAT_PATH).length;
    expect(routedCount).toBeGreaterThan(2);

    await h.advanceTime(60 * 60_000); // well past the notification freshness horizon

    // A fresh cursor over the SAME stream replays every event from offset 0.
    const replay = makeRouterHarness({
      clock: h.clock,
      network: h.network,
      progress: makeMemoryProgressStore(TelegramProcessorContract),
      stream: h.stream,
    });
    await replay.settle();

    // The stale notifications are skipped; the durable forward replays and
    // dedupes at the append layer, leaving every stream unchanged and the
    // refolded state equal to the live one.
    expect(replay.telegramCalls).toEqual([]);
    expect(h.network.eventsAt(CHAT_PATH)).toHaveLength(routedCount);
    expect(replay.state()).toEqual(h.state());
  });
});

describe("telegramAgentSystemPrompt", () => {
  it("routes replies through the journaled send on the agent's own stream", () => {
    const agentPath = `${CHAT_PATH}/session-5000`;
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
    // Threading guidance: /new sessions + reply hints (read / copy /
    // answer in place) — imperative, with the FILTERED transcript read (an
    // unfiltered getEvents pages through plumbing noise, not conversation).
    expect(prompt).toContain("/new");
    expect(prompt).toContain("READ the referenced thread FIRST");
    expect(prompt).toContain(
      'getEvents({ eventTypes: ["events.iterate.com/telegram/webhook-received", "events.iterate.com/telegram/send-requested"] })',
    );
    expect(prompt).toContain("your judgement");
    // Arbitrary Bot API methods remain available as immediate calls.
    expect(prompt).toContain(`itx.integrations.telegram.get("${CONNECTION}")`);
    // Hint at the available primitives without scripting the agent's work.
    expect(prompt).toContain("the raw webhook retains file_id");
    expect(prompt).toContain(`itx.integrations.telegram.get("${CONNECTION}").getFile`);
    expect(prompt).toContain("project egress with the connection's write-only bot-token secret");
    expect(prompt).toContain("itx.agent.addFiles");
    expect(prompt).not.toContain("you cannot view them yet");
  });
});

describe("buildTelegramAccessSettingsUrl", () => {
  it("targets one project's Telegram connection editor", () => {
    expect(
      buildTelegramAccessSettingsUrl({
        baseUrl: "http://localhost:5173",
        connection: "support-bot",
        projectSlug: "acme",
      }),
    ).toBe("http://localhost:5173/projects/acme/integrations?telegramAccess=support-bot");
  });
});
