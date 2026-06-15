import { describe, expect, it } from "vitest";
import type { StreamEvent } from "@iterate-com/shared/streams/stream-event";
import { ProjectConfigWorkerProcessor } from "./implementation.ts";

describe("ProjectConfigWorkerProcessor", () => {
  it("forwards every event to the config worker in stream order", async () => {
    const forwarded: string[] = [];
    const processor = newProcessor({
      forwardToConfigWorker: async (event) => {
        forwarded.push(`${event.offset}:${event.type}`);
      },
    });

    await processor.ingest({
      events: [
        event({ offset: 3, type: "events.iterate.com/stream/child-stream-created" }),
        event({ offset: 4, type: "events.iterate.com/project/created" }),
      ],
      streamMaxOffset: 4,
    });
    await processor.ingest({
      events: [event({ offset: 5, type: "some.custom/event" })],
      streamMaxOffset: 5,
    });

    expect(forwarded).toEqual([
      "3:events.iterate.com/stream/child-stream-created",
      "4:events.iterate.com/project/created",
      "5:some.custom/event",
    ]);
  });

  it("does not advance the checkpoint past a failed forward", async () => {
    let fail = true;
    const forwarded: number[] = [];
    const processor = newProcessor({
      forwardToConfigWorker: async (event) => {
        if (fail) throw new Error("config worker host hiccup");
        forwarded.push(event.offset);
      },
    });

    await expect(
      processor.ingest({ events: [event({ offset: 3, type: "t" })], streamMaxOffset: 3 }),
    ).rejects.toThrow("config worker host hiccup");
    expect(processor.checkpointOffset).toBe(0);

    // The replayed batch (at-least-once) delivers it.
    fail = false;
    await processor.ingest({ events: [event({ offset: 3, type: "t" })], streamMaxOffset: 3 });
    expect(forwarded).toEqual([3]);
    expect(processor.checkpointOffset).toBe(3);
  });
});

function newProcessor(deps: { forwardToConfigWorker: (event: StreamEvent) => Promise<void> }) {
  return new ProjectConfigWorkerProcessor({
    iterateContext: { stream: { append: () => {}, appendBatch: () => {} } },
    ...deps,
  });
}

function event(args: { offset: number; type: string }): StreamEvent {
  return {
    type: args.type,
    payload: {},
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
