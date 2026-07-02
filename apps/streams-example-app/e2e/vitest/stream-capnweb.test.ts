import { RpcTarget } from "capnweb";
import { describe, expect, it } from "vitest";
import { e2eStreamPath, e2eStreamPathLabel, toStreamWebSocketUrl } from "../helpers.ts";
import { withStreamConnectionFromBrowser } from "../../src/lib/stream-rpc.ts";
import { withStreamConnectionFromNode } from "../../src/lib/node-stream-connection.ts";
import type { WebSocketFrame } from "../../src/lib/stream-connection.ts";
import type { StreamEvent, StreamEventInput } from "~/types.ts";

const e2eIt = process.env.STREAM_STAGING_E2E === "true" ? it : it.skip;
const e2eItFails = process.env.STREAM_STAGING_E2E === "true" ? it.fails : it.skip;

class TestSubscriptionCallback extends RpcTarget {
  readonly batches: StreamEvent[][] = [];

  /** All delivered events, flattened — initial/state-only batches are empty. */
  get events(): StreamEvent[] {
    return this.batches.flat();
  }

  processEventBatch(args: { events: StreamEvent[]; streamMaxOffset: number }): undefined {
    this.batches.push(args.events);
  }
}

describe("stream capnweb protocol", () => {
  e2eIt("browser client appends events by stream URL", async () => {
    const path = e2eStreamPathLabel("stream-browser-client");
    await using stream = await withStreamConnectionFromBrowser({
      url: toStreamWebSocketUrl({ path }),
    });

    const [appended] = await stream.stream.append({
      type: "test.stream.browser-client",
      payload: { path },
    });

    expect(appended).toMatchObject({
      type: "test.stream.browser-client",
      payload: { path },
      offset: 3,
      createdAt: expect.any(String),
    });
  });

  e2eIt("appends events after the stream-created event over capnweb @preview", async () => {
    const path = e2eStreamPathLabel("stream-capnweb-append");
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });

    const [appended] = await stream.stream.append({
      type: "test.stream.capnweb-append",
      payload: { path },
    });

    expect(appended).toMatchObject({
      type: "test.stream.capnweb-append",
      payload: { path },
      offset: 3,
      createdAt: expect.any(String),
    });
  });

  e2eIt("appends, reads, and keeps running after event rows larger than 2 MiB", async () => {
    const path = e2eStreamPathLabel("stream-capnweb-large-row");
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });
    // Large enough to exceed the old single-row SQLite target and span multiple
    // storage chunks. Keep this below Cloudflare's 32 MiB inbound WebSocket frame
    // ceiling: that limit applies to client append calls, while stream-to-sink
    // `processEventBatch` fan-out can still deliver larger events once stored.
    const body = "x".repeat(2 * 1024 * 1024 + 256 * 1024);
    const event: StreamEventInput = {
      type: "test.stream.capnweb-large-row",
      payload: { body },
    };

    expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeGreaterThan(2 * 1024 * 1024);

    const [appended] = await stream.stream.append(event);
    if (appended === undefined) throw new Error("append returned no event");
    expect(appended).toMatchObject({
      type: "test.stream.capnweb-large-row",
      offset: 3,
      createdAt: expect.any(String),
    });
    expectLargePayload(appended, body.length);

    const byOffset = await stream.stream.getEvent({ offset: appended.offset });
    if (byOffset === undefined) throw new Error("large event was not readable by offset");
    expect(byOffset.offset).toBe(appended.offset);
    expectLargePayload(byOffset, body.length);

    const events = await stream.stream.getEvents({ afterOffset: appended.offset - 1, limit: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]?.offset).toBe(appended.offset);
    expectLargePayload(events[0], body.length);

    const [afterLargeRow] = await stream.stream.append({
      type: "test.stream.capnweb-after-large-row",
      payload: { path },
    });
    expect(afterLargeRow).toMatchObject({
      type: "test.stream.capnweb-after-large-row",
      offset: appended.offset + 1,
      payload: { path },
    });
  });

  e2eItFails(
    "documents Cloudflare's 32 MiB inbound WebSocket frame ceiling for capnweb appends",
    async () => {
      const path = e2eStreamPathLabel("stream-capnweb-inbound-frame-limit");
      using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });
      const event: StreamEventInput = {
        type: "test.stream.capnweb-inbound-frame-limit",
        payload: { body: "x".repeat(32 * 1024 * 1024) },
      };

      expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeGreaterThan(32 * 1024 * 1024);

      // This is expected to fail before stream storage sees the event: Cloudflare
      // accepts inbound WebSocket messages up to 32 MiB, and capnweb serializes
      // a single append call into one WebSocket message.
      await stream.stream.append(event);
    },
  );

  // Cross-stream appends now go through the public `Stream.at(relativePath)`
  // capability. These prove path resolution lands on the same leading-slash DO
  // coordinates a direct reader connects to.
  e2eIt('at() resolves relative child paths ("child" and "./child")', async () => {
    const base = e2eStreamPathLabel("e2e/resolve-child");
    using parent = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path: base }) });

    const [viaBare] = await parent.stream
      .at("child")
      .append({ type: "test.stream.resolve", payload: { kind: "bare" } });
    const [viaDot] = await parent.stream
      .at("./child")
      .append({ type: "test.stream.resolve", payload: { kind: "dot" } });

    // Both forms resolve to the same `${base}/child` stream the reader connects to.
    using child = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl({ path: `${base}/child` }),
    });
    const events = await child.stream.getEvents({ afterOffset: 0 });
    expect(events).toContainEqual(viaBare);
    expect(events).toContainEqual(viaDot);
    expect(viaBare?.offset).not.toBe(viaDot?.offset);

    // Nothing leaked into the parent (the child's created announcement is the
    // only parent-side trace, and it is a stream/child-stream-created fact).
    const parentEvents = await parent.stream.getEvents({ afterOffset: 0 });
    expect(parentEvents.some((event) => event.type === "test.stream.resolve")).toBe(false);
  });

  e2eIt("at() resolves an absolute /root/path", async () => {
    const unique = crypto.randomUUID();
    const base = e2eStreamPath(`/e2e/resolve-abs-${unique}`);
    const target = e2eStreamPath(`/e2e/resolve-abs-target-${unique}`);
    using parent = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path: base }) });

    const [appended] = await parent.stream
      .at(target)
      .append({ type: "test.stream.resolve", payload: { kind: "absolute" } });

    using targetStream = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl({ path: target }),
    });
    await expect(targetStream.stream.getEvents({ afterOffset: 0 })).resolves.toContainEqual(
      appended,
    );
    const parentEvents = await parent.stream.getEvents({ afterOffset: 0 });
    expect(parentEvents.some((event) => event.type === "test.stream.resolve")).toBe(false);
  });

  e2eIt("at() resolves ..-relative parent, grandparent and mixed paths", async () => {
    const root = e2eStreamPathLabel("e2e/resolve-up");
    using current = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl({ path: `${root}/a/b/c` }),
    });

    // ../parent -> {root}/a/b/parent
    const [toParent] = await current.stream
      .at("../parent")
      .append({ type: "test.stream.resolve", payload: { kind: "parent" } });
    using parentStream = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl({ path: `${root}/a/b/parent` }),
    });
    await expect(parentStream.stream.getEvents({ afterOffset: 0 })).resolves.toContainEqual(
      toParent,
    );

    // ../../grandparent -> {root}/a/grandparent
    const [toGrand] = await current.stream
      .at("../../grandparent")
      .append({ type: "test.stream.resolve", payload: { kind: "grandparent" } });
    using grandStream = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl({ path: `${root}/a/grandparent` }),
    });
    await expect(grandStream.stream.getEvents({ afterOffset: 0 })).resolves.toContainEqual(toGrand);

    // ../../grandparent/.././bla normalizes to {root}/a/bla
    const [toMixed] = await current.stream
      .at("../../grandparent/.././bla")
      .append({ type: "test.stream.resolve", payload: { kind: "mixed" } });
    using blaStream = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl({ path: `${root}/a/bla` }),
    });
    await expect(blaStream.stream.getEvents({ afterOffset: 0 })).resolves.toContainEqual(toMixed);
  });

  e2eIt("at() rejects a path that escapes the stream root", async () => {
    // base has depth 2 ([e2e, resolve-escape-...]); three `..` pops past the root.
    const base = e2eStreamPathLabel("e2e/resolve-escape");
    using parent = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path: base }) });

    await expect(
      parent.stream
        .at("../../../too-far")
        .append({ type: "test.stream.resolve", payload: { kind: "escape" } }),
    ).rejects.toThrow();
  });

  e2eIt("append returns events in input order including idempotency hits", async () => {
    const path = e2eStreamPathLabel("stream-capnweb-batch");
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });

    const [existing] = await stream.stream.append({
      type: "test.stream.capnweb-batch-existing",
      idempotencyKey: "batch-existing",
      payload: { path },
    });
    await expect(stream.stream.getEvent({ idempotencyKey: "batch-existing" })).resolves.toEqual(
      existing,
    );
    const batch = await stream.stream.append(
      {
        type: "test.stream.capnweb-batch-new",
        payload: { n: 1 },
      },
      {
        type: "test.stream.capnweb-batch-existing",
        idempotencyKey: "batch-existing",
        payload: { path },
      },
      {
        type: "test.stream.capnweb-batch-new",
        payload: { n: 2 },
      },
    );

    expect(batch).toMatchObject([
      {
        type: "test.stream.capnweb-batch-new",
        offset: 4,
        payload: { n: 1 },
      },
      existing,
      {
        type: "test.stream.capnweb-batch-new",
        offset: 5,
        payload: { n: 2 },
      },
    ]);
  });

  e2eIt("deduplicates same-batch idempotency keys before writing", async () => {
    const path = e2eStreamPathLabel("stream-capnweb-same-batch-idempotency");
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });

    const batch = await stream.stream.append(
      {
        type: "test.stream.capnweb-same-batch-idempotency",
        idempotencyKey: "same-batch",
        payload: { n: 1 },
      },
      {
        type: "test.stream.capnweb-same-batch-idempotency",
        idempotencyKey: "same-batch",
        payload: { n: 2 },
      },
    );

    expect(batch[1]).toEqual(batch[0]);
    await expect(
      stream.stream
        .getEvents({ afterOffset: 0 })
        .then((events) => events.map((event) => event.type)),
    ).resolves.toEqual([
      "events.iterate.com/stream/created",
      "events.iterate.com/stream/woken",
      "test.stream.capnweb-same-batch-idempotency",
    ]);
  });

  e2eIt("uses exclusive numeric cursors", async () => {
    const path = e2eStreamPathLabel("stream-capnweb-cursors");
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });

    await stream.stream.append(
      {
        type: "test.stream.capnweb-cursor",
        payload: { n: 1 },
      },
      {
        type: "test.stream.capnweb-cursor",
        payload: { n: 2 },
      },
    );

    await expect(stream.stream.getEvents({ afterOffset: 0 })).resolves.toMatchObject([
      { offset: 1 },
      { offset: 2 },
      { offset: 3 },
      { offset: 4 },
    ]);
    await expect(
      stream.stream.getEvents({ afterOffset: 1, beforeOffset: 4 }),
    ).resolves.toMatchObject([{ offset: 2 }, { offset: 3 }]);
    await expect(stream.stream.getEvents({ afterOffset: 2 })).resolves.toMatchObject([
      { offset: 3 },
      { offset: 4 },
    ]);
  });

  e2eIt("replays history and then delivers live batches to subscribers", async () => {
    const path = e2eStreamPathLabel("stream-capnweb-replay");
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });

    const [first] = await stream.stream.append({
      type: "test.stream.capnweb-replay",
      payload: { n: 1 },
    });

    const callback = new TestSubscriptionCallback();
    using subscription = await stream.stream.subscribe({
      subscriptionKey: "replay",
      processEventBatch: (batch) => callback.processEventBatch(batch),
      replayAfterOffset: 0,
    });
    await waitFor(() => callback.batches.length === 1, 1_000);

    const [second] = await stream.stream.append({
      type: "test.stream.capnweb-replay",
      payload: { n: 2 },
    });
    await waitFor(() => callback.batches.length === 2, 1_000);
    const runtime = await stream.stream.runtimeState();
    const coreProcessorState = runtime.coreProcessorState as {
      projectId: string | null;
      path: string;
    };

    expect(callback.batches).toEqual([
      [
        expect.objectContaining({
          type: "events.iterate.com/stream/created",
          offset: 1,
          payload: {
            projectId: coreProcessorState.projectId,
            path,
          },
        }),
        expect.objectContaining({
          type: "events.iterate.com/stream/woken",
          offset: 2,
          payload: {
            incarnationId: expect.any(String),
          },
        }),
        first,
        // The subscriber's own connect is a durable presence fact, appended
        // after the replay cursor is fixed — so it arrives as the tail of the
        // subscriber's first batch.
        expect.objectContaining({
          type: "events.iterate.com/stream/subscriber-connected",
          offset: 4,
          payload: {
            subscriptionKey: "replay",
            subscriptionType: "ephemeral",
          },
        }),
      ],
      [second],
    ]);
    await subscription.unsubscribe();
  });

  e2eIt("assigns a subscription key when subscribe omits one", async () => {
    const path = e2eStreamPathLabel("stream-capnweb-anon-sub");
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });

    const callbackA = new TestSubscriptionCallback();
    const callbackB = new TestSubscriptionCallback();
    using first = await stream.stream.subscribe({
      processEventBatch: (batch) => callbackA.processEventBatch(batch),
    });
    using second = await stream.stream.subscribe({
      processEventBatch: (batch) => callbackB.processEventBatch(batch),
    });

    const firstKey = await first.subscriptionKey;
    const secondKey = await second.subscriptionKey;
    expect(firstKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(secondKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(firstKey).not.toBe(secondKey);

    const runtime = await stream.stream.runtimeState();
    expect(runtime.runtime.connections[firstKey]).toMatchObject({
      subscriptionType: "ephemeral",
    });
    expect(runtime.runtime.connections[secondKey]).toMatchObject({
      subscriptionType: "ephemeral",
    });

    const [appended] = await stream.stream.append({
      type: "test.stream.capnweb-anon-sub",
      payload: { path },
    });
    if (appended === undefined) throw new Error("append returned no event");
    // Each subscribe also appends a subscriber-connected presence fact, and
    // every subscription gets an initial state push — batch counts are not
    // stable here, so wait for the content instead.
    const delivered = (callback: TestSubscriptionCallback, offset: number) =>
      callback.batches.flat().some((event) => event.offset === offset);
    await waitFor(
      () => delivered(callbackA, appended.offset) && delivered(callbackB, appended.offset),
      1_000,
    );
    expect(callbackA.batches.at(-1)).toEqual([appended]);
    expect(callbackB.batches.at(-1)).toEqual([appended]);
    const callbackABatchesBeforeUnsubscribe = callbackA.batches.length;

    await first.unsubscribe();
    const [afterUnsubscribe] = await stream.stream.append({
      type: "test.stream.capnweb-anon-sub-after-unsub",
      payload: { path },
    });
    if (afterUnsubscribe === undefined) throw new Error("append returned no event");
    await waitFor(() => delivered(callbackB, afterUnsubscribe.offset), 1_000);
    expect(callbackA.batches.length).toBe(callbackABatchesBeforeUnsubscribe);
  });

  // The legacy engine's hosted circuit-breaker processor is gone; the pause
  // door it drove is core stream behavior on the next engine, exercised here
  // directly through the public paused/resumed events.
  e2eIt("pauses and resumes ordinary appends through the core stream gate", async () => {
    const path = e2eStreamPathLabel("stream-capnweb-pause-gate");
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });

    await stream.stream.append({
      type: "events.iterate.com/stream/paused",
      payload: { reason: "e2e pause" },
    });

    await expect(
      stream.stream.append({
        type: "test.stream.pause-gate.rejected",
        payload: { path },
      }),
    ).rejects.toThrow("stream paused");

    await stream.stream.append({
      type: "events.iterate.com/stream/resumed",
      payload: { reason: "e2e resume" },
    });
    const [afterResume] = await stream.stream.append({
      type: "test.stream.pause-gate.accepted",
      payload: { path },
    });
    expect(afterResume).toMatchObject({ type: "test.stream.pause-gate.accepted" });
  });

  e2eIt("delivers event batches without subscriber-originated requests", async () => {
    const path = e2eStreamPathLabel("stream-capnweb-wire");
    const callback = new TestSubscriptionCallback();

    using subscriber = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });
    const frames: WebSocketFrame[] = [];
    subscriber.onWebSocketFrame((frame) => frames.push(frame));
    await subscriber.stream.subscribe({
      subscriptionKey: "wire",
      processEventBatch: (batch) => callback.processEventBatch(batch),
      replayAfterOffset: 2,
    });
    const afterSubscribe = frames.length;

    using publisher = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });
    const input: StreamEventInput = {
      type: "test.stream.capnweb-wire",
      payload: { path },
    };
    const [appended] = await publisher.stream.append(input);
    if (appended === undefined) throw new Error("append returned no event");
    // Deliveries before the published event: the subscription's initial state
    // push (events: []) and/or the subscriber's own subscriber-connected
    // presence fact (offset 3, appended during subscribe) — wait for content.
    await waitFor(
      () => callback.batches.flat().some((event) => event.offset === appended.offset),
      1_000,
    );

    expect(appended).toMatchObject({
      type: input.type,
      payload: input.payload,
      offset: 4,
      createdAt: expect.any(String),
    });
    // Batch boundaries race (initial push, presence fact commit timing), but
    // the delivered EVENTS are exact: the subscriber's own connected fact,
    // then the published event — each exactly once, in offset order.
    expect(callback.batches.at(-1)).toEqual([appended]);
    expect(callback.batches.flat()).toEqual([
      expect.objectContaining({
        type: "events.iterate.com/stream/subscriber-connected",
        offset: 3,
      }),
      appended,
    ]);
    // Deliveries are server pushes: the subscriber never ORIGINATES a request
    // for them. Unlike the legacy engine, the next engine's worker→DO bridge
    // observes each delivery's result, so the browser answers every push with
    // one `resolve` frame — allowed here; anything else outbound is not.
    const outbound = outboundFrames(frames, afterSubscribe);
    expect(outbound.every((frame) => Array.isArray(frame) && frame[0] === "resolve")).toBe(true);

    const inbound = parsedFrames(frames)
      .slice(afterSubscribe)
      .filter((frame) => frame.direction === "in");
    expect(inbound.every((frame) => isDeliveryProtocolFrame(frame.data))).toBe(true);
    // Earlier push frames race the `afterSubscribe` snapshot and each other:
    // the subscription's initial state push (events: []) and the
    // subscriber-connected fact's delivery. Assert the last frame (the
    // published event's) exactly; earlier ones are push frames by the
    // `isPushOrReleaseFrame` check above.
    const pushFrames = inbound.filter((frame) => isPushFrame(frame.data));
    expect(pushFrames.length).toBeGreaterThanOrEqual(1);
    expect(pushFrames.at(-1)).toMatchObject({
      direction: "in",
      data: [
        "push",
        [
          "pipeline",
          expect.any(Number),
          [],
          [
            {
              events: [
                [
                  {
                    type: input.type,
                    payload: input.payload,
                    offset: 4,
                    createdAt: expect.any(String),
                  },
                ],
              ],
            },
          ],
        ],
      ],
    });
  });
});

function parsedFrames(messages: WebSocketFrame[]) {
  return messages.map((frame) => ({
    direction: frame.direction,
    data: JSON.parse(frame.data) as unknown,
  }));
}

function outboundFrames(messages: WebSocketFrame[], afterFrameIndex: number) {
  return parsedFrames(messages)
    .slice(afterFrameIndex)
    .filter((frame) => frame.direction === "out")
    .map((frame) => frame.data);
}

/**
 * Protocol predicate for inbound frames that batch delivery may produce: the
 * push itself, the server's pull of the delivery result (the next engine
 * observes it — see the resolve-frame note in the wire test), and releases
 * during subscribe teardown.
 */
function isDeliveryProtocolFrame(value: unknown) {
  return (
    isPushFrame(value) || (Array.isArray(value) && (value[0] === "release" || value[0] === "pull"))
  );
}

function isPushFrame(value: unknown) {
  return Array.isArray(value) && value[0] === "push";
}

function expectLargePayload(event: StreamEvent | undefined, expectedBodyLength: number) {
  if (event === undefined) throw new Error("expected event to be defined");
  const payload = event.payload;
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("body" in payload) ||
    typeof payload.body !== "string"
  ) {
    throw new Error("expected event payload.body to be a string");
  }
  expect(payload.body).toHaveLength(expectedBodyLength);
}

async function waitFor(assertion: () => boolean | Promise<boolean>, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}
