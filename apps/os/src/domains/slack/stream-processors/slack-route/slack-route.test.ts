// The thread router, post-migration: same routing semantics as the old
// bespoke SlackProcessor, consuming the generic capture envelope on the
// account stream and forwarding the LEGACY wire format to thread streams
// (slack-agent downstream is byte-compatible).

import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "@iterate-com/streams/shared/event";
import { SlackRouteProcessor, type SlackRouteProcessorDeps } from "./implementation.ts";

describe("SlackRouteProcessor", () => {
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
      events: [envelopeEvent({ offset: 7, text: "hello" })],
      streamMaxOffset: 7,
    });
    await flushBackgroundWork();

    const expectedStreamPath = "/agents/slack/default/c123/ts-1772136258-963519";
    expect(bootstrapCalls).toEqual([
      { channel: "C123", streamPath: expectedStreamPath, threadTs: "1772136258.963519" },
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
      // Route memory on the account stream itself.
      { streamPath: undefined, event: routeEvent },
      // Bootstrap + route + forwarded webhook on the routed stream, in order.
      { streamPath: expectedStreamPath, event: bootstrapEvent },
      { streamPath: expectedStreamPath, event: routeEvent },
      {
        streamPath: expectedStreamPath,
        event: {
          type: "events.iterate.com/slack/webhook-received",
          idempotencyKey: "slack-route/forward-slack-webhook@7",
          // The LEGACY wire shape: { body } — slack-agent untouched.
          payload: { body: slackBody("hello") },
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
        envelopeEvent({ offset: 4, text: "again" }),
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
          idempotencyKey: "slack-route/forward-slack-webhook@4",
          payload: { body: slackBody("again") },
        },
      },
    ]);
  });

  it("ignores envelopes that cannot be keyed as channel:thread_ts", async () => {
    const { appended, processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 5,
          type: "events.iterate.com/integration/event-received",
          payload: {
            integration: "slack",
            transport: "webhook",
            routingKey: "team:T1",
            body: { type: "url_verification", challenge: "x" },
          },
        }),
      ],
      streamMaxOffset: 5,
    });
    await flushBackgroundWork();

    expect(appended).toEqual([]);
  });

  it("acknowledges routed webhooks and pre-warms hosts for new routes", async () => {
    const acknowledged: unknown[] = [];
    const prewarmed: string[] = [];
    const { processor } = createProcessor({
      createRoutedStreamBootstrapEvents: () => [],
      acknowledgeRoutedWebhook: ({ payload }) => {
        acknowledged.push(payload);
      },
      prewarmRoutedStreamHosts: ({ streamPath }) => {
        prewarmed.push(streamPath);
      },
    });

    await processor.ingest({
      events: [envelopeEvent({ offset: 7, text: "hello" })],
      streamMaxOffset: 7,
    });
    await flushBackgroundWork();

    expect(acknowledged).toEqual([{ body: slackBody("hello") }]);
    expect(prewarmed).toEqual(["/agents/slack/default/c123/ts-1772136258-963519"]);
  });

  it("nests thread streams under the workspace ACCOUNT — multiple Slacks coexist", async () => {
    const { appended, processor } = createProcessor({
      createRoutedStreamBootstrapEvents: () => [],
    });

    await processor.ingest({
      events: [envelopeEvent({ offset: 9, text: "hi from second workspace", account: "t9zz" })],
      streamMaxOffset: 9,
    });
    await flushBackgroundWork();

    const routed = appended.find((entry) => entry.streamPath != null);
    expect(routed?.streamPath).toBe("/agents/slack/t9zz/c123/ts-1772136258-963519");
  });
});

function createProcessor(
  deps: SlackRouteProcessorDeps & { sideEffectsAfterOffset?: () => number } = {},
) {
  const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
  const processor = new SlackRouteProcessor({
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

async function flushBackgroundWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function slackBody(text: string) {
  return {
    type: "event_callback",
    event: {
      type: "message",
      channel: "C123",
      channel_type: "channel",
      user: "U_USER",
      ts: "1772136259.000000",
      thread_ts: "1772136258.963519",
      event_ts: "1772136259.000000",
      text,
    },
  };
}

function envelopeEvent(args: { offset: number; text: string; account?: string }) {
  return committedEvent({
    offset: args.offset,
    type: "events.iterate.com/integration/event-received",
    payload: {
      integration: "slack",
      transport: "webhook" as const,
      routingKey: "team:T1",
      ...(args.account == null ? {} : { account: args.account }),
      body: slackBody(args.text),
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
    createdAt: "2026-06-12T00:00:00.000Z",
  };
}
