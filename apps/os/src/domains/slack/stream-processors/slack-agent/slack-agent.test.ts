// State is built by ingesting events; first-attach lookback is covered by the
// sideEffectsAfterOffset anchor test.

import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "@iterate-com/streams/shared/event";
import {
  SlackAgentProcessor,
  eyesReactionTargetFromWebhookPayload,
  type SlackAgentProcessorDeps,
} from "./implementation.ts";

describe("eyesReactionTargetFromWebhookPayload", () => {
  const humanMessagePayload = (event: Record<string, unknown> = {}) => ({
    slackTeamId: "T1",
    body: {
      type: "event_callback",
      authorizations: [{ is_bot: true, user_id: "U_BOT", bot_id: "B_BOT" }],
      event: {
        type: "message",
        channel: "C123",
        channel_type: "channel",
        user: "U_HUMAN",
        ts: "1772136259.000000",
        text: "hello",
        ...event,
      },
    },
  });

  it("targets human messages", () => {
    expect(eyesReactionTargetFromWebhookPayload(humanMessagePayload())).toEqual({
      channel: "C123",
      timestamp: "1772136259.000000",
    });
  });

  it("skips bot-authored messages", () => {
    expect(
      eyesReactionTargetFromWebhookPayload(humanMessagePayload({ bot_id: "B_OTHER" })),
    ).toBeNull();
    expect(
      eyesReactionTargetFromWebhookPayload(humanMessagePayload({ subtype: "bot_message" })),
    ).toBeNull();
  });

  it("skips actions performed by the authorized bot user", () => {
    expect(eyesReactionTargetFromWebhookPayload(humanMessagePayload({ user: "U_BOT" }))).toBeNull();
  });

  it("skips reaction events", () => {
    expect(
      eyesReactionTargetFromWebhookPayload({
        slackTeamId: "T1",
        body: {
          type: "event_callback",
          event: {
            type: "reaction_added",
            user: "U_HUMAN",
            reaction: "eyes",
            item: { type: "message", channel: "C123", ts: "1772136259.000000" },
          },
        },
      }),
    ).toBeNull();
  });

  it("skips payloads without a message timestamp", () => {
    expect(eyesReactionTargetFromWebhookPayload({ body: { event: {} } })).toBeNull();
  });
});

describe("SlackAgentProcessor", () => {
  it("reduces Slack route context", async () => {
    const { processor } = createProcessor();

    await processor.ingest({ events: [routeEvent()], streamMaxOffset: 1 });

    expect(processor.state).toMatchObject({
      channel: "C123",
      streamPath: "/agents/slack/c123/ts-1772136258-963519",
      threadTs: "1772136258.963519",
    });
  });

  it("extracts botUserId from webhook authorizations", async () => {
    const { processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 1,
          type: "events.iterate.com/slack/webhook-received",
          payload: {
            body: {
              type: "event_callback",
              event: {
                type: "message",
                channel: "C123",
                user: "U_USER",
                ts: "1772136259.000000",
                thread_ts: "1772136258.963519",
                text: "hello",
              },
              authorizations: [
                { team_id: "T123", user_id: "U_BOT", is_bot: true, is_enterprise_install: false },
              ],
            },
          },
        }),
      ],
      streamMaxOffset: 1,
    });

    expect(processor.state.botUserId).toBe("U_BOT");
  });

  it("captures route context in state and announces nothing (the slack cap is provided on the agent's own context)", async () => {
    const { appended, processor } = createProcessor();

    await processor.ingest({ events: [routeEvent()], streamMaxOffset: 1 });
    await flushBackgroundWork();

    // The `slack` capability is provided onto the agent's own itx context
    // (agentContextCapabilities → provideCapability), not announced here — so
    // thread-route-configured only folds route context into state.
    expect(appended).toEqual([]);
    expect(processor.state.channel).toBeDefined();
    expect(processor.state.threadTs).toBeDefined();
  });

  it("emits a Slack-posting codemode script for the debug bang command", async () => {
    const { appended, processor } = createProcessor();

    await processor.ingest({
      events: [webhookEvent({ offset: 42, text: "!debug" })],
      streamMaxOffset: 42,
    });
    await flushBackgroundWork();

    expect(appended).toHaveLength(1);
    expect(appended[0]!.event).toMatchObject({
      type: "events.iterate.com/itx/script-execution-requested",
      idempotencyKey: "slack-agent/slack-bang-command-to-codemode-script@42",
      payload: {
        enqueued: true,
        executionId: "slack-bang-command-42",
      },
    });
    const code = (appended[0]!.event.payload as { code: string }).code;
    expect(code).toContain("const debug = await itx.debug();");
    expect(code).toContain("await itx.slack.chat.postMessage({");
    expect(code).toContain('channel: "C123"');
    expect(code).toContain('thread_ts: "1772136258.963519"');
    expect(code).toContain("text: `Debug info:\\n${debug}`");
    expect(code).not.toContain("slack.agent.threadInfo()");
    expect(code).not.toContain("slack.threadInfo");
  });

  it("emits direct codemode scripts for non-debug bang commands", async () => {
    const { appended, processor } = createProcessor();

    await processor.ingest({
      events: [webhookEvent({ offset: 45, text: "!slack.agent.threadInfo" })],
      streamMaxOffset: 45,
    });
    await flushBackgroundWork();

    expect(appended).toHaveLength(1);
    const code = (appended[0]!.event.payload as { code: string }).code;
    expect(code).toContain("await itx.slack.agent.threadInfo();");
    expect(code).not.toContain("slack.chat.postMessage");
    expect(code).not.toContain("const debug = await");
  });

  it("emits agent input for non-bang Slack messages", async () => {
    const { appended, processor } = createProcessor();

    await processor.ingest({
      events: [webhookEvent({ offset: 43, text: "please look at this" })],
      streamMaxOffset: 43,
    });
    await flushBackgroundWork();

    expect(appended).toHaveLength(1);
    expect(appended[0]!.event).toMatchObject({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "slack-agent/slack-webhook-to-agent-input@43",
      payload: {
        content: expect.stringContaining(
          "`events.iterate.com/slack/webhook-received` event received",
        ),
      },
    });
    const content = (appended[0]!.event.payload as { content: string }).content;
    expect(content).toContain("```yaml");
    expect(content).toContain("text: please look at this");
    expect(content).toContain('thread_ts: "1772136258.963519"');
  });

  it("commits agent input before adding the Slack eyes reaction", async () => {
    const calls: unknown[] = [];
    const { processor } = createProcessor({
      callSlackApi: async (method, body) => {
        calls.push(["slack", method, body]);
      },
      onAppend: (event) => {
        calls.push(["append", event.type, event.idempotencyKey]);
      },
    });

    await processor.ingest({
      events: [webhookEvent({ offset: 43, text: "please look at this" })],
      streamMaxOffset: 43,
    });
    await flushBackgroundWork();

    expect(calls).toEqual([
      [
        "append",
        "events.iterate.com/agent/input-added",
        "slack-agent/slack-webhook-to-agent-input@43",
      ],
      [
        "slack",
        "reactions.add",
        {
          channel: "C123",
          name: "eyes",
          timestamp: "1772136259.000000",
        },
      ],
    ]);
  });

  it("reduces but does not re-run side effects for events at or below the anchor", async () => {
    const { appended, processor } = createProcessor({ sideEffectsAfterOffset: () => 2 });

    await processor.ingest({
      events: [routeEvent(), webhookEvent({ offset: 2, text: "historical message" })],
      streamMaxOffset: 3,
    });
    await flushBackgroundWork();

    // State rebuilt from history...
    expect(processor.state).toMatchObject({
      channel: "C123",
      threadTs: "1772136258.963519",
      latestMessageTs: "1772136259.000000",
    });
    // ...without re-registering the provider or re-sending agent input.
    expect(appended).toEqual([]);

    await processor.ingest({
      events: [webhookEvent({ offset: 3, text: "live message" })],
      streamMaxOffset: 3,
    });
    await flushBackgroundWork();
    expect(appended.map(({ event }) => event.type)).toEqual([
      "events.iterate.com/agent/input-added",
    ]);
    expect(appended[0]!.event.idempotencyKey).toBe("slack-agent/slack-webhook-to-agent-input@3");
  });

  it("emits agent input for raw Slack interactivity payloads", async () => {
    const { appended, processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 46,
          type: "events.iterate.com/slack/webhook-received",
          payload: {
            body: {
              type: "block_actions",
              team: { id: "T123" },
              channel: { id: "C123" },
              message: {
                ts: "1772136259.000000",
                thread_ts: "1772136258.963519",
                text: "Choose one",
              },
              actions: [{ action_id: "approve", type: "button", value: "yes" }],
            },
          },
        }),
      ],
      streamMaxOffset: 46,
    });
    await flushBackgroundWork();

    expect(appended).toHaveLength(1);
    expect(appended[0]!.event).toMatchObject({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "slack-agent/slack-webhook-to-agent-input@46",
      payload: {
        content: expect.stringContaining("type: block_actions"),
      },
    });
    expect((appended[0]!.event.payload as { content: string }).content).toContain(
      "action_id: approve",
    );
  });

  it("updates and clears the Slack assistant status for agent/codemode activity", async () => {
    const slackCalls: Array<[string, Record<string, unknown>]> = [];
    const { processor } = createProcessor({
      callSlackApi: async (method, body) => {
        slackCalls.push([method, body]);
      },
    });

    // Establish channel/thread/latestMessageTs context (also adds eyes).
    await processor.ingest({
      events: [webhookEvent({ offset: 1, text: "please look at this" })],
      streamMaxOffset: 1,
    });
    await processor.ingest({
      events: [
        committedEvent({
          offset: 2,
          type: "events.iterate.com/agent/status-updated",
          payload: { status: "working", reason: "llm-request" },
        }),
        committedEvent({
          offset: 3,
          type: "events.iterate.com/agent/status-updated",
          payload: { status: "idle", reason: "llm-request" },
        }),
      ],
      streamMaxOffset: 3,
    });
    await flushBackgroundWork();

    expect(slackCalls).toEqual([
      ["reactions.add", { channel: "C123", name: "eyes", timestamp: "1772136259.000000" }],
      [
        "assistant.threads.setStatus",
        {
          channel_id: "C123",
          thread_ts: "1772136258.963519",
          status: "is thinking...",
          loading_messages: ["Thinking..."],
        },
      ],
      [
        "assistant.threads.setStatus",
        { channel_id: "C123", thread_ts: "1772136258.963519", status: "" },
      ],
      ["reactions.remove", { channel: "C123", name: "eyes", timestamp: "1772136259.000000" }],
    ]);
  });

  it("ignores webhook events caused by our own bot user (e.g. bot adding a reaction)", async () => {
    const { appended, processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 50,
          type: "events.iterate.com/slack/webhook-received",
          payload: {
            body: {
              type: "event_callback",
              event: {
                type: "reaction_added",
                user: "U_BOT",
                reaction: "eyes",
                item: { type: "message", channel: "C123", ts: "1772136259.000000" },
                item_user: "U_USER",
                event_ts: "1772136260.000000",
              },
              authorizations: [
                { team_id: "T123", user_id: "U_BOT", is_bot: true, is_enterprise_install: false },
              ],
            },
          },
        }),
      ],
      streamMaxOffset: 50,
    });
    await flushBackgroundWork();

    expect(appended).toEqual([]);
  });

  it("ignores messages posted by our own bot", async () => {
    const { appended, processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 51,
          type: "events.iterate.com/slack/webhook-received",
          payload: {
            body: {
              type: "event_callback",
              event: {
                type: "message",
                subtype: "bot_message",
                bot_id: "B_OUR_BOT",
                channel: "C123",
                ts: "1772136259.000000",
                thread_ts: "1772136258.963519",
                text: "I am the bot replying",
              },
              authorizations: [
                {
                  team_id: "T123",
                  user_id: "U_BOT",
                  bot_id: "B_OUR_BOT",
                  is_bot: true,
                  is_enterprise_install: false,
                },
              ],
            },
          },
        }),
      ],
      streamMaxOffset: 51,
    });
    await flushBackgroundWork();

    expect(appended).toEqual([]);
  });

  it("forwards messages posted by other bots to the agent", async () => {
    const { appended, processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 52,
          type: "events.iterate.com/slack/webhook-received",
          payload: {
            body: {
              type: "event_callback",
              event: {
                type: "message",
                subtype: "bot_message",
                bot_id: "B_OTHER_BOT",
                channel: "C123",
                ts: "1772136259.000000",
                thread_ts: "1772136258.963519",
                text: "I am another bot mentioning @iterate",
              },
              authorizations: [
                {
                  team_id: "T123",
                  user_id: "U_BOT",
                  bot_id: "B_OUR_BOT",
                  is_bot: true,
                  is_enterprise_install: false,
                },
              ],
            },
          },
        }),
      ],
      streamMaxOffset: 52,
    });
    await flushBackgroundWork();

    expect(appended).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "events.iterate.com/agent/input-added",
        }),
      }),
    ]);
  });
});

function createProcessor(
  deps: SlackAgentProcessorDeps & {
    onAppend?: (event: StreamEventInput) => void;
    sideEffectsAfterOffset?: () => number;
  } = {},
) {
  const { onAppend, ...processorDeps } = deps;
  const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
  const processor = new SlackAgentProcessor({
    iterateContext: {
      stream: {
        append: async ({ event, streamPath }) => {
          onAppend?.(event);
          appended.push({ event, streamPath });
          return committedEvent({ ...event, offset: appended.length });
        },
        appendBatch: async ({ events, streamPath }) => {
          return events.map((event) => {
            onAppend?.(event);
            appended.push({ event, streamPath });
            return committedEvent({ ...event, offset: appended.length });
          });
        },
      },
    },
    ...processorDeps,
  });
  return { appended, processor };
}

/** Background appends settle on the microtask queue; one macrotask flushes them. */
async function flushBackgroundWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function routeEvent() {
  return committedEvent({
    offset: 1,
    type: "events.iterate.com/slack/thread-route-configured",
    payload: {
      channel: "C123",
      threadTs: "1772136258.963519",
      streamPath: "/agents/slack/c123/ts-1772136258-963519",
    },
  });
}

function webhookEvent(args: { offset: number; text: string }) {
  return committedEvent({
    offset: args.offset,
    type: "events.iterate.com/slack/webhook-received",
    payload: {
      body: {
        type: "event_callback",
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "U_USER",
          ts: "1772136259.000000",
          thread_ts: "1772136258.963519",
          event_ts: "1772136259.000000",
          text: args.text,
        },
      },
    },
  });
}

function committedEvent(args: {
  type: string;
  payload?: unknown;
  idempotencyKey?: string;
  offset: number;
}): StreamEvent {
  return {
    type: args.type,
    payload: args.payload,
    ...(args.idempotencyKey == null ? {} : { idempotencyKey: args.idempotencyKey }),
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
