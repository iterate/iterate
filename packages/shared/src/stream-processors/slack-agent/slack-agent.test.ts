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
              "Use ctx.slack.agent.threadInfo() to get { channel, thread_ts } for the current Slack thread.",
          },
        },
      },
    ]);
  });

  it("emits codemode script requests for bang commands without calling ctx.slack.agent.threadInfo", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    const event = webhookEvent({
      offset: 42,
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
    expect(appended[0].event).toMatchObject({
      type: "events.iterate.com/codemode/script-execution-requested",
      idempotencyKey: "slack-agent/slack-bang-command-to-codemode-script@42",
      payload: {
        scriptExecutionId: "slack-bang-command-42",
      },
    });
    expect((appended[0].event.payload as { code: string }).code).toContain(
      "await ctx.slack.agent.threadInfo();",
    );
    expect((appended[0].event.payload as { code: string }).code).not.toContain(
      "ctx.slack.chat.postMessage",
    );
    expect((appended[0].event.payload as { code: string }).code).not.toContain(
      "ctx.slack.threadInfo",
    );
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
        content: expect.stringContaining("- thread_ts: 1772136258.963519"),
      },
    });
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
