// The slack-agent facet's executable spec, on the generic step harness from
// iterate/processors/testing: the REAL StreamProcessorRunner over the shared
// MemoryStream (production idempotency semantics: a same-key append with a
// different body is REJECTED), virtual time for the 👀 freshness gates, and
// fresh-progress replays for refold safety. Scenarios are ordered steps —
// typed appends plus function steps driving the Slack Web API / file-storage
// fakes (the facet's only vendor surfaces, wired in createProcessor). The
// host-driven runtime presentation lane (presentRuntimeTransition) has its
// own suite in slack-runtime-presentation.test.ts.

import { describe, expect, it, vi } from "vitest";
import type { ConsumedInput, StreamEventInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import { DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS } from "../capability-host/capability-host-processor-contract.ts";
import {
  SlackAgentProcessor,
  compileBangCommand,
  eyesReactionTargetFromWebhookPayload,
} from "./slack-agent-processor-implementation.ts";
import type { SlackAgentProcessorContract } from "./slack-agent-processor-contract.ts";

type AgentEventInput = ConsumedInput<SlackAgentProcessorContract>;

const TEAM_ID = "T0TEAM";
const CONNECTION = "nustom";
const AGENT_PATH = "/agents/slack/nustom/c123/ts-111-222";

// -----------------------------------------------------------------------------
// Event literals and payload builders: the facet's birth, the route fact, and
// the recurring Slack webhook shapes. These are event BUILDERS (data), not
// append wrappers — every test appends through the harness's typed append.
// -----------------------------------------------------------------------------

const SLACK_AGENT_BORN = {
  type: "events.iterate.com/slack-agent/created",
  payload: { config: { channel: "C123", connection: CONNECTION, threadTs: "111.222" } },
} satisfies AgentEventInput;

const THREAD_ROUTE_CONFIGURED = {
  type: "events.iterate.com/slack/thread-route-configured",
  payload: { channel: "C123", threadTs: "111.222", streamPath: AGENT_PATH },
} satisfies AgentEventInput;

const REVIVED = {
  type: "events.iterate.com/stream/processor-revived",
  payload: { processorSlug: "slack-agent", revivals: 1, version: "test" },
} satisfies AgentEventInput;

function summaryUpdated(
  payload: Extract<
    AgentEventInput,
    { type: "events.iterate.com/agent/summary-updated" }
  >["payload"],
): AgentEventInput {
  return { type: "events.iterate.com/agent/summary-updated", payload };
}

function humanMessageWebhookPayload(input: {
  channel?: string;
  channelType?: "channel" | "im" | "mpim";
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
      // strip it (asserted below) while the rest stays readable.
      token: "verification-secret",
      team_id: TEAM_ID,
      event_id: input.eventId ?? "Ev123",
      authorizations: [{ is_bot: true, user_id: "UBOT", bot_id: "BBOT" }],
      event: {
        type: "message",
        channel: input.channel ?? "C123",
        channel_type: input.channelType ?? "channel",
        user: "UHUMAN",
        text: input.text ?? defaultText,
        ts: input.ts ?? "111.222",
        blocks: [{ type: "rich_text", elements: [] }],
        ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
      },
    },
  };
}

/** A message in the app's DM ("assistant") surface, where Slack's assistant
 * thread UI (setStatus/setTitle) is valid. */
function assistantMessageWebhookPayload(
  input: Parameters<typeof humanMessageWebhookPayload>[0] = {},
) {
  return humanMessageWebhookPayload({
    ...input,
    channel: input.channel ?? "D123",
    channelType: "im",
  });
}

function botMessageWebhookPayload() {
  const payload = humanMessageWebhookPayload({});
  const event = payload.body.event as Record<string, unknown>;
  event.bot_id = "BBOT";
  delete event.user;
  return payload;
}

// -----------------------------------------------------------------------------
// Harness: the generic step harness plus the facet's Slack fakes, wired in
// createProcessor. `slackCalls` records every Slack Web API attempt in order;
// per-test `callSlackApi` overrides inject vendor failures. Pass a previous
// harness's substrate with a fresh progress store to replay the same stream
// from offset zero — the refold recipe.
// -----------------------------------------------------------------------------

function makeSlackAgentHarness(input?: {
  callSlackApi?: (call: {
    body: Record<string, unknown>;
    connection: string;
    method: string;
  }) => Promise<void>;
  fetchSlackChannelName?: (call: { channel: string; connection: string }) => Promise<string | null>;
  storeSlackFiles?: ConstructorParameters<typeof SlackAgentProcessor>[0]["storeSlackFiles"];
  substrate?: HarnessSubstrate;
}) {
  const slackCalls: { body: Record<string, unknown>; method: string }[] = [];
  const harness = makeProcessorHarness<SlackAgentProcessorContract>({
    createProcessor: (deps) =>
      new SlackAgentProcessor({
        stream: deps.stream,
        path: deps.path,
        projectId: null,
        now: deps.now,
        callSlackApi: async (call) => {
          slackCalls.push({ body: call.body, method: call.method });
          await input?.callSlackApi?.(call);
        },
        ...(input?.fetchSlackChannelName === undefined
          ? {}
          : { fetchSlackChannelName: input.fetchSlackChannelName }),
        ...(input?.storeSlackFiles === undefined ? {} : { storeSlackFiles: input.storeSlackFiles }),
      }),
    path: AGENT_PATH,
    ...(input?.substrate === undefined ? {} : { substrate: input.substrate }),
  });
  return { ...harness, slackCalls };
}

describe("SlackAgentProcessor", () => {
  it("ignores a second Slack-agent birth certificate during reduction", async () => {
    const h = makeSlackAgentHarness();
    await h.play(["append", SLACK_AGENT_BORN]);
    await h.append(SLACK_AGENT_BORN);
    expect(h.state().birthCertificate).toEqual(SLACK_AGENT_BORN.payload);
  });

  it("turns a routed @mention into triggering agent context and adds the eyes reaction", async () => {
    const h = makeSlackAgentHarness();
    await h.play([
      "append",
      SLACK_AGENT_BORN,
      THREAD_ROUTE_CONFIGURED,
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: humanMessageWebhookPayload({}),
      },
    ]);

    const inputs = h.events("events.iterate.com/agents/context-added");
    expect(inputs).toHaveLength(1);
    const payload = inputs[0]!.payload;
    expect(payload).toMatchObject({
      role: "developer",
      actor: { type: "slack", userId: "UHUMAN" },
      refs: [
        {
          type: "event",
          streamPath: AGENT_PATH,
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

    expect(h.slackCalls).toContainEqual({
      method: "reactions.add",
      body: { channel: "C123", name: "eyes", timestamp: "111.222" },
    });

    expect(h.state()).toMatchObject({
      botBotId: "BBOT",
      botUserId: "UBOT",
      channel: "C123",
      conversationActive: true,
      eyesReactionMessageTs: "111.222",
      threadTs: "111.222",
    });
  });

  it("classifies structured idempotent Slack reaction outcomes without reporting them", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = makeSlackAgentHarness({
        callSlackApi: async ({ method }) => {
          if (method === "reactions.add") {
            throw Object.assign(new Error("opaque Slack failure"), {
              slackErrorCode: "already_reacted",
            });
          }
        },
      });
      await h.play([
        "append",
        SLACK_AGENT_BORN,
        THREAD_ROUTE_CONFIGURED,
        {
          type: "events.iterate.com/slack/webhook-received",
          payload: humanMessageWebhookPayload({}),
        },
      ]);

      expect(error).not.toHaveBeenCalledWith(
        "[slack-agent] Slack side effect failed",
        expect.anything(),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("records unmentioned human messages as non-triggering history without eyes", async () => {
    const h = makeSlackAgentHarness();
    await h.play([
      "append",
      SLACK_AGENT_BORN,
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: humanMessageWebhookPayload({ mentionBot: false, text: "just humans talking" }),
      },
    ]);

    const inputs = h.events("events.iterate.com/agents/context-added");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
    expect(inputs[0]!.payload.content).toContain("just humans talking");
    expect(h.slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
    expect(h.state().conversationActive).toBe(false);
  });

  it("wakes on app_mention without requiring the text form <@bot>", async () => {
    const h = makeSlackAgentHarness();
    const payload = humanMessageWebhookPayload({ text: "hey iterate, status?" });
    (payload.body.event as Record<string, unknown>).type = "app_mention";
    await h.play([
      "append",
      SLACK_AGENT_BORN,
      { type: "events.iterate.com/slack/webhook-received", payload },
    ]);

    const inputs = h.events("events.iterate.com/agents/context-added");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload.llmRequestPolicy).toEqual({
      behaviour: "after-current-request",
    });
    expect(h.slackCalls).toContainEqual({
      method: "reactions.add",
      body: { channel: "C123", name: "eyes", timestamp: "111.222" },
    });
    expect(h.state().conversationActive).toBe(true);
  });

  it("after a mention, later unmentioned thread messages still trigger the LLM", async () => {
    const h = makeSlackAgentHarness();
    await h.play([
      "append",
      SLACK_AGENT_BORN,
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
    ]);

    const inputs = h.events("events.iterate.com/agents/context-added");
    expect(inputs).toHaveLength(2);
    expect(inputs.map((event) => event.payload.llmRequestPolicy)).toEqual([
      { behaviour: "after-current-request" },
      { behaviour: "after-current-request" },
    ]);
    // Eyes only on the activating mention, not the follow-up.
    expect(h.slackCalls.filter((call) => call.method === "reactions.add")).toEqual([
      { method: "reactions.add", body: { channel: "C123", name: "eyes", timestamp: "111.222" } },
    ]);
    expect(h.state().conversationActive).toBe(true);
  });

  it("materializes shared files and attaches them to the agent context item", async () => {
    const stored: { files: unknown; storageKey: string }[] = [];
    const attachment = {
      contentType: "image/png",
      filename: "cat.png",
      path: "/agents/slack/c123/ts-111-222/slack-1-0-cat.png",
      size: 3,
      url: "https://iterate-files--demo.iterate.app/x?sig=y",
    };
    const h = makeSlackAgentHarness({
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
    await h.play([
      "append",
      SLACK_AGENT_BORN,
      { type: "events.iterate.com/slack/webhook-received", payload },
    ]);

    expect(stored).toHaveLength(1);
    expect(stored[0]!.files).toEqual([
      { mimetype: "image/png", name: "cat.png", urlPrivate: "https://files.slack.com/f1" },
    ]);
    // Stable per webhook event so replays overwrite instead of duplicating.
    expect(stored[0]!.storageKey).toBe("slack-2");

    const inputs = h.events("events.iterate.com/agents/context-added");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({ files: [attachment] });
  });

  it("a failed file download forwards the message with an explicit loss note", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = makeSlackAgentHarness({
        storeSlackFiles: async () => {
          throw new Error("slack download exploded");
        },
      });

      const payload = humanMessageWebhookPayload({});
      (payload.body.event as Record<string, unknown>).files = [
        { name: "cat.png", url_private: "https://files.slack.com/f1" },
      ];
      await h.play([
        "append",
        SLACK_AGENT_BORN,
        { type: "events.iterate.com/slack/webhook-received", payload },
      ]);

      const inputs = h.events("events.iterate.com/agents/context-added");
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.payload).not.toHaveProperty("files");
      const content = inputs[0]!.payload.content;
      expect(content).toContain("cat.png");
      // Never a silent drop: the loss and its cause are visible to the model.
      expect(content).toContain("[1 attachment(s) could not be loaded: slack download exploded]");
    } finally {
      error.mockRestore();
    }
  });

  it("ignores our own bot's messages entirely", async () => {
    const h = makeSlackAgentHarness();
    await h.play([
      "append",
      SLACK_AGENT_BORN,
      { type: "events.iterate.com/slack/webhook-received", payload: botMessageWebhookPayload() },
    ]);

    expect(h.events("events.iterate.com/agents/context-added")).toHaveLength(0);
    expect(h.slackCalls).toHaveLength(0);
  });

  it("records non-message events as non-triggering input without an eyes reaction", async () => {
    const h = makeSlackAgentHarness();
    await h.play([
      "append",
      SLACK_AGENT_BORN,
      {
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
      },
    ]);

    const inputs = h.events("events.iterate.com/agents/context-added");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
    expect(h.slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });

  it("compiles bang commands into itx script executions instead of agent context", async () => {
    const h = makeSlackAgentHarness();
    await h.play([
      "append",
      SLACK_AGENT_BORN,
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: humanMessageWebhookPayload({ text: "!whoami" }),
      },
    ]);

    const scripts = h.events("events.iterate.com/capability-host/script-run-requested");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.payload.code).toContain("await itx.whoami()");
    // The request body is DETERMINISTIC: expiry anchors to the webhook's
    // createdAt, never `now`, so an at-least-once redelivery re-appends the
    // identical body and dedupes on the key instead of wedging the frame.
    const webhook = h.events("events.iterate.com/slack/webhook-received")[0]!;
    expect(scripts[0]!.payload).toMatchObject({
      executionId: "slack-bang-command-2",
      expiresAt: Date.parse(webhook.createdAt) + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS,
    });
    expect(h.events("events.iterate.com/agents/context-added")).toHaveLength(0);
    expect(h.slackCalls).toContainEqual({
      method: "reactions.add",
      body: { channel: "C123", name: "eyes", timestamp: "111.222" },
    });
  });

  it("reports an unexpected title-paint failure once without wedging the checkpoint", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = makeSlackAgentHarness({
        callSlackApi: async ({ method }) => {
          if (method === "assistant.threads.setTitle") throw new Error("slack blew up");
        },
      });

      await h.play([
        "append",
        SLACK_AGENT_BORN,
        {
          type: "events.iterate.com/slack/webhook-received",
          payload: assistantMessageWebhookPayload(),
        },
      ]);
      h.slackCalls.length = 0;

      await h.play(["append", summaryUpdated({ title: "Trip planning" })]);

      expect(h.slackCalls).toEqual([
        {
          method: "assistant.threads.setTitle",
          body: { channel_id: "D123", thread_ts: "111.222", title: "Trip planning" },
        },
      ]);
      expect(h.state().summary).toMatchObject({ title: "Trip planning" });
      expect(error).toHaveBeenCalledWith(
        "[slack-agent] Slack side effect failed",
        expect.objectContaining({ method: "assistant.threads.setTitle" }),
      );

      // The failure is settled, not replayed: the next pass repeats nothing.
      h.slackCalls.length = 0;
      await h.settle();
      expect(h.slackCalls).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it("clears a title with an empty Slack title and dedupes the cleared state", async () => {
    const h = makeSlackAgentHarness();
    await h.play(
      [
        "append",
        SLACK_AGENT_BORN,
        {
          type: "events.iterate.com/slack/webhook-received",
          payload: assistantMessageWebhookPayload(),
        },
      ],
      ["append", summaryUpdated({ title: "Trip planning" })],
    );
    h.slackCalls.length = 0;

    await h.play(["append", summaryUpdated({ title: null })]);
    expect(h.slackCalls).toEqual([
      {
        method: "assistant.threads.setTitle",
        body: { channel_id: "D123", thread_ts: "111.222", title: "" },
      },
    ]);

    h.slackCalls.length = 0;
    await h.play(["append", summaryUpdated({ activity: "Waiting for a choice" })]);
    expect(h.slackCalls).toEqual([]);
  });

  it("settles a failed title clear without replaying it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = makeSlackAgentHarness({
        callSlackApi: async ({ body, method }) => {
          if (method === "assistant.threads.setTitle" && body.title === "") {
            throw new Error("slack clear blew up");
          }
        },
      });

      await h.play(
        [
          "append",
          SLACK_AGENT_BORN,
          {
            type: "events.iterate.com/slack/webhook-received",
            payload: assistantMessageWebhookPayload(),
          },
        ],
        ["append", summaryUpdated({ title: "Trip planning" })],
      );
      h.slackCalls.length = 0;

      await h.play(["append", summaryUpdated({ title: null })]);
      expect(h.slackCalls).toEqual([
        {
          method: "assistant.threads.setTitle",
          body: { channel_id: "D123", thread_ts: "111.222", title: "" },
        },
      ]);
      expect(error).toHaveBeenCalledWith(
        "[slack-agent] Slack side effect failed",
        expect.objectContaining({ method: "assistant.threads.setTitle" }),
      );

      h.slackCalls.length = 0;
      await h.settle();
      expect(h.slackCalls).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it("repaints stale title set and clear facts in fresh incarnations", async () => {
    // A title is durable current-state paint, unlike the transient status:
    // a fresh incarnation delivering long-stale summary facts still paints
    // the reduced title (set or cleared), while the stale 👀 ack is skipped.
    const setCase = makeSlackAgentHarness();
    await setCase.stream.append(
      SLACK_AGENT_BORN as StreamEventInput,
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: assistantMessageWebhookPayload(),
      },
      summaryUpdated({ title: "Trip planning" }) as StreamEventInput,
    );
    await setCase.advanceTime(16 * 60_000);
    expect(setCase.slackCalls).toEqual([
      {
        method: "assistant.threads.setTitle",
        body: { channel_id: "D123", thread_ts: "111.222", title: "Trip planning" },
      },
    ]);

    const clearCase = makeSlackAgentHarness();
    await clearCase.stream.append(
      SLACK_AGENT_BORN as StreamEventInput,
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: assistantMessageWebhookPayload(),
      },
      summaryUpdated({ title: "Trip planning" }) as StreamEventInput,
      summaryUpdated({ title: null }) as StreamEventInput,
    );
    await clearCase.advanceTime(16 * 60_000);
    expect(clearCase.slackCalls).toEqual([
      {
        method: "assistant.threads.setTitle",
        body: { channel_id: "D123", thread_ts: "111.222", title: "" },
      },
    ]);
  });

  it("replaces the previous eyes reaction when another mention arrives", async () => {
    const h = makeSlackAgentHarness();
    await h.play([
      "append",
      SLACK_AGENT_BORN,
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: humanMessageWebhookPayload({ eventId: "Ev-first", ts: "111.222" }),
      },
    ]);
    h.slackCalls.length = 0;

    await h.play([
      "append",
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: humanMessageWebhookPayload({
          eventId: "Ev-second",
          threadTs: "111.222",
          ts: "111.444",
        }),
      },
    ]);

    expect(h.slackCalls).toEqual([
      {
        method: "reactions.remove",
        body: { channel: "C123", name: "eyes", timestamp: "111.222" },
      },
      {
        method: "reactions.add",
        body: { channel: "C123", name: "eyes", timestamp: "111.444" },
      },
    ]);
    expect(h.state().eyesReactionMessageTs).toBe("111.444");
  });

  it("a summary-only update paints the title but clears no transient status", async () => {
    const h = makeSlackAgentHarness();
    await h.play([
      "append",
      SLACK_AGENT_BORN,
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: assistantMessageWebhookPayload(),
      },
    ]);
    h.slackCalls.length = 0;

    // The agent set its title before any runtime was announced. That says
    // nothing about work: no status clear, and the 👀 ack MUST survive.
    await h.play(["append", summaryUpdated({ title: "Trip planning" })]);

    expect(h.slackCalls).toEqual([
      {
        method: "assistant.threads.setTitle",
        body: { channel_id: "D123", thread_ts: "111.222", title: "Trip planning" },
      },
    ]);
  });

  it("skips the stale 👀 ack on a late wake but still lands the agent context", async () => {
    // The webhook arrived while the processor's host was down; delivery
    // happens 16 minutes later. The durable lane (agent context) must land —
    // the ack lane must not pretend the message was "just picked up".
    const h = makeSlackAgentHarness();
    await h.stream.append(SLACK_AGENT_BORN as StreamEventInput, {
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    await h.advanceTime(16 * 60_000);

    expect(h.events("events.iterate.com/agents/context-added")).toHaveLength(1);
    expect(h.slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });

  it("a revival clears the transient presentation a dead incarnation left behind", async () => {
    const h = makeSlackAgentHarness();
    await h.play([
      "append",
      SLACK_AGENT_BORN,
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: assistantMessageWebhookPayload(),
      },
    ]);
    h.slackCalls.length = 0;

    // The platform revival fact's at-head pass restores honest presentation:
    // the title repaints from the reduced summary (empty = cleared) and the
    // dead incarnation's status/👀 are removed.
    await h.play(["append", REVIVED]);
    expect(h.slackCalls).toEqual([
      {
        method: "assistant.threads.setTitle",
        body: { channel_id: "D123", thread_ts: "111.222", title: "" },
      },
      {
        method: "assistant.threads.setStatus",
        body: { channel_id: "D123", thread_ts: "111.222", status: "" },
      },
      {
        method: "reactions.remove",
        body: { channel: "D123", name: "eyes", timestamp: "111.222" },
      },
    ]);
  });

  it("captures route context as a typed Slack binding without authoring a summary", async () => {
    const h = makeSlackAgentHarness({ fetchSlackChannelName: async () => "trip-planning" });
    await h.play(["append", SLACK_AGENT_BORN, THREAD_ROUTE_CONFIGURED]);

    expect(h.state()).toMatchObject({ channel: "C123", threadTs: "111.222" });
    expect(h.events("events.iterate.com/agent/summary-updated")).toHaveLength(0);
    const bindings = h.events("events.iterate.com/agent/binding-set");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.payload).toEqual({
      type: "slack_thread",
      connection: CONNECTION,
      channelId: "C123",
      threadTs: "111.222",
      channelName: "trip-planning",
    });
    expect(h.slackCalls).toHaveLength(0);
  });

  it("retries transient channel-name resolution before committing the binding", async () => {
    let attempts = 0;
    const h = makeSlackAgentHarness({
      fetchSlackChannelName: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Slack conversations.info timed out");
        return "trip-planning";
      },
    });
    await h.play(["append", SLACK_AGENT_BORN]);

    // First delivery: the enrichment throws inside the blocking closure. The
    // pass MUST reject and the cursor MUST hold, so the host replays it.
    await expect(h.append(THREAD_ROUTE_CONFIGURED)).rejects.toThrow("conversations.info timed out");
    expect(h.events("events.iterate.com/agent/binding-set")).toHaveLength(0);

    await h.settle();
    expect(attempts).toBe(2);
    expect(h.events("events.iterate.com/agent/binding-set")[0]?.payload).toMatchObject({
      channelName: "trip-planning",
      type: "slack_thread",
    });
  });

  it("compiles the !debug bang command into a Slack-posting debug script", async () => {
    const h = makeSlackAgentHarness();
    await h.play([
      "append",
      SLACK_AGENT_BORN,
      THREAD_ROUTE_CONFIGURED,
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: humanMessageWebhookPayload({ text: "!debug" }),
      },
    ]);

    const scripts = h.events("events.iterate.com/capability-host/script-run-requested");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({
      idempotencyKey: "slack-agent/bang-command@/agents/slack/nustom/c123/ts-111-222:3",
      payload: { executionId: "slack-bang-command-3" },
    });
    const code = scripts[0]!.payload.code;
    expect(code).toContain("const debug = await itx.debug();");
    expect(code).toContain('await itx.integrations.slack.get("nustom").chat.postMessage({');
    expect(code).toContain('channel: "C123"');
    expect(code).toContain('thread_ts: "111.222"');
    expect(code).toContain("text: `Debug info:\\n${debug}`");
    expect(h.events("events.iterate.com/agents/context-added")).toHaveLength(0);
    expect(h.slackCalls).toContainEqual({
      method: "reactions.add",
      body: { channel: "C123", name: "eyes", timestamp: "111.222" },
    });
  });

  it("commits the agent context before adding the Slack eyes reaction", async () => {
    // Record appends and Slack API calls into one list to pin their order:
    // the agent context must be durable before the eyes reaction signals
    // receipt to the user.
    const calls: string[] = [];
    const h = makeSlackAgentHarness({
      callSlackApi: async ({ method }) => {
        calls.push(`slack:${method}`);
      },
    });
    await h.stream.append(SLACK_AGENT_BORN as StreamEventInput, {
      type: "events.iterate.com/slack/webhook-received",
      payload: humanMessageWebhookPayload({}),
    });
    const originalAppend = h.stream.append.bind(h.stream);
    h.stream.append = async (...inputs: StreamEventInput[]) => {
      calls.push(...inputs.map((input) => `append:${input.type}`));
      return originalAppend(...inputs);
    };
    await h.settle();

    expect(calls).toEqual([
      "append:events.iterate.com/agents/context-added",
      "slack:reactions.add",
    ]);
  });

  it("turns raw Slack interactivity payloads into triggering agent context", async () => {
    const h = makeSlackAgentHarness();
    await h.play([
      "append",
      SLACK_AGENT_BORN,
      {
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
      },
    ]);

    const inputs = h.events("events.iterate.com/agents/context-added");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      idempotencyKey: "slack-agent/webhook-to-agent-context@/agents/slack/nustom/c123/ts-111-222:2",
    });
    const payload = inputs[0]!.payload;
    // Interactivity payloads carry the presser at user.id, not event.user.
    expect(payload).toMatchObject({
      role: "developer",
      actor: { type: "slack", userId: "U777" },
      refs: [
        {
          type: "event",
          streamPath: AGENT_PATH,
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
    const h = makeSlackAgentHarness();
    await h.play([
      "append",
      SLACK_AGENT_BORN,
      {
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
      },
    ]);

    expect(h.events("events.iterate.com/agents/context-added")).toHaveLength(0);
    expect(h.slackCalls).toHaveLength(0);
  });

  it("forwards other-bot @mentions as triggering agent context without eyes", async () => {
    const h = makeSlackAgentHarness();
    const payload = humanMessageWebhookPayload({
      text: "<@UBOT> I am another bot mentioning iterate",
    });
    const event = payload.body.event as Record<string, unknown>;
    event.subtype = "bot_message";
    event.bot_id = "BOTHERBOT"; // not our authorized bot (BBOT)
    delete event.user;
    await h.play([
      "append",
      SLACK_AGENT_BORN,
      { type: "events.iterate.com/slack/webhook-received", payload },
    ]);

    const inputs = h.events("events.iterate.com/agents/context-added");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload.llmRequestPolicy).toEqual({
      behaviour: "after-current-request",
    });
    // Bot-authored messages never get the eyes reaction, even when forwarded.
    expect(h.slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });

  it("records other-bot messages without an @mention as non-triggering history", async () => {
    const h = makeSlackAgentHarness();
    const payload = humanMessageWebhookPayload({
      mentionBot: false,
      text: "I am another bot chatting ambiently",
    });
    const event = payload.body.event as Record<string, unknown>;
    event.subtype = "bot_message";
    event.bot_id = "BOTHERBOT";
    delete event.user;
    await h.play([
      "append",
      SLACK_AGENT_BORN,
      { type: "events.iterate.com/slack/webhook-received", payload },
    ]);

    const inputs = h.events("events.iterate.com/agents/context-added");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
    expect(h.slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });

  it("forwards other bot messages when Slack authorizations omit bot_id", async () => {
    const h = makeSlackAgentHarness();
    const payload = humanMessageWebhookPayload({ text: "<@UBOT> !debug" });
    delete (payload.body.authorizations[0] as Record<string, unknown>).bot_id;
    const event = payload.body.event as Record<string, unknown>;
    event.subtype = "bot_message";
    event.bot_id = "BOTHERBOT";
    event.user = "UOTHERBOT";
    event.bot_profile = { id: "BOTHERBOT", user_id: "UOTHERBOT" };

    await h.play([
      "append",
      SLACK_AGENT_BORN,
      THREAD_ROUTE_CONFIGURED,
      { type: "events.iterate.com/slack/webhook-received", payload },
    ]);

    const scripts = h.events("events.iterate.com/capability-host/script-run-requested");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.payload.code).toContain("const debug = await itx.debug();");
    expect(h.slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
  });

  it("ignores our own bot messages when Slack authorizations omit bot_id", async () => {
    const h = makeSlackAgentHarness();
    const payload = humanMessageWebhookPayload({ text: "<@UBOT> !debug" });
    delete (payload.body.authorizations[0] as Record<string, unknown>).bot_id;
    const event = payload.body.event as Record<string, unknown>;
    event.subtype = "bot_message";
    event.bot_id = "BBOT";
    event.user = "UBOT";
    event.bot_profile = { id: "BBOT", user_id: "UBOT" };

    await h.play([
      "append",
      SLACK_AGENT_BORN,
      { type: "events.iterate.com/slack/webhook-received", payload },
    ]);

    expect(h.events("events.iterate.com/capability-host/script-run-requested")).toHaveLength(0);
    expect(h.events("events.iterate.com/agents/context-added")).toHaveLength(0);
    expect(h.slackCalls).toHaveLength(0);
  });

  it("ignores bot messages when Slack gives no comparable bot identity", async () => {
    const h = makeSlackAgentHarness();
    const payload = humanMessageWebhookPayload({ text: "<@UBOT> !debug" });
    delete (payload.body.authorizations[0] as Record<string, unknown>).bot_id;
    const event = payload.body.event as Record<string, unknown>;
    event.subtype = "bot_message";
    event.bot_id = "BBOT";
    delete event.user;
    delete event.bot_profile;

    await h.play([
      "append",
      SLACK_AGENT_BORN,
      { type: "events.iterate.com/slack/webhook-received", payload },
    ]);

    expect(h.events("events.iterate.com/capability-host/script-run-requested")).toHaveLength(0);
    expect(h.events("events.iterate.com/agents/context-added")).toHaveLength(0);
    expect(h.slackCalls).toHaveLength(0);
  });

  it("refold: a full replay dedupes every durable append and re-acks nothing", async () => {
    // The harshest at-least-once redelivery: a fresh progress store over the
    // SAME stream replays every event from offset zero, long after the clock
    // moved. Every blocked per-event append (context transcription, binding,
    // bang-command script request) must re-produce a body IDENTICAL to the
    // committed one and dedupe on its key — a now()-stamped field (like the
    // pre-refactor bang-command expiry) would be a same-key CONFLICT that
    // wedges the frame forever. The stale 👀 ack lane must stay quiet.
    const h = makeSlackAgentHarness();
    await h.play(
      [
        "append",
        SLACK_AGENT_BORN,
        THREAD_ROUTE_CONFIGURED,
        {
          type: "events.iterate.com/slack/webhook-received",
          payload: humanMessageWebhookPayload({ eventId: "Ev-mention", ts: "111.222" }),
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/slack/webhook-received",
          payload: humanMessageWebhookPayload({
            eventId: "Ev-bang",
            text: "!whoami",
            threadTs: "111.222",
            ts: "111.333",
          }),
        },
      ],
      ["advanceTime", 60 * 60_000], // well past the ack freshness horizon
    );
    const liveOffsets = h.events().map((row) => row.offset);
    expect(h.events("events.iterate.com/capability-host/script-run-requested")).toHaveLength(1);

    const replay = makeSlackAgentHarness({
      substrate: { ...h.substrate, progress: makeMemoryProgressStore() },
    });
    await replay.settle(); // replays the whole stream; a wedge would throw here

    expect(replay.events().map((row) => row.offset)).toEqual(liveOffsets);
    expect(replay.slackCalls.filter((call) => call.method === "reactions.add")).toHaveLength(0);
    expect(replay.state()).toEqual(h.state());
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
