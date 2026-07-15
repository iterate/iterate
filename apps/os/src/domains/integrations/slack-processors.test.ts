import { describe, expect, it, vi } from "vitest";
import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEventInput } from "../streams/schemas.ts";
import { slackAgentSystemPrompt } from "../agents/agent-defaults.ts";
import { MemoryStreamNetwork, deliverNewEvents } from "../streams/test-helpers.ts";
import { StreamProcessorRunner } from "../streams/stream-processor-runner.ts";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "../streams/stream-processor-registry.ts";
import { SlackProcessor } from "./slack-processor-implementation.ts";
import {
  SLACK_AGENT_REVIVED_EVENT_TYPE,
  SlackAgentProcessorContract,
} from "./slack-agent-processor-contract.ts";
import {
  SlackAgentProcessor,
  compileBangCommand,
  eyesReactionTargetFromWebhookPayload,
} from "./slack-agent-processor-implementation.ts";

const TEAM_ID = "T0TEAM";
const CONNECTION = "nustom";

function connectedEvent() {
  return {
    type: "events.iterate.com/slack/connected" as const,
    payload: {
      connection: CONNECTION,
      externalId: TEAM_ID,
      projectId: "prj_1",
      teamId: TEAM_ID,
      teamName: "acme",
    },
  };
}

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
      // Real webhooks carry the verification secret; the transcriber must
      // strip it (asserted below) while the router still reads the rest.
      token: "verification-secret",
      team_id: TEAM_ID,
      event_id: input.eventId ?? "Ev123",
      authorizations: [{ is_bot: true, user_id: "UBOT", bot_id: "BBOT" }],
      event: {
        type: "message",
        channel: input.channel ?? "C123",
        user: "UHUMAN",
        text: input.text ?? "hello agent",
        ts: input.ts ?? "111.222",
        blocks: [{ type: "rich_text", elements: [] }],
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
    const stream = network.get("/integrations/slack/nustom");
    const acked: unknown[] = [];
    const processor = new SlackProcessor({
      stream,
      path: stream.path,
      projectId: null,
      connection: CONNECTION,
      acknowledgeRoutedWebhook: ({ payload }) => {
        acked.push(payload);
      },
    });
    const cursors = new Map<object, number>();

    await stream.append(connectedEvent(), {
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
      streamPath: "/agents/slack/nustom/c123/ts-111-222",
      threadTs: "111.222",
    });

    // …and the routed stream receives [route, webhook] verbatim.
    const routed = network.eventsAt("/agents/slack/nustom/c123/ts-111-222");
    expect(routed.map((event) => event.type)).toEqual([
      "events.iterate.com/slack/thread-route-configured",
      "events.iterate.com/slack/webhook-received",
    ]);
    expect(routed[1]!.payload).toEqual(humanMessageWebhookPayload({}));

    // The fast-ack hook fired once for the forwarded webhook.
    expect(acked).toHaveLength(1);
  });

  it("routes webhooks that arrive before the connected fact folds", async () => {
    // The connection is a projection of the host DO's name, not folded state,
    // so routing is total from the very first webhook — event ordering cannot
    // produce a window where a message is dropped.
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack/nustom");
    const processor = new SlackProcessor({
      stream,
      path: stream.path,
      projectId: null,
      connection: CONNECTION,
    });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });

    const routed = network.eventsAt("/agents/slack/nustom/c123/ts-111-222");
    expect(routed.map((event) => event.type)).toEqual([
      "events.iterate.com/slack/thread-route-configured",
      "events.iterate.com/slack/webhook-received",
    ]);
  });

  it("forwards follow-up webhooks through the reduced routing table", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack/nustom");
    const processor = new SlackProcessor({
      stream,
      path: stream.path,
      projectId: null,
      connection: CONNECTION,
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
    const stream = network.get("/integrations/slack/nustom");
    const processor = new SlackProcessor({
      stream,
      path: stream.path,
      projectId: null,
      connection: CONNECTION,
    });
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

  it("ignores connected/disconnected lifecycle facts (status is a journal fold, not router state)", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack/nustom");
    const processor = new SlackProcessor({
      stream,
      path: stream.path,
      projectId: null,
      connection: CONNECTION,
    });
    const cursors = new Map<object, number>();

    await stream.append(connectedEvent(), {
      type: "events.iterate.com/slack/disconnected",
      payload: { projectId: "prj_1", teamId: TEAM_ID },
    });
    await deliverNewEvents({ cursors, processor, stream });
    // The router's whole state is its routing table; connection status is read
    // straight off the journal by getConnectionStatus, so lifecycle facts
    // reduce to nothing here.
    expect(processor.state).toEqual({ routes: {} });
  });

  it("errors loudly instead of routing when the host stream carries no connection", async () => {
    const network = new MemoryStreamNetwork();
    // A mis-armed subscription: slack router woken on a non-connection path.
    const stream = network.get("/integrations/slack");
    const processor = new SlackProcessor({
      stream,
      path: stream.path,
      projectId: null,
      connection: null,
    });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    // Throwing (not dropping) holds the checkpoint so the webhook stays
    // replayable — a silent drop here is the 2026-06-15 outage shape.
    await expect(deliverNewEvents({ cursors, processor, stream })).rejects.toThrow(/no connection/);
    expect(network.streams.size).toBe(1);
  });

  it("acknowledges webhooks forwarded through existing routes", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack/nustom");
    const acked: unknown[] = [];
    const processor = new SlackProcessor({
      stream,
      path: stream.path,
      projectId: null,
      connection: CONNECTION,
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

  it("refold: replaying the journal neither re-acknowledges nor duplicates forwards", async () => {
    // THE refold test (docs/writing-stream-processors.md, "Refold safety").
    const clock = { now: Date.parse("2026-07-09T12:00:00Z") };
    const network = new MemoryStreamNetwork(() => clock.now);
    const stream = network.get("/integrations/slack/nustom");
    const acked: unknown[] = [];
    const processor = new SlackProcessor({
      stream,
      path: stream.path,
      projectId: null,
      connection: CONNECTION,
      acknowledgeRoutedWebhook: ({ payload }) => {
        acked.push(payload);
      },
      now: () => clock.now,
    });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });
    expect(acked).toHaveLength(1);
    const routedPath = "/agents/slack/nustom/c123/ts-111-222";
    expect(network.eventsAt(routedPath)).toHaveLength(2);

    clock.now += 60 * 60_000;
    const refoldAcked: unknown[] = [];
    const refolded = new SlackProcessor({
      stream,
      path: stream.path,
      projectId: null,
      connection: CONNECTION,
      acknowledgeRoutedWebhook: ({ payload }) => {
        refoldAcked.push(payload);
      },
      now: () => clock.now,
    });
    await deliverNewEvents({ cursors, processor: refolded, stream });

    // The stale ack is skipped; the durable forwards replay and dedupe at the
    // append layer (idempotency keys), leaving the routed stream unchanged.
    expect(refoldAcked).toEqual([]);
    expect(network.eventsAt(routedPath)).toHaveLength(2);
    expect(
      stream.events.filter(
        (event) => event.type === "events.iterate.com/slack/thread-route-configured",
      ),
    ).toHaveLength(1);
  });

  it("ignores and never acknowledges webhooks that cannot be keyed as channel:thread_ts", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack/nustom");
    const acked: unknown[] = [];
    const processor = new SlackProcessor({
      stream,
      path: stream.path,
      projectId: null,
      connection: CONNECTION,
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
    const stream = network.get("/integrations/slack/nustom");
    const routed = network.get("/agents/slack/nustom/c123/ts-111-222");
    const originalRoutedAppend = routed.append.bind(routed);
    let failNextForward = true;
    routed.append = async (...inputs: StreamEventInput[]) => {
      if (failNextForward) {
        failNextForward = false;
        throw new Error("cold StreamsCapability RPC failed");
      }
      return originalRoutedAppend(...inputs);
    };
    const processor = new SlackProcessor({
      stream,
      path: stream.path,
      projectId: null,
      connection: CONNECTION,
    });
    // The connected fact folds first (the connection names new thread paths).
    const [connected] = await stream.append(connectedEvent());
    await processor.ingest({ events: [connected!], streamMaxOffset: 1 });
    expect(processor.checkpointOffset).toBe(1);
    const [webhook] = await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });

    // First delivery: the forward throws. ingest MUST reject and the
    // checkpoint MUST hold — otherwise the webhook is gone for good.
    await expect(processor.ingest({ events: [webhook!], streamMaxOffset: 2 })).rejects.toThrow(
      /StreamsCapability/,
    );
    expect(processor.checkpointOffset).toBe(1);
    expect(routed.events).toHaveLength(0);

    // The host replays the same webhook from the un-advanced checkpoint; the
    // forward now succeeds and the checkpoint advances.
    await processor.ingest({ events: [webhook!], streamMaxOffset: 2 });
    expect(processor.checkpointOffset).toBe(2);
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
  // REAL runner drive (the production registry's driver): the status repaint
  // and the status-clear obligation live in `onCaughtUp`, which ONLY the
  // runner fires — legacy `ingest` would silently skip both and every status
  // assertion here would test nothing. `readPageSize` shrinks the catch-up
  // page so a single `deliver()` exercises behind-head frames (the carry).
  function setup(deps?: {
    callSlackApi?: (method: string, body: Record<string, unknown>) => Promise<void>;
    readPageSize?: number;
    statusClearDebounceMs?: number;
    storeSlackFiles?: ConstructorParameters<typeof SlackAgentProcessor>[0]["storeSlackFiles"];
  }) {
    const clock = { now: Date.parse("2026-07-09T12:00:00Z") };
    const network = new MemoryStreamNetwork(() => clock.now);
    const stream = network.get("/agents/slack/nustom/c123/ts-111-222");
    const slackCalls: Array<{ body: Record<string, unknown>; method: string }> = [];
    const processor = new SlackAgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      callSlackApi: async (method, body) => {
        slackCalls.push({ body, method });
        await deps?.callSlackApi?.(method, body);
      },
      now: () => clock.now,
      statusClearDebounceMs: deps?.statusClearDebounceMs ?? 0,
      ...(deps?.storeSlackFiles === undefined ? {} : { storeSlackFiles: deps.storeSlackFiles }),
    });
    const runner = new StreamProcessorRunner({
      processor,
      stream,
      ...(deps?.readPageSize === undefined ? {} : { readPageSize: deps.readPageSize }),
    });
    return {
      clock,
      deliver: () => runner.catchUp(),
      network,
      processor,
      runner,
      slackCalls,
      stream,
    };
  }

  it("turns a routed human message into triggering agent input and adds the eyes reaction", async () => {
    const { deliver, runner, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/thread-route-configured",
      payload: {
        channel: "C123",
        threadTs: "111.222",
        streamPath: "/agents/slack/nustom/c123/ts-111-222",
      },
    });
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/message-received",
    );
    expect(inputs).toHaveLength(1);
    const payload = inputs[0]!.payload as { content: string; llmRequestPolicy?: unknown };
    expect(payload.content).toContain("slack/webhook-received");
    expect(payload.content).toContain("hello agent");
    // The contract default (triggering) policy applies.
    expect(payload.llmRequestPolicy).toEqual({ behaviour: "after-current-request" });

    // The transcript is CURATED: the webhook's verification token must never
    // reach the LLM provider, and envelope/rich-text noise stays out while
    // the facts (channel, sender, ts) stay in.
    expect(payload.content).not.toContain("verification-secret");
    expect(payload.content).not.toContain("authorizations");
    expect(payload.content).not.toContain("blocks");
    expect(payload.content).toContain("C123");
    expect(payload.content).toContain("UHUMAN");
    expect(payload.content).toContain("111.222");

    expect(slackCalls).toContainEqual({
      method: "reactions.add",
      body: { channel: "C123", name: "eyes", timestamp: "111.222" },
    });

    expect(runner.currentState).toMatchObject({
      botBotId: "BBOT",
      botUserId: "UBOT",
      channel: "C123",
      latestMessageTs: "111.222",
      threadTs: "111.222",
    });
  });

  it("materializes shared files and attaches them to the agent input", async () => {
    const stored: Array<{ files: unknown; storageKey: string }> = [];
    const attachment = {
      contentType: "image/png",
      filename: "cat.png",
      path: "/agents/slack/c123/ts-111-222/slack-1-0-cat.png",
      size: 3,
      url: "https://iterate-files--demo.iterate.app/x?sig=y",
    };
    const { deliver, stream } = setup({
      storeSlackFiles: async (input) => {
        stored.push(input);
        return [attachment];
      },
    });

    const payload = humanMessageWebhookPayload({});
    (payload.body.event as Record<string, unknown>).files = [
      {
        id: "F1",
        mimetype: "image/png",
        name: "cat.png",
        url_private: "https://files.slack.com/f1",
      },
      { no_url: true }, // malformed entries are skipped, not fatal
    ];
    await stream.append({ type: "events.iterate.com/slack/webhook-received", payload });
    await deliver();

    expect(stored).toHaveLength(1);
    expect(stored[0]!.files).toEqual([
      { mimetype: "image/png", name: "cat.png", urlPrivate: "https://files.slack.com/f1" },
    ]);
    expect(stored[0]!.storageKey).toMatch(/^slack-\d+$/);

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/message-received",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({ files: [attachment] });
  });

  it("degrades to a plain agent input when file storage fails", async () => {
    const { deliver, stream } = setup({
      storeSlackFiles: async () => {
        throw new Error("slack download exploded");
      },
    });

    const payload = humanMessageWebhookPayload({});
    (payload.body.event as Record<string, unknown>).files = [
      { name: "cat.png", url_private: "https://files.slack.com/f1" },
    ];
    await stream.append({ type: "events.iterate.com/slack/webhook-received", payload });
    await deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/message-received",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).not.toHaveProperty("files");
    expect((inputs[0]!.payload as { content: string }).content).toContain("cat.png");
  });

  it("ignores our own bot's messages entirely", async () => {
    const { deliver, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: botMessageWebhookPayload(),
    });
    await deliver();

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/message-received"),
    ).toHaveLength(0);
    expect(slackCalls).toHaveLength(0);
  });

  it("records non-message events as non-triggering input without an eyes reaction", async () => {
    const { deliver, slackCalls, stream } = setup();

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
    await deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/message-received",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
    expect(slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });

  it("compiles bang commands into itx script executions instead of agent input", async () => {
    const { deliver, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({ text: "!whoami" }),
    });
    await deliver();

    const scripts = stream.events.filter(
      (event) => event.type === "events.iterate.com/capability-host/script-execution-requested",
    );
    expect(scripts).toHaveLength(1);
    expect((scripts[0]!.payload as { code: string }).code).toContain("await itx.whoami()");
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/message-received"),
    ).toHaveLength(0);
    expect(slackCalls).toContainEqual({
      method: "reactions.add",
      body: { channel: "C123", name: "eyes", timestamp: "111.222" },
    });
  });

  it("mirrors the LLM request lifecycle into the Slack assistant status", async () => {
    const { deliver, slackCalls, stream } = setup();

    // Establish thread context first.
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    slackCalls.length = 0;

    const [requested] = await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", requestId: "llm-request:1" },
    });
    await deliver();
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
        llmRequestOffset: requested!.offset,
        result: { status: "success" },
      },
    });
    await deliver();
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

  it("repaints the status once per batch — the latest lifecycle fact wins", async () => {
    const { deliver, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    slackCalls.length = 0;

    // Requested and completed land in ONE batch: the status is a repaint of
    // current truth, so only the final (cleared) status reaches Slack — no
    // transient "is thinking..." call for a request that already finished.
    const requestedOffset = (stream.events.at(-1)?.offset ?? 0) + 1;
    await stream.append(
      {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "gpt-test", requestId: "llm-request:1" },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: {
          durationMs: 10,
          llmRequestOffset: requestedOffset,
          result: { status: "success" },
        },
      },
    );
    await deliver();
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

  it("keeps the tools status on while a script is running after its LLM completes", async () => {
    const { deliver, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    slackCalls.length = 0;

    const requestedOffset = (stream.events.at(-1)?.offset ?? 0) + 1;
    await stream.append(
      {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "gpt-test", requestId: "llm-request:1" },
      },
      {
        type: "events.iterate.com/capability-host/script-execution-requested",
        payload: { code: "async () => {}", executionId: "script-1" },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: {
          durationMs: 10,
          llmRequestOffset: requestedOffset,
          result: { status: "success" },
        },
      },
    );
    await deliver();

    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "C123",
          thread_ts: "111.222",
          status: "is using tools...",
          loading_messages: ["Using tools..."],
        },
      },
    ]);

    slackCalls.length = 0;
    await stream.append({
      type: "events.iterate.com/capability-host/script-execution-completed",
      payload: { executionId: "script-1", result: null },
    });
    await deliver();
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

  it("debounces idle clears and cancels them when the next LLM starts", async () => {
    const { deliver, slackCalls, stream } = setup({ statusClearDebounceMs: 30 });

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    slackCalls.length = 0;

    const [requested] = await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", requestId: "llm-request:1" },
    });
    await deliver();
    slackCalls.length = 0;

    await stream.append({
      type: "events.iterate.com/agent/llm-request-completed",
      payload: {
        durationMs: 10,
        llmRequestOffset: requested!.offset,
        result: { status: "success" },
      },
    });
    await deliver();
    expect(slackCalls).toEqual([]);

    await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", requestId: "llm-request:2" },
    });
    await deliver();
    await new Promise((resolve) => setTimeout(resolve, 50));

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
  });

  it("keeps a newer LLM active when an older cancelled request completes late", async () => {
    const { deliver, runner, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    const [requestA] = await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", requestId: "llm-request:a" },
    });
    await deliver();
    await stream.append({
      type: "events.iterate.com/agent/llm-request-cancelled",
      payload: {
        phase: "requested",
        reason: "interrupted-by-user-input",
        llmRequestOffset: requestA!.offset,
      },
    });
    await deliver();
    const [requestB] = await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", requestId: "llm-request:b" },
    });
    await deliver();
    slackCalls.length = 0;

    await stream.append({
      type: "events.iterate.com/agent/llm-request-completed",
      payload: {
        durationMs: 10,
        llmRequestOffset: requestA!.offset,
        result: { status: "success" },
      },
    });
    await deliver();

    expect(runner.currentState.activeLlmRequestOffsets).toEqual([requestB!.offset]);
    expect(runner.currentState.pendingStatusClear).toBeUndefined();
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
  });

  it("serializes a due clear before a newer LLM status repaint", async () => {
    vi.useFakeTimers();
    try {
      let clearStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        clearStarted = resolve;
      });
      let releaseClear!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseClear = resolve;
      });
      const { deliver, slackCalls, stream } = setup({
        statusClearDebounceMs: 30,
        callSlackApi: async (method, body) => {
          if (method !== "assistant.threads.setStatus" || body.status !== "") return;
          clearStarted();
          await released;
        },
      });

      await stream.append({
        type: "events.iterate.com/slack/webhook-received",
        payload: humanMessageWebhookPayload({}),
      });
      await deliver();
      const [requestA] = await stream.append({
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "gpt-test", requestId: "llm-request:a" },
      });
      await deliver();
      await stream.append({
        type: "events.iterate.com/agent/llm-request-completed",
        payload: {
          durationMs: 10,
          llmRequestOffset: requestA!.offset,
          result: { status: "success" },
        },
      });
      await deliver();
      await vi.advanceTimersByTimeAsync(30);
      expect(
        stream.events.some(
          (event) => event.type === "events.iterate.com/slack-agent/status-clear-due",
        ),
      ).toBe(true);
      slackCalls.length = 0;

      const dueDelivery = deliver();
      await started;
      await stream.append({
        type: "events.iterate.com/agent/llm-request-requested",
        payload: { model: "gpt-test", requestId: "llm-request:b" },
      });
      const newerRequestDelivery = deliver();
      releaseClear();
      await Promise.all([dueDelivery, newerRequestDelivery]);

      expect(
        slackCalls
          .filter((call) => call.method === "assistant.threads.setStatus")
          .map((call) => call.body.status),
      ).toEqual(["", "is thinking..."]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("recovers an idle status clear after the debounce timer is lost to eviction", async () => {
    // The recovery flagship for this processor, driven the way production
    // drives it: a REAL createStreamProcessorRegistry (runner +
    // durableObjectRecovery + keepalive alarm) over a fake DurableObjectState
    // — the same harness shape as repo-recovery.test.ts. `crash()` is an
    // eviction: the armed status-clear debounce timer dies behind the
    // incarnation fence; the journal, KV progress, and the durable alarm
    // survive, and the alarm's revival appends `slack-agent/revived`, whose
    // ordinary delivery re-derives the pending clear from the fold.
    const clock = { now: Date.parse("2026-07-09T12:00:00Z") };
    const network = new MemoryStreamNetwork(() => clock.now);
    const stream = network.get("/agents/slack/nustom/c123/ts-111-222");
    const slackCalls: Array<{ body: Record<string, unknown>; method: string }> = [];

    const kv = new Map<string, unknown>();
    const alarm: { at: number | null } = { at: null };
    let pending: Promise<unknown>[] = [];
    const ctx = {
      storage: {
        kv: {
          get: (key: string) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
          put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
          delete: (key: string) => kv.delete(key),
        },
        getAlarm: async () => alarm.at,
        setAlarm: async (at: number | Date) => {
          alarm.at = typeof at === "number" ? at : at.getTime();
        },
        deleteAlarm: async () => {
          alarm.at = null;
        },
      },
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise.catch(() => undefined)),
    } as unknown as DurableObjectState;

    let incarnation = 0;
    let registry!: StreamProcessorRegistry;
    const boot = () => {
      incarnation += 1;
      const mine = incarnation;
      // The fence: the dead incarnation's armed debounce timer must not
      // append its status-clear-due — exactly as an evicted isolate cannot —
      // or the revival would have nothing left to recover.
      const fencedStream = new Proxy(stream, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (incarnation !== mine) {
              throw new Error(`stream call from evicted incarnation ${mine}`);
            }
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }) as unknown as Stream;
      registry = createStreamProcessorRegistry(ctx, {
        stream: fencedStream,
        path: stream.path,
        projectId: null,
        version: "v-test",
        now: () => clock.now,
      });
      registry.register(
        new SlackAgentProcessor({
          stream: fencedStream,
          path: stream.path,
          projectId: null,
          callSlackApi: async (method, body) => {
            slackCalls.push({ body, method });
          },
          now: () => clock.now,
          statusClearDebounceMs: 1_000,
        }),
        { recovery: { revivedEventType: SLACK_AGENT_REVIVED_EVENT_TYPE } },
      );
    };
    boot();

    const head = () => stream.events.at(-1)?.offset ?? 0;
    const deliverPending = async () => {
      const woken = await registry.wakeStreamSubscriber({
        stream: { projectId: null, path: stream.path, streamMaxOffset: head() },
        subscriptionKey: "wake:slack-agent",
        processorSlug: SlackAgentProcessorContract.slug,
      });
      const events = stream.events.filter((event) => event.offset > woken.checkpointOffset);
      if (events.length > 0) {
        await woken.sink({
          projectId: null,
          path: stream.path,
          events,
          streamMaxOffset: head(),
          state: null,
        });
      }
    };

    await stream.append({
      type: "events.iterate.com/slack/thread-route-configured",
      payload: {
        channel: "C123",
        threadTs: "111.222",
        streamPath: "/agents/slack/nustom/c123/ts-111-222",
      },
    });
    await deliverPending();
    const [requested] = await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", requestId: "llm-request:1" },
    });
    await deliverPending();
    await stream.append({
      type: "events.iterate.com/agent/llm-request-completed",
      payload: {
        durationMs: 10,
        llmRequestOffset: requested!.offset,
        result: { status: "success" },
      },
    });
    await deliverPending();
    expect(slackCalls.at(-1)?.body).toMatchObject({ status: "is thinking..." });

    // The armed 1s debounce is keepalive-tracked work: the revival alarm sits
    // ahead of it.
    expect(alarm.at).not.toBeNull();
    pending = [];
    boot(); // THE EVICTION: the debounce timer dies; journal/KV/alarm survive

    // Fire the durable alarm through the REAL handleAlarm path: the keepalive
    // sees the died work and journals the processor-scoped revival fact.
    while (alarm.at !== null && alarm.at <= clock.now + 60_000) {
      clock.now = Math.max(clock.now, alarm.at);
      alarm.at = null; // the platform consumes the alarm by firing it
      await registry.handleAlarm();
    }
    expect(
      stream.events.filter((event) => event.type === SLACK_AGENT_REVIVED_EVENT_TYPE),
    ).toHaveLength(1);

    // Its ordinary delivery drives the fresh incarnation to head; onCaughtUp
    // re-derives the pending clear — now past its debounce — and paints it.
    await deliverPending();
    expect(slackCalls).toContainEqual({
      method: "assistant.threads.setStatus",
      body: { channel_id: "C123", thread_ts: "111.222", status: "" },
    });
  });

  it("carries a behind-head lifecycle fact to the at-head repaint", async () => {
    // readPageSize 1 makes one catch-up deliver the completion in a frame
    // stamped BEHIND the head (a render/input event follows it — the
    // wake-lane shape) while the frame that reaches head contains no
    // lifecycle facts at all. The clear must not be lost OR run per behind
    // frame: exactly one clear pair, painted at the at-head pulse. Without
    // the carry, Slack keeps "is thinking..." and the eyes reaction forever.
    const { deliver, slackCalls, stream } = setup({ readPageSize: 1 });

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    slackCalls.length = 0;

    await stream.append(
      {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: {
          durationMs: 10,
          llmRequestOffset: 1,
          result: { status: "success" },
        },
      },
      {
        // Not consumed by slack-agent: stands in for the renders/inputs that
        // typically trail a completion.
        type: "events.iterate.com/agent/input-added",
        payload: { content: "render" },
      },
    );
    await deliver();
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

  it("skips the stale 👀 ack on a late wake but still lands the agent input", async () => {
    const { clock, deliver, slackCalls, stream } = setup();

    // The webhook arrived while the processor's host was down; delivery
    // happens 16 minutes later. The durable lane (agent input) must land —
    // the ack lane must not pretend the message was "just picked up".
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    clock.now += 16 * 60_000;
    await deliver();

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/message-received"),
    ).toHaveLength(1);
    expect(slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });

  it("refold: replaying the full journal re-executes no Slack calls and appends nothing new", async () => {
    // THE refold test (docs/writing-stream-processors.md, "Refold safety"):
    // a state-schema deploy discards the progress record and replays the
    // journal from offset 0 into a fresh instance. Durable lanes dedupe via
    // idempotency keys; acknowledgement/cosmetic lanes must not re-fire.
    const { clock, deliver, runner, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    const [requested] = await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-test", requestId: "llm-request:1" },
    });
    await deliver();
    await stream.append({
      type: "events.iterate.com/agent/llm-request-completed",
      payload: {
        durationMs: 10,
        llmRequestOffset: requested!.offset,
        result: { status: "success" },
      },
    });
    await deliver();
    // Consume the processor's own status-clear completion so both the live
    // checkpoint and a from-zero refold cover the same journal prefix.
    await deliver();
    expect(slackCalls.length).toBeGreaterThan(0);
    const journalBeforeRefold = stream.events.length;

    clock.now += 60 * 60_000;
    const refoldCalls: Array<{ body: Record<string, unknown>; method: string }> = [];
    const refolded = new SlackAgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      callSlackApi: async (method, body) => {
        refoldCalls.push({ body, method });
      },
      now: () => clock.now,
    });
    const refoldRunner = new StreamProcessorRunner({ processor: refolded, stream });
    await refoldRunner.catchUp();

    expect(refoldCalls).toEqual([]);
    expect(stream.events).toHaveLength(journalBeforeRefold);
    // The refolded state converged to the live processor's.
    expect(refoldRunner.currentState).toEqual(runner.currentState);
  });

  it("captures route context (including streamPath) in state without announcing anything", async () => {
    const { deliver, runner, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/thread-route-configured",
      payload: {
        channel: "C123",
        threadTs: "111.222",
        streamPath: "/agents/slack/nustom/c123/ts-111-222",
      },
    });
    await deliver();

    expect(runner.currentState).toMatchObject({
      channel: "C123",
      streamPath: "/agents/slack/nustom/c123/ts-111-222",
      threadTs: "111.222",
    });
    // The `slack` capability is provided on the agent's own itx context
    // (provideCapability), not announced from here — the route event only
    // folds into state, with no appends and no Slack API calls.
    expect(stream.events).toHaveLength(1);
    expect(slackCalls).toHaveLength(0);
  });

  it("compiles the !debug bang command into a Slack-posting debug script", async () => {
    const { deliver, slackCalls, stream } = setup();

    await stream.append(
      {
        // The router forwards the route event ahead of webhooks, so the agent
        // knows its stream path — and from it, the connection the debug reply
        // must post through.
        type: "events.iterate.com/slack/thread-route-configured",
        payload: {
          channel: "C123",
          threadTs: "111.222",
          streamPath: "/agents/slack/nustom/c123/ts-111-222",
        },
      },
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: humanMessageWebhookPayload({ text: "!debug" }),
      },
    );
    await deliver();

    const scripts = stream.events.filter(
      (event) => event.type === "events.iterate.com/capability-host/script-execution-requested",
    );
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({
      idempotencyKey: "slack-agent/bang-command@/agents/slack/nustom/c123/ts-111-222:2",
      payload: { executionId: "slack-bang-command-2" },
    });
    const code = (scripts[0]!.payload as { code: string }).code;
    expect(code).toContain("const debug = await itx.debug();");
    expect(code).toContain('await itx.integrations.slack.get("nustom").chat.postMessage({');
    expect(code).toContain('channel: "C123"');
    expect(code).toContain('thread_ts: "111.222"');
    expect(code).toContain("text: `Debug info:\\n${debug}`");
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/message-received"),
    ).toHaveLength(0);
    expect(slackCalls).toContainEqual({
      method: "reactions.add",
      body: { channel: "C123", name: "eyes", timestamp: "111.222" },
    });
  });

  it("commits the agent input before adding the Slack eyes reaction", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/agents/slack/nustom/c123/ts-111-222");
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
      path: stream.path,
      projectId: null,
      callSlackApi: async (method) => {
        calls.push(`slack:${method}`);
      },
    });
    await new StreamProcessorRunner({ processor, stream }).catchUp();

    expect(calls).toEqual([
      "append:events.iterate.com/agents/message-received",
      "slack:reactions.add",
    ]);
  });

  it("turns raw Slack interactivity payloads into triggering agent input", async () => {
    const { deliver, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: {
        slackTeamId: TEAM_ID,
        body: {
          type: "block_actions",
          team: { id: TEAM_ID },
          channel: { id: "C123" },
          user: { id: "U777" },
          message: { ts: "111.333", thread_ts: "111.222", text: "Choose one" },
          actions: [{ action_id: "approve", type: "button", value: "yes" }],
        },
      },
    });
    await deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/message-received",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      idempotencyKey: "slack-agent/webhook-to-agent-input@/agents/slack/nustom/c123/ts-111-222:1",
    });
    const payload = inputs[0]!.payload as {
      content: string;
      from?: unknown;
      llmRequestPolicy?: unknown;
    };
    // Interactivity payloads carry the presser at user.id, not event.user.
    expect(payload.from).toEqual({ kind: "slack", userId: "U777" });
    expect(payload.content).toContain("type: block_actions");
    expect(payload.content).toContain("action_id: approve");
    expect(payload.llmRequestPolicy).toEqual({ behaviour: "after-current-request" });
  });

  it("ignores webhook events performed by our own bot user (e.g. our bot adding a reaction)", async () => {
    const { deliver, slackCalls, stream } = setup();

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
    await deliver();

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/message-received"),
    ).toHaveLength(0);
    expect(slackCalls).toHaveLength(0);
  });

  it("forwards messages posted by other bots to the agent", async () => {
    const { deliver, slackCalls, stream } = setup();

    const payload = humanMessageWebhookPayload({ text: "I am another bot mentioning @iterate" });
    const event = payload.body.event as Record<string, unknown>;
    event.subtype = "bot_message";
    event.bot_id = "BOTHERBOT"; // not our authorized bot (BBOT)
    delete event.user;
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload,
    });
    await deliver();

    expect(
      stream.events.filter((streamEvent) => {
        return streamEvent.type === "events.iterate.com/agents/message-received";
      }),
    ).toHaveLength(1);
    // Bot-authored messages never get the eyes reaction, even when forwarded.
    expect(slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });

  it("forwards other bot messages when Slack authorizations omit bot_id", async () => {
    const { deliver, slackCalls, stream } = setup();

    const payload = humanMessageWebhookPayload({ text: "<@UBOT> !debug" });
    delete (payload.body.authorizations[0] as Record<string, unknown>).bot_id;
    const event = payload.body.event as Record<string, unknown>;
    event.subtype = "bot_message";
    event.bot_id = "BOTHERBOT";
    event.user = "UOTHERBOT";
    event.bot_profile = { id: "BOTHERBOT", user_id: "UOTHERBOT" };

    await stream.append(
      {
        type: "events.iterate.com/slack/thread-route-configured",
        payload: {
          channel: "C123",
          threadTs: "111.222",
          streamPath: "/agents/slack/nustom/c123/ts-111-222",
        },
      },
      {
        type: "events.iterate.com/slack/webhook-received",
        payload,
      },
    );
    await deliver();

    const scripts = stream.events.filter(
      (streamEvent) =>
        streamEvent.type === "events.iterate.com/capability-host/script-execution-requested",
    );
    expect(scripts).toHaveLength(1);
    expect((scripts[0]!.payload as { code: string }).code).toContain(
      "const debug = await itx.debug();",
    );
    expect(slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });

  it("ignores our own bot messages when Slack authorizations omit bot_id", async () => {
    const { deliver, slackCalls, stream } = setup();

    const payload = humanMessageWebhookPayload({ text: "<@UBOT> !debug" });
    delete (payload.body.authorizations[0] as Record<string, unknown>).bot_id;
    const event = payload.body.event as Record<string, unknown>;
    event.subtype = "bot_message";
    event.bot_id = "BBOT";
    event.user = "UBOT";
    event.bot_profile = { id: "BBOT", user_id: "UBOT" };

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload,
    });
    await deliver();

    expect(
      stream.events.filter((streamEvent) => {
        return streamEvent.type === "events.iterate.com/capability-host/script-execution-requested";
      }),
    ).toHaveLength(0);
    expect(
      stream.events.filter(
        (streamEvent) => streamEvent.type === "events.iterate.com/agents/message-received",
      ),
    ).toHaveLength(0);
    expect(slackCalls).toHaveLength(0);
  });

  it("ignores bot messages when Slack gives no comparable bot identity", async () => {
    const { deliver, slackCalls, stream } = setup();

    const payload = humanMessageWebhookPayload({ text: "<@UBOT> !debug" });
    delete (payload.body.authorizations[0] as Record<string, unknown>).bot_id;
    const event = payload.body.event as Record<string, unknown>;
    event.subtype = "bot_message";
    event.bot_id = "BBOT";
    delete event.user;
    delete event.bot_profile;

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload,
    });
    await deliver();

    expect(
      stream.events.filter((streamEvent) => {
        return streamEvent.type === "events.iterate.com/capability-host/script-execution-requested";
      }),
    ).toHaveLength(0);
    expect(
      stream.events.filter(
        (streamEvent) => streamEvent.type === "events.iterate.com/agents/message-received",
      ),
    ).toHaveLength(0);
    expect(slackCalls).toHaveLength(0);
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
  it("tells Slack agents to use the Google-backed Gmail capability for inbox requests", () => {
    const prompt = slackAgentSystemPrompt(CONNECTION);
    expect(prompt).toContain('itx.integrations.slack.get("nustom").chat.postMessage');
    expect(prompt).toContain("itx.integrations.list()");
    expect(prompt).toContain("itx.integrations.gmail.get().request");
    expect(prompt).toContain('path: "/users/me/messages"');
    expect(prompt).toContain("Do not claim you lack inbox access");
  });

  it("wraps bare expressions in an async itx arrow", () => {
    expect(
      compileBangCommand({
        channel: "C1",
        connection: "nustom",
        message: "!whoami",
        threadTs: "1.2",
      })?.code,
    ).toContain("await itx.whoami()");
    expect(
      compileBangCommand({
        channel: "C1",
        connection: "nustom",
        message: "<@U1> !__describe",
        threadTs: "1.2",
      })?.code,
    ).toContain("await itx.__describe()");
  });

  it("returns null for ordinary messages", () => {
    expect(
      compileBangCommand({
        channel: "C1",
        connection: "nustom",
        message: "hello",
        threadTs: "1.2",
      }),
    ).toBeNull();
    expect(
      compileBangCommand({
        channel: "C1",
        connection: "nustom",
        message: undefined,
        threadTs: "1.2",
      }),
    ).toBeNull();
  });
});
