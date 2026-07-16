// The composite mirror drive's executable contract, ported from the legacy
// CompositeBrowserProcessor test to REAL runner drive: members are genuine
// StreamProcessor subclasses driven by genuine StreamProcessorRunners over an
// in-memory journal, so what these tests pin is exactly what the browser
// runtime runs — min-checkpoint replay, canonical fan-out order, failure
// propagation with ahead-member dedupe on replay, primary metrics delegation,
// and the synthetic union contract.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineProcessorContract } from "../../processor-contracts.ts";
import type { StreamEvent } from "../../schemas.ts";
import { StreamProcessor } from "../../stream-processor.ts";
import {
  StreamProcessorRunner,
  type ProcessorProgress,
  type ProcessorProgressStore,
} from "../../stream-processor-runner.ts";
import { MemoryStream } from "../../test-helpers.ts";
import { CompositeMirrorDrive } from "./composite-mirror-drive.ts";

const MEMBER_VERSION = "0.1.0";

function delivery(
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
    events,
    scannedAfterOffset,
    scannedThroughOffset,
    streamMaxOffset: args.streamMaxOffset ?? scannedThroughOffset,
  };
}

/** A pre-seedable in-memory progress store (the browser store's stand-in). */
function memoryProgress(initialAck = 0): ProcessorProgressStore<Record<string, never>> {
  let record: ProcessorProgress<Record<string, never>> | undefined =
    initialAck === 0
      ? undefined
      : {
          reduction: {
            reducerVersion: MEMBER_VERSION,
            reducedThroughOffset: initialAck,
            state: {},
          },
          processing: { acknowledgedThroughOffset: initialAck, cursorRevision: 0 },
        };
  return {
    read: () => record,
    commit: (progress, opts) => {
      const revision = record?.processing.cursorRevision ?? 0;
      if (opts.expectedCursorRevision !== revision) {
        throw new Error("progress commit fenced: stale cursorRevision");
      }
      record = progress;
    },
  };
}

// A minimal canonical member: records which offsets its processEvent applied
// (into a shared order log so cross-member ordering is observable) and can be
// told to throw at an offset to exercise the fan-out failure path.
function makeMember(
  slug: string,
  stream: MemoryStream,
  opts: { order?: string[]; ack?: number } = {},
) {
  const contract = defineProcessorContract({
    slug,
    version: MEMBER_VERSION,
    description: `stub ${slug}`,
    stateSchema: z.object({}),
    events: {},
    consumes: ["*"],
    emits: [],
  });
  const applied: number[] = [];
  const behavior = { throwAtOffset: undefined as number | undefined };
  class Member extends StreamProcessor<typeof contract> {
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
  const processor = new Member({ stream, path: stream.path, projectId: null });
  const runner = new StreamProcessorRunner({
    processor,
    stream,
    durability: { progress: memoryProgress(opts.ack ?? 0) },
  });
  return { member: { slug, processor, runner }, applied, behavior, processor };
}

describe("CompositeMirrorDrive", () => {
  it("requires at least one member", () => {
    expect(() => new CompositeMirrorDrive([])).toThrow(/at least one member/);
  });

  it("reports the MINIMUM member checkpoint as the replay cursor", async () => {
    const stream = new MemoryStream();
    const raw = makeMember("browser-raw-events", stream, { ack: 5000 });
    const feed = makeMember("browser-feed", stream, { ack: 0 });
    const composite = new CompositeMirrorDrive([raw.member, feed.member]);
    // Both the wake-handshake cursor and the published snapshot carry the
    // minimum, so replay covers the least-caught-up member.
    expect((await composite.openDelivery()).checkpointOffset).toBe(0);
    expect((await composite.snapshot()).offset).toBe(0);
  });

  it("fans a frame out to every member in canonical order (primary first)", async () => {
    const stream = new MemoryStream();
    const order: string[] = [];
    const raw = makeMember("browser-raw-events", stream, { order });
    const feed = makeMember("browser-feed", stream, { order });
    const composite = new CompositeMirrorDrive([raw.member, feed.member]);
    const [event] = await stream.append({ type: "example.com/test", payload: {} });
    const opened = await composite.openDelivery();
    await opened.sink(delivery([event!]));
    expect(order).toEqual(["browser-raw-events", "browser-feed"]);
    expect(raw.applied).toEqual([1]);
    expect(feed.applied).toEqual([1]);
  });

  it("propagates a later member's failure after the earlier member committed; the replay dedupes for the ahead member", async () => {
    const stream = new MemoryStream();
    const order: string[] = [];
    const raw = makeMember("browser-raw-events", stream, { order });
    const feed = makeMember("browser-feed", stream, { order });
    const composite = new CompositeMirrorDrive([raw.member, feed.member]);
    const [event] = await stream.append({ type: "example.com/test", payload: {} });
    const frame = delivery([event!]);

    feed.behavior.throwAtOffset = event!.offset;
    const opened = await composite.openDelivery();
    // The primary still ran (and committed its own cursor) before the
    // failure propagated — the runtime self-heals by resubscribing from the
    // new minimum checkpoint.
    await expect(opened.sink(frame)).rejects.toThrow(/browser-feed apply failed/);
    expect(order).toEqual(["browser-raw-events", "browser-feed"]);

    // The healed replay: the ahead member's runner offset-dedupes the
    // redelivered frame (its processEvent never re-runs), while the failed
    // member — whose cursor never advanced — applies it now.
    feed.behavior.throwAtOffset = undefined;
    await opened.sink(frame);
    expect(raw.applied).toEqual([1]);
    expect(feed.applied).toEqual([1, 1]);
  });

  it("re-stamps fanned frames at their own tail so no member self-pulls a byte-capped frame's remainder", async () => {
    const stream = new MemoryStream();
    const readEvents = vi.spyOn(stream, "readEvents");
    const raw = makeMember("browser-raw-events", stream);
    const feed = makeMember("browser-feed", stream);
    const composite = new CompositeMirrorDrive([raw.member, feed.member]);
    const [first, second] = await stream.append(
      { type: "example.com/test", payload: {} },
      { type: "example.com/test", payload: {} },
    );

    const opened = await composite.openDelivery();
    // A byte-capped frame: it carries only offset 1 but is stamped with the
    // full raw head (offset 2), exactly like the server pump's capped frames.
    await opened.sink(
      delivery([first!], { scannedThroughOffset: first!.offset, streamMaxOffset: second!.offset }),
    );
    // Flush the runners' trailing background lane. Pre-fix, EACH member saw
    // its acknowledged cursor behind the stamped head and self-pulled the
    // tail over the network — on top of the server pump, which delivers that
    // same tail anyway, the one download crossed the wire up to three times.
    // Browser members have no onCaughtUp, so the self-pull bought nothing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readEvents).not.toHaveBeenCalled();
    expect(raw.applied).toEqual([1]);
    expect(feed.applied).toEqual([1]);

    // The tail still arrives through the single server subscription.
    await opened.sink(
      delivery([second!], {
        scannedAfterOffset: first!.offset,
        scannedThroughOffset: second!.offset,
      }),
    );
    expect(raw.applied).toEqual([1, 2]);
    expect(feed.applied).toEqual([1, 2]);
  });

  it("delegates subscriber metrics to the primary (first) member", () => {
    const stream = new MemoryStream();
    const raw = makeMember("browser-raw-events", stream);
    const feed = makeMember("browser-feed", stream);
    const composite = new CompositeMirrorDrive([raw.member, feed.member]);
    expect(composite.subscriberMetrics).toBe(raw.processor.subscriberMetrics);
    expect(composite.subscriberMetrics).not.toBe(feed.processor.subscriberMetrics);
  });

  it("announces a synthetic mirror contract with the union of members' consumes", () => {
    const stream = new MemoryStream();
    const raw = makeMember("browser-raw-events", stream);
    const feed = makeMember("browser-feed", stream);
    const composite = new CompositeMirrorDrive([raw.member, feed.member]);
    expect(composite.contract.slug).toBe("browser-stream-mirror");
    expect(composite.contract.consumes).toEqual(["*"]);
    expect(composite.contract.emits).toEqual([]);
  });
});
