// These tests use real StreamProcessor subclasses and StreamProcessorRunners
// over an in-memory stream. They verify the browser's exact behavior: request
// replay from the smallest checkpoint, call processors in order, preserve
// earlier commits when a later processor rejects, and announce one combined
// callback contract to the server.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import type { StreamEvent } from "iterate/processors";
import { StreamProcessor } from "iterate/processors";
import {
  StreamProcessorRunner,
  type ProcessorProgress,
  type ProcessorProgressStore,
} from "iterate/processors";
import { MemoryStream } from "iterate/processors/testing";
import { BrowserStreamProcessorGroup } from "./browser-stream-processor-group.ts";

const PROCESSOR_VERSION = "0.1.0";

function delivery(
  stream: MemoryStream,
  events: StreamEvent[],
  args: {
    scannedAfterOffset?: number;
    scannedThroughOffset?: number;
    streamMaxOffset?: number;
  } = {},
) {
  const scannedAfterOffset = args.scannedAfterOffset ?? 0;
  const scannedThroughOffset =
    args.scannedThroughOffset ?? events.at(-1)?.offset ?? scannedAfterOffset;
  return {
    streamId: stream.streamId,
    events,
    scannedAfterOffset,
    scannedThroughOffset,
    streamMaxOffset: args.streamMaxOffset ?? scannedThroughOffset,
  };
}

/** A pre-seedable in-memory progress store (the browser store's stand-in). */
function memoryProgress(
  streamId: string,
  initialAcknowledgedOffset = 0,
): ProcessorProgressStore<Record<string, never>> {
  let record: ProcessorProgress<Record<string, never>> | undefined =
    initialAcknowledgedOffset === 0
      ? undefined
      : {
          streamId,
          reduction: {
            reducerVersion: PROCESSOR_VERSION,
            reducedThroughOffset: initialAcknowledgedOffset,
            state: {},
          },
          processing: {
            acknowledgedThroughOffset: initialAcknowledgedOffset,
            cursorRevision: 0,
          },
        };
  return {
    read: () => record,
    commit: (progress, opts) => {
      if (opts.expectedStreamId !== record?.streamId) {
        throw new Error("progress commit fenced: stale streamId");
      }
      const revision = record?.processing.cursorRevision ?? 0;
      if (opts.expectedCursorRevision !== revision) {
        throw new Error("progress commit fenced: stale cursorRevision");
      }
      record = progress;
    },
  };
}

// A minimal processor that records applied offsets and can reject at one
// offset. The shared order array makes cross-processor call order observable.
function makeProcessor(
  slug: string,
  stream: MemoryStream,
  opts: { order?: string[]; ack?: number } = {},
) {
  const contract = defineProcessorContract({
    slug,
    version: PROCESSOR_VERSION,
    description: `stub ${slug}`,
    stateSchema: z.object({}),
    events: {},
    consumes: ["*"],
    emits: [],
  });
  const applied: number[] = [];
  const behavior = { throwAtOffset: undefined as number | undefined };
  class TestProcessor extends StreamProcessor<typeof contract> {
    readonly contract = contract;
    protected override processEvent({
      event,
    }: Parameters<StreamProcessor<typeof contract>["processEvent"]>[0]): undefined {
      if (event === null) return;
      opts.order?.push(slug);
      applied.push(event.offset);
      if (behavior.throwAtOffset === event.offset) {
        throw new Error(`${slug} apply failed`);
      }
    }
  }
  const processor = new TestProcessor({ stream, path: stream.path, projectId: null });
  const runner = new StreamProcessorRunner({
    processor,
    stream,
    durability: { progress: memoryProgress(stream.streamId, opts.ack ?? 0) },
  });
  return { entry: { slug, processor, runner }, applied, behavior, processor };
}

describe("BrowserStreamProcessorGroup", () => {
  it("requires at least one processor", () => {
    expect(() => new BrowserStreamProcessorGroup([])).toThrow(/at least one processor/);
  });

  it("asks the server to replay after the smallest processor checkpoint", async () => {
    const stream = new MemoryStream();
    const raw = makeProcessor("browser-raw-events", stream, { ack: 5000 });
    const feed = makeProcessor("browser-feed", stream, { ack: 0 });
    const group = new BrowserStreamProcessorGroup([raw.entry, feed.entry]);
    expect((await group.openEventBatchCallback()).checkpointOffset).toBe(0);
    expect((await group.snapshot()).offset).toBe(0);
  });

  it("calls every processor in configured order", async () => {
    const stream = new MemoryStream();
    const order: string[] = [];
    const raw = makeProcessor("browser-raw-events", stream, { order });
    const feed = makeProcessor("browser-feed", stream, { order });
    const group = new BrowserStreamProcessorGroup([raw.entry, feed.entry]);
    const [event] = await stream.append({ type: "example.com/test", payload: {} });
    const opened = await group.openEventBatchCallback();
    await opened.processEventBatch(delivery(stream, [event!]));
    expect(order).toEqual(["browser-raw-events", "browser-feed"]);
    expect(raw.applied).toEqual([1]);
    expect(feed.applied).toEqual([1]);
  });

  it("keeps an earlier processor's commit when a later processor rejects and skips that earlier processor on replay", async () => {
    const stream = new MemoryStream();
    const order: string[] = [];
    const raw = makeProcessor("browser-raw-events", stream, { order });
    const feed = makeProcessor("browser-feed", stream, { order });
    const group = new BrowserStreamProcessorGroup([raw.entry, feed.entry]);
    const [event] = await stream.append({ type: "example.com/test", payload: {} });
    const batch = delivery(stream, [event!]);

    feed.behavior.throwAtOffset = event!.offset;
    const opened = await group.openEventBatchCallback();
    // The raw-event processor commits before the feed processor rejects.
    await expect(opened.processEventBatch(batch)).rejects.toThrow(/browser-feed apply failed/);
    expect(order).toEqual(["browser-raw-events", "browser-feed"]);

    // On replay, the raw-event runner ignores the offset it already committed;
    // the feed runner processes it because its failed transaction did not
    // advance its acknowledged offset.
    feed.behavior.throwAtOffset = undefined;
    await opened.processEventBatch(batch);
    expect(raw.applied).toEqual([1]);
    expect(feed.applied).toEqual([1, 1]);
  });

  it("does not make each processor download the remainder of a byte-limited callback batch", async () => {
    const stream = new MemoryStream();
    const getEventPage = vi.spyOn(stream, "getEventPage");
    const raw = makeProcessor("browser-raw-events", stream);
    const feed = makeProcessor("browser-feed", stream);
    const group = new BrowserStreamProcessorGroup([raw.entry, feed.entry]);
    const [first, second] = await stream.append(
      { type: "example.com/test", payload: {} },
      { type: "example.com/test", payload: {} },
    );

    const opened = await group.openEventBatchCallback();
    getEventPage.mockClear();
    // The callback sends only offset 1 in this byte-limited batch while
    // reporting that the stream already contains offset 2.
    await opened.processEventBatch(
      delivery(stream, [first!], {
        scannedThroughOffset: first!.offset,
        streamMaxOffset: second!.offset,
      }),
    );
    // Give any queued Stream.getEvents calls time to run. Neither processor
    // should read offset 2 because the same callback sends it next.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getEventPage).not.toHaveBeenCalled();
    expect(raw.applied).toEqual([1]);
    expect(feed.applied).toEqual([1]);

    // Offset 2 arrives in the callback's next batch.
    await opened.processEventBatch(
      delivery(stream, [second!], {
        scannedAfterOffset: first!.offset,
        scannedThroughOffset: second!.offset,
      }),
    );
    expect(raw.applied).toEqual([1, 2]);
    expect(feed.applied).toEqual([1, 2]);
  });

  it("makes every processor read missing durable events after an empty callback batch", async () => {
    const stream = new MemoryStream();
    const getEventPage = vi.spyOn(stream, "getEventPage");
    const raw = makeProcessor("browser-raw-events", stream);
    const feed = makeProcessor("browser-feed", stream);
    const group = new BrowserStreamProcessorGroup([raw.entry, feed.entry]);
    await stream.append(
      { type: "example.com/test", payload: {} },
      { type: "example.com/test", payload: {} },
    );

    const opened = await group.openEventBatchCallback();
    getEventPage.mockClear();
    await opened.processEventBatch(
      delivery(stream, [], { scannedThroughOffset: 0, streamMaxOffset: 2 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getEventPage).toHaveBeenCalledTimes(2);
    expect(raw.applied).toEqual([1, 2]);
    expect(feed.applied).toEqual([1, 2]);
  });

  it("reports event-consumption metrics from the first processor", () => {
    const stream = new MemoryStream();
    const raw = makeProcessor("browser-raw-events", stream);
    const feed = makeProcessor("browser-feed", stream);
    const group = new BrowserStreamProcessorGroup([raw.entry, feed.entry]);
    expect(group.eventConsumptionMetrics).toBe(raw.processor.eventConsumptionMetrics);
    expect(group.eventConsumptionMetrics).not.toBe(feed.processor.eventConsumptionMetrics);
  });

  it("announces one callback contract containing every processor's consumed event types", () => {
    const stream = new MemoryStream();
    const raw = makeProcessor("browser-raw-events", stream);
    const feed = makeProcessor("browser-feed", stream);
    const group = new BrowserStreamProcessorGroup([raw.entry, feed.entry]);
    expect(group.contract.slug).toBe("browser-stream-processors");
    expect(group.contract.consumes).toEqual(["*"]);
    expect(group.contract.emits).toEqual([]);
  });
});
