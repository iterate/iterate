// Exercises the class-based jsonata-reactor: rule configuration reduces into
// state, wildcard-consumed events evaluate rules, and reactions are appended
// (including cross-stream reactions via `streamPath`).

import { describe, expect, it } from "vitest";
import type { StreamEvent } from "@iterate-com/shared/streams/stream-event";
import { JsonataReactorProcessor } from "./implementation.ts";
import type { StreamProcessorIterateContext } from "~/domains/streams/engine/stream-processor.ts";

describe("JsonataReactorProcessor", () => {
  it("appends configured reactions for matching events", async () => {
    const { stream, appended } = memoryStream();
    const processor = new JsonataReactorProcessor({ iterateContext: { stream } });

    await processor.ingest({
      events: [
        event({
          type: "events.iterate.com/jsonata-reactor/rule-configured",
          payload: {
            slug: "echo-pings",
            matcher: "type = 'events.iterate.com/test/ping'",
            reactions: [
              {
                type: "append-events",
                events: `{ "event": { "type": "events.iterate.com/test/pong", "payload": { "from": payload.from } } }`,
              },
            ],
          },
          offset: 1,
        }),
      ],
      streamMaxOffset: 1,
    });
    expect(appended).toEqual([]);

    await processor.ingest({
      events: [
        event({
          type: "events.iterate.com/test/ping",
          payload: { from: "test" },
          offset: 2,
        }),
      ],
      streamMaxOffset: 2,
    });

    expect(appended).toEqual([
      {
        event: {
          type: "events.iterate.com/test/pong",
          payload: { from: "test" },
        },
      },
    ]);
  });

  it("ignores events that do not match any rule", async () => {
    const { stream, appended } = memoryStream();
    const processor = new JsonataReactorProcessor({ iterateContext: { stream } });

    await processor.ingest({
      events: [
        event({
          type: "events.iterate.com/jsonata-reactor/rule-configured",
          payload: {
            slug: "echo-pings",
            matcher: "type = 'events.iterate.com/test/ping'",
            reactions: [],
          },
          offset: 1,
        }),
        event({ type: "events.iterate.com/test/other", payload: {}, offset: 2 }),
      ],
      streamMaxOffset: 2,
    });

    expect(appended).toEqual([]);
  });

  it("passes a rule-provided streamPath through to the append", async () => {
    const { stream, appended } = memoryStream();
    const processor = new JsonataReactorProcessor({ iterateContext: { stream } });

    await processor.ingest({
      events: [
        event({
          type: "events.iterate.com/jsonata-reactor/rule-configured",
          payload: {
            slug: "fan-out",
            matcher: "type = 'events.iterate.com/test/ping'",
            reactions: [
              {
                type: "append-events",
                events: `{ "streamPath": "/other", "event": { "type": "events.iterate.com/test/pong", "payload": {} } }`,
              },
            ],
          },
          offset: 1,
        }),
        event({ type: "events.iterate.com/test/ping", payload: {}, offset: 2 }),
      ],
      streamMaxOffset: 2,
    });

    expect(appended).toEqual([
      {
        streamPath: "/other",
        event: { type: "events.iterate.com/test/pong", payload: {} },
      },
    ]);
  });
});

function memoryStream() {
  let nextOffset = 100;
  const appended: { streamPath?: string; event: unknown }[] = [];
  const stream: StreamProcessorIterateContext["stream"] = {
    append: (args) => {
      appended.push(args as { streamPath?: string; event: unknown });
      const committed: StreamEvent = {
        ...args.event,
        offset: nextOffset++,
        createdAt: new Date(0).toISOString(),
      };
      return committed;
    },
    appendBatch: (args) =>
      args.events.map((input) => {
        appended.push({ event: input });
        const committed: StreamEvent = {
          ...input,
          offset: nextOffset++,
          createdAt: new Date(0).toISOString(),
        };
        return committed;
      }),
  };
  return { stream, appended };
}

function event(args: { type: string; payload: unknown; offset: number }): StreamEvent {
  return {
    type: args.type,
    payload: args.payload,
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
