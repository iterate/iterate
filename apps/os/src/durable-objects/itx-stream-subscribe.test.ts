// Proves the itx stream-subscribe chain against a REAL Stream Durable Object:
// test callback → Workers RPC → ItxStreamHarness (stand-in for the capnweb
// session) → ItxStream.subscribe → ctx.exports loopback → StreamsBackend
// .subscribe → Stream DO holds the wrapper. The key risk under test is
// lifetime: deliveries must keep arriving after every initiating RPC call has
// returned, for as long as the returned subscription handle is held.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import type { StreamCursor, Event as StreamEvent } from "@iterate-com/shared/streams/types";

const TEST_EVENT_TYPE = "test.iterate.com/itx-subscribe/marker";
// Must match the harness entrypoint's project id (itx-stream-subscribe-test-entry.ts).
const PROJECT_ID = "proj__test__itxsubscribe";

type StreamState = {
  namespace: string;
  path: string;
  eventCount: number;
  childPaths: string[];
  metadata: Record<string, unknown>;
};

type EventBatch = { events: StreamEvent[]; state: StreamState; streamMaxOffset: number };

type HarnessStub = {
  append(input: {
    path: string;
    event: { type: string; payload: Record<string, unknown> };
  }): Promise<StreamEvent>;
  appendOutsidePolicy(input: { path: string }): Promise<void>;
  getState(input: { path: string }): Promise<StreamState>;
  read(input: { path: string }): Promise<StreamEvent[]>;
  subscribe(
    input: { afterOffset: StreamCursor; events?: boolean; path: string },
    onEventBatch: (batch: EventBatch) => unknown,
  ): Promise<{ unsubscribe(): Promise<void> }>;
  onStateChange(
    input: { path: string },
    onState: (state: StreamState) => unknown,
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

  test("every batch carries the stream's public state — the exact getState shape", async () => {
    const path = newStreamPath();
    await harness.append({ path, event: markerEvent("seed") });

    const collector = createCollector();
    const subscription = await harness.subscribe(
      { afterOffset: "start", path },
      collector.onEventBatch,
    );
    await vi.waitFor(() => expect(collector.markers()).toEqual(["seed"]));

    // subscribe-state === getState: same projection, same shape, same values.
    const state = await harness.getState({ path });
    const batchState = collector.batches.at(-1)!.state;
    expect(batchState).toEqual(state);
    expect(Object.keys(batchState).sort()).toEqual([
      "childPaths",
      "eventCount",
      "metadata",
      "namespace",
      "path",
    ]);

    await subscription.unsubscribe();
  });

  test("a live-only subscription immediately delivers an initial state batch", async () => {
    const path = newStreamPath();
    await harness.append({ path, event: markerEvent("pre") });

    const collector = createCollector();
    const subscription = await harness.subscribe(
      { afterOffset: "end", path },
      collector.onEventBatch,
    );

    // No append after subscribing — the initial push alone must arrive, so a
    // subscriber can paint its first render without a separate getState call.
    // (The subscribe itself appends a subscriber-connected presence fact,
    // which may ride the first batch or follow it; nothing older arrives.)
    await vi.waitFor(() => expect(collector.batches.length).toBeGreaterThanOrEqual(1));
    expect(
      collector.batches[0]!.events.every(
        (event) => event.type === "events.iterate.com/stream/subscriber-connected",
      ),
    ).toBe(true);
    // created + woken + "pre" are already committed.
    expect(collector.batches[0]!.state.eventCount).toBeGreaterThanOrEqual(3);
    expect(collector.batches[0]!.streamMaxOffset).toBeGreaterThanOrEqual(3);

    await subscription.unsubscribe();
  });

  test("events: false delivers state-only batches: initial state, then state after appends", async () => {
    const path = newStreamPath();
    const collector = createCollector();
    const subscription = await harness.subscribe(
      // afterOffset is ignored in state-only mode (implicitly live-from-now).
      { afterOffset: "start", events: false, path },
      collector.onEventBatch,
    );

    await vi.waitFor(() => expect(collector.batches.length).toBeGreaterThanOrEqual(1));
    expect(collector.batches[0]!.events).toEqual([]);
    const initialEventCount = collector.batches[0]!.state.eventCount;

    await harness.append({ path, event: markerEvent("bump") });
    await vi.waitFor(() =>
      expect(collector.batches.at(-1)!.state.eventCount).toBeGreaterThan(initialEventCount),
    );
    // Despite afterOffset "start", no events are ever delivered.
    expect(collector.batches.every((batch) => batch.events.length === 0)).toBe(true);

    await subscription.unsubscribe();
  });

  test("onStateChange pushes the current state immediately, then after every append", async () => {
    const path = newStreamPath();
    await harness.append({ path, event: markerEvent("first") });

    const states: StreamState[] = [];
    const subscription = await harness.onStateChange({ path }, (state) => {
      states.push(state);
    });

    await vi.waitFor(() => expect(states.length).toBeGreaterThanOrEqual(1));
    const initial = states[0]!;
    expect(initial.namespace).toBe(PROJECT_ID);
    expect(initial.path).toBe(path);
    const initialEventCount = initial.eventCount;

    await harness.append({ path, event: markerEvent("second") });
    await vi.waitFor(() => expect(states.at(-1)!.eventCount).toBeGreaterThan(initialEventCount));

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

describe("itx errors across real Workers RPC boundaries", () => {
  test("an ItxError's code and details survive the loopback and harness hops", async () => {
    const path = newStreamPath();
    // The append-policy FORBIDDEN is thrown inside StreamsBackend, crosses
    // the ctx.exports loopback into the harness entrypoint, then the harness
    // RPC boundary into this test — two real Workers RPC serializations.
    const error = await harness.appendOutsidePolicy({ path }).then(
      () => null,
      (thrown: unknown) => thrown as Error & { code?: unknown; details?: unknown },
    );

    expect(error).not.toBeNull();
    expect(error!.name).toBe("ItxError");
    expect(error!.code).toBe("FORBIDDEN");
    expect(error!.details).toEqual({ path, policyMode: "none" });
  });
});

describe("stream child paths against a real Stream Durable Object", () => {
  test("child stream creation records immediate child paths", async () => {
    const base = `/list-tests/${crypto.randomUUID()}`;
    for (const path of [`${base}/a`, `${base}/a/b`, `${base}/c`]) {
      await harness.append({ path, event: markerEvent("seed") });
    }

    // Ancestor announcements (and the intermediate streams they create) are
    // fire-and-forget background appends, so poll until they all land.
    await vi.waitFor(
      async () => {
        await expect(harness.getState({ path: "/" })).resolves.toMatchObject({
          childPaths: expect.arrayContaining(["/list-tests"]),
        });
        await expect(harness.getState({ path: "/list-tests" })).resolves.toMatchObject({
          childPaths: expect.arrayContaining([base]),
        });
        await expect(harness.getState({ path: base })).resolves.toMatchObject({
          childPaths: expect.arrayContaining([`${base}/a`, `${base}/c`]),
        });
        await expect(harness.getState({ path: `${base}/a` })).resolves.toMatchObject({
          childPaths: expect.arrayContaining([`${base}/a/b`]),
        });
      },
      { timeout: 10_000 },
    );
  });

  test("a root persisted with obsolete descendantPaths is rebuilt without it", async () => {
    const base = `/migration-tests/${crypto.randomUUID()}`;
    await harness.append({ path: `${base}/a/b`, event: markerEvent("seed") });
    await vi.waitFor(
      async () => {
        await expect(harness.getState({ path: "/" })).resolves.toMatchObject({
          childPaths: expect.arrayContaining(["/migration-tests"]),
        });
        await expect(harness.getState({ path: "/migration-tests" })).resolves.toMatchObject({
          childPaths: expect.arrayContaining([base]),
        });
        await expect(harness.getState({ path: base })).resolves.toMatchObject({
          childPaths: expect.arrayContaining([`${base}/a`]),
        });
        await expect(harness.getState({ path: `${base}/a` })).resolves.toMatchObject({
          childPaths: expect.arrayContaining([`${base}/a/b`]),
        });
      },
      { timeout: 10_000 },
    );

    const streamNamespace = (env as unknown as { STREAM: DurableObjectNamespace }).STREAM;
    const rootStub = streamNamespace.getByName(`${PROJECT_ID}:/`);
    await runInDurableObject(rootStub, async (_instance, state) => {
      const stored = state.storage.kv.get<Record<string, unknown>>("state");
      if (stored === undefined) throw new Error("expected persisted root stream state");
      state.storage.kv.put("state", {
        ...stored,
        descendantPaths: [base, `${base}/a`, `${base}/a/b`],
      });
      state.storage.kv.put("stateVersion", 2);
    });
    // Abort the current incarnation so the next call re-runs the constructor's
    // read-persisted-state path against the stale storage. The abort makes
    // the kill() RPC itself reject; that is expected.
    await (rootStub as unknown as { kill(): Promise<void> }).kill().catch(() => {});

    const rewokenRootStub = streamNamespace.getByName(`${PROJECT_ID}:/`);
    await vi.waitFor(async () => {
      const runtimeState = await (
        rewokenRootStub as unknown as {
          runtimeState(): Promise<{ coreProcessorState: Record<string, unknown> }>;
        }
      ).runtimeState();
      expect(runtimeState.coreProcessorState).not.toHaveProperty("descendantPaths");
    });

    // The rewoken root sees the version mismatch, replays its event log, and
    // keeps only immediate child paths.
    await expect(harness.getState({ path: "/" })).resolves.toMatchObject({
      childPaths: expect.arrayContaining(["/migration-tests"]),
    });
    await expect(harness.getState({ path: "/migration-tests" })).resolves.toMatchObject({
      childPaths: expect.arrayContaining([base]),
    });
    await expect(harness.getState({ path: base })).resolves.toMatchObject({
      childPaths: expect.arrayContaining([`${base}/a`]),
    });
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
