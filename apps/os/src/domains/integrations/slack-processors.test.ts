import { describe, expect, it } from "vitest";
import type { Stream, StreamEvent, StreamEventInput } from "../../types.ts";
import { SlackProcessor } from "./slack-processor-implementation.ts";
import {
  SlackAgentProcessor,
  compileBangCommand,
  eyesReactionTargetFromWebhookPayload,
} from "./slack-agent-processor-implementation.ts";

/**
 * In-memory network of streams keyed by path, so router tests can observe the
 * cross-stream forwards (`stream.at(path).append(...)`) next to same-stream
 * appends.
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

  async getEvents(): Promise<StreamEvent[]> {
    return [...this.events];
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

const TEAM_ID = "T0TEAM";

function humanMessageWebhookPayload(input: {
  channel?: string;
  eventId?: string;
  text?: string;
  threadTs?: string;
  ts?: string;
}) {
  return {
    slackTeamId: TEAM_ID,
    headers: { slackEventId: input.eventId ?? "Ev123", slackRequestTimestamp: "1" },
    body: {
      type: "event_callback",
      team_id: TEAM_ID,
      event_id: input.eventId ?? "Ev123",
      authorizations: [{ is_bot: true, user_id: "UBOT", bot_id: "BBOT" }],
      event: {
        type: "message",
        channel: input.channel ?? "C123",
        user: "UHUMAN",
        text: input.text ?? "hello agent",
        ts: input.ts ?? "111.222",
        ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
      },
    },
  };
}

function botMessageWebhookPayload() {
  const payload = humanMessageWebhookPayload({});
  const event = payload.body.event as Record<string, unknown>;
  event.bot_id = "BBOT";
  delete event.user;
  return payload;
}

describe("SlackProcessor (webhook router)", () => {
  it("creates a route and forwards the webhook to the routed agent stream", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack");
    const acked: unknown[] = [];
    const processor = new SlackProcessor({
      stream,
      acknowledgeRoutedWebhook: ({ payload }) => {
        acked.push(payload);
      },
    });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });

    // The route fact lands on the router's own stream…
    const routeEvents = stream.events.filter(
      (event) => event.type === "events.iterate.com/slack/thread-route-configured",
    );
    expect(routeEvents).toHaveLength(1);
    expect(routeEvents[0]!.payload).toMatchObject({
      channel: "C123",
      streamPath: "/agents/slack/c123/ts-111-222",
      threadTs: "111.222",
    });

    // …and the routed stream receives [route, webhook] verbatim.
    const routed = network.eventsAt("/agents/slack/c123/ts-111-222");
    expect(routed.map((event) => event.type)).toEqual([
      "events.iterate.com/slack/thread-route-configured",
      "events.iterate.com/slack/webhook-received",
    ]);
    expect(routed[1]!.payload).toEqual(humanMessageWebhookPayload({}));

    // The fast-ack hook fired once for the forwarded webhook.
    expect(acked).toHaveLength(1);
  });

  it("forwards follow-up webhooks through the reduced routing table", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack");
    const processor = new SlackProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/slack/thread-route-configured",
      payload: {
        channel: "C123",
        threadTs: "111.222",
        streamPath: "/agents/slack/custom-route",
      },
    });
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({ eventId: "Ev456", threadTs: "111.222", ts: "333.444" }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    const routed = network.eventsAt("/agents/slack/custom-route");
    expect(routed.map((event) => event.type)).toEqual([
      "events.iterate.com/slack/webhook-received",
    ]);
    // No duplicate route event: the existing route won.
    expect(
      stream.events.filter(
        (event) => event.type === "events.iterate.com/slack/thread-route-configured",
      ),
    ).toHaveLength(1);
  });

  it("drops item-keyed events (reactions) whose thread has no route", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack");
    const processor = new SlackProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: {
        slackTeamId: TEAM_ID,
        body: {
          type: "event_callback",
          event: {
            type: "reaction_added",
            user: "UHUMAN",
            item: { channel: "C123", ts: "999.999" },
          },
        },
      },
    });
    await deliverNewEvents({ cursors, processor, stream });

    expect(network.streams.size).toBe(1); // nothing forwarded anywhere
    expect(
      stream.events.filter(
        (event) => event.type === "events.iterate.com/slack/thread-route-configured",
      ),
    ).toHaveLength(0);
  });

  it("reduces connected/disconnected facts into connection state", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack");
    const processor = new SlackProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/slack/connected",
      payload: {
        externalId: TEAM_ID,
        projectId: "prj_1",
        teamId: TEAM_ID,
        teamName: "acme",
      },
    });
    await deliverNewEvents({ cursors, processor, stream });
    expect(processor.state.connection).toMatchObject({ status: "connected", teamId: TEAM_ID });

    await stream.append({
      type: "events.iterate.com/slack/disconnected",
      payload: { projectId: "prj_1", teamId: TEAM_ID },
    });
    await deliverNewEvents({ cursors, processor, stream });
    expect(processor.state.connection.status).toBe("disconnected");
  });

  it("acknowledges webhooks forwarded through existing routes", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack");
    const acked: unknown[] = [];
    const processor = new SlackProcessor({
      stream,
      acknowledgeRoutedWebhook: ({ payload }) => {
        acked.push(payload);
      },
    });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/slack/thread-route-configured",
      payload: {
        channel: "C123",
        threadTs: "111.222",
        streamPath: "/agents/slack/custom-route",
      },
    });
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({ threadTs: "111.222", ts: "333.444" }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    // The fast ack fires on the known-route path too, not just route creation.
    expect(acked).toHaveLength(1);
    expect(network.eventsAt("/agents/slack/custom-route")).toHaveLength(1);
  });

  it("ignores and never acknowledges webhooks that cannot be keyed as channel:thread_ts", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack");
    const acked: unknown[] = [];
    const processor = new SlackProcessor({
      stream,
      acknowledgeRoutedWebhook: ({ payload }) => {
        acked.push(payload);
      },
    });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: { body: { type: "url_verification", challenge: "x" } },
    });
    await deliverNewEvents({ cursors, processor, stream });

    expect(network.streams.size).toBe(1); // nothing forwarded anywhere
    expect(
      stream.events.filter(
        (event) => event.type === "events.iterate.com/slack/thread-route-configured",
      ),
    ).toHaveLength(0);
    expect(acked).toEqual([]);
  });

  it("replays the webhook when the forward append fails instead of dropping it", async () => {
    // Regression for the 2026-06-15 prd loss: the first message on a fresh
    // project reached the project stream but the agent never saw it — the
    // fire-and-forget forward threw once and the only copy was dropped. The
    // forward is a durable obligation under `blockProcessorWhile`: a failed
    // cross-stream append rejects the batch and HOLDS the checkpoint so the
    // host replays the webhook until it lands.
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack");
    const routed = network.get("/agents/slack/c123/ts-111-222");
    const originalRoutedAppend = routed.append.bind(routed);
    let failNextForward = true;
    routed.append = async (...inputs: StreamEventInput[]) => {
      if (failNextForward) {
        failNextForward = false;
        throw new Error("cold StreamsCapability RPC failed");
      }
      return originalRoutedAppend(...inputs);
    };
    const processor = new SlackProcessor({ stream });
    const [webhook] = await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });

    // First delivery: the forward throws. ingest MUST reject and the
    // checkpoint MUST stay at 0 — otherwise the webhook is gone for good.
    await expect(processor.ingest({ events: [webhook!], streamMaxOffset: 1 })).rejects.toThrow(
      /StreamsCapability/,
    );
    expect(processor.checkpointOffset).toBe(0);
    expect(routed.events).toHaveLength(0);

    // The host replays the same webhook from the un-advanced checkpoint; the
    // forward now succeeds and the checkpoint advances.
    await processor.ingest({ events: [webhook!], streamMaxOffset: 1 });
    expect(processor.checkpointOffset).toBe(1);
    expect(routed.events.map((event) => event.type)).toEqual([
      "events.iterate.com/slack/thread-route-configured",
      "events.iterate.com/slack/webhook-received",
    ]);
    // The route fact on the router's own stream deduped via its idempotency
    // key instead of double-appending across the replay.
    expect(
      stream.events.filter(
        (event) => event.type === "events.iterate.com/slack/thread-route-configured",
      ),
    ).toHaveLength(1);
  });
});

describe("SlackAgentProcessor", () => {
  function setup() {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/agents/slack/c123/ts-111-222");
    const slackCalls: Array<{ body: Record<string, unknown>; method: string }> = [];
    const processor = new SlackAgentProcessor({
      stream,
      callSlackApi: async (method, body) => {
        slackCalls.push({ body, method });
      },
    });
    const cursors = new Map<object, number>();
    return { cursors, network, processor, slackCalls, stream };
  }

  it("turns a routed human message into triggering agent input and adds the eyes reaction", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/thread-route-configured",
      payload: {
        channel: "C123",
        threadTs: "111.222",
        streamPath: "/agents/slack/c123/ts-111-222",
      },
    });
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(inputs).toHaveLength(1);
    const payload = inputs[0]!.payload as { content: string; llmRequestPolicy?: unknown };
    expect(payload.content).toContain("slack/webhook-received");
    expect(payload.content).toContain("hello agent");
    // The contract default (triggering) policy applies.
    expect(payload.llmRequestPolicy).toEqual({ behaviour: "after-current-request" });

    expect(slackCalls).toContainEqual({
      method: "reactions.add",
      body: { channel: "C123", name: "eyes", timestamp: "111.222" },
    });

    expect(processor.state).toMatchObject({
      botBotId: "BBOT",
      botUserId: "UBOT",
      channel: "C123",
      latestMessageTs: "111.222",
      threadTs: "111.222",
    });
  });

  it("ignores our own bot's messages entirely", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: botMessageWebhookPayload(),
    });
    await deliverNewEvents({ cursors, processor, stream });

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agent/input-added"),
    ).toHaveLength(0);
    expect(slackCalls).toHaveLength(0);
  });

  it("records non-message events as non-triggering input without an eyes reaction", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: {
        slackTeamId: TEAM_ID,
        body: {
          type: "event_callback",
          event: {
            type: "reaction_added",
            user: "UHUMAN",
            reaction: "tada",
            item: { channel: "C123", ts: "111.222" },
          },
        },
      },
    });
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
    expect(slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });

  it("compiles bang commands into itx script executions instead of agent input", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({ text: "!whoami" }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    const scripts = stream.events.filter(
      (event) => event.type === "events.iterate.com/itx/script-execution-requested",
    );
    expect(scripts).toHaveLength(1);
    expect((scripts[0]!.payload as { code: string }).code).toContain("await itx.whoami()");
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agent/input-added"),
    ).toHaveLength(0);
    expect(slackCalls).toContainEqual({
      method: "reactions.add",
      body: { channel: "C123", name: "eyes", timestamp: "111.222" },
    });
  });

  it("mirrors the LLM request lifecycle into the Slack assistant status", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    // Establish thread context first.
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });
    slackCalls.length = 0;

    await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", provider: "openai-ws", requestId: "llm-request:1" },
    });
    await deliverNewEvents({ cursors, processor, stream });
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "C123",
          thread_ts: "111.222",
          status: "is thinking...",
          loading_messages: ["Thinking..."],
        },
      },
    ]);

    slackCalls.length = 0;
    await stream.append({
      type: "events.iterate.com/agent/llm-request-completed",
      payload: {
        durationMs: 10,
        llmRequestId: 1,
        provider: "openai-ws",
        result: { status: "success" },
      },
    });
    await deliverNewEvents({ cursors, processor, stream });
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: { channel_id: "C123", thread_ts: "111.222", status: "" },
      },
      {
        method: "reactions.remove",
        body: { channel: "C123", name: "eyes", timestamp: "111.222" },
      },
    ]);
  });

  it("captures route context (including streamPath) in state without announcing anything", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/thread-route-configured",
      payload: {
        channel: "C123",
        threadTs: "111.222",
        streamPath: "/agents/slack/c123/ts-111-222",
      },
    });
    await deliverNewEvents({ cursors, processor, stream });

    expect(processor.state).toMatchObject({
      channel: "C123",
      streamPath: "/agents/slack/c123/ts-111-222",
      threadTs: "111.222",
    });
    // The `slack` capability is provided on the agent's own itx context
    // (provideCapability), not announced from here — the route event only
    // folds into state, with no appends and no Slack API calls.
    expect(stream.events).toHaveLength(1);
    expect(slackCalls).toHaveLength(0);
  });

  it("compiles the !debug bang command into a Slack-posting describe script", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({ text: "!debug" }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    const scripts = stream.events.filter(
      (event) => event.type === "events.iterate.com/itx/script-execution-requested",
    );
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({
      idempotencyKey: "slack-agent:bang-command:1",
      payload: { executionId: "slack-bang-command-1" },
    });
    // Legacy called `itx.debug()` and carried an `enqueued` payload flag; on
    // itx the debug dump is `itx.describe()` and the payload is just
    // { code, executionId }.
    const code = (scripts[0]!.payload as { code: string }).code;
    expect(code).toContain("const debug = await itx.describe();");
    expect(code).toContain("await itx.slack.chat.postMessage({");
    expect(code).toContain('channel: "C123"');
    expect(code).toContain('thread_ts: "111.222"');
    expect(code).toContain("text: `Debug info:");
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agent/input-added"),
    ).toHaveLength(0);
    expect(slackCalls).toContainEqual({
      method: "reactions.add",
      body: { channel: "C123", name: "eyes", timestamp: "111.222" },
    });
  });

  it("commits the agent input before adding the Slack eyes reaction", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/agents/slack/c123/ts-111-222");
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });

    // Record appends and Slack API calls into one list to pin their order:
    // the agent input must be durable before the eyes reaction signals
    // receipt to the user.
    const calls: string[] = [];
    const originalAppend = stream.append.bind(stream);
    stream.append = async (...inputs: StreamEventInput[]) => {
      calls.push(...inputs.map((input) => `append:${input.type}`));
      return originalAppend(...inputs);
    };
    const processor = new SlackAgentProcessor({
      stream,
      callSlackApi: async (method) => {
        calls.push(`slack:${method}`);
      },
    });
    const cursors = new Map<object, number>();
    await deliverNewEvents({ cursors, processor, stream });

    expect(calls).toEqual(["append:events.iterate.com/agent/input-added", "slack:reactions.add"]);
  });

  it("turns raw Slack interactivity payloads into triggering agent input", async () => {
    const { cursors, processor, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: {
        slackTeamId: TEAM_ID,
        body: {
          type: "block_actions",
          team: { id: TEAM_ID },
          channel: { id: "C123" },
          message: { ts: "111.333", thread_ts: "111.222", text: "Choose one" },
          actions: [{ action_id: "approve", type: "button", value: "yes" }],
        },
      },
    });
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ idempotencyKey: "slack-agent:webhook-to-agent-input:1" });
    const payload = inputs[0]!.payload as { content: string; llmRequestPolicy?: unknown };
    expect(payload.content).toContain("type: block_actions");
    expect(payload.content).toContain("action_id: approve");
    expect(payload.llmRequestPolicy).toEqual({ behaviour: "after-current-request" });
  });

  it("ignores webhook events performed by our own bot user (e.g. our bot adding a reaction)", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: {
        slackTeamId: TEAM_ID,
        body: {
          type: "event_callback",
          authorizations: [{ is_bot: true, user_id: "UBOT", bot_id: "BBOT" }],
          event: {
            type: "reaction_added",
            user: "UBOT",
            reaction: "eyes",
            item: { channel: "C123", ts: "111.222" },
            item_user: "UHUMAN",
          },
        },
      },
    });
    await deliverNewEvents({ cursors, processor, stream });

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agent/input-added"),
    ).toHaveLength(0);
    expect(slackCalls).toHaveLength(0);
  });

  it("forwards messages posted by other bots to the agent", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    const payload = humanMessageWebhookPayload({ text: "I am another bot mentioning @iterate" });
    const event = payload.body.event as Record<string, unknown>;
    event.subtype = "bot_message";
    event.bot_id = "BOTHERBOT"; // not our authorized bot (BBOT)
    delete event.user;
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload,
    });
    await deliverNewEvents({ cursors, processor, stream });

    expect(
      stream.events.filter((streamEvent) => {
        return streamEvent.type === "events.iterate.com/agent/input-added";
      }),
    ).toHaveLength(1);
    // Bot-authored messages never get the eyes reaction, even when forwarded.
    expect(slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });
});

describe("eyesReactionTargetFromWebhookPayload", () => {
  it("targets human messages", () => {
    expect(eyesReactionTargetFromWebhookPayload(humanMessageWebhookPayload({}))).toEqual({
      channel: "C123",
      timestamp: "111.222",
    });
  });

  it("skips bot messages and reaction events", () => {
    expect(eyesReactionTargetFromWebhookPayload(botMessageWebhookPayload())).toBeNull();
    expect(
      eyesReactionTargetFromWebhookPayload({
        body: {
          type: "event_callback",
          event: { type: "reaction_added", item: { channel: "C123", ts: "1.2" } },
        },
      }),
    ).toBeNull();
  });

  it("skips messages whose only bot marker is the bot_message subtype", () => {
    const payload = humanMessageWebhookPayload({});
    (payload.body.event as Record<string, unknown>).subtype = "bot_message";
    expect(eyesReactionTargetFromWebhookPayload(payload)).toBeNull();
  });

  it("skips actions performed by the authorized bot user", () => {
    const payload = humanMessageWebhookPayload({});
    (payload.body.event as Record<string, unknown>).user = "UBOT";
    expect(eyesReactionTargetFromWebhookPayload(payload)).toBeNull();
  });

  it("skips payloads without a message timestamp", () => {
    expect(eyesReactionTargetFromWebhookPayload({ body: { event: {} } })).toBeNull();
  });
});

describe("compileBangCommand", () => {
  it("wraps bare expressions in an async itx arrow", () => {
    expect(
      compileBangCommand({ channel: "C1", message: "!whoami", threadTs: "1.2" })?.code,
    ).toContain("await itx.whoami()");
    expect(
      compileBangCommand({ channel: "C1", message: "<@U1> !describe", threadTs: "1.2" })?.code,
    ).toContain("await itx.describe()");
  });

  it("returns null for ordinary messages", () => {
    expect(compileBangCommand({ channel: "C1", message: "hello", threadTs: "1.2" })).toBeNull();
    expect(compileBangCommand({ channel: "C1", message: undefined, threadTs: "1.2" })).toBeNull();
  });
});
