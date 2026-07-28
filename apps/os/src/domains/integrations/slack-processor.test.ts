// The Slack webhook ROUTER's executable spec, on the generic step harness
// from iterate/processors/testing: the REAL StreamProcessorRunner over a
// MemoryStreamNetwork (so cross-stream forwards are observable next to
// same-stream appends), virtual time for the acknowledgement freshness gate,
// and production idempotency semantics (a same-key append with a different
// body is REJECTED). The fast-ack fake is the router's one vendor surface,
// wired in createProcessor.

import { describe, expect, it } from "vitest";
import type { ConsumedInput, StreamEventInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStreamNetwork,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import { slackAgentSystemPrompt } from "../agents/agent-defaults.ts";
import { SlackProcessor } from "./slack-processor-implementation.ts";
import { SlackProcessorContract } from "./slack-processor-contract.ts";

const TEAM_ID = "T0TEAM";
const CONNECTION = "nustom";
const ROUTER_PATH = "/integrations/slack/nustom";
const ROUTED_THREAD_PATH = "/agents/slack/nustom/c123/ts-111-222";

const ROUTER_CREATED = {
  type: "events.iterate.com/slack/created",
  payload: { config: { connection: CONNECTION } },
} satisfies ConsumedInput<SlackProcessorContract>;

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
      // Real webhooks carry the verification secret; the downstream
      // transcriber strips it while the router still reads the rest.
      token: "verification-secret",
      team_id: TEAM_ID,
      event_id: input.eventId ?? "Ev123",
      authorizations: [{ is_bot: true, user_id: "UBOT", bot_id: "BBOT" }],
      event: {
        type: "message",
        channel: input.channel ?? "C123",
        channel_type: "channel",
        user: "UHUMAN",
        text: input.text ?? "<@UBOT> hello agent",
        ts: input.ts ?? "111.222",
        blocks: [{ type: "rich_text", elements: [] }],
        ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
      },
    },
  };
}

/**
 * The generic harness plus the router's fast-ack fake. The substrate stream
 * comes from a MemoryStreamNetwork sharing the virtual clock, so forwards to
 * routed thread streams are observable and correctly timestamped. Pass a
 * previous harness's substrate (+ network) with a fresh progress store to
 * replay the same stream from offset zero — the refold recipe.
 */
function makeRouterHarness(substrate?: HarnessSubstrate & { network: MemoryStreamNetwork }) {
  const clock = substrate?.clock ?? { now: Date.parse("2026-07-09T12:00:00Z") };
  const network = substrate?.network ?? new MemoryStreamNetwork(() => clock.now);
  const stream = substrate?.stream ?? network.get(ROUTER_PATH);
  const acked: unknown[] = [];
  const harness = makeProcessorHarness<SlackProcessorContract>({
    createProcessor: (deps) =>
      new SlackProcessor({
        ...deps,
        acknowledgeRoutedWebhook: ({ payload }) => {
          acked.push(payload);
        },
      }),
    substrate: {
      clock,
      stream,
      progress: substrate?.progress ?? makeMemoryProgressStore(SlackProcessorContract),
    },
  });
  return { ...harness, acked, network };
}

describe("SlackProcessor (webhook router)", () => {
  it("ignores a second Slack-router birth certificate during reduction", async () => {
    const h = makeRouterHarness();
    await h.play(["append", ROUTER_CREATED]);
    await h.append(ROUTER_CREATED);
    expect(h.state().birthCertificate).toEqual(ROUTER_CREATED.payload);
  });

  it("creates a route and forwards the webhook to the routed agent stream", async () => {
    const h = makeRouterHarness();
    await h.play([
      "append",
      ROUTER_CREATED,
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: humanMessageWebhookPayload({}),
      },
    ]);

    // The route fact lands on the router's own stream…
    expect(h.events("events.iterate.com/slack/thread-route-configured")).toMatchObject([
      {
        payload: {
          channel: "C123",
          streamPath: ROUTED_THREAD_PATH,
          threadTs: "111.222",
        },
      },
    ]);

    // …and the routed stream is explicitly born and bound before [route, webhook].
    const routed = h.network.eventsAt(ROUTED_THREAD_PATH);
    expect(routed.slice(0, 4).map((event) => event.type)).toEqual([
      "events.iterate.com/agent/created",
      "events.iterate.com/agent/binding-set",
      "events.iterate.com/capability-host/created",
      "events.iterate.com/slack-agent/created",
    ]);
    expect(
      routed.filter((event) => event.type === "events.iterate.com/stream/subscription-configured"),
    ).toHaveLength(4);
    expect(
      routed.find(
        (event) =>
          event.type === "events.iterate.com/agents/context-added" &&
          (event.payload as { key?: string }).key === "agent/system-prompt",
      ),
    ).toMatchObject({
      payload: {
        content: slackAgentSystemPrompt(CONNECTION),
        key: "agent/system-prompt",
        role: "system",
      },
    });
    expect(routed.slice(-2).map((event) => event.type)).toEqual([
      "events.iterate.com/slack/thread-route-configured",
      "events.iterate.com/slack/webhook-received",
    ]);
    expect(routed.at(-1)!.payload).toEqual(humanMessageWebhookPayload({}));

    // The fast-ack hook fired once for the forwarded webhook.
    expect(h.acked).toHaveLength(1);
  });

  it("the routed system prompt teaches Slack replies, Gmail access, and the silence default", () => {
    const prompt = slackAgentSystemPrompt(CONNECTION);
    expect(prompt).toContain('itx.integrations.slack.get("nustom").chat.postMessage');
    expect(prompt).toContain("itx.integrations.list()");
    expect(prompt).toContain("itx.integrations.gmail.get().request");
    expect(prompt).toContain('path: "/users/me/messages"');
    expect(prompt).toContain("Do not claim you lack inbox access");
    expect(prompt).toContain("SILENCE IS THE DEFAULT");
    expect(prompt).toContain("When in doubt, stay silent");
  });

  it("forwards follow-up webhooks through the reduced routing table", async () => {
    const h = makeRouterHarness();
    await h.play(
      [
        "append",
        ROUTER_CREATED,
        {
          type: "events.iterate.com/slack/thread-route-configured",
          payload: {
            channel: "C123",
            threadTs: "111.222",
            streamPath: "/agents/slack/custom-route",
          },
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/slack/webhook-received",
          payload: humanMessageWebhookPayload({
            eventId: "Ev456",
            threadTs: "111.222",
            ts: "333.444",
          }),
        },
      ],
    );

    expect(h.network.eventsAt("/agents/slack/custom-route").map((event) => event.type)).toEqual([
      "events.iterate.com/slack/webhook-received",
    ]);
    // No duplicate route event: the existing route won.
    expect(h.events("events.iterate.com/slack/thread-route-configured")).toHaveLength(1);
    // The fast ack fires on the known-route path too, not just route creation.
    expect(h.acked).toHaveLength(1);
  });

  it("drops item-keyed events (reactions) whose thread has no route", async () => {
    const h = makeRouterHarness();
    await h.play([
      "append",
      ROUTER_CREATED,
      {
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
      },
    ]);

    expect(h.network.streams.size).toBe(1); // nothing forwarded anywhere
    expect(h.events("events.iterate.com/slack/thread-route-configured")).toHaveLength(0);
    expect(h.acked).toEqual([]);
  });

  it("ignores connected/disconnected lifecycle facts (status is a stream read, not router state)", async () => {
    const h = makeRouterHarness();
    await h.play(["append", ROUTER_CREATED]);
    // Lifecycle facts are not in the router's consumed vocabulary — appended
    // raw, they must reduce to nothing. The router's whole state is its
    // routing table; connection status is read straight off the stream by
    // getConnectionStatus.
    await h.stream.append(
      {
        type: "events.iterate.com/slack/connected",
        payload: {
          connection: CONNECTION,
          externalId: TEAM_ID,
          projectId: "prj_1",
          teamId: TEAM_ID,
          teamName: "acme",
        },
      },
      {
        type: "events.iterate.com/slack/disconnected",
        payload: { projectId: "prj_1", teamId: TEAM_ID },
      },
    );
    await h.settle();

    expect(h.state()).toEqual({
      birthCertificate: { config: { connection: CONNECTION } },
      routes: {},
    });
  });

  it("does nothing before its explicit birth certificate", async () => {
    const h = makeRouterHarness();
    await h.play([
      "append",
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: humanMessageWebhookPayload({}),
      },
    ]);

    expect(h.network.streams.size).toBe(1);
    expect(h.acked).toEqual([]);
  });

  it("refold: replaying the stream neither re-acknowledges nor duplicates forwards", async () => {
    // THE refold test (docs/writing-stream-processors.md, "Refold safety").
    const h = makeRouterHarness();
    await h.play([
      "append",
      ROUTER_CREATED,
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: humanMessageWebhookPayload({}),
      },
    ]);
    expect(h.acked).toHaveLength(1);
    const routedCount = h.network.eventsAt(ROUTED_THREAD_PATH).length;
    expect(routedCount).toBeGreaterThan(2);

    await h.advanceTime(60 * 60_000); // well past the ack freshness horizon

    // A fresh cursor over the SAME stream replays every event from offset 0.
    const replay = makeRouterHarness({
      clock: h.clock,
      network: h.network,
      progress: makeMemoryProgressStore(SlackProcessorContract),
      stream: h.stream,
    });
    await replay.settle();

    // The stale ack is skipped; the durable forwards replay and dedupe at the
    // append layer (idempotency keys), leaving every stream unchanged and the
    // refolded state equal to the live one.
    expect(replay.acked).toEqual([]);
    expect(h.network.eventsAt(ROUTED_THREAD_PATH)).toHaveLength(routedCount);
    expect(replay.events("events.iterate.com/slack/thread-route-configured")).toHaveLength(1);
    expect(replay.state()).toEqual(h.state());
  });

  it("ignores and never acknowledges webhooks that cannot be keyed as channel:thread_ts", async () => {
    const h = makeRouterHarness();
    await h.play([
      "append",
      ROUTER_CREATED,
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: { body: { type: "url_verification", challenge: "x" } },
      },
    ]);

    expect(h.network.streams.size).toBe(1); // nothing forwarded anywhere
    expect(h.events("events.iterate.com/slack/thread-route-configured")).toHaveLength(0);
    expect(h.acked).toEqual([]);
  });

  it("replays the webhook when the forward append fails instead of dropping it", async () => {
    // Regression for the 2026-06-15 prd loss: the first message on a fresh
    // project reached the project stream but the agent never saw it — the
    // fire-and-forget forward threw once and the only copy was dropped. The
    // forward is a durable obligation under `blockProcessorWhile`: a failed
    // cross-stream append rejects the batch and HOLDS the checkpoint so the
    // host replays the webhook until it lands.
    const h = makeRouterHarness();
    const routed = h.network.get(ROUTED_THREAD_PATH);
    const originalRoutedAppend = routed.append.bind(routed);
    let failNextForward = true;
    routed.append = async (...inputs: StreamEventInput[]) => {
      if (failNextForward) {
        failNextForward = false;
        throw new Error("cold StreamsCapability RPC failed");
      }
      return originalRoutedAppend(...inputs);
    };
    await h.play(["append", ROUTER_CREATED]);
    await expect(h.runner().snapshot()).resolves.toMatchObject({ offset: 1 });

    // First delivery: the forward throws. The pass MUST reject and the
    // cursor MUST hold — otherwise the webhook is gone for good. (The home
    // route fact landed before the forward threw; it replays and dedupes.)
    await expect(
      h.append({
        type: "events.iterate.com/slack/webhook-received",
        payload: humanMessageWebhookPayload({}),
      }),
    ).rejects.toThrow(/StreamsCapability/);
    await expect(h.runner().snapshot()).resolves.toMatchObject({ offset: 1 });
    expect(routed.events).toHaveLength(0);

    // The runner replays the same webhook from the un-advanced cursor; the
    // forward now succeeds and the cursor advances through the route fact
    // the failed attempt had already committed to the router's own stream.
    await h.settle();
    await expect(h.runner().snapshot()).resolves.toMatchObject({ offset: 3 });
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
    expect(h.events("events.iterate.com/slack/thread-route-configured")).toHaveLength(1);
  });
});
