import { describe, expect, it } from "vitest";
import type { GenericMessageEvent, MessageChangedEvent, ReactionAddedEvent } from "@slack/types";
import { STREAM_SUBSCRIPTION_CONFIGURED_TYPE } from "../../streams/core-event-types.ts";
import { buildProcessorRegisteredEvent } from "../core/contract.ts";
import {
  getInitialProcessorState,
  reduceProcessorEvents,
  type ConsumedEvent,
  type ProcessorState,
  type ProcessorStreamApi,
  type StreamEvent,
  type StreamEventInput,
} from "../stream-processor.ts";
import { SlackProcessorContract } from "./contract.ts";
import { createSlackProcessor } from "./implementation.ts";

describe("createSlackProcessor", () => {
  it("keeps Slack timestamp to stream path routing in reduced state", () => {
    const state = reduceProcessorEvents({
      contract: SlackProcessorContract,
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

    expect(state.routes).toEqual({
      "C123:1772136258.963519": "/agents/slack/c123/ts-1772136258-963519",
    });
  });

  it("keeps Slack connection state on the integration stream", () => {
    const state = reduceProcessorEvents({
      contract: SlackProcessorContract,
      events: [
        committedEvent({
          type: "events.iterate.com/slack/connected",
          payload: {
            connectionId: "conn_123",
            externalId: "T123",
            projectId: "prj_123",
            teamId: "T123",
            teamName: "Iterate",
          },
        }),
      ],
    });

    expect(state.connection).toEqual({
      status: "connected",
      connectionId: "conn_123",
      externalId: "T123",
      teamId: "T123",
      teamName: "Iterate",
    });
  });

  it("tolerates nullable Slack connected metadata from existing integration events", () => {
    const state = reduceProcessorEvents({
      contract: SlackProcessorContract,
      events: [
        committedEvent({
          type: "events.iterate.com/slack/connected",
          payload: {
            connectionId: "conn_123",
            externalId: "T123",
            projectId: "prj_123",
            teamDomain: null,
            teamId: "T123",
            teamName: "Iterate",
            webhookProviderIdentifier: null,
          },
        }),
      ],
    });

    expect(state.connection).toEqual({
      status: "connected",
      connectionId: "conn_123",
      externalId: "T123",
      teamId: "T123",
      teamName: "Iterate",
    });
  });

  it("does not infer routes from raw Slack webhooks", () => {
    expect(
      reduceProcessorEvents({
        contract: SlackProcessorContract,
        events: [
          committedEvent({
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
                  ts: "1772136258.963519",
                  event_ts: "1772136258.963519",
                  text: "hello",
                },
              },
            },
          }),
        ],
      }).routes,
    ).toEqual({});
  });

  it("still participates in standard processor registration", () => {
    expect(
      reduceProcessorEvents({
        contract: SlackProcessorContract,
        events: [
          committedEvent(buildProcessorRegisteredEvent({ contract: SlackProcessorContract })),
        ],
      }).hasRegisteredCurrentVersion,
    ).toBe(true);
  });

  it("forwards raw Slack webhooks when their channel and Slack timestamp match a configured route", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    const event = webhookEvent({
      offset: 10,
      body: slackMessageWebhook({
        channel: "C123",
        ts: "1772136259.000000",
        threadTs: "1772136258.963519",
        text: "extra context",
      }),
    });

    await createSlackProcessor().implementation.afterAppend?.({
      event,
      previousState: slackState(),
      state: slackState({
        routes: { "C123:1772136258.963519": "/agents/slack/c123/ts-1772136258-963519" },
      }),
      streamApi: testSlackStreamApi(appended),
      signal: new AbortController().signal,
    });

    expect(appended).toEqual([
      {
        streamPath: "/agents/slack/c123/ts-1772136258-963519",
        event: {
          type: "events.iterate.com/slack/webhook-received",
          payload: event.payload,
          idempotencyKey: "slack/forward-slack-webhook@10",
        },
      },
    ]);
  });

  it("forwards raw Slack interactivity payloads when they include message thread coordinates", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    const event = webhookEvent({
      offset: 16,
      body: {
        type: "block_actions",
        team: { id: "T123" },
        channel: { id: "C123" },
        message: {
          type: "message",
          ts: "1772136259.000000",
          thread_ts: "1772136258.963519",
          text: "Choose one",
        },
        actions: [{ action_id: "approve", block_id: "decision", type: "button", value: "yes" }],
      },
    });

    await createSlackProcessor().implementation.afterAppend?.({
      event,
      previousState: slackState(),
      state: slackState({
        routes: { "C123:1772136258.963519": "/agents/slack/c123/ts-1772136258-963519" },
      }),
      streamApi: testSlackStreamApi(appended),
      signal: new AbortController().signal,
    });

    expect(appended).toEqual([
      {
        streamPath: "/agents/slack/c123/ts-1772136258-963519",
        event: {
          type: "events.iterate.com/slack/webhook-received",
          payload: event.payload,
          idempotencyKey: "slack/forward-slack-webhook@16",
        },
      },
    ]);
  });

  it("creates a route for the first message-like Slack webhook and bootstraps the routed stream in one batch", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    const event = webhookEvent({
      offset: 14,
      body: slackMessageWebhook({
        channel: "C123",
        ts: "1772136258.963519",
        text: "start here",
      }),
    });

    await createSlackProcessor({
      createRoutedStreamBootstrapEvents: () => [
        {
          type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
          idempotencyKey: "slack-agent-subscription",
          payload: {
            slug: "slack-agent:C123:1772136258.963519",
            type: "callable",
            callable: {
              type: "workers-rpc",
              via: {
                type: "env-binding",
                bindingType: "durable-object-namespace",
                bindingName: "SLACK_AGENT",
                durableObject: { name: "slack-agent-do" },
              },
              rpcMethod: "afterAppend",
              argsMode: "object",
            },
          },
        },
        {
          type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
          idempotencyKey: "agent-subscription",
          payload: {
            slug: "agent:C123:1772136258.963519",
            type: "callable",
            callable: {
              type: "workers-rpc",
              via: {
                type: "env-binding",
                bindingType: "durable-object-namespace",
                bindingName: "AGENT",
                durableObject: { name: "agent-do" },
              },
              rpcMethod: "afterAppend",
              argsMode: "object",
            },
          },
        },
      ],
    }).implementation.afterAppend?.({
      event,
      previousState: slackState(),
      state: slackState(),
      streamApi: testSlackStreamApi(appended),
      signal: new AbortController().signal,
    });

    expect(appended.map((item) => item.streamPath)).toEqual([
      undefined,
      "/agents/slack/c123/ts-1772136258-963519",
      "/agents/slack/c123/ts-1772136258-963519",
      "/agents/slack/c123/ts-1772136258-963519",
      "/agents/slack/c123/ts-1772136258-963519",
    ]);
    expect(appended.map((item) => item.event.type)).toEqual([
      "events.iterate.com/slack/thread-route-configured",
      STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      "events.iterate.com/slack/thread-route-configured",
      "events.iterate.com/slack/webhook-received",
    ]);
    expect(appended[0].event.payload).toEqual({
      channel: "C123",
      threadTs: "1772136258.963519",
      streamPath: "/agents/slack/c123/ts-1772136258-963519",
    });
    expect(appended[3].event.payload).toEqual(appended[0].event.payload);
    expect(appended[4].event.payload).toEqual(event.payload);
  });

  it("creates a route for a Slack assistant root mention webhook", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    const event = webhookEvent({
      offset: 15,
      body: slackMessageWebhook({
        channel: "C08R1SMTZGD",
        ts: "1778565914.773159",
        text: "<@U08T48230AD>",
        assistantThread: { action_token: "redacted-action-token" },
      }),
    });

    await createSlackProcessor().implementation.afterAppend?.({
      event,
      previousState: slackState(),
      state: slackState(),
      streamApi: testSlackStreamApi(appended),
      signal: new AbortController().signal,
    });

    expect(appended.map((item) => item.event.type)).toEqual([
      "events.iterate.com/slack/thread-route-configured",
      "events.iterate.com/slack/thread-route-configured",
      "events.iterate.com/slack/webhook-received",
    ]);
    expect(appended[0].event.payload).toEqual({
      channel: "C08R1SMTZGD",
      threadTs: "1778565914.773159",
      streamPath: "/agents/slack/c08r1smtzgd/ts-1778565914-773159",
    });
    expect(appended.slice(1).map((item) => item.streamPath)).toEqual([
      "/agents/slack/c08r1smtzgd/ts-1778565914-773159",
      "/agents/slack/c08r1smtzgd/ts-1778565914-773159",
    ]);
  });

  it("uses nested Slack message thread coordinates instead of enumerating every Slack update subtype", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    const event = webhookEvent({
      offset: 11,
      body: slackMessageChangedWebhook({
        channel: "C123",
        ts: "1772136260.000000",
        threadTs: "1772136258.963519",
      }),
    });

    await createSlackProcessor().implementation.afterAppend?.({
      event,
      previousState: slackState(),
      state: slackState({
        routes: { "C123:1772136258.963519": "/agents/slack/c123/ts-1772136258-963519" },
      }),
      streamApi: testSlackStreamApi(appended),
      signal: new AbortController().signal,
    });

    expect(appended.map((item) => item.streamPath)).toEqual([
      "/agents/slack/c123/ts-1772136258-963519",
    ]);
  });

  it("routes reaction webhooks through the reacted Slack timestamp", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    const event = webhookEvent({
      offset: 12,
      body: slackReactionWebhook({
        channel: "C123",
        messageTs: "1772136258.963519",
        reaction: "thumbsup",
      }),
    });

    await createSlackProcessor().implementation.afterAppend?.({
      event,
      previousState: slackState(),
      state: slackState({
        routes: { "C123:1772136258.963519": "/agents/slack/c123/ts-1772136258-963519" },
      }),
      streamApi: testSlackStreamApi(appended),
      signal: new AbortController().signal,
    });

    expect(appended.map((item) => item.event.type)).toEqual([
      "events.iterate.com/slack/webhook-received",
    ]);
  });

  it("leaves reaction webhooks without an existing route on the global webhook stream only", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    const event = webhookEvent({
      offset: 13,
      body: slackReactionWebhook({
        channel: "C123",
        messageTs: "1772136258.963519",
        reaction: "thumbsup",
      }),
    });

    await createSlackProcessor().implementation.afterAppend?.({
      event,
      previousState: slackState(),
      state: slackState(),
      streamApi: testSlackStreamApi(appended),
      signal: new AbortController().signal,
    });

    expect(appended).toEqual([]);
  });
});

function slackState(
  state?: Partial<ProcessorState<typeof SlackProcessorContract>>,
): ProcessorState<typeof SlackProcessorContract> {
  return {
    ...getInitialProcessorState(SlackProcessorContract),
    hasRegisteredCurrentVersion: true,
    ...state,
  };
}

function testSlackStreamApi(
  appended: Array<{ streamPath?: string; event: StreamEventInput }>,
): ProcessorStreamApi<typeof SlackProcessorContract> {
  return testStreamApi(appended) as ProcessorStreamApi<typeof SlackProcessorContract>;
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

function webhookEvent(args: { body: Record<string, unknown>; offset: number }) {
  return committedEvent(
    {
      type: "events.iterate.com/slack/webhook-received",
      payload: { body: args.body },
      offset: args.offset,
    },
    "/integrations/slack",
  ) as Extract<
    ConsumedEvent<typeof SlackProcessorContract>,
    { type: "events.iterate.com/slack/webhook-received" }
  >;
}

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

function slackMessageWebhook(args: {
  assistantThread?: Record<string, unknown>;
  channel: string;
  ts: string;
  threadTs?: string;
  text: string;
}): Record<string, unknown> {
  return {
    type: "event_callback",
    event: {
      type: "message",
      subtype: undefined,
      channel: args.channel,
      channel_type: "channel",
      user: "U_USER",
      ts: args.ts,
      event_ts: args.ts,
      text: args.text,
      ...(args.assistantThread == null ? {} : { assistant_thread: args.assistantThread }),
      ...(args.threadTs == null ? {} : { thread_ts: args.threadTs }),
    } satisfies GenericMessageEvent,
  };
}

function slackMessageChangedWebhook(args: {
  channel: string;
  ts: string;
  threadTs: string;
}): Record<string, unknown> {
  return {
    type: "event_callback",
    event: {
      type: "message",
      subtype: "message_changed",
      event_ts: args.ts,
      hidden: true,
      channel: args.channel,
      channel_type: "channel",
      ts: args.ts,
      message: {
        type: "message",
        subtype: undefined,
        channel: args.channel,
        channel_type: "channel",
        user: "U_USER",
        ts: args.ts,
        thread_ts: args.threadTs,
        event_ts: args.ts,
        text: "edited",
      },
      previous_message: {
        type: "message",
        subtype: undefined,
        channel: args.channel,
        channel_type: "channel",
        user: "U_USER",
        ts: args.ts,
        thread_ts: args.threadTs,
        event_ts: args.ts,
        text: "before",
      },
    } satisfies MessageChangedEvent,
  };
}

function slackReactionWebhook(args: {
  channel: string;
  messageTs: string;
  reaction: string;
}): Record<string, unknown> {
  return {
    type: "event_callback",
    event: {
      type: "reaction_added",
      user: "U_USER",
      item_user: "U_MESSAGE_AUTHOR",
      event_ts: args.messageTs,
      reaction: args.reaction,
      item: { type: "message", channel: args.channel, ts: args.messageTs },
    } satisfies ReactionAddedEvent,
  };
}
