import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { defineProcessor } from "../../events/src/durable-objects/define-processor.ts";
import {
  PullSubscriptionPatternProcessorRuntime,
  PullSubscriptionProcessorRuntime,
} from "./sdk.ts";
import {
  StreamPath,
  type Event,
  type EventInput,
  type JSONObject,
  type StreamPath as StreamPathType,
} from "./types.ts";

async function testSharedProcessorDefinitionKeepsPerRuntimeState() {
  const processor = defineProcessor<{ processorInstanceId: number }>(() => ({
    slug: "factory-test",
    initialState: {
      processorInstanceId: 0,
    },
    reduce: ({ event, state }) => {
      if (event.type !== "tick") {
        return state;
      }

      return {
        processorInstanceId: event.offset,
      };
    },
  }));

  const client = new MockEventsClient({
    [StreamPath.parse("/one")]: [
      makeInitializedEvent({ streamPath: StreamPath.parse("/one"), offset: 1 }),
      makeGenericEvent({
        streamPath: StreamPath.parse("/one"),
        offset: 2,
        type: "tick",
        payload: { source: "one" },
      }),
    ],
    [StreamPath.parse("/two")]: [
      makeInitializedEvent({ streamPath: StreamPath.parse("/two"), offset: 1 }),
      makeGenericEvent({
        streamPath: StreamPath.parse("/two"),
        offset: 9,
        type: "tick",
        payload: { source: "two" },
      }),
    ],
  });

  const firstRuntime = new PullSubscriptionProcessorRuntime({
    eventsClient: client,
    processor,
    streamPath: StreamPath.parse("/one"),
  });
  const secondRuntime = new PullSubscriptionProcessorRuntime({
    eventsClient: client,
    processor,
    streamPath: StreamPath.parse("/two"),
  });

  assert.equal(firstRuntime.getState().processorInstanceId, 0);
  assert.equal(secondRuntime.getState().processorInstanceId, 0);

  const firstRunPromise = firstRuntime.run();
  const secondRunPromise = secondRuntime.run();

  await client.waitForLiveSubscription(StreamPath.parse("/one"));
  await client.waitForLiveSubscription(StreamPath.parse("/two"));

  firstRuntime.stop();
  secondRuntime.stop();

  await firstRunPromise;
  await secondRunPromise;

  assert.equal(firstRuntime.getState().processorInstanceId, 2);
  assert.equal(secondRuntime.getState().processorInstanceId, 9);
  assert.notEqual(
    firstRuntime.getState().processorInstanceId,
    secondRuntime.getState().processorInstanceId,
  );
}

async function testPatternRuntimeWatchesExistingAndNewMatchingStreamsOnly() {
  const rootPath = StreamPath.parse("/");
  const teamAPath = StreamPath.parse("/team/a");
  const teamBPath = StreamPath.parse("/team/b");
  const teamCPath = StreamPath.parse("/team/c");
  const teamDeepPath = StreamPath.parse("/team/a/deep");
  const teamBDeepPath = StreamPath.parse("/team/b/deep");
  const otherPath = StreamPath.parse("/other/x");
  const otherLaterPath = StreamPath.parse("/other/y");

  const client = new MockEventsClient({
    [rootPath]: [
      makeInitializedEvent({ streamPath: rootPath, offset: 1 }),
      makeChildStreamCreatedEvent({ offset: 2, childPath: teamAPath }),
      makeChildStreamCreatedEvent({ offset: 3, childPath: otherPath }),
    ],
    [teamAPath]: [
      makeInitializedEvent({ streamPath: teamAPath, offset: 1 }),
      makeGenericEvent({
        streamPath: teamAPath,
        offset: 2,
        type: "tick",
        payload: { source: "history" },
      }),
    ],
    [teamBPath]: [makeInitializedEvent({ streamPath: teamBPath, offset: 1 })],
    [teamCPath]: [makeInitializedEvent({ streamPath: teamCPath, offset: 1 })],
    [teamDeepPath]: [makeInitializedEvent({ streamPath: teamDeepPath, offset: 1 })],
    [teamBDeepPath]: [makeInitializedEvent({ streamPath: teamBDeepPath, offset: 1 })],
    [otherPath]: [makeInitializedEvent({ streamPath: otherPath, offset: 1 })],
    [otherLaterPath]: [makeInitializedEvent({ streamPath: otherLaterPath, offset: 1 })],
  });

  const runtime = new PullSubscriptionPatternProcessorRuntime({
    eventsClient: client,
    streamPattern: "/team/*",
    processor: defineProcessor<{ tickCount: number }>(() => ({
      slug: "pattern-test",
      initialState: { tickCount: 0 },
      reduce: ({ event, state }) => {
        if (event.type !== "tick") {
          return state;
        }

        return { tickCount: state.tickCount + 1 };
      },
      afterAppend: async ({ append, event, state }) => {
        if (event.type !== "tick") {
          return;
        }

        await append({
          type: "processed",
          payload: {
            sourceOffset: event.offset,
            tickCount: state.tickCount,
          },
        });
      },
    })),
  });

  const runPromise = runtime.run();

  await client.waitForLiveSubscription(rootPath);
  await client.waitForLiveSubscription(teamAPath);

  assert.deepEqual(runtime.getStreamPaths(), [teamAPath]);
  assert.equal(client.getLiveSubscriptionCount(otherPath), 0);
  assert.equal(client.getLiveSubscriptionCount(teamDeepPath), 0);

  client.emit(
    teamAPath,
    makeGenericEvent({
      streamPath: teamAPath,
      offset: 3,
      type: "tick",
      payload: { source: "live-a" },
    }),
  );

  await client.waitForAppendCount(1);

  assert.deepEqual(
    client.appended.map((entry) => entry.path),
    [teamAPath],
  );

  client.emit(rootPath, makeChildStreamCreatedEvent({ offset: 4, childPath: teamBPath }));
  client.emit(rootPath, makeChildStreamCreatedEvent({ offset: 5, childPath: teamDeepPath }));
  client.emit(rootPath, makeChildStreamCreatedEvent({ offset: 6, childPath: otherLaterPath }));
  client.emit(rootPath, makeChildStreamCreatedEvent({ offset: 7, childPath: teamCPath }));
  client.emit(rootPath, makeChildStreamCreatedEvent({ offset: 8, childPath: teamBDeepPath }));

  await client.waitForLiveSubscription(teamBPath);
  await client.waitForLiveSubscription(teamCPath);

  assert.deepEqual(runtime.getStreamPaths(), [teamAPath, teamBPath, teamCPath]);
  assert.equal(client.getLiveSubscriptionCount(teamDeepPath), 0);
  assert.equal(client.getLiveSubscriptionCount(teamBDeepPath), 0);
  assert.equal(client.getLiveSubscriptionCount(otherPath), 0);
  assert.equal(client.getLiveSubscriptionCount(otherLaterPath), 0);

  client.emit(
    teamBPath,
    makeGenericEvent({
      streamPath: teamBPath,
      offset: 2,
      type: "tick",
      payload: { source: "live-b" },
    }),
  );
  client.emit(
    teamCPath,
    makeGenericEvent({
      streamPath: teamCPath,
      offset: 2,
      type: "tick",
      payload: { source: "live-c" },
    }),
  );
  client.emit(
    teamDeepPath,
    makeGenericEvent({
      streamPath: teamDeepPath,
      offset: 2,
      type: "tick",
      payload: { source: "live-deep-a" },
    }),
  );
  client.emit(
    teamBDeepPath,
    makeGenericEvent({
      streamPath: teamBDeepPath,
      offset: 2,
      type: "tick",
      payload: { source: "live-deep-b" },
    }),
  );
  client.emit(
    otherLaterPath,
    makeGenericEvent({
      streamPath: otherLaterPath,
      offset: 2,
      type: "tick",
      payload: { source: "live-other" },
    }),
  );

  await client.waitForAppendCount(3);
  await delay(25);

  assert.deepEqual(client.appended.map((entry) => entry.path).sort(), [
    teamAPath,
    teamBPath,
    teamCPath,
  ]);
  assert.equal(runtime.getState(teamDeepPath), undefined);
  assert.equal(runtime.getState(teamBDeepPath), undefined);
  assert.equal(runtime.getState(otherPath), undefined);
  assert.equal(runtime.getState(otherLaterPath), undefined);
  assert.deepEqual(
    client.appended.map((entry) => ({
      path: entry.path,
      type: entry.event.type,
      payload: entry.event.payload,
    })),
    [
      {
        path: teamAPath,
        type: "processed",
        payload: {
          sourceOffset: 3,
          tickCount: 2,
        },
      },
      {
        path: teamBPath,
        type: "processed",
        payload: {
          sourceOffset: 2,
          tickCount: 1,
        },
      },
      {
        path: teamCPath,
        type: "processed",
        payload: {
          sourceOffset: 2,
          tickCount: 1,
        },
      },
    ],
  );

  runtime.stop();
  await runPromise;
}

class MockEventsClient {
  appended: Array<{ path: StreamPathType; event: Event }> = [];
  #eventsByPath: Map<StreamPathType, Event[]>;
  #liveSubscribers = new Map<StreamPathType, Set<(event: Event) => void>>();

  constructor(seedEventsByPath: Record<StreamPathType, Event[]>) {
    this.#eventsByPath = new Map(
      Object.entries(seedEventsByPath) as Array<[StreamPathType, Event[]]>,
    );
  }

  async append(input: { path: StreamPathType; event: EventInput }) {
    const nextOffset =
      (this.#eventsByPath.get(input.path)?.at(-1)?.offset ?? 0) + this.appended.length + 1;
    const event = makeEvent({
      streamPath: input.path,
      offset: nextOffset,
      type: input.event.type,
      payload: input.event.payload,
      metadata: input.event.metadata,
      idempotencyKey: input.event.idempotencyKey,
    });
    this.appended.push({ path: input.path, event });
    return { event };
  }

  async stream(
    input: { path: StreamPathType; offset?: number; live?: boolean },
    options: { signal?: AbortSignal },
  ) {
    const history = (this.#eventsByPath.get(input.path) ?? []).filter(
      (event) => event.offset > (input.offset ?? 0),
    );

    return this.#iterate({
      history,
      live: input.live === true,
      path: input.path,
      signal: options.signal,
    });
  }

  emit(path: StreamPathType, event: Event) {
    const subscribers = this.#liveSubscribers.get(path);
    if (subscribers == null) {
      return;
    }

    for (const subscriber of subscribers) {
      subscriber(event);
    }
  }

  async waitForLiveSubscription(path: StreamPathType, count = 1) {
    await waitFor(() => (this.#liveSubscribers.get(path)?.size ?? 0) >= count);
  }

  getLiveSubscriptionCount(path: StreamPathType) {
    return this.#liveSubscribers.get(path)?.size ?? 0;
  }

  async waitForAppendCount(count: number) {
    await waitFor(() => this.appended.length >= count);
  }

  async *#iterate(args: {
    history: Event[];
    live: boolean;
    path: StreamPathType;
    signal?: AbortSignal;
  }): AsyncIterable<Event> {
    for (const event of args.history) {
      yield event;
    }

    if (!args.live) {
      return;
    }

    const queue: Event[] = [];
    let notifyNext: (() => void) | undefined;
    const onEvent = (event: Event) => {
      queue.push(event);
      notifyNext?.();
      notifyNext = undefined;
    };

    const subscribers = this.#liveSubscribers.get(args.path) ?? new Set<(event: Event) => void>();
    subscribers.add(onEvent);
    this.#liveSubscribers.set(args.path, subscribers);

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }

        await waitForLiveEvent({
          signal: args.signal,
          onReady: (resolve) => (notifyNext = resolve),
        });
      }
    } finally {
      const liveSubscribers = this.#liveSubscribers.get(args.path);
      liveSubscribers?.delete(onEvent);
      if (liveSubscribers?.size === 0) {
        this.#liveSubscribers.delete(args.path);
      }
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }

    await delay(10);
  }
}

async function waitForLiveEvent(args: {
  signal?: AbortSignal;
  onReady: (resolve: () => void) => void;
}) {
  if (args.signal?.aborted) {
    throw abortError();
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      reject(abortError());
    };

    args.signal?.addEventListener("abort", onAbort, { once: true });
    args.onReady(() => {
      args.signal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

function makeInitializedEvent(args: { streamPath: StreamPathType; offset: number }): Event {
  return makeEvent({
    streamPath: args.streamPath,
    offset: args.offset,
    type: "https://events.iterate.com/events/stream/initialized",
    payload: {
      projectSlug: "public",
      path: args.streamPath,
    },
  });
}

function makeChildStreamCreatedEvent(args: { offset: number; childPath: StreamPathType }): Event {
  return makeEvent({
    streamPath: StreamPath.parse("/"),
    offset: args.offset,
    type: "https://events.iterate.com/events/stream/child-stream-created",
    payload: {
      childPath: args.childPath,
    },
  });
}

function makeGenericEvent(args: {
  streamPath: StreamPathType;
  offset: number;
  type: string;
  payload: Record<string, string>;
}): Event {
  return makeEvent(args);
}

function makeEvent(args: {
  streamPath: StreamPathType;
  offset: number;
  type: string;
  payload: JSONObject;
  metadata?: JSONObject;
  idempotencyKey?: string;
}): Event {
  return {
    streamPath: args.streamPath,
    offset: args.offset,
    type: args.type,
    payload: args.payload,
    metadata: args.metadata,
    idempotencyKey: args.idempotencyKey,
    createdAt: new Date(args.offset * 1_000).toISOString(),
  };
}

await testSharedProcessorDefinitionKeepsPerRuntimeState();
await testPatternRuntimeWatchesExistingAndNewMatchingStreamsOnly();
