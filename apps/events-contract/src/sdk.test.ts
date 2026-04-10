import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  defineProcessor,
  type ProcessorLogger,
  PullProcessorRuntime,
  PushSubscriptionProcessorRuntime,
} from "./sdk.ts";
import {
  Event as EventSchema,
  StreamPath,
  type Event,
  type EventInput,
  type StreamCursor,
  type StreamPath as StreamPathType,
} from "./types.ts";

const silentLogger = createSilentLogger();

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

  const firstRuntime = new PullProcessorRuntime({
    eventsClient: client,
    includeChildren: false,
    logger: silentLogger,
    processor,
    path: "/one",
  });
  const secondRuntime = new PullProcessorRuntime({
    eventsClient: client,
    includeChildren: false,
    logger: silentLogger,
    processor,
    path: "/two",
  });

  assert.equal(firstRuntime.getState()!.processorInstanceId, 0);
  assert.equal(secondRuntime.getState()!.processorInstanceId, 0);

  const firstRunPromise = firstRuntime.run();
  const secondRunPromise = secondRuntime.run();

  await client.waitForLiveSubscription(StreamPath.parse("/one"));
  await client.waitForLiveSubscription(StreamPath.parse("/two"));

  firstRuntime.stop();
  secondRuntime.stop();

  await firstRunPromise;
  await secondRunPromise;

  assert.equal(firstRuntime.getState()!.processorInstanceId, 2);
  assert.equal(secondRuntime.getState()!.processorInstanceId, 9);
  assert.notEqual(
    firstRuntime.getState()!.processorInstanceId,
    secondRuntime.getState()!.processorInstanceId,
  );
}

async function testStatelessProcessorCanOmitInitialState() {
  const streamPath = StreamPath.parse("/stateless");
  let afterAppendStateSeen: undefined | "unset" = "unset";
  const client = new MockEventsClient({
    [streamPath]: [makeInitializedEvent({ streamPath, offset: 1 })],
  });

  const runtime = new PullProcessorRuntime({
    eventsClient: client,
    includeChildren: false,
    logger: silentLogger,
    processor: defineProcessor(() => ({
      slug: "stateless",
      async afterAppend({ append, event, state }) {
        afterAppendStateSeen = state;
        if (event.type !== "tick") {
          return;
        }

        await append({
          event: {
            type: "processed",
            payload: { sourceOffset: event.offset },
          },
        });
      },
    })),
    path: streamPath,
  });

  assert.equal(runtime.getState(), undefined);

  const runPromise = runtime.run();
  await client.waitForLiveSubscription(streamPath);
  client.emit(
    streamPath,
    makeGenericEvent({
      streamPath,
      offset: 2,
      type: "tick",
      payload: { source: "live" },
    }),
  );

  await client.waitForAppendCount(1);
  runtime.stop();
  await runPromise;

  assert.equal(afterAppendStateSeen, undefined);
  assert.equal(runtime.getState(), undefined);
}

async function testReducerCanSkipReturningState() {
  const streamPath = StreamPath.parse("/reduce-optional-return");
  const client = new MockEventsClient({
    [streamPath]: [makeInitializedEvent({ streamPath, offset: 1 })],
  });

  const runtime = new PullProcessorRuntime({
    eventsClient: client,
    includeChildren: false,
    logger: silentLogger,
    processor: defineProcessor<{ count: number }>(() => ({
      slug: "reduce-optional-return",
      initialState: { count: 0 },
      reduce: ({ event, state }) => {
        if (event.type === "tick") {
          return { count: state.count + 1 };
        }
      },
    })),
    path: streamPath,
  });

  const runPromise = runtime.run();
  await client.waitForLiveSubscription(streamPath);

  client.emit(
    streamPath,
    makeGenericEvent({
      streamPath,
      offset: 2,
      type: "noop",
      payload: {},
    }),
  );
  client.emit(
    streamPath,
    makeGenericEvent({
      streamPath,
      offset: 3,
      type: "tick",
      payload: {},
    }),
  );

  await waitFor(() => runtime.getState()!.count === 1);
  runtime.stop();
  await runPromise;

  assert.deepEqual(runtime.getState(), { count: 1 });
}

async function testIncludeChildrenWatchesExistingAndNewDescendantStreams() {
  const teamPath = StreamPath.parse("/team");
  const teamAPath = StreamPath.parse("/team/a");
  const teamBPath = StreamPath.parse("/team/b");
  const teamCPath = StreamPath.parse("/team/c");
  const teamDeepPath = StreamPath.parse("/team/a/deep");
  const teamBDeepPath = StreamPath.parse("/team/b/deep");

  const client = new MockEventsClient({
    [teamPath]: [
      makeInitializedEvent({ streamPath: teamPath, offset: 1 }),
      makeChildStreamCreatedEvent({ offset: 2, childPath: teamAPath, streamPath: teamPath }),
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
  });

  const runtime = new PullProcessorRuntime({
    eventsClient: client,
    logger: silentLogger,
    path: "/team",
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
          event: {
            type: "processed",
            payload: {
              sourceOffset: event.offset,
              tickCount: state.tickCount,
            },
          },
        });
      },
    })),
  });

  const runPromise = runtime.run();

  await client.waitForLiveSubscription(teamPath, 2);
  await client.waitForLiveSubscription(teamAPath);

  assert.deepEqual(runtime.getStreamPaths(), [teamPath, teamAPath]);
  assert.equal(client.getLiveSubscriptionCount(teamPath), 2);

  client.emit(
    teamPath,
    makeGenericEvent({
      streamPath: teamPath,
      offset: 3,
      type: "tick",
      payload: { source: "live-root" },
    }),
  );

  await client.waitForAppendCount(1);

  assert.deepEqual(
    client.appended.map((entry) => entry.path),
    [teamPath],
  );
  assert.deepEqual(runtime.getState(teamPath), { tickCount: 1 });

  client.emit(
    teamAPath,
    makeGenericEvent({
      streamPath: teamAPath,
      offset: 3,
      type: "tick",
      payload: { source: "live-a" },
    }),
  );

  await client.waitForAppendCount(2);

  assert.deepEqual(
    client.appended.map((entry) => entry.path),
    [teamPath, teamAPath],
  );

  client.emit(
    teamPath,
    makeChildStreamCreatedEvent({ offset: 4, childPath: teamBPath, streamPath: teamPath }),
  );
  client.emit(
    teamPath,
    makeChildStreamCreatedEvent({ offset: 5, childPath: teamDeepPath, streamPath: teamPath }),
  );
  client.emit(
    teamPath,
    makeChildStreamCreatedEvent({ offset: 6, childPath: teamCPath, streamPath: teamPath }),
  );
  client.emit(
    teamPath,
    makeChildStreamCreatedEvent({ offset: 7, childPath: teamBDeepPath, streamPath: teamPath }),
  );

  await client.waitForLiveSubscription(teamBPath);
  await client.waitForLiveSubscription(teamDeepPath);
  await client.waitForLiveSubscription(teamCPath);
  await client.waitForLiveSubscription(teamBDeepPath);

  assert.deepEqual(runtime.getStreamPaths(), [
    teamPath,
    teamAPath,
    teamDeepPath,
    teamBPath,
    teamBDeepPath,
    teamCPath,
  ]);
  assert.equal(client.getLiveSubscriptionCount(teamDeepPath), 1);
  assert.equal(client.getLiveSubscriptionCount(teamBDeepPath), 1);

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

  await client.waitForAppendCount(6);
  await delay(25);

  assert.deepEqual(client.appended.map((entry) => entry.path).sort(), [
    teamPath,
    teamAPath,
    teamDeepPath,
    teamBPath,
    teamBDeepPath,
    teamCPath,
  ]);
  assert.deepEqual(runtime.getState(teamPath), { tickCount: 1 });
  assert.deepEqual(runtime.getState(teamDeepPath), { tickCount: 1 });
  assert.deepEqual(runtime.getState(teamBDeepPath), { tickCount: 1 });
  assert.deepEqual(
    client.appended
      .map((entry) => ({
        path: entry.path,
        type: entry.event.type,
        payload: entry.event.payload,
      }))
      .toSorted((left, right) => left.path.localeCompare(right.path)),
    [
      {
        path: teamPath,
        type: "processed",
        payload: {
          sourceOffset: 3,
          tickCount: 1,
        },
      },
      {
        path: teamAPath,
        type: "processed",
        payload: {
          sourceOffset: 3,
          tickCount: 2,
        },
      },
      {
        path: teamDeepPath,
        type: "processed",
        payload: {
          sourceOffset: 2,
          tickCount: 1,
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
        path: teamBDeepPath,
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

async function testLiveDiscoveredFreshChildReplaysRecentHistoryAfterAppendWithPerEventState() {
  const teamPath = StreamPath.parse("/team");
  const freshChildPath = StreamPath.parse("/team/fresh");
  const recentCreatedAt = new Date().toISOString();
  const client = new MockEventsClient({
    [teamPath]: [makeInitializedEvent({ streamPath: teamPath, offset: 1 })],
    [freshChildPath]: [
      makeInitializedEvent({
        streamPath: freshChildPath,
        offset: 1,
        createdAt: recentCreatedAt,
      }),
      makeGenericEvent({
        streamPath: freshChildPath,
        offset: 2,
        type: "tick",
        payload: { source: "history-1" },
        createdAt: recentCreatedAt,
      }),
      makeGenericEvent({
        streamPath: freshChildPath,
        offset: 3,
        type: "tick",
        payload: { source: "history-2" },
        createdAt: recentCreatedAt,
      }),
    ],
  });

  const runtime = new PullProcessorRuntime({
    eventsClient: client,
    logger: silentLogger,
    path: "/team",
    processor: defineProcessor<{ tickCount: number }>(() => ({
      slug: "fresh-child-history-replay",
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
          event: {
            type: "processed",
            payload: {
              sourceOffset: event.offset,
              tickCount: state.tickCount,
            },
          },
        });
      },
    })),
  });

  const runPromise = runtime.run();

  await client.waitForLiveSubscription(teamPath, 2);
  client.emit(
    teamPath,
    makeChildStreamCreatedEvent({
      offset: 2,
      childPath: freshChildPath,
      streamPath: teamPath,
    }),
  );

  await client.waitForLiveSubscription(freshChildPath);
  await client.waitForAppendCount(2);

  assert.deepEqual(
    client.appended.map((entry) => ({
      path: entry.path,
      type: entry.event.type,
      payload: entry.event.payload,
    })),
    [
      {
        path: freshChildPath,
        type: "processed",
        payload: {
          sourceOffset: 2,
          tickCount: 1,
        },
      },
      {
        path: freshChildPath,
        type: "processed",
        payload: {
          sourceOffset: 3,
          tickCount: 2,
        },
      },
    ],
  );
  assert.deepEqual(runtime.getState(freshChildPath), { tickCount: 2 });

  runtime.stop();
  await runPromise;
}

async function testProcessorAppendResolvesCurrentAbsoluteAndRelativePaths() {
  const teamAPath = StreamPath.parse("/team/a");
  const client = new MockEventsClient({
    [teamAPath]: [makeInitializedEvent({ streamPath: teamAPath, offset: 1 })],
  });

  const runtime = new PullProcessorRuntime({
    eventsClient: client,
    includeChildren: false,
    logger: silentLogger,
    processor: defineProcessor(() => ({
      slug: "append-paths",
      initialState: null,
      async afterAppend({ append, event }) {
        if (event.type !== "tick") {
          return;
        }

        await append({
          event: { type: "same-stream", payload: {} },
        });
        await append({
          path: ".",
          event: { type: "same-stream-dot", payload: {} },
        });
        await append({
          path: "./child",
          event: { type: "child-stream", payload: {} },
        });
        await append({
          path: "../",
          event: { type: "parent-stream", payload: {} },
        });
        await append({
          path: "/elsewhere",
          event: { type: "absolute-stream", payload: {} },
        });
      },
    })),
    path: teamAPath,
  });

  const runPromise = runtime.run();

  await client.waitForLiveSubscription(teamAPath);

  client.emit(
    teamAPath,
    makeGenericEvent({
      streamPath: teamAPath,
      offset: 2,
      type: "tick",
      payload: { source: "live" },
    }),
  );

  await client.waitForAppendCount(5);

  assert.deepEqual(
    client.appended.map((entry) => entry.path),
    [
      teamAPath,
      teamAPath,
      StreamPath.parse("/team/a/child"),
      StreamPath.parse("/team"),
      StreamPath.parse("/elsewhere"),
    ],
  );

  runtime.stop();
  await runPromise;
}

async function testProcessorAppendRejectsInvalidRelativePaths() {
  const rootPath = StreamPath.parse("/");
  const childPath = StreamPath.parse("/team/a");

  const invalidRelativeClient = new MockEventsClient({
    [childPath]: [makeInitializedEvent({ streamPath: childPath, offset: 1 })],
  });
  const invalidRelativeRuntime = new PullProcessorRuntime({
    eventsClient: invalidRelativeClient,
    includeChildren: false,
    logger: silentLogger,
    processor: defineProcessor(() => ({
      slug: "invalid-relative",
      initialState: null,
      async afterAppend({ append, event }) {
        if (event.type !== "tick") {
          return;
        }

        await append({
          path: "child" as never,
          event: { type: "unreachable", payload: {} },
        });
      },
    })),
    path: childPath,
  });

  const invalidRelativeRunPromise = invalidRelativeRuntime.run();
  await invalidRelativeClient.waitForLiveSubscription(childPath);
  invalidRelativeClient.emit(
    childPath,
    makeGenericEvent({
      streamPath: childPath,
      offset: 2,
      type: "tick",
      payload: { source: "live" },
    }),
  );

  await assert.rejects(invalidRelativeRunPromise, /append path must be absolute or dot-relative/);
  assert.equal(invalidRelativeClient.appended.length, 0);

  const aboveRootClient = new MockEventsClient({
    [rootPath]: [makeInitializedEvent({ streamPath: rootPath, offset: 1 })],
  });
  const aboveRootRuntime = new PullProcessorRuntime({
    eventsClient: aboveRootClient,
    includeChildren: false,
    logger: silentLogger,
    processor: defineProcessor(() => ({
      slug: "above-root",
      initialState: null,
      async afterAppend({ append, event }) {
        if (event.type !== "tick") {
          return;
        }

        await append({
          path: "../",
          event: { type: "unreachable", payload: {} },
        });
      },
    })),
    path: rootPath,
  });

  const aboveRootRunPromise = aboveRootRuntime.run();
  await aboveRootClient.waitForLiveSubscription(rootPath);
  aboveRootClient.emit(
    rootPath,
    makeGenericEvent({
      streamPath: rootPath,
      offset: 2,
      type: "tick",
      payload: { source: "live" },
    }),
  );

  await assert.rejects(aboveRootRunPromise, /append path cannot walk above root/);
  assert.equal(aboveRootClient.appended.length, 0);
}

async function testProcessorRuntimeStopDuringHistoryDoesNotEnterLivePhase() {
  const client = new SlowHistoryEventsClient(StreamPath.parse("/history"));
  const runtime = new PullProcessorRuntime({
    eventsClient: client,
    includeChildren: false,
    logger: silentLogger,
    processor: defineProcessor<{ seen: number }>(() => ({
      slug: "history-stop",
      initialState: { seen: 0 },
      reduce: ({ event, state }) => (event.type === "tick" ? { seen: state.seen + 1 } : state),
    })),
    path: "/history",
  });

  const runPromise = runtime.run();

  await client.waitForHistoryStart();
  runtime.stop();
  await runPromise;

  assert.equal(client.liveStreamStarted, false);
}

async function testPushRuntimeCatchesUpAndAppendsWithCanonicalProcessorContract() {
  const streamPath = StreamPath.parse("/push/demo");
  const client = new MockEventsClient({
    [streamPath]: [
      makeInitializedEvent({ streamPath, offset: 1 }),
      makeGenericEvent({
        streamPath,
        offset: 2,
        type: "tick",
        payload: { source: "history" },
      }),
      makeGenericEvent({
        streamPath,
        offset: 3,
        type: "tick",
        payload: { source: "history" },
      }),
    ],
  });

  const runtime = new PushSubscriptionProcessorRuntime({
    eventsClient: client,
    processor: defineProcessor<{ count: number }>(() => ({
      slug: "push-runtime",
      initialState: { count: 0 },
      reduce: ({ event, state }) => (event.type === "tick" ? { count: state.count + 1 } : state),
      async afterAppend({ append, event, state }) {
        if (event.type !== "tick") {
          return;
        }

        await append({
          event: {
            type: "processed",
            payload: {
              sourceOffset: event.offset,
              tickCount: state.count,
            },
          },
        });
      },
    })),
    streamPath,
  });

  await runtime.consume(
    makeGenericEvent({
      streamPath,
      offset: 4,
      type: "tick",
      payload: { source: "live" },
    }),
  );

  assert.deepEqual(runtime.getState(), { count: 3 });
  assert.deepEqual(client.appended, [
    {
      path: streamPath,
      event: makeEvent({
        streamPath,
        offset: 4,
        type: "processed",
        payload: {
          sourceOffset: 4,
          tickCount: 3,
        },
      }),
    },
  ]);
}

async function testPushRuntimeSerializesOutOfOrderDeliveriesWithoutDoubleReducingHistory() {
  const streamPath = StreamPath.parse("/push/ordered");
  const client = new MockEventsClient({
    [streamPath]: [
      makeInitializedEvent({ streamPath, offset: 1 }),
      makeGenericEvent({
        streamPath,
        offset: 2,
        type: "tick",
        payload: { source: "history-1" },
      }),
      makeGenericEvent({
        streamPath,
        offset: 3,
        type: "tick",
        payload: { source: "history-2" },
      }),
      makeGenericEvent({
        streamPath,
        offset: 4,
        type: "tick",
        payload: { source: "history-3" },
      }),
    ],
  });

  const seenOffsets: number[] = [];
  const runtime = new PushSubscriptionProcessorRuntime({
    eventsClient: client,
    processor: defineProcessor<{ count: number }>(() => ({
      slug: "push-ordered",
      initialState: { count: 0 },
      reduce: ({ event, state }) => {
        if (event.type !== "tick") {
          return state;
        }

        seenOffsets.push(event.offset);
        return { count: state.count + 1 };
      },
    })),
    streamPath,
  });

  await Promise.all([
    runtime.consume(
      makeGenericEvent({
        streamPath,
        offset: 5,
        type: "tick",
        payload: { source: "live-5" },
      }),
    ),
    runtime.consume(
      makeGenericEvent({
        streamPath,
        offset: 6,
        type: "tick",
        payload: { source: "live-6" },
      }),
    ),
  ]);

  assert.deepEqual(seenOffsets, [2, 3, 4, 5, 6]);
  assert.deepEqual(runtime.getState(), { count: 5 });
}

async function testPushRuntimeSkipsInclusiveCatchUpEventsAtLastProcessedOffset() {
  const streamPath = StreamPath.parse("/push/inclusive");
  const client = new InclusiveOffsetMockEventsClient({
    [streamPath]: [
      makeInitializedEvent({ streamPath, offset: 1 }),
      makeGenericEvent({
        streamPath,
        offset: 2,
        type: "tick",
        payload: { source: "history-2" },
      }),
      makeGenericEvent({
        streamPath,
        offset: 3,
        type: "tick",
        payload: { source: "history-3" },
      }),
      makeGenericEvent({
        streamPath,
        offset: 4,
        type: "tick",
        payload: { source: "history-4" },
      }),
    ],
  });
  const seenOffsets: number[] = [];

  const runtime = new PushSubscriptionProcessorRuntime({
    eventsClient: client,
    processor: defineProcessor<{ count: number }>(() => ({
      slug: "push-inclusive",
      initialState: { count: 0 },
      reduce: ({ event, state }) => {
        if (event.type !== "tick") {
          return state;
        }

        seenOffsets.push(event.offset);
        return { count: state.count + 1 };
      },
    })),
    streamPath,
  });

  await runtime.consume(
    makeGenericEvent({
      streamPath,
      offset: 3,
      type: "tick",
      payload: { source: "live-3" },
    }),
  );
  await runtime.consume(
    makeGenericEvent({
      streamPath,
      offset: 5,
      type: "tick",
      payload: { source: "live-5" },
    }),
  );

  assert.deepEqual(seenOffsets, [2, 3, 4, 5]);
  assert.deepEqual(runtime.getState(), { count: 4 });
}

async function testIncludeChildrenStopDuringHistoryWaitsForChildrenToExit() {
  const teamPath = StreamPath.parse("/team");
  const childPath = StreamPath.parse("/team/history");
  const client = new SlowPatternHistoryEventsClient(teamPath, childPath);
  const runtime = new PullProcessorRuntime({
    eventsClient: client,
    logger: silentLogger,
    path: "/team",
    processor: defineProcessor(() => ({
      slug: "pattern-stop",
      initialState: null,
    })),
  });

  const runPromise = runtime.run();

  await client.waitForChildHistoryStart();
  runtime.stop();
  await runPromise;

  assert.equal(client.childLiveStreamStarted, false);
}

async function testPrettyLoggingDescribesCatchupLiveReduceAndAfterAppend() {
  const streamPath = StreamPath.parse("/logs");
  const capturedLogger = createCapturedLogger();
  let reduceLoggerSeen: ProcessorLogger | undefined;
  let afterAppendLoggerSeen: ProcessorLogger | undefined;
  const client = new MockEventsClient({
    [streamPath]: [
      makeInitializedEvent({ streamPath, offset: 1 }),
      makeGenericEvent({
        streamPath,
        offset: 2,
        type: "tick",
        payload: { source: "history" },
      }),
    ],
  });

  const runtime = new PullProcessorRuntime({
    eventsClient: client,
    includeChildren: false,
    logger: capturedLogger.logger,
    processor: defineProcessor<{ seen: number }>(() => ({
      slug: "pretty-log",
      initialState: { seen: 0 },
      reduce: ({ event, logger, state }) => {
        reduceLoggerSeen = logger;
        return event.type === "tick" ? { seen: state.seen + 1 } : state;
      },
      async afterAppend({ append, event, logger, state }) {
        afterAppendLoggerSeen = logger;
        if (event.type !== "tick") {
          return;
        }

        await append({
          event: {
            type: "processed",
            payload: { seen: state.seen, sourceOffset: event.offset },
          },
        });
      },
    })),
    path: streamPath,
  });

  const runPromise = runtime.run();

  await client.waitForLiveSubscription(streamPath);
  client.emit(
    streamPath,
    makeGenericEvent({
      streamPath,
      offset: 3,
      type: "tick",
      payload: { source: "live" },
    }),
  );

  await client.waitForAppendCount(1);
  runtime.stop();
  await runPromise;

  assert.equal(reduceLoggerSeen, capturedLogger.logger);
  assert.equal(afterAppendLoggerSeen, capturedLogger.logger);
  assert.match(capturedLogger.joinedLogs(), /Catch-up reduced 2 events up to offset 2\./);
  assert.match(capturedLogger.joinedLogs(), /Reduced state:/);
  assert.match(capturedLogger.joinedLogs(), /"seen": 1/);
  assert.match(capturedLogger.joinedLogs(), /Live reduce for tick #3 \/logs\./);
  assert.match(capturedLogger.joinedLogs(), /Input event:/);
  assert.match(capturedLogger.joinedLogs(), /"source": "live"/);
  assert.match(capturedLogger.joinedLogs(), /afterAppend for tick #3 \/logs\./);
  assert.match(
    capturedLogger.joinedLogs(),
    /Appended processed #[0-9]+ \/logs while handling tick #3 \/logs\./,
  );
  assert.match(capturedLogger.joinedLogs(), /afterAppend complete for tick #3 \/logs\./);
}

async function testPrettyChildDiscoveryLoggingDescribesSubscribedStreams() {
  const teamPath = StreamPath.parse("/team");
  const teamAPath = StreamPath.parse("/team/a");
  const capturedLogger = createCapturedLogger();
  const client = new MockEventsClient({
    [teamPath]: [
      makeInitializedEvent({ streamPath: teamPath, offset: 1 }),
      makeChildStreamCreatedEvent({ offset: 2, childPath: teamAPath, streamPath: teamPath }),
    ],
    [teamAPath]: [makeInitializedEvent({ streamPath: teamAPath, offset: 1 })],
  });

  const runtime = new PullProcessorRuntime({
    eventsClient: client,
    logger: capturedLogger.logger,
    path: "/team",
    processor: defineProcessor(() => ({
      slug: "pattern-log",
      initialState: null,
    })),
  });

  const runPromise = runtime.run();
  await client.waitForLiveSubscription(teamAPath);
  runtime.stop();
  await runPromise;

  assert.match(capturedLogger.joinedLogs(), /Subscribing to stream \/team\./);
  assert.match(capturedLogger.joinedLogs(), /Subscribing to stream \/team\/a\./);
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
      payload: input.event.payload ?? {},
      metadata: input.event.metadata,
      idempotencyKey: input.event.idempotencyKey,
    });
    this.appended.push({ path: input.path, event });
    return { event };
  }

  async stream(
    input: { path: StreamPathType; after?: StreamCursor; before?: StreamCursor },
    options: { signal?: AbortSignal },
  ) {
    const pathEvents = this.#eventsByPath.get(input.path) ?? [];
    const endOffset = pathEvents.at(-1)?.offset ?? 0;
    const history = (this.#eventsByPath.get(input.path) ?? []).filter(
      (event) =>
        event.offset > resolveAfterCursor(input.after, endOffset) &&
        event.offset < resolveBeforeCursor(input.before, endOffset),
    );

    return this.#iterate({
      history,
      live: input.before == null,
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

class SlowHistoryEventsClient {
  liveStreamStarted = false;
  historyStarted = createDeferred<void>();
  #path: StreamPathType;

  constructor(path: StreamPathType) {
    this.#path = path;
  }

  async append(input: { path: StreamPathType; event: EventInput }) {
    return {
      event: makeEvent({
        streamPath: input.path,
        offset: 1,
        type: input.event.type,
        payload: input.event.payload ?? {},
        metadata: input.event.metadata,
        idempotencyKey: input.event.idempotencyKey,
      }),
    };
  }

  async stream(
    input: { path: StreamPathType; after?: StreamCursor; before?: StreamCursor },
    options: { signal?: AbortSignal },
  ) {
    if (input.before == null) {
      this.liveStreamStarted = true;
      return waitForever(options.signal);
    }

    return this.#history(options.signal);
  }

  async waitForHistoryStart() {
    await this.historyStarted.promise;
  }

  async *#history(signal?: AbortSignal) {
    yield makeInitializedEvent({ streamPath: this.#path, offset: 1 });
    this.historyStarted.resolve();
    await waitUntilAbort(signal);
  }
}

class SlowPatternHistoryEventsClient extends MockEventsClient {
  childLiveStreamStarted = false;
  childHistoryStarted = createDeferred<void>();
  #childPath: StreamPathType;

  constructor(parentPath: StreamPathType, childPath: StreamPathType) {
    super({
      [parentPath]: [
        makeInitializedEvent({ streamPath: parentPath, offset: 1 }),
        makeChildStreamCreatedEvent({ offset: 2, childPath, streamPath: parentPath }),
      ],
      [childPath]: [],
    });
    this.#childPath = childPath;
  }

  override async stream(
    input: { path: StreamPathType; after?: StreamCursor; before?: StreamCursor },
    options: { signal?: AbortSignal },
  ) {
    if (input.path === this.#childPath && input.before == null) {
      this.childLiveStreamStarted = true;
      return waitForever(options.signal);
    }

    if (input.path === this.#childPath && input.before != null) {
      return this.#childHistory(options.signal);
    }

    return super.stream(input, options);
  }

  async waitForChildHistoryStart() {
    await this.childHistoryStarted.promise;
  }

  async *#childHistory(signal?: AbortSignal) {
    yield makeInitializedEvent({ streamPath: this.#childPath, offset: 1 });
    this.childHistoryStarted.resolve();
    await waitUntilAbort(signal);
  }
}

class InclusiveOffsetMockEventsClient extends MockEventsClient {
  override async stream(
    input: { path: StreamPathType; after?: StreamCursor; before?: StreamCursor },
    options: { signal?: AbortSignal },
  ) {
    const inclusiveAfter =
      typeof input.after !== "number" ? input.after : input.after <= 1 ? "start" : input.after - 1;

    return super.stream(
      {
        ...input,
        after: inclusiveAfter,
      },
      options,
    );
  }
}

function resolveAfterCursor(cursor: StreamCursor | undefined, endOffset: number) {
  if (cursor == null || cursor === "start") {
    return 0;
  }

  if (cursor === "end") {
    return endOffset;
  }

  return cursor;
}

function resolveBeforeCursor(cursor: StreamCursor | undefined, endOffset: number) {
  if (cursor == null || cursor === "end") {
    return endOffset + 1;
  }

  if (cursor === "start") {
    return 1;
  }

  return cursor;
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

function waitForever(signal?: AbortSignal): AsyncIterable<Event> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          await waitForLiveEvent({
            signal,
            onReady: () => {},
          });

          return { done: false, value: undefined as never };
        },
      };
    },
  };
}

async function waitUntilAbort(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw abortError();
  }

  await new Promise<never>((_, reject) => {
    signal?.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

function createCapturedLogger() {
  const lines: string[] = [];
  const write = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  return {
    joinedLogs: () => stripAnsi(lines.join("\n")),
    lines,
    logger: {
      debug: write,
      error: write,
      info: write,
      log: write,
      warn: write,
    } satisfies ProcessorLogger,
  };
}

function createSilentLogger(): ProcessorLogger {
  const noop = () => {};
  return {
    debug: noop,
    error: noop,
    info: noop,
    log: noop,
    warn: noop,
  };
}

function stripAnsi(value: string) {
  return value.replace(new RegExp(String.raw`\u001b\[[0-9;]*m`, "g"), "");
}

function makeInitializedEvent(args: {
  streamPath: StreamPathType;
  offset: number;
  createdAt?: string;
}): Event {
  return makeEvent({
    streamPath: args.streamPath,
    offset: args.offset,
    type: "https://events.iterate.com/events/stream/initialized",
    payload: {
      projectSlug: "public",
      path: args.streamPath,
    },
    createdAt: args.createdAt,
  });
}

function makeChildStreamCreatedEvent(args: {
  offset: number;
  childPath: StreamPathType;
  streamPath?: StreamPathType;
}): Event {
  return makeEvent({
    streamPath: args.streamPath ?? StreamPath.parse("/"),
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
  createdAt?: string;
}): Event {
  return makeEvent(args);
}

function makeEvent(args: {
  streamPath: StreamPathType;
  offset: number;
  type: string;
  payload: EventInput["payload"];
  metadata?: EventInput["metadata"];
  idempotencyKey?: string;
  createdAt?: string;
}): Event {
  return EventSchema.parse({
    streamPath: args.streamPath,
    offset: args.offset,
    type: args.type,
    payload: args.payload ?? {},
    metadata: args.metadata,
    idempotencyKey: args.idempotencyKey,
    createdAt: args.createdAt ?? new Date(args.offset * 1_000).toISOString(),
  });
}

await testSharedProcessorDefinitionKeepsPerRuntimeState();
await testStatelessProcessorCanOmitInitialState();
await testReducerCanSkipReturningState();
await testIncludeChildrenWatchesExistingAndNewDescendantStreams();
await testLiveDiscoveredFreshChildReplaysRecentHistoryAfterAppendWithPerEventState();
await testProcessorAppendResolvesCurrentAbsoluteAndRelativePaths();
await testProcessorAppendRejectsInvalidRelativePaths();
await testProcessorRuntimeStopDuringHistoryDoesNotEnterLivePhase();
await testIncludeChildrenStopDuringHistoryWaitsForChildrenToExit();
await testPushRuntimeCatchesUpAndAppendsWithCanonicalProcessorContract();
await testPushRuntimeSerializesOutOfOrderDeliveriesWithoutDoubleReducingHistory();
await testPushRuntimeSkipsInclusiveCatchUpEventsAtLastProcessedOffset();
await testPrettyLoggingDescribesCatchupLiveReduceAndAfterAppend();
await testPrettyChildDiscoveryLoggingDescribesSubscribedStreams();
