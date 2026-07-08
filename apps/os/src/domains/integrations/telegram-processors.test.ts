// The Telegram router + agent processor pair, mirrored from
// slack-processors.test.ts: an in-memory stream network, real processors, no
// module mocks. Helpers live at the bottom of the file.

import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "../streams/schemas.ts";
import type { Stream } from "../../itx-api.generated.ts";
import { telegramAgentSystemPrompt } from "../projects/project-processor-implementation.ts";
import { TelegramProcessor } from "./telegram-processor-implementation.ts";
import { TelegramAgentProcessor } from "./telegram-agent-processor-implementation.ts";

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
    expect(processor.state).toEqual({});
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
});

describe("telegramAgentSystemPrompt", () => {
  it("routes replies through the connection's sendMessage and embeds the chat id", () => {
    const prompt = telegramAgentSystemPrompt({ chatId: String(CHAT_ID), connection: CONNECTION });
    expect(prompt).toContain(`itx.integrations.telegram["${CONNECTION}"].sendMessage`);
    expect(prompt).toContain(`this chat's id is ${CHAT_ID}`);
    expect(prompt).toContain("Never use itx.chat.sendMessage");
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
  text?: string;
  updateId?: number;
}) {
  return {
    botId: BOT_ID,
    body: {
      update_id: input.updateId ?? 100001,
      message: {
        message_id: 1,
        from: { id: 555, is_bot: false, first_name: "Misha", username: "misha" },
        chat: { id: input.chatId ?? CHAT_ID, type: input.chatType ?? "private" },
        date: 1_760_000_000,
        text: input.text ?? "hello agent",
      },
    },
  };
}

function setup() {
  const network = new MemoryStreamNetwork();
  const stream = network.get(`/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`);
  const telegramCalls: Array<{ body: Record<string, unknown>; method: string }> = [];
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
    callTelegramApi: async (method, body) => {
      calls.push(`telegram:${method}`);
      telegramCalls.push({ body, method });
    },
  });
  const cursors = new Map<object, number>();
  return { calls, cursors, network, processor, stream, telegramCalls };
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
    return { coreProcessorState: null, runtime: { connections: {} } };
  }

  async subscribe(): Promise<never> {
    throw new Error("MemoryStream does not implement subscribe().");
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
