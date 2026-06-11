import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "@iterate-com/streams/shared/event";
import {
  IntegrationIngressProcessor,
  type IntegrationIngressProcessorDeps,
} from "./implementation.ts";

describe("IntegrationIngressProcessor", () => {
  it("forwards captured events to the project that claimed the routing key", async () => {
    const { forwarded, processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 1,
          type: "events.iterate.com/integration/route-registered",
          payload: {
            integration: "github",
            routingKey: "installation:1234",
            projectId: "proj-a",
          },
        }),
        committedEvent({
          offset: 2,
          type: "events.iterate.com/integration/event-received",
          payload: {
            integration: "github",
            transport: "webhook",
            routingKey: "installation:1234",
            body: { action: "opened", installation: { id: 1234 } },
          },
        }),
      ],
      streamMaxOffset: 2,
    });
    await flushBackgroundWork();

    expect(processor.state.routes).toEqual({ "installation:1234": "proj-a" });
    expect(forwarded).toEqual([
      {
        projectId: "proj-a",
        event: {
          type: "events.iterate.com/integration/event-received",
          idempotencyKey: "integration-ingress/forward@2",
          payload: {
            integration: "github",
            transport: "webhook",
            routingKey: "installation:1234",
            body: { action: "opened", installation: { id: 1234 } },
          },
        },
      },
    ]);
  });

  it("routes gateway dispatches identically to webhooks", async () => {
    const { forwarded, processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 1,
          type: "events.iterate.com/integration/route-registered",
          payload: { integration: "discord", routingKey: "guild:42", projectId: "proj-b" },
        }),
        committedEvent({
          offset: 2,
          type: "events.iterate.com/integration/event-received",
          payload: {
            integration: "discord",
            transport: "gateway",
            routingKey: "guild:42",
            body: { op: 0, t: "MESSAGE_CREATE", s: 7, d: { guild_id: "42", content: "hi" } },
          },
        }),
      ],
      streamMaxOffset: 2,
    });
    await flushBackgroundWork();

    expect(forwarded.map((entry) => entry.projectId)).toEqual(["proj-b"]);
  });

  it("drops events whose routing key nobody claimed, and counts them", async () => {
    const { forwarded, processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 1,
          type: "events.iterate.com/integration/event-received",
          payload: {
            integration: "github",
            transport: "webhook",
            routingKey: "installation:999",
            body: {},
          },
        }),
      ],
      streamMaxOffset: 1,
    });
    await flushBackgroundWork();

    expect(forwarded).toEqual([]);
    expect(processor.state.dropped).toBe(1);
  });

  it("stops forwarding after route-removed", async () => {
    const { forwarded, processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 1,
          type: "events.iterate.com/integration/route-registered",
          payload: { integration: "github", routingKey: "installation:1", projectId: "proj-a" },
        }),
        committedEvent({
          offset: 2,
          type: "events.iterate.com/integration/route-removed",
          payload: { integration: "github", routingKey: "installation:1" },
        }),
        committedEvent({
          offset: 3,
          type: "events.iterate.com/integration/event-received",
          payload: {
            integration: "github",
            transport: "webhook",
            routingKey: "installation:1",
            body: {},
          },
        }),
      ],
      streamMaxOffset: 3,
    });
    await flushBackgroundWork();

    expect(processor.state.routes).toEqual({});
    expect(forwarded).toEqual([]);
  });
});

function createProcessor(deps: Partial<IntegrationIngressProcessorDeps> = {}) {
  const forwarded: Array<{ projectId: string; event: StreamEventInput }> = [];
  const processor = new IntegrationIngressProcessor({
    iterateContext: {
      stream: {
        append: async ({ event }) => committedEvent({ ...event, offset: 0 }),
        appendBatch: async ({ events }) =>
          events.map((event) => committedEvent({ ...event, offset: 0 })),
      },
    },
    forwardToProject: async (input) => {
      forwarded.push(input);
    },
    ...deps,
  });
  return { forwarded, processor };
}

async function flushBackgroundWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
    createdAt: "2026-06-11T00:00:00.000Z",
  };
}
