import { describe, expect, it } from "vitest";
import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEventInput } from "../streams/schemas.ts";
import { slackAgentSystemPrompt } from "../agents/agent-defaults.ts";
import {
  MemoryStreamNetwork,
  appendTestEvents,
  deliverNewEvents,
} from "../streams/test-helpers.ts";
import { SlackProcessor } from "./slack-processor-implementation.ts";
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
    const [connected] = await appendTestEvents(stream, connectedEvent());
    await processor.ingest({ events: [connected!], streamMaxOffset: 1 });
    expect(processor.checkpointOffset).toBe(1);
    const [webhook] = await appendTestEvents(stream, {
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
  function setup(deps?: {
    callSlackApi?: (method: string, body: Record<string, unknown>) => Promise<void>;
    fetchSlackChannelName?: (channel: string) => Promise<string | null>;
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
      ...(deps?.fetchSlackChannelName === undefined
        ? {}
        : { fetchSlackChannelName: deps.fetchSlackChannelName }),
      ...(deps?.storeSlackFiles === undefined ? {} : { storeSlackFiles: deps.storeSlackFiles }),
    });
    const cursors = new Map<object, number>();
    return { clock, cursors, network, processor, slackCalls, stream };
  }

  it("turns a routed human message into triggering agent input and adds the eyes reaction", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

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
    await deliverNewEvents({ cursors, processor, stream });

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

    expect(processor.state).toMatchObject({
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
    const { cursors, processor, stream } = setup({
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
    await deliverNewEvents({ cursors, processor, stream });

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
    const { cursors, processor, stream } = setup({
      storeSlackFiles: async () => {
        throw new Error("slack download exploded");
      },
    });

    const payload = humanMessageWebhookPayload({});
    (payload.body.event as Record<string, unknown>).files = [
      { name: "cat.png", url_private: "https://files.slack.com/f1" },
    ];
    await stream.append({ type: "events.iterate.com/slack/webhook-received", payload });
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/message-received",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).not.toHaveProperty("files");
    expect((inputs[0]!.payload as { content: string }).content).toContain("cat.png");
  });

  it("ignores our own bot's messages entirely", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: botMessageWebhookPayload(),
    });
    await deliverNewEvents({ cursors, processor, stream });

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/message-received"),
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
      (event) => event.type === "events.iterate.com/agents/message-received",
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

  it("paints the agent's announced status onto the Slack assistant thread", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    // Establish thread context first.
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });
    slackCalls.length = 0;

    await stream.append({
      type: "events.iterate.com/agent/status-changed",
      payload: { busy: true, sinceOffset: 1 },
    });
    await deliverNewEvents({ cursors, processor, stream });
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "C123",
          thread_ts: "111.222",
          status: "is making an LLM request...",
          loading_messages: ["making an LLM request..."],
        },
      },
    ]);

    slackCalls.length = 0;
    await stream.append({
      type: "events.iterate.com/agent/status-changed",
      payload: { busy: false, sinceOffset: 2 },
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

  it("repaints the status once per batch — the latest announcement wins", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });
    slackCalls.length = 0;

    // Busy and idle land in ONE batch: the status is a repaint of current
    // truth, so only the final (cleared) status reaches Slack — no transient
    // "is thinking..." call for work that already finished.
    await stream.append(
      {
        type: "events.iterate.com/agent/status-changed",
        payload: { busy: true, sinceOffset: 1 },
      },
      {
        type: "events.iterate.com/agent/status-changed",
        payload: { busy: false, sinceOffset: 2 },
      },
    );
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

  it("paints the agent's shortStatus verbatim and its title via setTitle", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });
    slackCalls.length = 0;

    // The agent authored a title and shortStatus mid-work; the busy patch
    // lands in the same batch. One title paint, one status paint — the
    // agent's own words complete "<agent> is …".
    await stream.append(
      {
        type: "events.iterate.com/agent/status-changed",
        payload: { title: "Trip planning", shortStatus: "comparing flights" },
      },
      {
        type: "events.iterate.com/agent/status-changed",
        payload: { busy: true, sinceOffset: 2 },
      },
    );
    await deliverNewEvents({ cursors, processor, stream });
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setTitle",
        body: { channel_id: "C123", thread_ts: "111.222", title: "Trip planning" },
      },
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "C123",
          thread_ts: "111.222",
          status: "is comparing flights...",
          loading_messages: ["comparing flights..."],
        },
      },
    ]);

    // An unchanged title never repaints; a shortStatus change repaints the status.
    slackCalls.length = 0;
    await stream.append({
      type: "events.iterate.com/agent/status-changed",
      payload: { shortStatus: "booking the winner" },
    });
    await deliverNewEvents({ cursors, processor, stream });
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "C123",
          thread_ts: "111.222",
          status: "is booking the winner...",
          loading_messages: ["booking the winner..."],
        },
      },
    ]);
  });

  it("retries a failed title paint on batch redelivery", async () => {
    let failNext = true;
    const { cursors, processor, slackCalls, stream } = setup({
      callSlackApi: async (method) => {
        if (method !== "assistant.threads.setTitle" || !failNext) return;
        failNext = false;
        throw new Error("slack blew up");
      },
    });

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });
    slackCalls.length = 0;

    const [patch] = await appendTestEvents(stream, {
      type: "events.iterate.com/agent/status-changed",
      payload: { title: "Trip planning" },
    });
    // The failed call fails the batch (checkpoint held) — the painted-title
    // record must NOT be written, or the redelivered batch would see the
    // rename as already painted and skip it forever.
    await expect(deliverNewEvents({ cursors, processor, stream })).rejects.toThrow("slack blew up");

    slackCalls.length = 0;
    await processor.ingest({ events: [patch!], streamMaxOffset: patch!.offset });
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setTitle",
        body: { channel_id: "C123", thread_ts: "111.222", title: "Trip planning" },
      },
    ]);
  });

  it("paints the script phase and a blocked wait in the agent's own words", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });
    slackCalls.length = 0;

    await stream.append({
      type: "events.iterate.com/agent/status-changed",
      payload: { busy: true, phase: "script", sinceOffset: 1 },
    });
    await deliverNewEvents({ cursors, processor, stream });
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "C123",
          thread_ts: "111.222",
          status: "is running a script...",
          loading_messages: ["running a script..."],
        },
      },
    ]);

    // The turn ends BLOCKED on the human: the status says so instead of
    // clearing, and the 👀 comes off (the message was handled).
    slackCalls.length = 0;
    await stream.append(
      {
        type: "events.iterate.com/agent/status-changed",
        payload: { blocked: true, shortStatus: "waiting for your Acme API key" },
      },
      {
        type: "events.iterate.com/agent/status-changed",
        payload: { busy: false, sinceOffset: 2 },
      },
    );
    await deliverNewEvents({ cursors, processor, stream });
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "C123",
          thread_ts: "111.222",
          status: "is waiting for your Acme API key...",
          loading_messages: ["waiting for your Acme API key..."],
        },
      },
      {
        method: "reactions.remove",
        body: { channel: "C123", name: "eyes", timestamp: "111.222" },
      },
    ]);
  });

  it("an authored-only patch (busy never announced) paints the title but clears nothing", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });
    slackCalls.length = 0;

    // The agent set its title before any busy flip was announced. That says
    // nothing about work: no status clear, and the 👀 ack MUST survive.
    await stream.append({
      type: "events.iterate.com/agent/status-changed",
      payload: { title: "Trip planning" },
    });
    await deliverNewEvents({ cursors, processor, stream });

    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setTitle",
        body: { channel_id: "C123", thread_ts: "111.222", title: "Trip planning" },
      },
    ]);
  });

  it("ignores a stale idle announcement that lost its race with newer work", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });
    slackCalls.length = 0;

    await stream.append({
      type: "events.iterate.com/agent/status-changed",
      payload: { busy: true, sinceOffset: 5 },
    });
    await deliverNewEvents({ cursors, processor, stream });
    slackCalls.length = 0;

    // The agent's debounced idle append can land AFTER a newer busy
    // announcement (the timer races new work by design — see the event's
    // contract). Its older sinceOffset folds to nothing, and the repaint
    // keeps the busy status instead of clearing it.
    await stream.append({
      type: "events.iterate.com/agent/status-changed",
      payload: { busy: false, sinceOffset: 3 },
    });
    await deliverNewEvents({ cursors, processor, stream });

    expect(processor.state.status).toMatchObject({ busy: true, sinceOffset: 5 });
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "C123",
          thread_ts: "111.222",
          status: "is making an LLM request...",
          loading_messages: ["making an LLM request..."],
        },
      },
    ]);
  });

  it("carries a behind-batch announcement to the at-head repaint", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });
    slackCalls.length = 0;

    // The idle announcement lands in a batch stamped BEHIND the head (a
    // render/input event already followed it — the wake-lane shape), and the
    // trailing catch-up batch that reaches head contains no announcements at
    // all. The repaint must not lose it: without the carry, Slack keeps
    // "is thinking..." and the eyes reaction forever.
    const [idle, render] = await appendTestEvents(
      stream,
      {
        type: "events.iterate.com/agent/status-changed",
        payload: { busy: false, sinceOffset: 1 },
      },
      {
        // Not consumed by slack-agent: stands in for the renders/inputs that
        // typically trail a completion.
        type: "events.iterate.com/agent/input-added",
        payload: { content: "render" },
      },
    );
    await processor.ingest({ events: [idle!], streamMaxOffset: render!.offset });
    expect(slackCalls).toEqual([]); // behind the head: deferred, not painted

    await processor.ingest({ events: [render!], streamMaxOffset: render!.offset });
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

  it("clears a status this incarnation painted even when the idle announcement is stale", async () => {
    const { clock, cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });
    await stream.append({
      type: "events.iterate.com/agent/status-changed",
      payload: { busy: true, sinceOffset: 1 },
    });
    await deliverNewEvents({ cursors, processor, stream });
    slackCalls.length = 0;

    // The idle announcement exists but is only DELIVERED past the freshness
    // horizon (the host slept through it). A status we ourselves painted must
    // still come down — the alternative is "is thinking..." forever.
    await stream.append({
      type: "events.iterate.com/agent/status-changed",
      payload: { busy: false, sinceOffset: 2 },
    });
    clock.now += 16 * 60_000;
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

  it("skips the stale 👀 ack on a late wake but still lands the agent input", async () => {
    const { clock, cursors, processor, slackCalls, stream } = setup();

    // The webhook arrived while the processor's host was down; delivery
    // happens 16 minutes later. The durable lane (agent input) must land —
    // the ack lane must not pretend the message was "just picked up".
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    clock.now += 16 * 60_000;
    await deliverNewEvents({ cursors, processor, stream });

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/message-received"),
    ).toHaveLength(1);
    expect(slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });

  it("refold: replaying the full journal re-executes no Slack calls and appends nothing new", async () => {
    // THE refold test (docs/writing-stream-processors.md, "Refold safety"):
    // a state-schema deploy discards the checkpoint and replays the journal
    // from offset 0 into a fresh instance. Durable lanes dedupe via
    // idempotency keys; acknowledgement/cosmetic lanes must not re-fire.
    const { clock, cursors, processor, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });
    await stream.append({
      type: "events.iterate.com/agent/status-changed",
      payload: { busy: true, sinceOffset: 1 },
    });
    await deliverNewEvents({ cursors, processor, stream });
    await stream.append({
      type: "events.iterate.com/agent/status-changed",
      payload: { busy: false, sinceOffset: 2 },
    });
    await deliverNewEvents({ cursors, processor, stream });
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
    await deliverNewEvents({ cursors, processor: refolded, stream });

    expect(refoldCalls).toEqual([]);
    expect(stream.events).toHaveLength(journalBeforeRefold);
    // The refolded state converged to the live processor's.
    expect(refolded.state).toEqual(processor.state);
  });

  it("captures route context and stamps the thread's roster identity once", async () => {
    const { cursors, processor, slackCalls, stream } = setup({
      fetchSlackChannelName: async () => "trip-planning",
    });

    await stream.append({
      type: "events.iterate.com/slack/thread-route-configured",
      payload: {
        channel: "C123",
        threadTs: "111.222",
        streamPath: "/agents/slack/nustom/c123/ts-111-222",
      },
    });
    await deliverNewEvents({ cursors, processor, stream });

    expect(processor.state).toMatchObject({
      channel: "C123",
      streamPath: "/agents/slack/nustom/c123/ts-111-222",
      threadTs: "111.222",
    });
    // The route stamps the slack icon and "#channel" identity for the roster
    // (idempotency-keyed: a re-configured route never re-stamps, and the
    // agent's own setStatus patches win later by journal order). No Slack
    // API calls ride this lane beyond the name lookup dep.
    const identity = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/status-changed",
    );
    expect(identity).toHaveLength(1);
    expect(identity[0]!.payload).toEqual({
      icon: "slack",
      title: "#trip-planning thread",
      note: "Slack thread in #trip-planning",
    });
    expect(slackCalls).toHaveLength(0);
  });

  it("compiles the !debug bang command into a Slack-posting debug script", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

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
    await deliverNewEvents({ cursors, processor, stream });

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
    stream.append = async (...args: Parameters<Stream["append"]>) => {
      const inputs = ("return" in args[0]! ? args.slice(1) : args) as StreamEventInput[];
      calls.push(...inputs.map((input) => `append:${input.type}`));
      return originalAppend(...args);
    };
    const processor = new SlackAgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      callSlackApi: async (method) => {
        calls.push(`slack:${method}`);
      },
    });
    const cursors = new Map<object, number>();
    await deliverNewEvents({ cursors, processor, stream });

    expect(calls).toEqual([
      "append:events.iterate.com/agents/message-received",
      "slack:reactions.add",
    ]);
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
          user: { id: "U777" },
          message: { ts: "111.333", thread_ts: "111.222", text: "Choose one" },
          actions: [{ action_id: "approve", type: "button", value: "yes" }],
        },
      },
    });
    await deliverNewEvents({ cursors, processor, stream });

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
      stream.events.filter((event) => event.type === "events.iterate.com/agents/message-received"),
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
        return streamEvent.type === "events.iterate.com/agents/message-received";
      }),
    ).toHaveLength(1);
    // Bot-authored messages never get the eyes reaction, even when forwarded.
    expect(slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });

  it("forwards other bot messages when Slack authorizations omit bot_id", async () => {
    const { cursors, processor, slackCalls, stream } = setup();

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
    await deliverNewEvents({ cursors, processor, stream });

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
    const { cursors, processor, slackCalls, stream } = setup();

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
    await deliverNewEvents({ cursors, processor, stream });

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
    const { cursors, processor, slackCalls, stream } = setup();

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
    await deliverNewEvents({ cursors, processor, stream });

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
