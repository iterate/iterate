import { describe, expect, it } from "vitest";
import type { GenericMessageEvent } from "@slack/types";
import {
  getInitialProcessorState,
  reduceProcessorEvents,
  type ConsumedEvent,
  type ProcessorState,
  type ProcessorStreamApi,
  type StreamEvent,
  type StreamEventInput,
} from "../stream-processor.ts";
import { SlackAgentProcessorContract } from "./contract.ts";
import { createSlackAgentProcessor } from "./implementation.ts";

describe("createSlackAgentProcessor", () => {
  it("reduces Slack route context", () => {
    const state = reduceProcessorEvents({
      contract: SlackAgentProcessorContract,
      events: [
        committedEvent({
          type: "events.iterate.com/slack/thread-route-configured",
          payload: {
            channel: "C123",
            threadTs: "1772136258.963519",
            streamPath: "/agents/slack/c123/ts-1772136258-963519",
          },
        }),
      ],
    });

    expect(state).toMatchObject({
      channel: "C123",
      streamPath: "/agents/slack/c123/ts-1772136258-963519",
      threadTs: "1772136258.963519",
    });
  });

  it("extracts botUserId from webhook authorizations", () => {
    const state = reduceProcessorEvents({
      contract: SlackAgentProcessorContract,
      events: [
        committedEvent({
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
    });

    expect(state.botUserId).toBe("U_BOT");
  });

  it("registers ctx.slack.agent as an event-based codemode provider when route context arrives", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    const event = routeEvent();

    await createSlackAgentProcessor().implementation.afterAppend?.({
      event,
      previousState: registeredSlackAgentState(),
      state: registeredSlackAgentState({
        channel: "C123",
        streamPath: "/agents/slack/c123/ts-1772136258-963519",
        threadTs: "1772136258.963519",
      }),
      streamApi: testSlackAgentStreamApi(appended),
      signal: new AbortController().signal,
    });

    expect(appended).toEqual([
      {
        streamPath: undefined,
        event: {
          type: "events.iterate.com/codemode/tool-provider-registered",
          idempotencyKey: "slack-agent/register-slack-agent-tool-provider@1",
          payload: {
            path: ["slack", "agent"],
            invocation: { kind: "event" },
            instructions:
              "Use ctx.slack.agent.threadInfo() only when you need route context that is not already in the Slack webhook payload. Slack agents MUST respond on the same thread_ts that received the message; otherwise they will not receive responses from that thread. Unless explicitly required, always include thread_ts in Slack replies. Do not post to Slack unless the bot was explicitly mentioned, a user directly asks or instructs you, or the surrounding thread context clearly calls for agent action. Normal Slack replies can use channel/thread_ts from the webhook event directly.",
          },
        },
      },
    ]);
  });

  it("emits a Slack-posting codemode script for the debug bang command", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    const event = webhookEvent({
      offset: 42,
      text: "!debug",
    });

    await createSlackAgentProcessor().implementation.afterAppend?.({
      event,
      previousState: registeredSlackAgentState(),
      state: registeredSlackAgentState({
        channel: "C123",
        latestMessageTs: "1772136259.000000",
        threadTs: "1772136258.963519",
      }),
      streamApi: testSlackAgentStreamApi(appended),
      signal: new AbortController().signal,
    });

    expect(appended).toHaveLength(1);
    expect(appended[0].event).toMatchObject({
      type: "events.iterate.com/codemode/script-execution-requested",
      idempotencyKey: "slack-agent/slack-bang-command-to-codemode-script@42",
      payload: {
        scriptExecutionId: "slack-bang-command-42",
      },
    });
    const code = (appended[0].event.payload as { code: string }).code;
    expect(code).toContain("const debug = await ctx.debug();");
    expect(code).toContain("await ctx.slack.chat.postMessage({");
    expect(code).toContain('channel: "C123"');
    expect(code).toContain('thread_ts: "1772136258.963519"');
    expect(code).toContain("text: `Debug info:\\n${debug}`");
    expect(code).not.toContain("ctx.slack.agent.threadInfo");
    expect(code).not.toContain("ctx.slack.threadInfo");
  });

  it("emits direct codemode scripts for non-debug bang commands", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    const event = webhookEvent({
      offset: 45,
      text: "!slack.agent.threadInfo",
    });

    await createSlackAgentProcessor().implementation.afterAppend?.({
      event,
      previousState: registeredSlackAgentState(),
      state: registeredSlackAgentState({
        channel: "C123",
        latestMessageTs: "1772136259.000000",
        threadTs: "1772136258.963519",
      }),
      streamApi: testSlackAgentStreamApi(appended),
      signal: new AbortController().signal,
    });

    expect(appended).toHaveLength(1);
    const code = (appended[0].event.payload as { code: string }).code;
    expect(code).toContain("await ctx.slack.agent.threadInfo();");
    expect(code).not.toContain("ctx.slack.chat.postMessage");
    expect(code).not.toContain("const debug = await");
  });

  it("emits agent input for non-bang Slack messages", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    const event = webhookEvent({
      offset: 43,
      text: "please look at this",
    });

    await createSlackAgentProcessor().implementation.afterAppend?.({
      event,
      previousState: registeredSlackAgentState(),
      state: registeredSlackAgentState({
        channel: "C123",
        latestMessageTs: "1772136259.000000",
        threadTs: "1772136258.963519",
      }),
      streamApi: testSlackAgentStreamApi(appended),
      signal: new AbortController().signal,
    });

    expect(appended).toHaveLength(1);
    expect(appended[0].event).toMatchObject({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "slack-agent/slack-webhook-to-agent-input@43",
      payload: {
        content: expect.stringContaining(
          "`events.iterate.com/slack/webhook-received` event received",
        ),
      },
    });
    const content = (appended[0].event.payload as { content: string }).content;
    expect(content).toContain("```yaml");
    expect(content).not.toContain("Slack reply guidance");
    expect(content).toContain("text: please look at this");
    expect(content).toContain('thread_ts: "1772136258.963519"');
    expect(content).not.toContain("Reply requirement:");
    expect(content).not.toContain("ctx.slack.chat.postMessage({ channel, thread_ts, text })");
    expect(content).not.toContain("Do not use `ctx.chat.sendMessage`");
  });

  it("emits agent input for messages from other bots", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    const slackCalls: Array<{ body: Record<string, unknown>; method: string }> = [];
    const event = committedEvent({
      type: "events.iterate.com/slack/webhook-received",
      payload: {
        body: {
          type: "event_callback",
          event: {
            type: "message",
            channel: "C123",
            channel_type: "channel",
            user: "U_OTHER_BOT",
            bot_id: "B_OTHER",
            ts: "1772136259.000000",
            event_ts: "1772136259.000000",
            text: "<@U_BOT> deployment says hello",
          },
          authorizations: [
            { team_id: "T123", user_id: "U_BOT", is_bot: true, is_enterprise_install: false },
          ],
        },
      },
      offset: 47,
    }) as Extract<
      ConsumedEvent<typeof SlackAgentProcessorContract>,
      { type: "events.iterate.com/slack/webhook-received" }
    >;

    await createSlackAgentProcessor({
      callSlackApi: async (method, body) => {
        slackCalls.push({ method, body });
      },
    }).implementation.afterAppend?.({
      event,
      previousState: registeredSlackAgentState(),
      state: registeredSlackAgentState({
        botUserId: "U_BOT",
        channel: "C123",
        threadTs: "1772136258.963519",
      }),
      streamApi: testSlackAgentStreamApi(appended),
      signal: new AbortController().signal,
    });

    expect(slackCalls).toEqual([]);
    expect(appended).toHaveLength(1);
    expect(appended[0].event).toMatchObject({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "slack-agent/slack-webhook-to-agent-input@47",
      payload: {
        content: expect.stringContaining("<@U_BOT> deployment says hello"),
      },
    });
  });

  it("emits agent input for raw Slack interactivity payloads", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    const event = committedEvent({
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
      offset: 46,
    }) as Extract<
      ConsumedEvent<typeof SlackAgentProcessorContract>,
      { type: "events.iterate.com/slack/webhook-received" }
    >;

    await createSlackAgentProcessor().implementation.afterAppend?.({
      event,
      previousState: registeredSlackAgentState(),
      state: registeredSlackAgentState({
        channel: "C123",
        latestMessageTs: "1772136259.000000",
        threadTs: "1772136258.963519",
      }),
      streamApi: testSlackAgentStreamApi(appended),
      signal: new AbortController().signal,
    });

    expect(appended).toHaveLength(1);
    expect(appended[0].event).toMatchObject({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "slack-agent/slack-webhook-to-agent-input@46",
      payload: {
        content: expect.stringContaining("type: block_actions"),
      },
    });
    expect((appended[0].event.payload as { content: string }).content).toContain(
      "action_id: approve",
    );
  });

  it("satisfies ctx.slack.agent.threadInfo function calls from reduced route state", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    const event = committedEvent({
      type: "events.iterate.com/codemode/function-call-requested",
      offset: 44,
      payload: {
        args: [],
        functionCallId: "call-1",
        functionPath: ["threadInfo"],
        invocationKind: "event",
        path: ["slack", "agent", "threadInfo"],
        providerPath: ["slack", "agent"],
        scriptExecutionId: "script-1",
      },
    }) as Extract<
      ConsumedEvent<typeof SlackAgentProcessorContract>,
      { type: "events.iterate.com/codemode/function-call-requested" }
    >;

    await createSlackAgentProcessor().implementation.afterAppend?.({
      event,
      previousState: registeredSlackAgentState(),
      state: registeredSlackAgentState({
        channel: "C123",
        streamPath: "/agents/slack/c123/ts-1772136258-963519",
        threadTs: "1772136258.963519",
      }),
      streamApi: testSlackAgentStreamApi(appended),
      signal: new AbortController().signal,
    });

    expect(appended).toEqual([
      {
        streamPath: undefined,
        event: {
          type: "events.iterate.com/codemode/function-call-completed",
          idempotencyKey: "slack-agent/slack-agent-thread-info-function-call-completed@44",
          payload: {
            durationMs: 0,
            functionCallId: "call-1",
            functionPath: ["threadInfo"],
            invocationKind: "event",
            outcome: {
              status: "returned",
              value: {
                channel: "C123",
                thread_ts: "1772136258.963519",
                streamPath: "/agents/slack/c123/ts-1772136258-963519",
              },
            },
            path: ["slack", "agent", "threadInfo"],
            providerPath: ["slack", "agent"],
            scriptExecutionId: "script-1",
          },
        },
      },
    ]);
  });
});

function registeredSlackAgentState(
  state?: Partial<ProcessorState<typeof SlackAgentProcessorContract>>,
): ProcessorState<typeof SlackAgentProcessorContract> {
  return {
    ...getInitialProcessorState(SlackAgentProcessorContract),
    hasRegisteredCurrentVersion: true,
    ...state,
  };
}

function testSlackAgentStreamApi(
  appended: Array<{ streamPath?: string; event: StreamEventInput }>,
): ProcessorStreamApi<typeof SlackAgentProcessorContract> {
  return testStreamApi(appended) as ProcessorStreamApi<typeof SlackAgentProcessorContract>;
}

function testStreamApi(appended: Array<{ streamPath?: string; event: StreamEventInput }>) {
  return {
    append: async ({ event, streamPath }: { event: StreamEventInput; streamPath?: string }) => {
      appended.push({ event, streamPath });
      return committedEvent(event, streamPath);
    },
    appendBatch: async ({
      events,
      streamPath,
    }: {
      events: StreamEventInput[];
      streamPath?: string;
    }) => {
      const appendedEvents: StreamEvent[] = [];
      for (const event of events) {
        appended.push({ event, streamPath });
        appendedEvents.push(committedEvent(event, streamPath));
      }
      return appendedEvents;
    },
    read: async () => [],
    subscribe: async function* () {},
  };
}

function routeEvent() {
  return committedEvent({
    type: "events.iterate.com/slack/thread-route-configured",
    payload: {
      channel: "C123",
      threadTs: "1772136258.963519",
      streamPath: "/agents/slack/c123/ts-1772136258-963519",
    },
  }) as Extract<
    ConsumedEvent<typeof SlackAgentProcessorContract>,
    { type: "events.iterate.com/slack/thread-route-configured" }
  >;
}

function webhookEvent(args: { offset: number; text: string }) {
  return committedEvent({
    type: "events.iterate.com/slack/webhook-received",
    payload: {
      body: {
        type: "event_callback",
        event: {
          type: "message",
          subtype: undefined,
          channel: "C123",
          channel_type: "channel",
          user: "U_USER",
          ts: "1772136259.000000",
          thread_ts: "1772136258.963519",
          event_ts: "1772136259.000000",
          text: args.text,
        } satisfies GenericMessageEvent,
      },
    },
    offset: args.offset,
  }) as Extract<
    ConsumedEvent<typeof SlackAgentProcessorContract>,
    { type: "events.iterate.com/slack/webhook-received" }
  >;
}

it("ignores webhook events caused by our own bot user (e.g. bot adding a reaction)", async () => {
  const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
  const event = committedEvent({
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
    offset: 50,
  }) as Extract<
    ConsumedEvent<typeof SlackAgentProcessorContract>,
    { type: "events.iterate.com/slack/webhook-received" }
  >;

  await createSlackAgentProcessor().implementation.afterAppend?.({
    event,
    previousState: registeredSlackAgentState(),
    state: registeredSlackAgentState({
      botUserId: "U_BOT",
      channel: "C123",
      latestMessageTs: "1772136259.000000",
      threadTs: "1772136258.963519",
    }),
    streamApi: testSlackAgentStreamApi(appended),
    signal: new AbortController().signal,
  });

  expect(appended).toEqual([]);
});

it("ignores message webhooks from our own bot user", async () => {
  const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
  const event = committedEvent({
    type: "events.iterate.com/slack/webhook-received",
    payload: {
      body: {
        type: "event_callback",
        event: {
          type: "message",
          channel: "C123",
          user: "U_BOT",
          bot_id: "B_BOT",
          ts: "1772136259.000000",
          event_ts: "1772136259.000000",
          text: "our own reply",
        },
        authorizations: [
          { team_id: "T123", user_id: "U_BOT", is_bot: true, is_enterprise_install: false },
        ],
      },
    },
    offset: 51,
  }) as Extract<
    ConsumedEvent<typeof SlackAgentProcessorContract>,
    { type: "events.iterate.com/slack/webhook-received" }
  >;

  await createSlackAgentProcessor().implementation.afterAppend?.({
    event,
    previousState: registeredSlackAgentState(),
    state: registeredSlackAgentState({
      botUserId: "U_BOT",
      channel: "C123",
      latestMessageTs: "1772136259.000000",
      threadTs: "1772136258.963519",
    }),
    streamApi: testSlackAgentStreamApi(appended),
    signal: new AbortController().signal,
  });

  expect(appended).toEqual([]);
});

function committedEvent(
  args: { type: string; payload: unknown; idempotencyKey?: string; offset?: number },
  streamPath = "/agents/slack/c123/ts-1772136258-963519",
): StreamEvent {
  return {
    streamPath,
    type: args.type,
    payload: args.payload,
    idempotencyKey: args.idempotencyKey,
    offset: args.offset ?? 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
