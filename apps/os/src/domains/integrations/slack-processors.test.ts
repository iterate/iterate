import { describe, expect, it } from "vitest";
import { ZERO_AGENT_RUNTIME } from "@iterate-com/shared/agent-events";
import type { StreamEventInput } from "../streams/schemas.ts";
import { slackAgentSystemPrompt } from "../agents/agent-defaults.ts";
import { MemoryStreamNetwork, driveProcessor } from "../streams/test-helpers.ts";
import { StreamProcessorRunner } from "../streams/stream-processor-runner.ts";
import { SlackProcessor } from "./slack-processor-implementation.ts";
import {
  SlackAgentProcessor,
  compileBangCommand,
  eyesReactionTargetFromWebhookPayload,
} from "./slack-agent-processor-implementation.ts";

const TEAM_ID = "T0TEAM";
const CONNECTION = "nustom";

function metadataChanged(payload: Record<string, unknown>) {
  return { type: "events.iterate.com/agent/metadata-changed" as const, payload };
}

function runtimeChanged(sinceOffset: number, work: "idle" | "llm" | "script" = "idle") {
  return {
    type: "events.iterate.com/agent/runtime-changed" as const,
    payload: {
      sinceOffset,
      runtime:
        work === "script"
          ? { ...ZERO_AGENT_RUNTIME, runningScripts: 1 }
          : work === "llm"
            ? {
                ...ZERO_AGENT_RUNTIME,
                llmRequests: { scheduled: 0, requested: 1, started: 0 },
              }
            : ZERO_AGENT_RUNTIME,
    },
  };
}

function newSlackRouter(input: ConstructorParameters<typeof SlackProcessor>[0]): SlackProcessor {
  void input.stream.append({
    type: "events.iterate.com/slack/created",
    idempotencyKey: "test:slack-router-created",
    payload: { config: { connection: CONNECTION } },
  });
  return new SlackProcessor(input);
}

function newSlackAgent(
  input: ConstructorParameters<typeof SlackAgentProcessor>[0],
): SlackAgentProcessor {
  void input.stream.append({
    type: "events.iterate.com/slack-agent/created",
    idempotencyKey: "test:slack-agent-created",
    payload: {
      config: { channel: "C123", connection: CONNECTION, threadTs: "111.222" },
    },
  });
  return new SlackAgentProcessor(input);
}

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
  /** When true (default), the message @mentions the authorized bot so the
   * mention-gate wakes the LLM. Pass false for ambient channel traffic. */
  mentionBot?: boolean;
  text?: string;
  threadTs?: string;
  ts?: string;
}) {
  const mentionBot = input.mentionBot !== false;
  const defaultText = mentionBot ? "<@UBOT> hello agent" : "hello agent";
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
        text: input.text ?? defaultText,
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
  it("throws when a second Slack-router birth certificate is reduced", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack/nustom");
    const processor = newSlackRouter({ stream, path: stream.path, projectId: "prj_1" });
    const driver = driveProcessor(processor, stream);
    await stream.append({
      type: "events.iterate.com/slack/created",
      payload: { config: { connection: CONNECTION } },
    });

    await expect(driver.deliver()).rejects.toThrow("more than one slack/created event");
  });

  it("creates a route and forwards the webhook to the routed agent stream", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack/nustom");
    const acked: unknown[] = [];
    const processor = newSlackRouter({
      stream,
      path: stream.path,
      projectId: "prj_1",
      acknowledgeRoutedWebhook: ({ payload }) => {
        acked.push(payload);
      },
    });
    const driver = driveProcessor(processor, stream);

    await stream.append(connectedEvent(), {
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await driver.deliver();

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

    // …and the routed stream is explicitly born and bound before [route, webhook].
    const routed = network.eventsAt("/agents/slack/nustom/c123/ts-111-222");
    expect(routed.slice(0, 4).map((event) => event.type)).toEqual([
      "events.iterate.com/agent/created",
      "events.iterate.com/agent/binding-set",
      "events.iterate.com/capability-host/created",
      "events.iterate.com/slack-agent/created",
    ]);
    expect(
      routed.filter((event) => event.type === "events.iterate.com/stream/subscription-configured"),
    ).toHaveLength(3);
    expect(routed.slice(-2).map((event) => event.type)).toEqual([
      "events.iterate.com/slack/thread-route-configured",
      "events.iterate.com/slack/webhook-received",
    ]);
    expect(routed.at(-1)!.payload).toEqual(humanMessageWebhookPayload({}));

    // The fast-ack hook fired once for the forwarded webhook.
    expect(acked).toHaveLength(1);
  });

  it("routes after birth even when no connected lifecycle fact exists", async () => {
    // The explicit birth certificate, not a connected fact or path parsing,
    // owns the connection used for routing.
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack/nustom");
    const processor = newSlackRouter({
      stream,
      path: stream.path,
      projectId: "prj_1",
    });
    const driver = driveProcessor(processor, stream);

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await driver.deliver();

    const routed = network.eventsAt("/agents/slack/nustom/c123/ts-111-222");
    expect(routed.slice(0, 4).map((event) => event.type)).toEqual([
      "events.iterate.com/agent/created",
      "events.iterate.com/agent/binding-set",
      "events.iterate.com/capability-host/created",
      "events.iterate.com/slack-agent/created",
    ]);
    expect(routed.slice(-2).map((event) => event.type)).toEqual([
      "events.iterate.com/slack/thread-route-configured",
      "events.iterate.com/slack/webhook-received",
    ]);
  });

  it("forwards follow-up webhooks through the reduced routing table", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack/nustom");
    const processor = newSlackRouter({
      stream,
      path: stream.path,
      projectId: "prj_1",
    });
    const driver = driveProcessor(processor, stream);

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
    await driver.deliver();

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
    const processor = newSlackRouter({
      stream,
      path: stream.path,
      projectId: "prj_1",
    });
    const driver = driveProcessor(processor, stream);

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
    await driver.deliver();

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
    const processor = newSlackRouter({
      stream,
      path: stream.path,
      projectId: "prj_1",
    });
    const driver = driveProcessor(processor, stream);

    await stream.append(connectedEvent(), {
      type: "events.iterate.com/slack/disconnected",
      payload: { projectId: "prj_1", teamId: TEAM_ID },
    });
    await driver.deliver();
    // The router's whole state is its routing table; connection status is read
    // straight off the journal by getConnectionStatus, so lifecycle facts
    // reduce to nothing here.
    expect(driver.state).toEqual({
      birthCertificate: { config: { connection: CONNECTION } },
      routes: {},
    });
  });

  it("does nothing before its explicit birth certificate", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack");
    const processor = new SlackProcessor({
      stream,
      path: stream.path,
      projectId: null,
    });
    const driver = driveProcessor(processor, stream);

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await driver.deliver();
    expect(network.streams.size).toBe(1);
  });

  it("acknowledges webhooks forwarded through existing routes", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/slack/nustom");
    const acked: unknown[] = [];
    const processor = newSlackRouter({
      stream,
      path: stream.path,
      projectId: "prj_1",
      acknowledgeRoutedWebhook: ({ payload }) => {
        acked.push(payload);
      },
    });
    const driver = driveProcessor(processor, stream);

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
    await driver.deliver();

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
    const processor = newSlackRouter({
      stream,
      path: stream.path,
      projectId: "prj_1",
      acknowledgeRoutedWebhook: ({ payload }) => {
        acked.push(payload);
      },
      now: () => clock.now,
    });
    const driver = driveProcessor(processor, stream);

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await driver.deliver();
    expect(acked).toHaveLength(1);
    const routedPath = "/agents/slack/nustom/c123/ts-111-222";
    const routedCount = network.eventsAt(routedPath).length;
    expect(routedCount).toBeGreaterThan(2);

    clock.now += 60 * 60_000;
    const refoldAcked: unknown[] = [];
    const refolded = newSlackRouter({
      stream,
      path: stream.path,
      projectId: "prj_1",
      acknowledgeRoutedWebhook: ({ payload }) => {
        refoldAcked.push(payload);
      },
      now: () => clock.now,
    });
    await driveProcessor(refolded, stream).deliver();

    // The stale ack is skipped; the durable forwards replay and dedupe at the
    // append layer (idempotency keys), leaving the routed stream unchanged.
    expect(refoldAcked).toEqual([]);
    expect(network.eventsAt(routedPath)).toHaveLength(routedCount);
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
    const processor = newSlackRouter({
      stream,
      path: stream.path,
      projectId: "prj_1",
      acknowledgeRoutedWebhook: ({ payload }) => {
        acked.push(payload);
      },
    });
    const driver = driveProcessor(processor, stream);

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: { body: { type: "url_verification", challenge: "x" } },
    });
    await driver.deliver();

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
    const processor = newSlackRouter({
      stream,
      path: stream.path,
      projectId: "prj_1",
    });
    const driver = driveProcessor(processor, stream);
    // Connected is an ordinary lifecycle fact; birth owns the connection.
    await stream.append(connectedEvent());
    await driver.deliver();
    await expect(driver.snapshot()).resolves.toMatchObject({ offset: 2 });
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });

    // First delivery: the forward throws. The pass MUST reject and the
    // cursor MUST hold — otherwise the webhook is gone for good. (The home
    // route fact landed before the forward threw; it replays and dedupes.)
    await expect(driver.deliver()).rejects.toThrow(/StreamsCapability/);
    await expect(driver.snapshot()).resolves.toMatchObject({ offset: 2 });
    expect(routed.events).toHaveLength(0);

    // The runner replays the same webhook from the un-advanced cursor; the
    // forward now succeeds and the cursor advances through the route fact
    // the failed attempt had already committed to the router's own stream.
    await driver.deliver();
    await expect(driver.snapshot()).resolves.toMatchObject({ offset: 4 });
    expect(routed.events.slice(0, 4).map((event) => event.type)).toEqual([
      "events.iterate.com/agent/created",
      "events.iterate.com/agent/binding-set",
      "events.iterate.com/capability-host/created",
      "events.iterate.com/slack-agent/created",
    ]);
    expect(routed.events.slice(-2).map((event) => event.type)).toEqual([
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
  // is `processEvent` under `delivery.caughtUp`, and only the runner stamps
  // an honest delivery context — a hand-rolled drive would never mark a head
  // event and every status assertion here would test nothing. `readPageSize`
  // shrinks the catch-up page so a single `deliver()` exercises behind-head
  // frames (the carry).
  function setup(deps?: {
    callSlackApi?: (input: {
      body: Record<string, unknown>;
      connection: string;
      method: string;
    }) => Promise<void>;
    fetchSlackChannelName?: (input: {
      channel: string;
      connection: string;
    }) => Promise<string | null>;
    readPageSize?: number;
    storeSlackFiles?: ConstructorParameters<typeof SlackAgentProcessor>[0]["storeSlackFiles"];
  }) {
    const clock = { now: Date.parse("2026-07-09T12:00:00Z") };
    const network = new MemoryStreamNetwork(() => clock.now);
    const stream = network.get("/agents/slack/nustom/c123/ts-111-222");
    const slackCalls: Array<{ body: Record<string, unknown>; method: string }> = [];
    const processor = newSlackAgent({
      stream,
      path: stream.path,
      projectId: null,
      callSlackApi: async (input) => {
        const { body, method } = input;
        slackCalls.push({ body, method });
        await deps?.callSlackApi?.(input);
      },
      now: () => clock.now,
      ...(deps?.fetchSlackChannelName === undefined
        ? {}
        : { fetchSlackChannelName: deps.fetchSlackChannelName }),
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

  it("throws when a second Slack-agent birth certificate is reduced", async () => {
    const { deliver, stream } = setup();
    await stream.append({
      type: "events.iterate.com/slack-agent/created",
      payload: {
        config: { channel: "C123", connection: CONNECTION, threadTs: "111.222" },
      },
    });

    await expect(deliver()).rejects.toThrow("more than one slack-agent/created event");
  });

  it("turns a routed @mention into triggering agent context and adds the eyes reaction", async () => {
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
      actor: { type: "slack", userId: "UHUMAN" },
      refs: [
        {
          type: "event",
          streamPath: "/agents/slack/nustom/c123/ts-111-222",
          offset: 3,
          eventType: "events.iterate.com/slack/webhook-received",
        },
      ],
    });
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
      conversationActive: true,
      eyesReactionMessageTs: "111.222",
      threadTs: "111.222",
    });
  });

  it("records unmentioned human messages as non-triggering history without eyes", async () => {
    const { deliver, runner, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({ mentionBot: false, text: "just humans talking" }),
    });
    await deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
    expect((inputs[0]!.payload as { content: string }).content).toContain("just humans talking");
    expect(slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
    expect(runner.currentState.conversationActive).toBe(false);
  });

  it("wakes on app_mention without requiring the text form <@bot>", async () => {
    const { deliver, runner, slackCalls, stream } = setup();

    const payload = humanMessageWebhookPayload({ text: "hey iterate, status?" });
    (payload.body.event as Record<string, unknown>).type = "app_mention";
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload,
    });
    await deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect((inputs[0]!.payload as { llmRequestPolicy?: unknown }).llmRequestPolicy).toEqual({
      behaviour: "after-current-request",
    });
    expect(slackCalls).toContainEqual({
      method: "reactions.add",
      body: { channel: "C123", name: "eyes", timestamp: "111.222" },
    });
    expect(runner.currentState.conversationActive).toBe(true);
  });

  it("after a mention, later unmentioned thread messages still trigger the LLM", async () => {
    const { deliver, runner, slackCalls, stream } = setup();

    await stream.append(
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: humanMessageWebhookPayload({ text: "<@UBOT> please help", ts: "111.222" }),
      },
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: humanMessageWebhookPayload({
          mentionBot: false,
          text: "and also check the logs",
          threadTs: "111.222",
          ts: "111.333",
        }),
      },
    );
    await deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(2);
    expect(
      inputs.map(
        (event) => (event.payload as { llmRequestPolicy?: { behaviour: string } }).llmRequestPolicy,
      ),
    ).toEqual([{ behaviour: "after-current-request" }, { behaviour: "after-current-request" }]);
    // Eyes only on the activating mention, not the follow-up.
    expect(slackCalls.filter((call) => call.method === "reactions.add")).toEqual([
      { method: "reactions.add", body: { channel: "C123", name: "eyes", timestamp: "111.222" } },
    ]);
    expect(runner.currentState.conversationActive).toBe(true);
  });

  it("materializes shared files and attaches them to the agent context item", async () => {
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
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({ files: [attachment] });
  });

  it("a failed file download forwards the message with an explicit loss note", async () => {
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
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).not.toHaveProperty("files");
    const content = (inputs[0]!.payload as { content: string }).content;
    expect(content).toContain("cat.png");
    // Never a silent drop: the loss and its cause are visible to the model.
    expect(content).toContain("[1 attachment(s) could not be loaded: slack download exploded]");
  });

  it("ignores our own bot's messages entirely", async () => {
    const { deliver, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: botMessageWebhookPayload(),
    });
    await deliver();

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/context-added"),
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
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
    expect(slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });

  it("compiles bang commands into itx script executions instead of agent context", async () => {
    const { deliver, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({ text: "!whoami" }),
    });
    await deliver();

    const scripts = stream.events.filter(
      (event) => event.type === "events.iterate.com/capability-host/script-run-requested",
    );
    expect(scripts).toHaveLength(1);
    expect((scripts[0]!.payload as { code: string }).code).toContain("await itx.whoami()");
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/context-added"),
    ).toHaveLength(0);
    expect(slackCalls).toContainEqual({
      method: "reactions.add",
      body: { channel: "C123", name: "eyes", timestamp: "111.222" },
    });
  });

  it("paints exact active runtime and clears Slack when runtime settles", async () => {
    const { deliver, slackCalls, stream } = setup();

    // Establish thread context first.
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    slackCalls.length = 0;

    await stream.append(runtimeChanged(1, "llm"));
    await deliver();
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "C123",
          thread_ts: "111.222",
          status: "Waiting for the model…",
          loading_messages: ["Waiting for the model…"],
        },
      },
    ]);

    slackCalls.length = 0;
    await stream.append(runtimeChanged(2));
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

  it("dedupes unchanged activity across exact runtime generations", async () => {
    const { deliver, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    await stream.append(runtimeChanged(1, "llm"));
    await deliver();
    slackCalls.length = 0;

    await stream.append(runtimeChanged(2, "llm"));
    await deliver();

    expect(slackCalls).toEqual([]);
  });

  it("retries a failed activity paint instead of memoizing it", async () => {
    let failNext = true;
    const { deliver, slackCalls, stream } = setup({
      callSlackApi: async ({ method }) => {
        if (method !== "assistant.threads.setStatus" || !failNext) return;
        failNext = false;
        throw new Error("slack status failed");
      },
    });

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    slackCalls.length = 0;
    await stream.append(runtimeChanged(1, "llm"));

    await expect(deliver()).rejects.toThrow("slack status failed");
    slackCalls.length = 0;
    await deliver();

    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "C123",
          thread_ts: "111.222",
          status: "Waiting for the model…",
          loading_messages: ["Waiting for the model…"],
        },
      },
    ]);
  });

  it("repaints presence once per batch from the latest runtime", async () => {
    const { deliver, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    slackCalls.length = 0;

    // Busy and idle land in ONE batch: the status is a repaint of current
    // truth, so only the final (cleared) status reaches Slack — no transient
    // "is thinking..." call for work that already finished.
    await stream.append(runtimeChanged(1, "llm"), runtimeChanged(2));
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

  it("a fresh incarnation clears settled runtime even when metadata is the last batch fact", async () => {
    const { clock, deliver, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    // The webhook is historical to this replacement incarnation, but the
    // settlement and following metadata patch are fresh. Slack may still
    // carry the status painted by the dead incarnation.
    clock.now += 16 * 60_000;
    await stream.append(runtimeChanged(1), metadataChanged({ activity: "Finished" }));
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

  it("paints authored activity verbatim and title via setTitle", async () => {
    const { deliver, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    slackCalls.length = 0;

    // Metadata and factual runtime land in the same batch. One title paint
    // and one activity paint are derived from the complete at-head fold.
    await stream.append(
      metadataChanged({ title: "Trip planning", activity: "Comparing flights" }),
      runtimeChanged(2, "llm"),
    );
    await deliver();
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
          status: "Comparing flights…",
          loading_messages: ["Comparing flights…"],
        },
      },
    ]);

    // An unchanged title never repaints; an activity change repaints status.
    slackCalls.length = 0;
    await stream.append(metadataChanged({ activity: "Booking the winner" }));
    await deliver();
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "C123",
          thread_ts: "111.222",
          status: "Booking the winner…",
          loading_messages: ["Booking the winner…"],
        },
      },
    ]);
  });

  it("retries a failed title paint on batch redelivery", async () => {
    let failNext = true;
    const { clock, deliver, slackCalls, stream } = setup({
      callSlackApi: async ({ method }) => {
        if (method !== "assistant.threads.setTitle" || !failNext) return;
        failNext = false;
        throw new Error("slack blew up");
      },
    });

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    slackCalls.length = 0;

    await stream.append(metadataChanged({ title: "Trip planning" }));
    // The failed call fails the frame (cursor held) — the painted-title
    // record must NOT be written, or the redelivered frame would see the
    // rename as already painted and skip it forever.
    await expect(deliver()).rejects.toThrow("slack blew up");

    slackCalls.length = 0;
    clock.now += 16 * 60_000;
    // The runner's cursor never advanced past the failed frame; the next
    // catch-up redelivers exactly the unacknowledged patch. Durable title
    // reconciliation does not expire while that checkpoint is held.
    await deliver();
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setTitle",
        body: { channel_id: "C123", thread_ts: "111.222", title: "Trip planning" },
      },
    ]);
  });

  it("clears a title with an empty Slack title and dedupes the cleared state", async () => {
    const { deliver, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    await stream.append(metadataChanged({ title: "Trip planning" }));
    await deliver();
    slackCalls.length = 0;

    await stream.append(metadataChanged({ title: null }));
    await deliver();
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setTitle",
        body: { channel_id: "C123", thread_ts: "111.222", title: "" },
      },
    ]);

    slackCalls.length = 0;
    await stream.append(metadataChanged({ activity: "Waiting for a choice" }));
    await deliver();
    expect(slackCalls).toEqual([]);
  });

  it("retries a failed title clear on batch redelivery", async () => {
    let failClear = true;
    const { clock, deliver, slackCalls, stream } = setup({
      callSlackApi: async ({ body, method }) => {
        if (method !== "assistant.threads.setTitle" || body.title !== "" || !failClear) return;
        failClear = false;
        throw new Error("slack clear blew up");
      },
    });

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    await stream.append(metadataChanged({ title: "Trip planning" }));
    await deliver();
    slackCalls.length = 0;

    await stream.append(metadataChanged({ title: null }));
    await expect(deliver()).rejects.toThrow("slack clear blew up");
    slackCalls.length = 0;
    clock.now += 16 * 60_000;
    await deliver();
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setTitle",
        body: { channel_id: "C123", thread_ts: "111.222", title: "" },
      },
    ]);
  });

  it("reconciles stale title set and clear facts in fresh incarnations", async () => {
    const setCase = setup();
    await setCase.stream.append(metadataChanged({ title: "Trip planning" }));
    setCase.clock.now += 16 * 60_000;
    await setCase.deliver();
    expect(setCase.slackCalls).toEqual([
      {
        method: "assistant.threads.setTitle",
        body: { channel_id: "C123", thread_ts: "111.222", title: "Trip planning" },
      },
    ]);

    const clearCase = setup();
    await clearCase.stream.append(
      metadataChanged({ title: "Trip planning" }),
      metadataChanged({ title: null }),
    );
    clearCase.clock.now += 16 * 60_000;
    await clearCase.deliver();
    expect(clearCase.slackCalls).toEqual([
      {
        method: "assistant.threads.setTitle",
        body: { channel_id: "C123", thread_ts: "111.222", title: "" },
      },
    ]);
  });

  it("paints script runtime but clears for semantic waiting", async () => {
    const { deliver, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    slackCalls.length = 0;

    await stream.append(runtimeChanged(1, "script"));
    await deliver();
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "C123",
          thread_ts: "111.222",
          status: "Running code…",
          loading_messages: ["Running code…"],
        },
      },
    ]);

    // A semantic dependency remains durable in Iterate, but Slack's typing
    // status is strictly transient runtime and must come down.
    slackCalls.length = 0;
    await stream.append(
      metadataChanged({
        activity: "Waiting for your Acme API key",
        waitingFor: "user_input",
      }),
      runtimeChanged(2),
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

  it("clears eyes from the acknowledged mention after a newer ambient follow-up", async () => {
    const { deliver, runner, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({ ts: "111.222" }),
    });
    await deliver();
    expect(runner.currentState.eyesReactionMessageTs).toBe("111.222");

    await stream.append(runtimeChanged(1, "script"));
    await deliver();
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({
        mentionBot: false,
        text: "one more detail",
        threadTs: "111.222",
        ts: "111.333",
      }),
    });
    await deliver();
    expect(runner.currentState.eyesReactionMessageTs).toBe("111.222");

    slackCalls.length = 0;
    await stream.append(runtimeChanged(2));
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

  it("replaces the previous eyes reaction when another mention arrives", async () => {
    const { deliver, runner, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({ eventId: "Ev-first", ts: "111.222" }),
    });
    await deliver();
    slackCalls.length = 0;

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({
        eventId: "Ev-second",
        threadTs: "111.222",
        ts: "111.444",
      }),
    });
    await deliver();

    expect(slackCalls).toEqual([
      {
        method: "reactions.remove",
        body: { channel: "C123", name: "eyes", timestamp: "111.222" },
      },
      {
        method: "reactions.add",
        body: { channel: "C123", name: "eyes", timestamp: "111.444" },
      },
    ]);
    expect(runner.currentState.eyesReactionMessageTs).toBe("111.444");
  });

  it("a metadata-only patch paints the title but clears no transient status", async () => {
    const { deliver, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    slackCalls.length = 0;

    // The agent set its title before any runtime was announced. That says
    // nothing about work: no status clear, and the 👀 ack MUST survive.
    await stream.append(metadataChanged({ title: "Trip planning" }));
    await deliver();

    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setTitle",
        body: { channel_id: "C123", thread_ts: "111.222", title: "Trip planning" },
      },
    ]);
  });

  it("ignores a stale settled runtime that lost its race with newer work", async () => {
    const { deliver, runner, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    slackCalls.length = 0;

    await stream.append(runtimeChanged(5, "llm"));
    await deliver();
    slackCalls.length = 0;

    // A delayed zero can land after newer work. Its older generation folds
    // to nothing and the repaint keeps active truth instead of clearing it.
    await stream.append(runtimeChanged(3));
    await deliver();

    expect(runner.currentState.runtimeChange).toMatchObject({
      sinceOffset: 5,
      runtime: { llmRequests: { requested: 1 } },
    });
    expect(slackCalls).toEqual([]);
  });

  it("carries a behind-head runtime change to the at-head repaint", async () => {
    // readPageSize 1 makes one catch-up deliver the idle announcement in a
    // frame stamped BEHIND the head (a trailing event follows it — the
    // wake-lane shape) while the frame that reaches head contains no
    // announcements at all. The repaint must not lose it OR run per behind
    // frame: exactly one title reset plus the status clear pair, painted at
    // the at-head pulse. Without the carry, Slack keeps stale presentation
    // from the dead incarnation.
    // The at-head pulse is `processEvent` under `delivery.caughtUp`. This
    // scenario uses a consumed revival fact, so it exercises the normal
    // per-event pass; an unconsumed tail would exercise the runner's eventless
    // at-head pass and repaint from the same final fold.
    const { deliver, slackCalls, stream } = setup({ readPageSize: 1 });

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    slackCalls.length = 0;

    await stream.append(runtimeChanged(1), {
      // Consumed by slack-agent but carrying no announcement: the revival
      // fact's ordinary delivery is the at-head pulse the repaint rides.
      type: "events.iterate.com/stream/processor-revived",
      payload: { processorSlug: "slack-agent", revivals: 1, version: "2026-07-14.1" },
    });
    await deliver();
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setTitle",
        body: { channel_id: "C123", thread_ts: "111.222", title: "" },
      },
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

  it("clears activity this incarnation painted even when settlement delivery is stale", async () => {
    const { clock, deliver, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    await stream.append(runtimeChanged(1, "llm"));
    await deliver();
    slackCalls.length = 0;

    // The zero runtime exists but is only DELIVERED past the freshness
    // horizon (the host slept through it). A status we ourselves painted must
    // still come down — the alternative is "is thinking..." forever.
    await stream.append(runtimeChanged(2));
    clock.now += 16 * 60_000;
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

  it("a fresh incarnation clears stale accepted-zero runtime", async () => {
    const { clock, deliver, slackCalls, stream } = setup();

    await stream.append(runtimeChanged(1, "llm"), runtimeChanged(2));
    clock.now += 16 * 60_000;
    await deliver();

    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: { channel_id: "C123", thread_ts: "111.222", status: "" },
      },
    ]);
  });

  it("retries failed accepted-zero cleanup after the freshness horizon", async () => {
    let failClear = true;
    const { clock, deliver, runner, slackCalls, stream } = setup({
      callSlackApi: async ({ body, method }) => {
        if (method !== "assistant.threads.setStatus" || body.status !== "" || !failClear) return;
        failClear = false;
        throw new Error("slack status clear failed");
      },
    });
    await deliver();
    const before = await runner.snapshot();
    await stream.append(runtimeChanged(1));

    await expect(deliver()).rejects.toThrow("slack status clear failed");
    await expect(runner.snapshot()).resolves.toMatchObject({ offset: before.offset });

    slackCalls.length = 0;
    clock.now += 16 * 60_000;
    await deliver();
    expect(slackCalls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: { channel_id: "C123", thread_ts: "111.222", status: "" },
      },
    ]);
  });

  it("skips the stale 👀 ack on a late wake but still lands the agent context", async () => {
    const { clock, deliver, slackCalls, stream } = setup();

    // The webhook arrived while the processor's host was down; delivery
    // happens 16 minutes later. The durable lane (agent context) must land —
    // the ack lane must not pretend the message was "just picked up".
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    clock.now += 16 * 60_000;
    await deliver();

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/context-added"),
    ).toHaveLength(1);
    expect(slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });

  it("refold: replaying the full journal performs only convergent cleanup", async () => {
    // THE refold test (docs/writing-stream-processors.md, "Refold safety"):
    // a state-schema deploy discards the checkpoint and replays the journal
    // from offset 0 into a fresh instance. Durable lanes dedupe via
    // idempotency keys; acknowledgement/cosmetic lanes must not re-fire.
    const { clock, deliver, runner, slackCalls, stream } = setup();

    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await deliver();
    await stream.append(runtimeChanged(1, "llm"));
    await deliver();
    await stream.append(runtimeChanged(2));
    await deliver();
    expect(slackCalls.length).toBeGreaterThan(0);
    const journalBeforeRefold = stream.events.length;

    clock.now += 60 * 60_000;
    const refoldCalls: Array<{ body: Record<string, unknown>; method: string }> = [];
    const refolded = newSlackAgent({
      stream,
      path: stream.path,
      projectId: null,
      callSlackApi: async ({ body, method }) => {
        refoldCalls.push({ body, method });
      },
      now: () => clock.now,
    });
    const refoldRunner = new StreamProcessorRunner({ processor: refolded, stream });
    await refoldRunner.catchUp();

    expect(refoldCalls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: { channel_id: "C123", thread_ts: "111.222", status: "" },
      },
      {
        method: "reactions.remove",
        body: { channel: "C123", name: "eyes", timestamp: "111.222" },
      },
    ]);
    expect(stream.events).toHaveLength(journalBeforeRefold);
    // The refolded state converged to the live processor's.
    expect(refoldRunner.currentState).toEqual(runner.currentState);
  });

  it("captures route context as a typed Slack binding without authoring metadata", async () => {
    const { deliver, runner, slackCalls, stream } = setup({
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
    await deliver();

    expect(runner.currentState).toMatchObject({
      channel: "C123",
      streamPath: "/agents/slack/nustom/c123/ts-111-222",
      threadTs: "111.222",
    });
    const metadata = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/metadata-changed",
    );
    expect(metadata).toHaveLength(0);
    const bindings = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/binding-set",
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.payload).toEqual({
      type: "slack_thread",
      connection: CONNECTION,
      channelId: "C123",
      threadTs: "111.222",
      channelName: "trip-planning",
    });
    expect(slackCalls).toHaveLength(0);
  });

  it("retries transient channel-name resolution before committing the binding", async () => {
    let attempts = 0;
    const { deliver, stream } = setup({
      fetchSlackChannelName: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Slack conversations.info timed out");
        return "trip-planning";
      },
    });

    await stream.append({
      type: "events.iterate.com/slack/thread-route-configured",
      payload: {
        channel: "C123",
        threadTs: "111.222",
        streamPath: "/agents/slack/nustom/c123/ts-111-222",
      },
    });

    await expect(deliver()).rejects.toThrow("conversations.info timed out");
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agent/binding-set"),
    ).toHaveLength(0);

    await deliver();
    expect(attempts).toBe(2);
    expect(
      stream.events.find((event) => event.type === "events.iterate.com/agent/binding-set")?.payload,
    ).toMatchObject({ channelName: "trip-planning", type: "slack_thread" });
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
      (event) => event.type === "events.iterate.com/capability-host/script-run-requested",
    );
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({
      idempotencyKey: "slack-agent/bang-command@/agents/slack/nustom/c123/ts-111-222:3",
      payload: { executionId: "slack-bang-command-3" },
    });
    const code = (scripts[0]!.payload as { code: string }).code;
    expect(code).toContain("const debug = await itx.debug();");
    expect(code).toContain('await itx.integrations.slack.get("nustom").chat.postMessage({');
    expect(code).toContain('channel: "C123"');
    expect(code).toContain('thread_ts: "111.222"');
    expect(code).toContain("text: `Debug info:\\n${debug}`");
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/context-added"),
    ).toHaveLength(0);
    expect(slackCalls).toContainEqual({
      method: "reactions.add",
      body: { channel: "C123", name: "eyes", timestamp: "111.222" },
    });
  });

  it("commits the agent context before adding the Slack eyes reaction", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/agents/slack/nustom/c123/ts-111-222");
    await stream.append({
      type: "events.iterate.com/slack-agent/created",
      payload: {
        config: { channel: "C123", connection: CONNECTION, threadTs: "111.222" },
      },
    });
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });

    // Record appends and Slack API calls into one list to pin their order:
    // the agent context must be durable before the eyes reaction signals
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
      callSlackApi: async ({ method }) => {
        calls.push(`slack:${method}`);
      },
    });
    await new StreamProcessorRunner({ processor, stream }).catchUp();

    expect(calls).toEqual([
      "append:events.iterate.com/agents/context-added",
      "slack:reactions.add",
    ]);
  });

  it("turns raw Slack interactivity payloads into triggering agent context", async () => {
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
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      idempotencyKey: "slack-agent/webhook-to-agent-context@/agents/slack/nustom/c123/ts-111-222:2",
    });
    const payload = inputs[0]!.payload as {
      actor?: unknown;
      content: string;
      llmRequestPolicy?: unknown;
      refs?: unknown;
      role: string;
    };
    // Interactivity payloads carry the presser at user.id, not event.user.
    expect(payload).toMatchObject({
      role: "developer",
      actor: { type: "slack", userId: "U777" },
      refs: [
        {
          type: "event",
          streamPath: "/agents/slack/nustom/c123/ts-111-222",
          offset: 2,
          eventType: "events.iterate.com/slack/webhook-received",
        },
      ],
    });
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
      stream.events.filter((event) => event.type === "events.iterate.com/agents/context-added"),
    ).toHaveLength(0);
    expect(slackCalls).toHaveLength(0);
  });

  it("forwards other-bot @mentions as triggering agent context without eyes", async () => {
    const { deliver, slackCalls, stream } = setup();

    const payload = humanMessageWebhookPayload({
      text: "<@UBOT> I am another bot mentioning iterate",
    });
    const event = payload.body.event as Record<string, unknown>;
    event.subtype = "bot_message";
    event.bot_id = "BOTHERBOT"; // not our authorized bot (BBOT)
    delete event.user;
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload,
    });
    await deliver();

    const inputs = stream.events.filter((streamEvent) => {
      return streamEvent.type === "events.iterate.com/agents/context-added";
    });
    expect(inputs).toHaveLength(1);
    expect((inputs[0]!.payload as { llmRequestPolicy?: unknown }).llmRequestPolicy).toEqual({
      behaviour: "after-current-request",
    });
    // Bot-authored messages never get the eyes reaction, even when forwarded.
    expect(slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });

  it("records other-bot messages without an @mention as non-triggering history", async () => {
    const { deliver, slackCalls, stream } = setup();

    const payload = humanMessageWebhookPayload({
      mentionBot: false,
      text: "I am another bot chatting ambiently",
    });
    const event = payload.body.event as Record<string, unknown>;
    event.subtype = "bot_message";
    event.bot_id = "BOTHERBOT";
    delete event.user;
    await stream.append({
      type: "events.iterate.com/slack/webhook-received",
      payload,
    });
    await deliver();

    const inputs = stream.events.filter(
      (streamEvent) => streamEvent.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
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
        streamEvent.type === "events.iterate.com/capability-host/script-run-requested",
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
        return streamEvent.type === "events.iterate.com/capability-host/script-run-requested";
      }),
    ).toHaveLength(0);
    expect(
      stream.events.filter(
        (streamEvent) => streamEvent.type === "events.iterate.com/agents/context-added",
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
        return streamEvent.type === "events.iterate.com/capability-host/script-run-requested";
      }),
    ).toHaveLength(0);
    expect(
      stream.events.filter(
        (streamEvent) => streamEvent.type === "events.iterate.com/agents/context-added",
      ),
    ).toHaveLength(0);
    expect(slackCalls).toHaveLength(0);
  });
});

describe("eyesReactionTargetFromWebhookPayload", () => {
  it("targets human messages that @mention the bot", () => {
    expect(eyesReactionTargetFromWebhookPayload(humanMessageWebhookPayload({}))).toEqual({
      channel: "C123",
      timestamp: "111.222",
    });
  });

  it("skips ambient human messages that do not @mention the bot", () => {
    expect(
      eyesReactionTargetFromWebhookPayload(
        humanMessageWebhookPayload({ mentionBot: false, text: "not for the bot" }),
      ),
    ).toBeNull();
  });

  it("targets app_mention deliveries", () => {
    const payload = humanMessageWebhookPayload({ text: "status?" });
    (payload.body.event as Record<string, unknown>).type = "app_mention";
    expect(eyesReactionTargetFromWebhookPayload(payload)).toEqual({
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
    expect(prompt).toContain("SILENCE IS THE DEFAULT");
    expect(prompt).toContain("When in doubt, stay silent");
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
