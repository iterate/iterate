// Proves the itx stream-subscribe chain against a REAL Stream Durable Object:
// test callback → Workers RPC → ItxStreamHarness (stand-in for the capnweb
// session) → ItxStream.subscribe → ctx.exports loopback → StreamsCapability
// .subscribe → Stream DO holds the wrapper. The key risk under test is
// lifetime: deliveries must keep arriving after every initiating RPC call has
// returned, for as long as the returned subscription handle is held.
import { env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import type { StreamCursor, Event as StreamEvent } from "@iterate-com/shared/streams/types";

const TEST_EVENT_TYPE = "test.iterate.com/itx-subscribe/marker";

type EventBatch = { events: StreamEvent[]; streamMaxOffset: number };

type HarnessStub = {
  append(input: {
    path: string;
    event: { type: string; payload: Record<string, unknown> };
  }): Promise<StreamEvent>;
  read(input: { path: string }): Promise<StreamEvent[]>;
  subscribe(
    input: { afterOffset: StreamCursor; path: string },
    onEventBatch: (batch: EventBatch) => unknown,
  ): Promise<{ unsubscribe(): Promise<void> }>;
};

const harness = (env as unknown as { HARNESS: HarnessStub }).HARNESS;

describe("itx stream subscribe against a real Stream Durable Object", () => {
  test("afterOffset 'start' replays history, then delivers live appends", async () => {
    const path = newStreamPath();
    await harness.append({ path, event: markerEvent("one") });
    await harness.append({ path, event: markerEvent("two") });

    const collector = createCollector();
    const subscription = await harness.subscribe(
      { afterOffset: "start", path },
      collector.onEventBatch,
    );

    await vi.waitFor(() => expect(collector.markers()).toEqual(["one", "two"]));

    await harness.append({ path, event: markerEvent("three") });
    await vi.waitFor(() => expect(collector.markers()).toEqual(["one", "two", "three"]));

    await subscription.unsubscribe();
  });

  test("afterOffset 'end' is live-only: pre-subscribe events are never replayed", async () => {
    const path = newStreamPath();
    await harness.append({ path, event: markerEvent("before") });

    const collector = createCollector();
    const subscription = await harness.subscribe(
      { afterOffset: "end", path },
      collector.onEventBatch,
    );

    await harness.append({ path, event: markerEvent("after") });
    // "after" has a higher offset than "before", so once it arrives, a buggy
    // replay would already have delivered "before" ahead of it.
    await vi.waitFor(() => expect(collector.markers()).toContain("after"));
    expect(collector.markers()).toEqual(["after"]);

    await subscription.unsubscribe();
  });

  test("numeric afterOffset replays only events after that offset", async () => {
    const path = newStreamPath();
    await harness.append({ path, event: markerEvent("one") });
    const second = await harness.append({ path, event: markerEvent("two") });
    await harness.append({ path, event: markerEvent("three") });

    const collector = createCollector();
    const subscription = await harness.subscribe(
      { afterOffset: second.offset, path },
      collector.onEventBatch,
    );

    await vi.waitFor(() => expect(collector.markers()).toEqual(["three"]));

    await harness.append({ path, event: markerEvent("four") });
    await vi.waitFor(() => expect(collector.markers()).toEqual(["three", "four"]));

    await subscription.unsubscribe();
  });

  test("unsubscribe() stops delivery of further appends", async () => {
    const path = newStreamPath();
    const collector = createCollector();
    const subscription = await harness.subscribe(
      { afterOffset: "end", path },
      collector.onEventBatch,
    );

    await harness.append({ path, event: markerEvent("delivered") });
    await vi.waitFor(() => expect(collector.markers()).toEqual(["delivered"]));

    await subscription.unsubscribe();
    await settle();

    await harness.append({ path, event: markerEvent("dropped") });
    await settle();
    expect(collector.markers()).toEqual(["delivered"]);
  });

  test("the callback chain survives long past the initiating RPC call", async () => {
    const path = newStreamPath();
    const collector = createCollector();
    const subscription = await harness.subscribe(
      { afterOffset: "end", path },
      collector.onEventBatch,
    );

    // Three separate live batches with real time between them. Every RPC call
    // that set the subscription up has long since returned; if any wrapper in
    // the chain was disposed with its originating call, delivery stops here.
    for (const [index, marker] of ["live-1", "live-2", "live-3"].entries()) {
      await settle(500);
      await harness.append({ path, event: markerEvent(marker) });
      await vi.waitFor(() => expect(collector.markers()).toHaveLength(index + 1));
    }

    expect(collector.markers()).toEqual(["live-1", "live-2", "live-3"]);
    // Spaced appends past catch-up arrive as separate pump batches, proving
    // repeated independent deliveries rather than one replay batch.
    expect(collector.batches.length).toBeGreaterThanOrEqual(2);

    await subscription.unsubscribe();
  });

  test("a throwing callback tears the subscription down without crashing the worker", async () => {
    const path = newStreamPath();
    let deliveries = 0;
    // workerd logs the throw below as an uncaught exception on the callee
    // side ("uncaught exception; source = Uncaught"); that's expected output,
    // not a failure — the caller (the capability's delivery closure) catches
    // it and tears the subscription down.
    await harness.subscribe({ afterOffset: "end", path }, () => {
      deliveries += 1;
      throw new Error("subscriber exploded");
    });

    await harness.append({ path, event: markerEvent("boom") });
    await vi.waitFor(() => expect(deliveries).toBeGreaterThanOrEqual(1));
    // Give the broken-callback teardown time to land in the capability.
    await settle();

    const deliveriesAfterTeardown = deliveries;
    await harness.append({ path, event: markerEvent("after-boom") });
    await settle();
    expect(deliveries).toBe(deliveriesAfterTeardown);

    // The worker (and the stream) survived: both appends were committed.
    const events = await harness.read({ path });
    expect(markersOf(events)).toEqual(["boom", "after-boom"]);
  });
});

function newStreamPath() {
  return `/itx-subscribe-tests/${crypto.randomUUID()}`;
}

function markerEvent(marker: string) {
  return { type: TEST_EVENT_TYPE, payload: { marker } };
}

function markersOf(events: StreamEvent[]) {
  return events
    .filter((event) => event.type === TEST_EVENT_TYPE)
    .map((event) => (event.payload as { marker: string }).marker);
}

function createCollector() {
  const batches: EventBatch[] = [];
  return {
    batches,
    markers: () => markersOf(batches.flatMap((batch) => batch.events)),
    onEventBatch: (batch: EventBatch) => {
      batches.push(batch);
    },
  };
}

function settle(ms = 750) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
