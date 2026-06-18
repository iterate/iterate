import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "@iterate-com/shared/streams/stream-event";
import { SlackProcessor } from "./implementation.ts";
import type { StreamProcessorStream } from "~/domains/streams/engine/stream-processor.ts";

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

  it("creates a route and forwards the first thread webhook", async () => {
    const { appended, processor } = createProcessor();

    await processor.ingest({
      events: [webhookEvent({ offset: 7, text: "hello" })],
      streamMaxOffset: 7,
    });
    await flushBackgroundWork();

    const expectedStreamPath = "/agents/slack/c123/ts-1772136258-963519";

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
      // Route + forwarded webhook on the routed stream, in order. Agent setup
      // is owned by ProjectProcessor when this child stream is created.
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
    const { appended, processor } = createProcessor();

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

  it("replays the webhook when the forward append fails instead of dropping it", async () => {
    // Regression for the prd 2026-06-15 loss: the first message on a fresh
    // project reached the project stream but the agent never saw it. The router
    // forwarded it with fire-and-forget `runInBackground`, so when the (cold,
    // cross-worker) append threw, the error was swallowed, the checkpoint
    // advanced, and the only copy of the message was dropped.
    //
    // The forward must be a durable obligation: a failed append rejects the
    // batch and HOLDS the checkpoint so the host replays the webhook. This test
    // fails against the old `runInBackground` wiring (ingest resolves, message
    // lost) and passes under `blockProcessorWhile`.
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    let failNextAppend = true;
    const streamFor = (streamPath: string | undefined): StreamProcessorStream =>
      ({
        append: async (args: { event: StreamEventInput }) => {
          const { event } = args;
          if (failNextAppend) {
            failNextAppend = false;
            throw new Error("cold StreamsCapability RPC failed");
          }
          appended.push({ event, streamPath });
          return committedEvent({ ...event, offset: appended.length });
        },
        appendBatch: async (args: { events: StreamEventInput[] }) =>
          args.events.map((event) => {
            appended.push({ event, streamPath });
            return committedEvent({ ...event, offset: appended.length });
          }),
        at: (nextPath: string) => streamFor(nextPath),
      }) as unknown as StreamProcessorStream;
    const processor = new SlackProcessor({
      stream: streamFor(undefined),
    });

    // First delivery: the append throws. ingest MUST reject and the checkpoint
    // MUST stay at 0 — otherwise the webhook is gone for good.
    await expect(
      processor.ingest({
        events: [webhookEvent({ offset: 7, text: "hello" })],
        streamMaxOffset: 7,
      }),
    ).rejects.toThrow(/StreamsCapability/);
    expect(processor.checkpointOffset).toBe(0);
    expect(appended).toEqual([]);

    // The host replays the same webhook from the un-advanced checkpoint; the
    // append now succeeds, the forward lands, and the checkpoint advances.
    await processor.ingest({
      events: [webhookEvent({ offset: 7, text: "hello" })],
      streamMaxOffset: 7,
    });
    expect(processor.checkpointOffset).toBe(7);
    expect(
      appended.some(
        (entry) =>
          entry.streamPath === "/agents/slack/c123/ts-1772136258-963519" &&
          entry.event.type === "events.iterate.com/slack/webhook-received",
      ),
    ).toBe(true);
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

  it("acknowledges routed webhooks for new routes", async () => {
    const acknowledged: unknown[] = [];
    const { processor } = createProcessor({
      acknowledgeRoutedWebhook: ({ payload }) => {
        acknowledged.push(payload);
      },
    });

    await processor.ingest({
      events: [webhookEvent({ offset: 7, text: "hello" })],
      streamMaxOffset: 7,
    });
    await flushBackgroundWork();

    expect(acknowledged).toEqual([webhookEvent({ offset: 7, text: "hello" }).payload]);
  });

  it("acknowledges webhooks on existing routes", async () => {
    const acknowledged: unknown[] = [];
    const { processor } = createProcessor({
      acknowledgeRoutedWebhook: ({ payload }) => {
        acknowledged.push(payload);
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

    expect(acknowledged).toHaveLength(1);
  });

  it("does not acknowledge unroutable webhooks", async () => {
    const acknowledged: unknown[] = [];
    const { processor } = createProcessor({
      acknowledgeRoutedWebhook: ({ payload }) => {
        acknowledged.push(payload);
      },
    });

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

    expect(acknowledged).toEqual([]);
  });
});

function createProcessor(
  deps: {
    acknowledgeRoutedWebhook?: (input: { payload: unknown }) => Promise<void> | void;
  } = {},
) {
  const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
  const streamFor = (streamPath: string | undefined): StreamProcessorStream =>
    ({
      append: async (args: { event: StreamEventInput }) => {
        const { event } = args;
        appended.push({ event, streamPath });
        return committedEvent({ ...event, offset: appended.length });
      },
      appendBatch: async (args: { events: StreamEventInput[] }) => {
        return args.events.map((event) => {
          appended.push({ event, streamPath });
          return committedEvent({ ...event, offset: appended.length });
        });
      },
      at: (nextPath: string) => streamFor(nextPath),
    }) as unknown as StreamProcessorStream;
  const processor = new SlackProcessor({
    stream: streamFor(undefined),
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
