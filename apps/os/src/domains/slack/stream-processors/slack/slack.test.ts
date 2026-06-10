import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "@iterate-com/streams/shared/event";
import { SlackProcessor, type SlackProcessorDeps } from "./implementation.ts";

describe("SlackProcessor", () => {
  it("reduces Slack connection state", async () => {
    const { processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 1,
          type: "events.iterate.com/slack/connected",
          payload: {
            connectionId: "conn-1",
            externalId: "T123",
            projectId: "project-1",
            teamId: "T123",
            teamName: "Acme",
          },
        }),
      ],
      streamMaxOffset: 1,
    });
    expect(processor.state.connection).toEqual({
      status: "connected",
      connectionId: "conn-1",
      externalId: "T123",
      teamId: "T123",
      teamName: "Acme",
    });

    await processor.ingest({
      events: [
        committedEvent({
          offset: 2,
          type: "events.iterate.com/slack/disconnected",
          payload: { connectionId: "conn-1", projectId: "project-1" },
        }),
      ],
      streamMaxOffset: 2,
    });
    expect(processor.state.connection).toMatchObject({ status: "disconnected" });
  });

  it("creates a route and forwards the first thread webhook with bootstrap events", async () => {
    const bootstrapEvent: StreamEventInput = {
      type: "events.iterate.com/stream/subscription-configured",
      idempotencyKey: "bootstrap:slack-agent",
      payload: { subscriptionKey: "slack-agent:project-1", subscriber: { type: "callable" } },
    };
    const bootstrapCalls: unknown[] = [];
    const { appended, processor } = createProcessor({
      createRoutedStreamBootstrapEvents: (input) => {
        bootstrapCalls.push(input);
        return [bootstrapEvent];
      },
    });

    await processor.ingest({
      events: [webhookEvent({ offset: 7, text: "hello" })],
      streamMaxOffset: 7,
    });
    await flushBackgroundWork();

    const expectedStreamPath = "/agents/slack/c123/ts-1772136258-963519";
    expect(bootstrapCalls).toEqual([
      {
        channel: "C123",
        streamPath: expectedStreamPath,
        threadTs: "1772136258.963519",
      },
    ]);

    const routeEvent = {
      type: "events.iterate.com/slack/thread-route-configured",
      idempotencyKey: "slack-route:C123:1772136258.963519",
      payload: {
        channel: "C123",
        threadTs: "1772136258.963519",
        streamPath: expectedStreamPath,
      },
    };
    expect(appended).toEqual([
      // Route memory on /integrations/slack itself.
      { streamPath: undefined, event: routeEvent },
      // Bootstrap + route + forwarded webhook on the routed stream, in order.
      {
        streamPath: expectedStreamPath,
        event: bootstrapEvent,
      },
      { streamPath: expectedStreamPath, event: routeEvent },
      {
        streamPath: expectedStreamPath,
        event: {
          type: "events.iterate.com/slack/webhook-received",
          idempotencyKey: "slack/forward-slack-webhook@7",
          payload: webhookEvent({ offset: 7, text: "hello" }).payload,
        },
      },
    ]);
  });

  it("forwards webhooks for known routes without re-bootstrapping", async () => {
    const { appended, processor } = createProcessor({
      createRoutedStreamBootstrapEvents: () => {
        throw new Error("must not bootstrap an already-routed thread");
      },
    });

    await processor.ingest({
      events: [
        committedEvent({
          offset: 3,
          type: "events.iterate.com/slack/thread-route-configured",
          payload: {
            channel: "C123",
            threadTs: "1772136258.963519",
            streamPath: "/agents/slack/custom-path",
          },
        }),
        webhookEvent({ offset: 4, text: "again" }),
      ],
      streamMaxOffset: 4,
    });
    await flushBackgroundWork();

    expect(processor.state.routes).toEqual({
      "C123:1772136258.963519": "/agents/slack/custom-path",
    });
    expect(appended).toEqual([
      {
        streamPath: "/agents/slack/custom-path",
        event: {
          type: "events.iterate.com/slack/webhook-received",
          idempotencyKey: "slack/forward-slack-webhook@4",
          payload: webhookEvent({ offset: 4, text: "again" }).payload,
        },
      },
    ]);
  });

  it("ignores webhooks that cannot be keyed as channel:thread_ts", async () => {
    const { appended, processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 5,
          type: "events.iterate.com/slack/webhook-received",
          payload: { body: { type: "url_verification", challenge: "x" } },
        }),
      ],
      streamMaxOffset: 5,
    });
    await flushBackgroundWork();

    expect(appended).toEqual([]);
  });

  it("does not create routes for item-keyed events (e.g. reactions) without an existing route", async () => {
    const { appended, processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 6,
          type: "events.iterate.com/slack/webhook-received",
          payload: {
            body: {
              type: "event_callback",
              event: {
                type: "reaction_added",
                user: "U1",
                reaction: "eyes",
                item: { type: "message", channel: "C123", ts: "1772136258.963519" },
              },
            },
          },
        }),
      ],
      streamMaxOffset: 6,
    });
    await flushBackgroundWork();

    expect(appended).toEqual([]);
  });

  it("skips side effects for events at or below the side-effect anchor", async () => {
    const { appended, processor } = createProcessor({ sideEffectsAfterOffset: () => 10 });

    await processor.ingest({
      events: [webhookEvent({ offset: 9, text: "historical" })],
      streamMaxOffset: 12,
    });
    await flushBackgroundWork();

    // Reduced (no route table change for plain messages) but no forwarding.
    expect(appended).toEqual([]);

    await processor.ingest({
      events: [webhookEvent({ offset: 11, text: "live" })],
      streamMaxOffset: 12,
    });
    await flushBackgroundWork();
    expect(appended.length).toBeGreaterThan(0);
  });
});

function createProcessor(
  deps: SlackProcessorDeps & { sideEffectsAfterOffset?: () => number } = {},
) {
  const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
  const processor = new SlackProcessor({
    iterateContext: {
      stream: {
        append: async ({ event, streamPath }) => {
          appended.push({ event, streamPath });
          return committedEvent({ ...event, offset: appended.length });
        },
        appendBatch: async ({ events, streamPath }) => {
          return events.map((event) => {
            appended.push({ event, streamPath });
            return committedEvent({ ...event, offset: appended.length });
          });
        },
      },
    },
    ...deps,
  });
  return { appended, processor };
}

/** Background appends settle on the microtask queue; one macrotask flushes them. */
async function flushBackgroundWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
