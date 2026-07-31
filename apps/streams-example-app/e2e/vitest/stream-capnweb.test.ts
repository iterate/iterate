// Runs against the playground named by WORKER_URL (a deployed env, as in the
// preview CI lane) or the local `pnpm dev` server when WORKER_URL is unset.
// Every test runs unconditionally: an unreachable target fails the suite
// loudly (see ../vitest-global-setup.ts) instead of skipping — a gate that
// silently skips is the failure mode docs/testing.md#lanes exists to prevent.

import { RpcTarget } from "capnweb";
import { describe, expect, it } from "vitest";
import { isIdempotencyConflict } from "iterate/processors";
import type { StreamEvent, StreamEventInput } from "iterate/sdk";
import {
  e2eStreamPath,
  e2eStreamPathLabel,
  toStreamWebSocketUrl,
  withStreamConnectionFromNode,
} from "../helpers.ts";
import { withStreamConnectionFromBrowser } from "../../src/lib/stream-rpc.ts";
import type { WebSocketFrame } from "../../src/lib/stream-connection.ts";

class TestEventBatchCallback extends RpcTarget {
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
  it("browser client appends events by stream URL", async () => {
    const path = e2eStreamPathLabel("stream-browser-client");
    await using stream = await withStreamConnectionFromBrowser({
      url: toStreamWebSocketUrl({ path }),
    });

    const [appended] = await stream.stream.append({
      type: "test.stream.browser-client",
      payload: { path },
    });

    // The standalone playground has no project worker, so its birth
    // certificate is only created + woken. It does not invent an event callback.
    expect(appended).toMatchObject({
      type: "test.stream.browser-client",
      payload: { path },
      offset: 3,
      createdAt: expect.any(String),
    });
  });

  it("appends events after the stream-created event over capnweb", async () => {
    // Open one new WebSocket on a fresh path after a pause. This test creates a FRESH
    // stream DO per attempt, so it is the fleet's canary for Durable Object
    // weather: during the 2026-07-06/07 Cloudflare "DO increased error rate
    // in ENAM" incident it failed in minutes-long windows (socket dead <1s
    // after a clean upgrade, on workers.dev AND custom domains alike) while
    // warm-DO tests sailed on. Reopening is safe (nothing was appended when
    // the socket dies mid-first-call; a fresh path per attempt means a late
    // duplicate could only land on an abandoned stream) and absorbs blips; a
    // window longer than the pause still fails — correct, that's an outage.
    const connectAndAppend = async () => {
      const path = e2eStreamPathLabel("stream-capnweb-append");
      using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });
      const [appended] = await stream.stream.append({
        type: "test.stream.capnweb-append",
        payload: { path },
      });
      return { appended, path };
    };
    let result: Awaited<ReturnType<typeof connectAndAppend>>;
    try {
      result = await connectAndAppend();
    } catch (error) {
      if (!/Network connection lost|WebSocket connection failed/i.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      result = await connectAndAppend();
    }

    expect(result.appended).toMatchObject({
      type: "test.stream.capnweb-append",
      payload: { path: result.path },
      offset: 3, // after the standalone birth certificate (created, woken)
      createdAt: expect.any(String),
    });
  });

  it("appends, reads, and keeps running after event rows larger than 2 MiB", async () => {
    const path = e2eStreamPathLabel("stream-capnweb-large-row");
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });
    // Large enough to exceed the old single-row SQLite target and span multiple
    // storage chunks. Keep this below Cloudflare's 32 MiB inbound WebSocket frame
    // ceiling: that limit applies to client append calls, while a stream calling
    // `processEventBatch` can still send larger events once stored.
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
      offset: 3, // after the standalone birth certificate
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

  it("documents Cloudflare's 32 MiB inbound WebSocket frame ceiling for capnweb appends", async () => {
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
    await expect(async () => {
      await stream.stream.append(event);
    }).rejects.toThrow(
      /(?:connection (?:lost|failed)|Peer closed WebSocket: 1009 Message is too large)/i,
    );
  });

  // Cross-stream appends now go through the public `Stream.at(relativePath)`
  // capability. These prove path resolution lands on the same leading-slash DO
  // coordinates a direct reader connects to.
  it('at() resolves relative child paths ("child" and "./child")', async () => {
    const base = e2eStreamPathLabel("e2e/resolve-child");
    using parent = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path: base }) });

    const [viaBare] = await parent.stream.at("child").append({
      type: "test.stream.resolve",
      idempotencyKey: `${base}:bare`,
      payload: { kind: "bare" },
    });
    const [viaDot] = await parent.stream.at("./child").append({
      type: "test.stream.resolve",
      idempotencyKey: `${base}:dot`,
      payload: { kind: "dot" },
    });

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

  it("at() resolves an absolute /root/path", async () => {
    const unique = crypto.randomUUID();
    const base = e2eStreamPath(`/e2e/resolve-abs-${unique}`);
    const target = e2eStreamPath(`/e2e/resolve-abs-target-${unique}`);
    using parent = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path: base }) });

    const [appended] = await parent.stream.at(target).append({
      type: "test.stream.resolve",
      idempotencyKey: `${unique}:absolute`,
      payload: { kind: "absolute" },
    });

    using targetStream = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl({ path: target }),
    });
    await expect(targetStream.stream.getEvents({ afterOffset: 0 })).resolves.toContainEqual(
      appended,
    );
    const parentEvents = await parent.stream.getEvents({ afterOffset: 0 });
    expect(parentEvents.some((event) => event.type === "test.stream.resolve")).toBe(false);
  });

  it("at() resolves ..-relative parent, grandparent and mixed paths", async () => {
    const root = e2eStreamPathLabel("e2e/resolve-up");
    using current = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl({ path: `${root}/a/b/c` }),
    });

    // ../parent -> {root}/a/b/parent
    const [toParent] = await current.stream.at("../parent").append({
      type: "test.stream.resolve",
      idempotencyKey: `${root}:parent`,
      payload: { kind: "parent" },
    });
    using parentStream = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl({ path: `${root}/a/b/parent` }),
    });
    await expect(parentStream.stream.getEvents({ afterOffset: 0 })).resolves.toContainEqual(
      toParent,
    );

    // ../../grandparent -> {root}/a/grandparent
    const [toGrand] = await current.stream.at("../../grandparent").append({
      type: "test.stream.resolve",
      idempotencyKey: `${root}:grandparent`,
      payload: { kind: "grandparent" },
    });
    using grandStream = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl({ path: `${root}/a/grandparent` }),
    });
    await expect(grandStream.stream.getEvents({ afterOffset: 0 })).resolves.toContainEqual(toGrand);

    // ../../grandparent/.././bla normalizes to {root}/a/bla
    const [toMixed] = await current.stream.at("../../grandparent/.././bla").append({
      type: "test.stream.resolve",
      idempotencyKey: `${root}:mixed`,
      payload: { kind: "mixed" },
    });
    using blaStream = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl({ path: `${root}/a/bla` }),
    });
    await expect(blaStream.stream.getEvents({ afterOffset: 0 })).resolves.toContainEqual(toMixed);
  });

  it("at() rejects a path that escapes the stream root", async () => {
    // base has depth 2 ([e2e, resolve-escape-...]); three `..` pops past the root.
    const base = e2eStreamPathLabel("e2e/resolve-escape");
    using parent = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path: base }) });

    await expect(
      parent.stream
        .at("../../../too-far")
        .append({ type: "test.stream.resolve", payload: { kind: "escape" } }),
    ).rejects.toThrow();
  });

  it("append returns events in input order including idempotency hits", async () => {
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

  it("deduplicates identical same-batch idempotency retries and rejects conflicts", async () => {
    const path = e2eStreamPathLabel("stream-capnweb-same-batch-idempotency");
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });

    const event = {
      type: "test.stream.capnweb-same-batch-idempotency",
      idempotencyKey: "same-batch",
      payload: { n: 1 },
    } as const;
    const batch = await stream.stream.append(event, event);

    expect(batch[1]).toEqual(batch[0]);
    await expect(
      stream.stream.append({
        ...event,
        payload: { n: 2 },
      }),
    ).rejects.toSatisfy(isIdempotencyConflict);
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

  it("uses exclusive numeric cursors", async () => {
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
    await expect(stream.stream.getEvents({ afterOffset: 3 })).resolves.toMatchObject([
      { offset: 4 },
    ]);
  });

  it("replays earlier events and then sends new batches to an open callback", async () => {
    const path = e2eStreamPathLabel("stream-capnweb-replay");
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });

    const [first] = await stream.stream.append({
      type: "test.stream.capnweb-replay",
      payload: { n: 1 },
    });

    const callback = new TestEventBatchCallback();
    using connection = await stream.stream.openConnection({
      connectionKey: "replay",
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
            streamId: expect.any(String),
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
        // Opening the callback appends a durable presence fact after the replay
        // cursor is fixed, so it arrives at the end of the first batch.
        expect.objectContaining({
          type: "events.iterate.com/stream/connection-opened",
          offset: 4,
          payload: {
            connectionKey: "replay",
            kind: "session",
          },
        }),
      ],
      [second],
    ]);
    await connection.close();
  });

  it("assigns a connection key when openConnection omits one", async () => {
    const path = e2eStreamPathLabel("stream-capnweb-anonymous-connection");
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });

    const callbackA = new TestEventBatchCallback();
    const callbackB = new TestEventBatchCallback();
    using first = await stream.stream.openConnection({
      processEventBatch: (batch) => callbackA.processEventBatch(batch),
    });
    // Held only to keep the second connection open; keys are read from
    // runtime state below.
    using _second = await stream.stream.openConnection({
      processEventBatch: (batch) => callbackB.processEventBatch(batch),
    });

    // The handle is a pure capability (no data properties cross the wire);
    // the server-assigned keys are observable in runtime state.
    const runtime = await stream.stream.runtimeState();
    const sessionKeys = Object.entries(runtime.runtime.connections)
      .filter(([, connection]) => connection.kind === "session")
      .map(([key]) => key);
    expect(sessionKeys).toHaveLength(2);
    for (const key of sessionKeys) {
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
    expect(sessionKeys[0]).not.toBe(sessionKeys[1]);

    const [appended] = await stream.stream.append({
      type: "test.stream.capnweb-anon-sub",
      payload: { path },
    });
    if (appended === undefined) throw new Error("append returned no event");
    // Each openConnection call also appends a connection-opened presence fact, and
    // every connection gets an initial state callback — batch counts are not
    // stable here, so wait for the content instead.
    const received = (callback: TestEventBatchCallback, offset: number) =>
      callback.batches.flat().some((event) => event.offset === offset);
    await waitFor(
      () => received(callbackA, appended.offset) && received(callbackB, appended.offset),
      1_000,
    );
    expect(callbackA.batches.at(-1)).toEqual([appended]);
    expect(callbackB.batches.at(-1)).toEqual([appended]);
    const callbackABatchesBeforeClose = callbackA.batches.length;

    await first.close();
    const [afterClose] = await stream.stream.append({
      type: "test.stream.capnweb-anonymous-connection-after-close",
      payload: { path },
    });
    if (afterClose === undefined) throw new Error("append returned no event");
    await waitFor(() => received(callbackB, afterClose.offset), 1_000);
    expect(callbackA.batches.length).toBe(callbackABatchesBeforeClose);
  });

  // The pre-itx-v4 hosted circuit-breaker processor is gone; the pause
  // door it drove is core stream behavior on itx, exercised here
  // directly through the public paused/resumed events.
  it("pauses and resumes ordinary appends through the core stream gate", async () => {
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

  it("sends event batches without callback-owner requests", async () => {
    const path = e2eStreamPathLabel("stream-capnweb-wire");
    const callback = new TestEventBatchCallback();

    using callbackClient = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });
    const frames: WebSocketFrame[] = [];
    callbackClient.onWebSocketFrame((frame) => frames.push(frame));
    await callbackClient.stream.openConnection({
      connectionKey: "wire",
      processEventBatch: (batch) => callback.processEventBatch(batch),
      // Skip the standalone birth certificate (created, woken).
      replayAfterOffset: 2,
    });
    const afterConnectionOpened = frames.length;

    using publisher = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });
    const input: StreamEventInput = {
      type: "test.stream.capnweb-wire",
      payload: { path },
    };
    const [appended] = await publisher.stream.append(input);
    if (appended === undefined) throw new Error("append returned no event");
    // Calls before the published event: the connection's initial state update
    // (events: []) and/or its own connection-opened presence fact (offset 3,
    // appended while opening) — wait for content.
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
    // the received EVENTS are exact: the callback connection's own opened fact,
    // then the published event — each exactly once, in offset order.
    expect(callback.batches.at(-1)).toEqual([appended]);
    expect(callback.batches.flat()).toEqual([
      expect.objectContaining({
        type: "events.iterate.com/stream/connection-opened",
        offset: 3,
      }),
      appended,
    ]);
    // These are server-initiated callback calls: the owner never originates a request
    // for them. Unlike the pre-itx-v4 implementation, the itx worker→DO bridge
    // observes each delivery's result, so the browser answers every push with
    // one `resolve` frame — allowed here; anything else outbound is not.
    const outbound = outboundFrames(frames, afterConnectionOpened);
    expect(outbound.every((frame) => Array.isArray(frame) && frame[0] === "resolve")).toBe(true);

    const inbound = parsedFrames(frames)
      .slice(afterConnectionOpened)
      .filter((frame) => frame.direction === "in");
    expect(inbound.every((frame) => isCallbackProtocolFrame(frame.data))).toBe(true);
    // Earlier push frames race the `afterConnectionOpened` snapshot and each other:
    // the connection's initial state callback (events: []) and the callback
    // for its connection-opened fact. Assert the last frame (the
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
 * Protocol predicate for inbound frames that a batch callback may produce: the
 * push itself, the server's pull of the callback result (itx
 * observes it — see the resolve-frame note in the wire test), and releases
 * while closing the connection.
 */
function isCallbackProtocolFrame(value: unknown) {
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
