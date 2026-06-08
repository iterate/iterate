import { RpcTarget } from "capnweb";
import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "../../../src/shared/event.ts";
import { connectStreamProcessorRunner } from "../../../src/node/connect-processor-runner.ts";
import { withStreamConnectionFromBrowser } from "../../../src/browser/connect.ts";
import { withStreamConnectionFromNode } from "../../../src/node/connect.ts";
import type { WebSocketFrame } from "../../../src/connection.ts";

const workerUrl = process.env.WORKER_URL ?? "http://localhost:5173";
const e2eIt = process.env.STREAM_STAGING_E2E === "true" ? it : it.skip;

class TestSubscriptionCallback extends RpcTarget {
  readonly batches: StreamEvent[][] = [];

  processEventBatch(args: { events: StreamEvent[]; streamMaxOffset: number }): undefined {
    this.batches.push(args.events);
  }
}

describe("stream capnweb protocol", () => {
  e2eIt("browser client appends events by stream URL", async () => {
    const path = `stream-browser-client-${crypto.randomUUID()}`;
    await using stream = await withStreamConnectionFromBrowser({ url: toStreamWebSocketUrl(path) });

    const appended = await stream.stream.append({
      event: {
        type: "test.stream.browser-client",
        payload: { path },
      },
    });

    expect(appended).toMatchObject({
      type: "test.stream.browser-client",
      payload: { path },
      offset: 3,
      createdAt: expect.any(String),
    });
  });

  e2eIt("appends events after the stream-created event over capnweb", async () => {
    const path = `stream-capnweb-append-${crypto.randomUUID()}`;
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(path) });

    const appended = await stream.stream.append({
      event: {
        type: "test.stream.capnweb-append",
        payload: { path },
      },
    });

    expect(appended).toMatchObject({
      type: "test.stream.capnweb-append",
      payload: { path },
      offset: 3,
      createdAt: expect.any(String),
    });
  });

  // Cross-stream append must land on the same leading-slash DO name the rest of the
  // system uses. The regressed `#resolveStream` stripped the leading slash, so an event
  // appended via `streamPath` went to `default:e2e/.../child` while a reader connects to
  // `default:/e2e/.../child` — a different, empty stream. These prove path resolution.
  e2eIt('append resolves relative child paths ("child" and "./child")', async () => {
    const base = `/e2e/resolve-child-${crypto.randomUUID()}`;
    using parent = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(base) });

    const viaBare = await parent.stream.append({
      streamPath: "child",
      event: { type: "test.stream.resolve", payload: { kind: "bare" } },
    });
    const viaDot = await parent.stream.append({
      streamPath: "./child",
      event: { type: "test.stream.resolve", payload: { kind: "dot" } },
    });

    // Both forms resolve to the same `${base}/child` stream the reader connects to.
    using child = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(`${base}/child`) });
    const events = await child.stream.getEvents({ afterOffset: 0 });
    expect(events).toContainEqual(viaBare);
    expect(events).toContainEqual(viaDot);
    expect(viaBare.offset).not.toBe(viaDot.offset);

    // Nothing leaked into the parent.
    const parentEvents = await parent.stream.getEvents({ afterOffset: 0 });
    expect(parentEvents.some((event) => event.type === "test.stream.resolve")).toBe(false);
  });

  e2eIt("append resolves an absolute /root/path", async () => {
    const unique = crypto.randomUUID();
    const base = `/e2e/resolve-abs-${unique}`;
    const target = `/e2e/resolve-abs-target-${unique}`;
    using parent = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(base) });

    const appended = await parent.stream.append({
      streamPath: target,
      event: { type: "test.stream.resolve", payload: { kind: "absolute" } },
    });

    using targetStream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(target) });
    await expect(targetStream.stream.getEvents({ afterOffset: 0 })).resolves.toContainEqual(
      appended,
    );
    const parentEvents = await parent.stream.getEvents({ afterOffset: 0 });
    expect(parentEvents.some((event) => event.type === "test.stream.resolve")).toBe(false);
  });

  e2eIt("append resolves ..-relative parent, grandparent and mixed paths", async () => {
    const root = `/e2e/resolve-up-${crypto.randomUUID()}`;
    using current = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(`${root}/a/b/c`) });

    // ../parent -> {root}/a/b/parent
    const toParent = await current.stream.append({
      streamPath: "../parent",
      event: { type: "test.stream.resolve", payload: { kind: "parent" } },
    });
    using parentStream = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl(`${root}/a/b/parent`),
    });
    await expect(parentStream.stream.getEvents({ afterOffset: 0 })).resolves.toContainEqual(
      toParent,
    );

    // ../../grandparent -> {root}/a/grandparent
    const toGrand = await current.stream.append({
      streamPath: "../../grandparent",
      event: { type: "test.stream.resolve", payload: { kind: "grandparent" } },
    });
    using grandStream = withStreamConnectionFromNode({
      url: toStreamWebSocketUrl(`${root}/a/grandparent`),
    });
    await expect(grandStream.stream.getEvents({ afterOffset: 0 })).resolves.toContainEqual(toGrand);

    // ../../grandparent/.././bla normalizes to {root}/a/bla
    const toMixed = await current.stream.append({
      streamPath: "../../grandparent/.././bla",
      event: { type: "test.stream.resolve", payload: { kind: "mixed" } },
    });
    using blaStream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(`${root}/a/bla`) });
    await expect(blaStream.stream.getEvents({ afterOffset: 0 })).resolves.toContainEqual(toMixed);
  });

  e2eIt("append rejects a streamPath that escapes the stream root", async () => {
    // base has depth 2 ([e2e, resolve-escape-...]); three `..` pops past the root.
    const base = `/e2e/resolve-escape-${crypto.randomUUID()}`;
    using parent = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(base) });

    await expect(
      parent.stream.append({
        streamPath: "../../../too-far",
        event: { type: "test.stream.resolve", payload: { kind: "escape" } },
      }),
    ).rejects.toThrow();
  });

  e2eIt("appendBatch returns events in input order including idempotency hits", async () => {
    const path = `stream-capnweb-batch-${crypto.randomUUID()}`;
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(path) });

    const existing = await stream.stream.append({
      event: {
        type: "test.stream.capnweb-batch-existing",
        idempotencyKey: "batch-existing",
        payload: { path },
      },
    });
    await expect(stream.stream.getEvent({ idempotencyKey: "batch-existing" })).resolves.toEqual(
      existing,
    );
    const batch = await stream.stream.appendBatch({
      events: [
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
      ],
    });

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
    const path = `stream-capnweb-same-batch-idempotency-${crypto.randomUUID()}`;
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(path) });

    const batch = await stream.stream.appendBatch({
      events: [
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
      ],
    });

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
    const path = `stream-capnweb-cursors-${crypto.randomUUID()}`;
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(path) });

    await stream.stream.appendBatch({
      events: [
        {
          type: "test.stream.capnweb-cursor",
          payload: { n: 1 },
        },
        {
          type: "test.stream.capnweb-cursor",
          payload: { n: 2 },
        },
      ],
    });

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

  e2eIt("exposes the stream reducer as an RPC method", async () => {
    const path = `stream-capnweb-reduce-${crypto.randomUUID()}`;
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(path) });

    const state = await stream.stream.reduce({
      event: {
        type: "events.iterate.com/stream/configured",
        offset: 3,
        createdAt: new Date().toISOString(),
        payload: {
          config: {
            simulatedStorageSyncDelayMs: 25,
          },
        },
      },
    });

    expect(state.config.simulatedStorageSyncDelayMs).toBe(25);
  });

  e2eIt("replays history and then delivers live batches to inbound subscribers", async () => {
    const path = `stream-capnweb-replay-${crypto.randomUUID()}`;
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(path) });

    const first = await stream.stream.append({
      event: {
        type: "test.stream.capnweb-replay",
        payload: { n: 1 },
      },
    });

    const callback = new TestSubscriptionCallback();
    await stream.stream.subscribe({
      subscriptionKey: "replay",
      processEventBatch: (batch) => callback.processEventBatch(batch),
      replayAfterOffset: 0,
    });
    await waitFor(() => callback.batches.length === 1, 1_000);

    const second = await stream.stream.append({
      event: {
        type: "test.stream.capnweb-replay",
        payload: { n: 2 },
      },
    });
    await waitFor(() => callback.batches.length === 2, 1_000);
    const runtime = await stream.stream.runtimeState();

    expect(callback.batches).toEqual([
      [
        expect.objectContaining({
          type: "events.iterate.com/stream/created",
          offset: 1,
          payload: {
            namespace: runtime.coreProcessorState.namespace,
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
      ],
      [second],
    ]);
  });

  e2eIt("assigns a subscription key when subscribe omits one", async () => {
    const path = `stream-capnweb-anon-sub-${crypto.randomUUID()}`;
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(path) });

    const callbackA = new TestSubscriptionCallback();
    const callbackB = new TestSubscriptionCallback();
    const first = await stream.stream.subscribe({
      processEventBatch: (batch) => callbackA.processEventBatch(batch),
    });
    const second = await stream.stream.subscribe({
      processEventBatch: (batch) => callbackB.processEventBatch(batch),
    });

    expect(first.subscriptionKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(second.subscriptionKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(first.subscriptionKey).not.toBe(second.subscriptionKey);

    const runtime = await stream.stream.runtimeState();
    expect(runtime.runtime.connections[first.subscriptionKey]).toMatchObject({
      direction: "inbound",
    });
    expect(runtime.runtime.connections[second.subscriptionKey]).toMatchObject({
      direction: "inbound",
    });

    const appended = await stream.stream.append({
      event: {
        type: "test.stream.capnweb-anon-sub",
        payload: { path },
      },
    });
    await waitFor(() => callbackA.batches.length === 1 && callbackB.batches.length === 1, 1_000);
    expect(callbackA.batches.at(-1)).toEqual([appended]);
    expect(callbackB.batches.at(-1)).toEqual([appended]);

    first.unsubscribe();
    await stream.stream.append({
      event: {
        type: "test.stream.capnweb-anon-sub-after-unsub",
        payload: { path },
      },
    });
    await waitFor(() => callbackB.batches.length === 2, 1_000);
    expect(callbackA.batches.length).toBe(1);
  });

  e2eIt("runs a hosted outbound processor from subscription-configured", async () => {
    const path = `stream-capnweb-processor-${crypto.randomUUID()}`;
    const subscriptionKey = `hosted-echo-${crypto.randomUUID()}`;
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(path) });
    const runtime = await stream.stream.runtimeState();
    const runnerName = `${runtime.coreProcessorState.namespace}:${path}:${subscriptionKey}`;
    await using processor = await connectStreamProcessorRunner({
      url: toStreamProcessorRunnerWebSocketUrl(runnerName, { processorSlug: "echo-example" }),
    });

    const configured = await stream.stream.append({
      event: {
        type: "events.iterate.com/stream/subscription-configured",
        idempotencyKey: `subscription:${subscriptionKey}`,
        payload: {
          subscriptionKey,
          subscriber: {
            type: "built-in",
            transport: "workers-rpc",
            processorSlug: "echo-example",
          },
        },
      },
    });

    await waitFor(async () => {
      const status = await processor.rpc.runtimeState();
      return status.processorSlug === "echo-example" && status.snapshot === undefined;
    }, 1_000);

    await stream.stream.append({
      event: {
        type: "events.iterate.com/echo-example/input-received",
        payload: { path },
      },
    });

    await waitFor(async () => {
      const status = await processor.rpc.runtimeState();
      const snapshot = status.snapshot;
      return (
        snapshot !== undefined &&
        (snapshot.state as { seen: number }).seen === 1 &&
        snapshot.offset > configured.offset
      );
    }, 1_000);
  });

  e2eIt("runs the hosted circuit breaker processor from a built-in subscription", async () => {
    const path = `stream-capnweb-hosted-circuit-breaker-${crypto.randomUUID()}`;
    const subscriptionKey = `hosted-breaker-${crypto.randomUUID()}`;
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(path) });
    const runtime = await stream.stream.runtimeState();
    const runnerName = `${runtime.coreProcessorState.namespace}:${path}:${subscriptionKey}`;
    await using processor = await connectStreamProcessorRunner({
      url: toStreamProcessorRunnerWebSocketUrl(runnerName, { processorSlug: "circuit-breaker" }),
    });

    const configured = await stream.stream.append({
      event: {
        type: "events.iterate.com/stream/subscription-configured",
        idempotencyKey: `subscription:${subscriptionKey}`,
        payload: {
          subscriptionKey,
          subscriber: {
            type: "built-in",
            transport: "workers-rpc",
            processorSlug: "circuit-breaker",
          },
        },
      },
    });

    await waitFor(async () => {
      const status = await processor.rpc.runtimeState();
      return status.processorSlug === "circuit-breaker" && status.snapshot === undefined;
    }, 1_000);

    await stream.stream.append({
      event: {
        type: "events.iterate.com/circuit-breaker/configured",
        payload: { burstCapacity: 1, refillRatePerMinute: 1 },
      },
    });
    await stream.stream.append({
      event: { type: "test.hosted-circuit-breaker.input", payload: { n: 1 } },
    });
    await stream.stream.append({
      event: { type: "test.hosted-circuit-breaker.input", payload: { n: 2 } },
    });

    await waitFor(async () => {
      const [streamRuntime, processorRuntime] = await Promise.all([
        stream.stream.runtimeState(),
        processor.rpc.runtimeState(),
      ]);
      return (
        streamRuntime.coreProcessorState.paused &&
        processorRuntime.snapshot !== undefined &&
        processorRuntime.snapshot.offset > configured.offset
      );
    }, 10_000);

    await expect(
      stream.stream.append({
        event: { type: "test.hosted-circuit-breaker.rejected", payload: { path } },
      }),
    ).rejects.toThrow("stream paused");
  });

  e2eIt("delivers event batches without subscriber-originated return traffic", async () => {
    const path = `stream-capnweb-wire-${crypto.randomUUID()}`;
    const callback = new TestSubscriptionCallback();

    using subscriber = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(path) });
    const frames: WebSocketFrame[] = [];
    subscriber.onWebSocketFrame((frame) => frames.push(frame));
    await subscriber.stream.subscribe({
      subscriptionKey: "wire",
      processEventBatch: (batch) => callback.processEventBatch(batch),
      replayAfterOffset: 2,
    });
    const afterSubscribe = frames.length;

    using publisher = withStreamConnectionFromNode({ url: toStreamWebSocketUrl(path) });
    const input: StreamEventInput = {
      type: "test.stream.capnweb-wire",
      payload: { path },
    };
    const appended = await publisher.stream.append({ event: input });
    await waitFor(() => callback.batches.length === 1, 1_000);

    expect(appended).toMatchObject({
      type: input.type,
      payload: input.payload,
      offset: 3,
      createdAt: expect.any(String),
    });
    expect(callback.batches).toEqual([[appended]]);
    expect(outboundFrames(frames, afterSubscribe)).toEqual([]);

    const inbound = parsedFrames(frames)
      .slice(afterSubscribe)
      .filter((frame) => frame.direction === "in");
    expect(inbound.every((frame) => isPushOrReleaseFrame(frame.data))).toBe(true);
    expect(inbound.filter((frame) => isPushFrame(frame.data))).toMatchObject([
      {
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
                      offset: 3,
                      createdAt: expect.any(String),
                    },
                  ],
                ],
              },
            ],
          ],
        ],
      },
    ]);
  });
});

function toStreamWebSocketUrl(path: string) {
  const url = new URL(workerUrl);
  url.pathname = streamApiPath(path);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

function streamApiPath(path: string) {
  if (path === "" || path === "/") return "/api/streams";
  return `/api/streams/${path.startsWith("/") ? encodeURIComponent(path) : path.split("/").map(encodeURIComponent).join("/")}`;
}

function toStreamProcessorRunnerWebSocketUrl(
  path: string,
  params: { processorSlug?: string } = {},
) {
  const url = new URL(workerUrl);
  url.pathname = `/stream-processor-runner/${path}`;
  if (params.processorSlug !== undefined)
    url.searchParams.set("processorSlug", params.processorSlug);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

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

function isPushOrReleaseFrame(value: unknown) {
  return isPushFrame(value) || (Array.isArray(value) && value[0] === "release");
}

function isPushFrame(value: unknown) {
  return Array.isArray(value) && value[0] === "push";
}

async function waitFor(assertion: () => boolean | Promise<boolean>, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}
