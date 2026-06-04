import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import { WebSocket as WsWebSocket, WebSocketServer } from "ws";
import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "../../../src/shared/event.ts";
import type { StreamPersistedProcessorState } from "../../../src/types.ts";
import type { SubscriptionConfiguredEvent } from "../../../src/processors/core/contract.ts";
import type { StreamProcessorRunnerRpc, StreamRpc, SubscriptionSink } from "../../../src/types.ts";
import { connectStreamProcessorRunner } from "../../../src/node/connect-processor-runner.ts";
import { connectStream as connectBrowserStream } from "../../../src/browser/connect.ts";

const workerUrl = process.env.WORKER_URL ?? "http://localhost:5173";
const e2eIt = process.env.STREAM_STAGING_E2E === "true" ? it : it.skip;
const localWorkerE2eIt =
  process.env.STREAM_STAGING_E2E === "true" &&
  ["localhost", "127.0.0.1"].includes(new URL(workerUrl).hostname)
    ? it
    : it.skip;
const cloudflaredE2eIt =
  process.env.STREAM_STAGING_E2E === "true" && process.env.STREAM_STAGING_CLOUDFLARED_E2E === "true"
    ? it
    : it.skip;
const externalRunnerPort = Number(process.env.STREAM_STAGING_EXTERNAL_RUNNER_PORT ?? 0);

type WsMessage = {
  direction: "out" | "in";
  data: string;
};

class TestSubscriptionSink extends RpcTarget implements SubscriptionSink {
  readonly batches: StreamEvent[][] = [];

  processEventBatch(args: { events: StreamEvent[]; streamMaxOffset: number }): undefined {
    this.batches.push(args.events);
  }
}

class NodeStreamProcessorRunner extends RpcTarget implements StreamProcessorRunnerRpc {
  readonly requestHeaders: Headers[] = [];
  readonly batches: StreamEvent[][] = [];
  subscriptionConfiguredEvent: SubscriptionConfiguredEvent | undefined;
  streamRuntimeState: { state: StreamPersistedProcessorState } | undefined;

  requestSubscription(args: {
    stream: RpcStub<StreamRpc>;
    subscriptionKey: string;
    streamMaxOffset: number;
    subscriptionConfiguredEvent: SubscriptionConfiguredEvent;
    streamRuntimeState: { state: StreamPersistedProcessorState };
  }): { sink: SubscriptionSink; replayAfterOffset?: number } {
    this.subscriptionConfiguredEvent = args.subscriptionConfiguredEvent;
    this.streamRuntimeState = args.streamRuntimeState;
    return { sink: this };
  }

  processEventBatch(args: { events: StreamEvent[]; streamMaxOffset: number }): undefined {
    this.batches.push(args.events);
  }

  runtimeState() {
    return {
      processorSlug: undefined,
      snapshot: undefined,
    };
  }
}

describe("stream capnweb protocol", () => {
  e2eIt("browser client appends events by stream URL", async () => {
    const path = `stream-browser-client-${crypto.randomUUID()}`;
    await using stream = await connectBrowserStream({ url: toStreamWebSocketUrl(path) });

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
    await using stream = await connectStream(path);

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

  e2eIt("appendBatch returns events in input order including idempotency hits", async () => {
    const path = `stream-capnweb-batch-${crypto.randomUUID()}`;
    await using stream = await connectStream(path);

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
    await using stream = await connectStream(path);

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
    await using stream = await connectStream(path);

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
    await using stream = await connectStream(path);

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

    expect(state.core.config.simulatedStorageSyncDelayMs).toBe(25);
  });

  e2eIt("replays history and then delivers live batches to inbound subscribers", async () => {
    const path = `stream-capnweb-replay-${crypto.randomUUID()}`;
    await using stream = await connectStream(path);

    const first = await stream.stream.append({
      event: {
        type: "test.stream.capnweb-replay",
        payload: { n: 1 },
      },
    });

    const sink = new TestSubscriptionSink();
    await stream.stream.subscribe({ subscriptionKey: "replay", sink, replayAfterOffset: 0 });
    await waitFor(() => sink.batches.length === 1, 1_000);

    const second = await stream.stream.append({
      event: {
        type: "test.stream.capnweb-replay",
        payload: { n: 2 },
      },
    });
    await waitFor(() => sink.batches.length === 2, 1_000);
    const runtime = await stream.stream.runtimeState();

    expect(sink.batches).toEqual([
      [
        expect.objectContaining({
          type: "events.iterate.com/stream/created",
          offset: 1,
          payload: {
            namespace: runtime.state.core.namespace,
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
    await using stream = await connectStream(path);

    const sinkA = new TestSubscriptionSink();
    const sinkB = new TestSubscriptionSink();
    const first = await stream.stream.subscribe({ sink: sinkA });
    const second = await stream.stream.subscribe({ sink: sinkB });

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
    await waitFor(() => sinkA.batches.length === 1 && sinkB.batches.length === 1, 1_000);
    expect(sinkA.batches.at(-1)).toEqual([appended]);
    expect(sinkB.batches.at(-1)).toEqual([appended]);

    first.unsubscribe();
    await stream.stream.append({
      event: {
        type: "test.stream.capnweb-anon-sub-after-unsub",
        payload: { path },
      },
    });
    await waitFor(() => sinkB.batches.length === 2, 1_000);
    expect(sinkA.batches.length).toBe(1);
  });

  e2eIt("runs a built-in outbound processor from subscription-configured", async () => {
    const path = `stream-capnweb-processor-${crypto.randomUUID()}`;
    const subscriptionKey = "echo-example";
    await using stream = await connectStream(path);
    const runtime = await stream.stream.runtimeState();
    await using processor = await connectStreamProcessorRunner({
      url: toStreamProcessorRunnerWebSocketUrl(
        `${runtime.state.core.namespace}:${path}:${subscriptionKey}`,
      ),
    });

    const configured = await stream.stream.append({
      event: {
        type: "events.iterate.com/stream/subscription-configured",
        idempotencyKey: `subscription:${subscriptionKey}`,
        payload: {
          subscriptionKey,
          subscriber: {
            type: "built-in",
            transport: "capnweb-websocket",
            processorSlug: "echo-example",
          },
        },
      },
    });

    await waitFor(async () => {
      const status = await processor.rpc.runtimeState();
      return (
        status.processorSlug === "echo-example" &&
        status.snapshot?.offset === configured.offset &&
        (status.snapshot?.state as { seen: number } | undefined)?.seen === 0
      );
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

  localWorkerE2eIt(
    "runs an external-url capnweb websocket processor from a node server",
    async () => {
      const path = `stream-capnweb-node-runner-${crypto.randomUUID()}`;
      const subscriptionKey = "node-runner";
      const headerValue = crypto.randomUUID();
      const runner = new NodeStreamProcessorRunner();
      await using runnerServer = await startNodeStreamProcessorRunnerServer({
        port: externalRunnerPort,
        runner,
      });
      await using stream = await connectStream(path);

      const configured = await stream.stream.append({
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: `subscription:${subscriptionKey}`,
          payload: {
            subscriptionKey,
            subscriber: {
              type: "external-url",
              transport: "capnweb-websocket",
              url: runnerServer.url,
              headers: {
                "x-stream-test": headerValue,
              },
            },
          },
        },
      });

      await waitFor(
        () =>
          runner.subscriptionConfiguredEvent?.offset === configured.offset &&
          runner.streamRuntimeState?.state.core.path === path &&
          runner.requestHeaders.some((headers) => headers.get("x-stream-test") === headerValue),
        10_000,
      );

      const appended = await stream.stream.append({
        event: {
          type: "test.processor.node-runner-input",
          payload: { path },
        },
      });

      await waitFor(
        () =>
          runner.batches.some((batch) => batch.some((event) => event.offset === appended.offset)),
        10_000,
      );
      expect(runner.batches.flat()).toContainEqual(appended);
    },
  );

  cloudflaredE2eIt(
    "runs an external-url capnweb websocket processor through cloudflared",
    async () => {
      const path = `stream-capnweb-cloudflared-${crypto.randomUUID()}`;
      const subscriptionKey = "cloudflared";
      const headerValue = crypto.randomUUID();
      const runner = new NodeStreamProcessorRunner();
      await using runnerServer = await startNodeStreamProcessorRunnerServer({
        port: externalRunnerPort,
        runner,
      });
      await using tunnel = await startCloudflaredTunnel(runnerServer.url);
      await using stream = await connectStream(path);

      const configured = await stream.stream.append({
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: `subscription:${subscriptionKey}`,
          payload: {
            subscriptionKey,
            subscriber: {
              type: "external-url",
              transport: "capnweb-websocket",
              url: tunnel.url,
              headers: {
                "x-stream-test": headerValue,
              },
            },
          },
        },
      });

      await waitFor(
        () =>
          runner.subscriptionConfiguredEvent?.offset === configured.offset &&
          runner.streamRuntimeState?.state.core.path === path &&
          runner.requestHeaders.some((headers) => headers.get("x-stream-test") === headerValue),
        10_000,
      );

      const appended = await stream.stream.append({
        event: {
          type: "test.processor.cloudflared-input",
          payload: { path },
        },
      });

      await waitFor(
        () =>
          runner.batches.some((batch) => batch.some((event) => event.offset === appended.offset)),
        10_000,
      );
      expect(runner.batches.flat()).toContainEqual(appended);
    },
    // Quick-tunnel startup + edge-registration + propagation buffer exceeds the
    // file's default 30s test timeout before the assertions even begin.
    90_000,
  );

  e2eIt("delivers event batches without subscriber-originated return traffic", async () => {
    const path = `stream-capnweb-wire-${crypto.randomUUID()}`;
    const sink = new TestSubscriptionSink();

    await using subscriber = await connectStream(path);
    await subscriber.stream.subscribe({
      subscriptionKey: "wire",
      sink,
      replayAfterOffset: 2,
    });
    const afterSubscribe = subscriber.wsMessages.length;

    await using publisher = await connectStream(path);
    const input: StreamEventInput = {
      type: "test.stream.capnweb-wire",
      payload: { path },
    };
    const appended = await publisher.stream.append({ event: input });
    await waitFor(() => sink.batches.length === 1, 1_000);

    expect(appended).toMatchObject({
      type: input.type,
      payload: input.payload,
      offset: 3,
      createdAt: expect.any(String),
    });
    expect(sink.batches).toEqual([[appended]]);
    expect(outboundFrames(subscriber.wsMessages, afterSubscribe)).toEqual([]);

    const inbound = parsedFrames(subscriber.wsMessages)
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
            ["processEventBatch"],
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

async function startNodeStreamProcessorRunnerServer(args: {
  port: number;
  runner: NodeStreamProcessorRunner;
}): Promise<
  AsyncDisposable & {
    url: string;
  }
> {
  const sessions = new Set<Disposable>();
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: args.port,
  });

  server.on("connection", (socket: WsWebSocket, request: IncomingMessage) => {
    args.runner.requestHeaders.push(headersFromIncomingMessage(request));
    const session = newWebSocketRpcSession(socket as unknown as globalThis.WebSocket, args.runner);
    sessions.add(session);
    socket.once("close", () => {
      sessions.delete(session);
      session[Symbol.dispose]();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`unexpected WebSocket server address: ${String(address)}`);
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    async [Symbol.asyncDispose]() {
      for (const session of sessions) session[Symbol.dispose]();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

function headersFromIncomingMessage(request: IncomingMessage) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

async function startCloudflaredTunnel(originUrl: string): Promise<
  AsyncDisposable & {
    url: string;
  }
> {
  const child = spawn("cloudflared", ["tunnel", "--url", originUrl, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  const url = await waitForCloudflaredUrl(child, output);
  // cloudflared prints the quick-tunnel URL ~1s before it registers an edge
  // connection, and a freshly registered quick tunnel still 530s for a few more
  // seconds while edge routing propagates. The stream worker dials the subscriber
  // URL exactly once when `subscription-configured` is appended (reconciliation
  // only re-dials on a topology change or RPC break), so that single dial must
  // land on an already-routable tunnel. We wait for the edge registration log,
  // then a propagation buffer. (We can't poll the URL from here: the test host's
  // resolver does not resolve fresh *.trycloudflare.com names, while the deployed
  // worker reaches them through Cloudflare's own resolver.)
  await waitForCloudflaredRegistered(child, output);
  await new Promise((resolve) => setTimeout(resolve, 8_000));

  return {
    url,
    async [Symbol.asyncDispose]() {
      child.kill();
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(resolve, 1_000);
      });
    },
  };
}

async function waitForCloudflaredUrl(
  child: ChildProcessByStdio<null, Readable, Readable>,
  output: string[],
): Promise<string> {
  const urlPattern = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for cloudflared URL:\n${output.join("")}`));
    }, 20_000);

    const onData = (data: Buffer) => {
      const text = data.toString("utf8");
      output.push(text);
      const url = text.match(urlPattern)?.[0] ?? output.join("").match(urlPattern)?.[0];
      if (url === undefined) return;
      cleanup();
      resolve(url);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `cloudflared exited before URL (code=${code}, signal=${signal}):\n${output.join("")}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

async function waitForCloudflaredRegistered(
  child: ChildProcessByStdio<null, Readable, Readable>,
  output: string[],
): Promise<void> {
  const registeredPattern = /Registered tunnel connection/;
  if (output.join("").match(registeredPattern)) return;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for cloudflared edge connection:\n${output.join("")}`));
    }, 20_000);

    const onData = (data: Buffer) => {
      const text = data.toString("utf8");
      output.push(text);
      if (!text.match(registeredPattern)) return;
      cleanup();
      resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `cloudflared exited before registering (code=${code}, signal=${signal}):\n${output.join("")}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

async function connectStream(path: string): Promise<
  AsyncDisposable & {
    stream: RpcStub<StreamRpc>;
    wsMessages: WsMessage[];
  }
> {
  const wsMessages: WsMessage[] = [];
  const webSocket = newRecordingWebSocket(toStreamWebSocketUrl(path), wsMessages);
  await waitForWebSocketOpen(webSocket);
  const stream = newWebSocketRpcSession<StreamRpc>(webSocket as unknown as globalThis.WebSocket);

  return {
    stream,
    wsMessages,
    async [Symbol.asyncDispose]() {
      stream[Symbol.dispose]();
      await closeWebSocket(webSocket);
    },
  };
}

function newRecordingWebSocket(url: string, wsMessages: WsMessage[]) {
  const webSocket = new WebSocket(url);
  const send = webSocket.send.bind(webSocket);

  webSocket.send = ((data: Parameters<WebSocket["send"]>[0]) => {
    wsMessages.push({ direction: "out", data: describeWebSocketFrameData(data) });
    return send(data);
  }) as WebSocket["send"];

  webSocket.addEventListener("message", (event) => {
    wsMessages.push({ direction: "in", data: describeWebSocketFrameData(event.data) });
  });

  return webSocket;
}

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

function toStreamProcessorRunnerWebSocketUrl(path: string) {
  const url = new URL(workerUrl);
  url.pathname = `/stream-processor-runner/${path}`;
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

function parsedFrames(messages: WsMessage[]) {
  return messages.map((frame) => ({
    direction: frame.direction,
    data: JSON.parse(frame.data) as unknown,
  }));
}

function outboundFrames(messages: WsMessage[], afterFrameIndex: number) {
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

function describeWebSocketFrameData(data: unknown) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  throw new TypeError(`unexpected WebSocket frame data: ${String(data)}`);
}

function waitForWebSocketOpen(webSocket: WebSocket) {
  if (webSocket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    webSocket.addEventListener("open", () => resolve(), { once: true });
    webSocket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
      once: true,
    });
  });
}

function closeWebSocket(webSocket: WebSocket) {
  if (webSocket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve) => {
    webSocket.addEventListener("close", () => resolve(), { once: true });
    webSocket.close();
  });
}

async function waitFor(assertion: () => boolean | Promise<boolean>, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}
