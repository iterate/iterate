// Live event connections and stored subscriptions through the public ITX seam.
//
// This is intentionally a real live-deployment suite: product behavior enters
// through Stream capabilities and observes appended events, reduced state,
// runtime state, and delivered events. Guarded test capabilities are used only
// for deterministic fault/lifecycle injection. Pure reducer ordering and
// validation cases belong beside the core processor; cross-stream sending and
// callback behavior belong here. Local runs skip the two destructive-lifecycle
// proofs that require a preview deployment.

import { expect, test } from "vitest";
import {
  MAX_COPIED_FROM_HOPS,
  type StreamDeliveryBatch,
  type StreamEvent,
  type StreamEventBatch,
  type StreamEventInput,
  type CopyReceipt,
} from "iterate/processors";
import type {
  CoreProcessorState,
  Stream,
  StreamRuntimeDebugState,
} from "../../src/itx-api.generated.ts";
import { deliveryId as streamDeliveryId } from "../../src/domains/streams/stream-event-sender.ts";
import { subscriptionConfigurationForDelivery } from "../../src/domains/streams/core-processor-contract.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import {
  adminSecret,
  deployedBaseUrl,
  withItxSession,
  type ItxWebSocketMessage,
} from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const MATCHING_EVENT_TYPE = "events.iterate.test/subscriptions/matching";
const OTHER_EVENT_TYPE = "events.iterate.test/subscriptions/other";

/**
 * The default real-deployment test setup: one authenticated ITX session and
 * one fresh project, disposed together. Tests open streams and perform every
 * product action through the returned public project capability.
 *
 *     using testProject = await openTestProject(marker);
 *     const { project } = testProject;
 *
 * A test opens sessions directly only when it specifically needs multiple
 * WebSockets, frame recording, session revocation, or a global stream. The
 * four explicitly named helpers at the bottom are the only test-only seams:
 * append trusted core events, deliver a trusted stream batch, force idle
 * teardown, and reset a stream lifetime.
 */

// Session callback connections and waitForEvent.
test("replaying earlier events, receiving new appends, filters, state callbacks, ephemeral events, and close compose", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/subscriptions/session/matrix/${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using stream = project.streams.get(streamPath);

  const [historicalMatch, historicalEphemeral, historicalNonMatch] = await stream.append(
    { type: MATCHING_EVENT_TYPE, payload: { marker, selected: true, sequence: 1 } },
    {
      type: MATCHING_EVENT_TYPE,
      ephemeral: true,
      payload: { marker, selected: true, sequence: 2 },
    },
    { type: MATCHING_EVENT_TYPE, payload: { marker, selected: false, sequence: 3 } },
  );

  const selected: StreamEvent[] = [];
  const live: StreamEvent[] = [];
  const states: Array<{ eventCount: number; maxOffset: number }> = [];
  using selectedConnection = await stream.openConnection({
    connectionKey: `selected-${marker}`,
    replayAfterOffset: 0,
    maxReplayOffsetGap: 100,
    filter: {
      eventTypes: [MATCHING_EVENT_TYPE],
      jsonataCondition: "payload.selected = true",
    },
    processEventBatch: (batch) => selected.push(...batch.events),
  });
  using liveConnection = await stream.openConnection({
    connectionKey: `live-${marker}`,
    eventTypes: [MATCHING_EVENT_TYPE, OTHER_EVENT_TYPE],
    processEventBatch: (batch) => live.push(...batch.events),
  });
  using stateConnection = await stream.openConnection({
    connectionKey: `state-${marker}`,
    events: false,
    processEventBatch: (batch) => {
      expect(batch).toMatchObject({ events: [] });
      const state = coreState({ coreProcessorState: batch.state });
      states.push({ eventCount: state.eventCount, maxOffset: state.maxOffset });
    },
  });

  const [liveMatch, liveEphemeral, liveOther] = await stream.append(
    { type: MATCHING_EVENT_TYPE, payload: { marker, selected: true, sequence: 4 } },
    {
      type: MATCHING_EVENT_TYPE,
      ephemeral: true,
      payload: { marker, selected: true, sequence: 5 },
    },
    { type: OTHER_EVENT_TYPE, payload: { marker, selected: true, sequence: 6 } },
  );

  await waitForCondition(
    () =>
      selected.some((event) => event.offset === liveEphemeral!.offset) &&
      live.some((event) => event.offset === liveOther!.offset) &&
      states.some((state) => state.maxOffset >= liveOther!.offset),
    { description: "all three callback connections to observe the new append" },
  );

  const selectedOffsets = selected.map((event) => event.offset);
  expect(selectedOffsets).toEqual([
    historicalMatch!.offset,
    historicalEphemeral!.offset,
    liveMatch!.offset,
    liveEphemeral!.offset,
  ]);
  expect(selectedOffsets).not.toContain(historicalNonMatch!.offset);
  expect(live.map((event) => event.offset)).toEqual([
    liveMatch!.offset,
    liveEphemeral!.offset,
    liveOther!.offset,
  ]);
  expect(states.length).toBeGreaterThanOrEqual(2);

  const stateWhileOpen = runtimeState(await stream.runtimeState());
  expect(Object.keys(stateWhileOpen.runtime.connections)).toEqual(
    expect.arrayContaining([`selected-${marker}`, `live-${marker}`, `state-${marker}`]),
  );
  // Session callbacks are intentionally runtime-only. Reduced state must not
  // retain a callback that died with its WebSocket session.
  expect(stateWhileOpen.coreProcessorState).not.toHaveProperty("connectionsByKey");

  await selectedConnection.close();
  const selectedCount = selected.length;
  await stream.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, selected: true, sequence: 7 },
  });
  await waitForCondition(() => live.some((event) => event.payload?.sequence === 7), {
    description: "the remaining callback to receive an event after the other callback closes",
  });
  expect(selected).toHaveLength(selectedCount);

  await liveConnection.close();
  await stateConnection.close();
});

// Constrained consumers (embedded clients reassembling each batch into a
// fixed buffer) cap what one delivery may carry; the cursor pages the rest
// with no gap, and `state: false` drops the per-batch core-state payload.
test("per-connection delivery caps split coalesced appends and state can be omitted", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/subscriptions/session/delivery-caps/${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using stream = project.streams.get(streamPath);

  const batches: StreamEventBatch[] = [];
  using _capped = await stream.openConnection({
    connectionKey: `capped-${marker}`,
    eventTypes: [MATCHING_EVENT_TYPE],
    maxDeliveryEvents: 2,
    state: false,
    processEventBatch: (batch) => batches.push(batch),
  });

  // One atomic five-event append commits in one turn — without the cap it
  // would arrive as a single five-event batch.
  const appended = await stream.append(
    ...Array.from({ length: 5 }, (_, sequence) => ({
      type: MATCHING_EVENT_TYPE,
      payload: { marker, sequence },
    })),
  );
  const lastOffset = appended.at(-1)!.offset;
  await waitForCondition(
    () => batches.some((batch) => batch.events.some((event) => event.offset === lastOffset)),
    { description: "the capped connection to page through all five events" },
  );

  const eventBatches = batches.filter((batch) => batch.events.length > 0);
  expect(eventBatches.length).toBeGreaterThanOrEqual(3);
  for (const batch of eventBatches) {
    expect(batch.events.length).toBeLessThanOrEqual(2);
  }
  for (const batch of batches) {
    expect(batch.state).toBeNull();
  }
  expect(eventBatches.flatMap((batch) => batch.events.map((event) => event.offset))).toEqual(
    appended.map((event) => event.offset),
  );

  // A byte cap below any single event still delivers one event per batch
  // (the consumer must see the oversized event, not a stalled cursor).
  const single: StreamEventBatch[] = [];
  using _bytesCapped = await stream.openConnection({
    connectionKey: `bytes-capped-${marker}`,
    eventTypes: [MATCHING_EVENT_TYPE],
    maxDeliveryBytes: 1,
    processEventBatch: (batch) => single.push(batch),
  });
  const byteCappedAppend = await stream.append(
    { type: MATCHING_EVENT_TYPE, payload: { marker, sequence: 10 } },
    { type: MATCHING_EVENT_TYPE, payload: { marker, sequence: 11 } },
    { type: MATCHING_EVENT_TYPE, payload: { marker, sequence: 12 } },
  );
  await waitForCondition(
    () =>
      single.some((batch) =>
        batch.events.some((event) => event.offset === byteCappedAppend.at(-1)!.offset),
      ),
    { description: "the byte-capped connection to page through the appends" },
  );
  const singleEventBatches = single.filter((batch) => batch.events.length > 0);
  expect(singleEventBatches.length).toBe(3);
  for (const batch of singleEventBatches) {
    expect(batch.events.length).toBe(1);
    expect(batch.state).not.toBeNull();
  }
  expect(singleEventBatches.flatMap((batch) => batch.events.map((event) => event.offset))).toEqual(
    byteCappedAppend.map((event) => event.offset),
  );
});

test("a live filter failure closes the callback and records the concrete error", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/subscriptions/session/filter-failure/${marker}`;
  const connectionKey = `filter-failure-${marker}`;
  const batches: StreamEventBatch[] = [];

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using stream = project.streams.get(streamPath);
  using _handle = await stream.openConnection({
    connectionKey,
    filter: {
      jsonataCondition: '($assert(false, "live filter rejected event"); true)',
    },
    processEventBatch: (batch) => batches.push(batch),
  });

  let closed: StreamEvent | undefined;
  await waitForCondition(
    async () => {
      closed = (
        await stream.getEvents({
          afterOffset: 0,
          eventTypes: ["events.iterate.com/stream/connection-closed"],
        })
      ).find((event) => event.payload?.connectionKey === connectionKey);
      return closed !== undefined;
    },
    { description: "the failing live filter to close its callback" },
  );

  expect(batches).toEqual([]);
  expect(closed).toMatchObject({
    payload: {
      connectionKey,
      reason: "delivery-failed",
      error: "live filter rejected event",
    },
  });
  expect(runtimeState(await stream.runtimeState()).runtime.connections).not.toHaveProperty(
    connectionKey,
  );
});

test("waitForEvent records one open and close pair and cleans up after a timeout", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/subscriptions/wait-presence/${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using stream = project.streams.get(streamPath);

  await stream.append({ type: OTHER_EVENT_TYPE, payload: { marker, sequence: 0 } });
  const afterOffset = coreState(await stream.runtimeState()).maxOffset;
  const waiting = stream.waitForEvent({
    afterOffset,
    eventTypes: [MATCHING_EVENT_TYPE],
    timeoutMs: 10_000,
  });

  let connectionKey: string | undefined;
  await waitForCondition(
    async () => {
      const opened = (
        await stream.getEvents({
          afterOffset,
          eventTypes: ["events.iterate.com/stream/connection-opened"],
          limit: 100,
        })
      ).find((event) => {
        const payload = event.payload as {
          connectionKey?: unknown;
          openedBy?: { description?: unknown };
        };
        if (
          payload.openedBy?.description !== "waitForEvent" ||
          typeof payload.connectionKey !== "string"
        ) {
          return false;
        }
        connectionKey = payload.connectionKey;
        return true;
      });
      return opened !== undefined;
    },
    { description: "waitForEvent connection-opened presence fact" },
  );

  const [matching] = await stream.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, sequence: 1 },
  });
  await expect(waiting).resolves.toMatchObject({ offset: matching!.offset });

  await waitForCondition(
    async () =>
      (
        await stream.getEvents({
          afterOffset,
          eventTypes: ["events.iterate.com/stream/connection-closed"],
          limit: 100,
        })
      ).some(
        (event) => (event.payload as { connectionKey?: unknown }).connectionKey === connectionKey,
      ),
    { description: "waitForEvent connection-closed presence fact" },
  );

  const presence = (
    await stream.getEvents({
      afterOffset,
      eventTypes: [
        "events.iterate.com/stream/connection-opened",
        "events.iterate.com/stream/connection-closed",
      ],
      limit: 100,
    })
  ).filter(
    (event) => (event.payload as { connectionKey?: unknown }).connectionKey === connectionKey,
  );
  expect(presence.map((event) => event.type)).toEqual([
    "events.iterate.com/stream/connection-opened",
    "events.iterate.com/stream/connection-closed",
  ]);
  expect(presence[1]?.payload).toMatchObject({ reason: "closed-by-owner" });

  const timeoutAfterOffset = coreState(await stream.runtimeState()).maxOffset;
  await expect(
    stream.waitForEvent({
      afterOffset: timeoutAfterOffset,
      eventTypes: [MATCHING_EVENT_TYPE],
      timeoutMs: 100,
    }),
  ).rejects.toThrow(/Timed out waiting for stream event/);
  await waitForCondition(
    async () =>
      Object.values(runtimeState(await stream.runtimeState()).runtime.connections).every(
        (connection) => connection.openedBy?.description !== "waitForEvent",
      ),
    { description: "the timed-out wait callback to leave runtime state" },
  );

  const [historicalEphemeral, historicalDurable] = await stream.append(
    {
      type: MATCHING_EVENT_TYPE,
      ephemeral: true,
      payload: { marker, phase: "historical-ephemeral" },
    },
    {
      type: MATCHING_EVENT_TYPE,
      payload: { marker, phase: "historical-durable" },
    },
  );
  await expect(
    stream.waitForEvent({
      afterOffset: 0,
      eventTypes: [MATCHING_EVENT_TYPE],
      predicate: (event) => event.payload?.phase === "historical-durable",
      timeoutMs: 10_000,
    }),
  ).resolves.toMatchObject({ offset: historicalDurable!.offset });
  await expect(
    stream.waitForEvent({
      afterOffset: 0,
      eventTypes: [MATCHING_EVENT_TYPE],
      predicate: (event) => event.payload?.phase === "historical-ephemeral",
      timeoutMs: 10_000,
    }),
  ).resolves.toMatchObject({ offset: historicalEphemeral!.offset, ephemeral: true });

  const liveEphemeralWait = stream.waitForEvent({
    afterOffset: coreState(await stream.runtimeState()).maxOffset,
    eventTypes: [MATCHING_EVENT_TYPE],
    predicate: (event) => event.payload?.phase === "live-ephemeral",
    timeoutMs: 10_000,
  });
  // The earlier waits have already closed their connections, so any
  // waitForEvent connection present now is this one.
  await waitForCondition(
    async () =>
      Object.values(runtimeState(await stream.runtimeState()).runtime.connections).some(
        (connection) => connection.openedBy?.description === "waitForEvent",
      ),
    { description: "the live-ephemeral wait to arm its stream connection" },
  );
  const [liveEphemeral] = await stream.append({
    type: MATCHING_EVENT_TYPE,
    ephemeral: true,
    payload: { marker, phase: "live-ephemeral" },
  });
  await expect(liveEphemeralWait).resolves.toMatchObject({ offset: liveEphemeral!.offset });
});

test("opening the same connection key atomically replaces the callback", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/subscriptions/session/replacement/${marker}`;
  const connectionKey = `replace-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using stream = project.streams.get(streamPath);

  const first: number[] = [];
  const second: number[] = [];
  using firstHandle = await stream.openConnection({
    connectionKey,
    processEventBatch: (batch) => {
      first.push(
        ...batch.events
          .filter((event) => event.type === MATCHING_EVENT_TYPE)
          .map((event) => event.payload!.sequence as number),
      );
    },
  });

  await stream.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, sequence: 1 },
  });
  await waitForCondition(() => first.includes(1), {
    description: "the original callback to receive its event",
  });

  const beforeReplacement = coreState(await stream.runtimeState()).maxOffset;
  using secondHandle = await stream.openConnection({
    connectionKey,
    processEventBatch: (batch) => {
      second.push(
        ...batch.events
          .filter((event) => event.type === MATCHING_EVENT_TYPE)
          .map((event) => event.payload!.sequence as number),
      );
    },
  });
  await firstHandle.close();
  await stream.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, sequence: 2 },
  });
  await waitForCondition(() => second.includes(2), {
    description: "the same-key replacement callback to receive the next event",
  });
  expect(first).toEqual([1]);
  expect(second).toEqual([2]);
  expect(
    (
      await stream.getEvents({
        afterOffset: beforeReplacement,
        eventTypes: ["events.iterate.com/stream/connection-closed"],
      })
    ).some(
      (event) =>
        event.payload?.connectionKey === connectionKey && event.payload?.reason === "replaced",
    ),
  ).toBe(true);
  await secondHandle.close();
});

test("invalid replay coordinates and durable-key collisions leave a live callback untouched", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/subscriptions/session/rejected-opens/${marker}`;
  const connectionKey = `rejected-opens-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using stream = project.streams.get(streamPath);

  const received: number[] = [];
  using handle = await stream.openConnection({
    connectionKey,
    processEventBatch: (batch) => {
      received.push(
        ...batch.events
          .filter((event) => event.type === MATCHING_EVENT_TYPE)
          .map((event) => event.payload!.sequence as number),
      );
    },
  });

  await expect(
    openAndCloseConnection(stream, {
      connectionKey,
      replayAfterOffset: 0,
      maxReplayOffsetGap: 0,
      processEventBatch: () => undefined,
    }),
  ).rejects.toThrow(/replay gap/);
  await expect(
    openAndCloseConnection(stream, {
      replayAfterOffset: Number.NaN,
      processEventBatch: () => undefined,
    }),
  ).rejects.toThrow(/non-negative/);
  await expect(
    openAndCloseConnection(stream, {
      expectedStreamId: "ffffffff-ffff-4fff-bfff-ffffffffffff",
      processEventBatch: () => undefined,
    }),
  ).rejects.toThrow(/stream ID changed/);
  await expect(
    openAndCloseConnection(stream, {
      connectionKey: "project-worker",
      processEventBatch: () => undefined,
    }),
  ).rejects.toThrow(/reserved by a subscription/);
  await expect(
    stream.append(
      subscriptionConfigured({
        subscriptionKey: connectionKey,
        receiver: {
          action: "itx-call",
          expression: ["worker", "processEventBatch"],
          delivery: deliveryPolicy("now"),
        },
      }),
    ),
  ).rejects.toThrow(/already used by a live session connection/);

  await stream.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, sequence: 1 },
  });
  await waitForCondition(() => received.includes(1), {
    description: "the original callback to survive every rejected open and key collision",
  });
  expect(
    runtimeState(await stream.runtimeState()).runtime.connections[connectionKey],
  ).toMatchObject({ kind: "session" });
  await handle.close();
});

test("callback capabilities cross the worker proxy and disappear with their session", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/subscriptions/session/capabilities/${marker}`;
  const connectionKey = `capabilities-${marker}`;

  using observerSession = withItxSession();
  using observerItx = observerSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await observerItx.projects
    .get(`stream-subscriptions-${RUN_SUFFIX}-${marker}`)
    .create({});
  const { projectId } = await project.__describe();
  using observerStream = project.streams.get(streamPath);

  const callbackSession = withItxSession();
  let pingCalls = 0;
  try {
    const callbackItx = callbackSession.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
    });
    const callbackProject = callbackItx.projects.get(projectId);
    const callbackStream = callbackProject.streams.get(streamPath);
    const handle = await callbackStream.openConnection({
      connectionKey,
      processEventBatch: () => undefined,
      getRuntimeState: () => ({
        runtime: { marker },
        snapshot: { offset: 123, state: { marker } },
      }),
      ping: ({ t0 }) => {
        pingCalls += 1;
        const t1 = Date.now();
        return { t0, t1, t2: Date.now() };
      },
      openedBy: {
        description: "callback capability probe",
        processor: {
          announcement: {
            consumes: ["*"],
            description: "Callback capability probe",
            emits: [],
            ownedEvents: [],
            slug: "e2e.callback-capability-probe",
            version: "0.1.0",
          },
        },
      },
    });
    expect(await handle.connectionKey).toBe(connectionKey);

    await waitForCondition(
      async () => {
        const state = await observerStream.getProcessorRuntimeState({
          subscriptionKey: connectionKey,
        });
        return state?.runtime?.marker === marker && state.snapshot.offset === 123;
      },
      { description: "the retained getRuntimeState capability to cross both RPC hops" },
    );
    await waitForCondition(
      async () => {
        const connection = runtimeState(await observerStream.runtimeState()).runtime.connections[
          connectionKey
        ];
        return (
          pingCalls >= 1 &&
          connection?.openedBy?.description === "callback capability probe" &&
          (connection.pingRttMs?.samples ?? 0) >= 1
        );
      },
      { description: "the retained ping capability to produce a live RTT sample" },
    );

    disposeRpc(callbackSession);
    await waitForCondition(
      async () =>
        runtimeState(await observerStream.runtimeState()).runtime.connections[connectionKey] ===
        undefined,
      { description: "session disposal to revoke the callback" },
    );
  } finally {
    disposeRpc(callbackSession);
  }
});

test("newly appended events cross the callback owner's WebSocket in one direction", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/subscriptions/session/wire/${marker}`;

  using publisherSession = withItxSession();
  using publisherItx = publisherSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await publisherItx.projects
    .get(`stream-subscriptions-${RUN_SUFFIX}-${marker}`)
    .create({});
  const { projectId } = await project.__describe();

  const frames: ItxWebSocketMessage[] = [];
  using callbackProject = withItxSession({
    auth: { type: "admin-secret", secret: adminSecret() },
    projectId,
    onWebSocketMessage: (message) => frames.push(message),
  });
  const receivedOffsets: number[] = [];
  using handle = await callbackProject.streams.get(streamPath).openConnection({
    replayAfterOffset: 0,
    processEventBatch: (batch) =>
      receivedOffsets.push(...batch.events.map((event) => event.offset)),
  });

  await waitForCondition(() => receivedOffsets.length > 0, {
    description: "the initial callback batch",
  });
  // A request/response on the same WebSocket is an ordering barrier for the
  // initial callback frames. Everything observed after it belongs to the
  // live append below; no timing guess is needed.
  expect(await handle.ping()).toBe(true);
  const liveFramesStartAt = frames.length;
  const appended = await project.streams
    .get(streamPath)
    .append(
      { type: MATCHING_EVENT_TYPE, payload: { marker, sequence: 1 } },
      { type: MATCHING_EVENT_TYPE, payload: { marker, sequence: 2 } },
    );
  await waitForCondition(() => receivedOffsets.includes(appended.at(-1)!.offset), {
    description: "the newly appended batch to cross the callback owner's socket",
  });

  const liveFrames = frames.slice(liveFramesStartAt);
  expect(liveFrames.filter(([, direction]) => direction === "in").length).toBeGreaterThan(0);
  expect(liveFrames.filter(([, direction]) => direction === "out")).toEqual([]);
  await handle.close();
});

test("warm live delivery remains bounded across repeated appends", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/subscriptions/session/latency/${marker}`;
  const sampleCount = 20;

  using publisherSession = withItxSession();
  using publisherItx = publisherSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await publisherItx.projects
    .get(`stream-subscriptions-${RUN_SUFFIX}-${marker}`)
    .create({});
  const { projectId } = await project.__describe();

  using callbackProject = withItxSession({
    auth: { type: "admin-secret", secret: adminSecret() },
    projectId,
  });
  const arrivedAt = new Map<number, number>();
  using handle = await callbackProject.streams.get(streamPath).openConnection({
    processEventBatch: (batch) => {
      const now = performance.now();
      for (const event of batch.events) arrivedAt.set(event.offset, now);
    },
  });

  const [warmup] = await project.streams.get(streamPath).append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, warmup: true },
  });
  await waitForCondition(() => arrivedAt.has(warmup!.offset), {
    description: "the warm-up event to reach the open callback",
  });

  const deliveryTimes: number[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const sentAt = performance.now();
    const [event] = await project.streams.get(streamPath).append({
      type: MATCHING_EVENT_TYPE,
      payload: { marker, sample },
    });
    await waitForCondition(() => arrivedAt.has(event!.offset), {
      description: `latency sample ${sample}`,
    });
    deliveryTimes.push(arrivedAt.get(event!.offset)! - sentAt);
  }

  const sorted = deliveryTimes.toSorted((left, right) => left - right);
  const p50 = sorted[Math.floor(sorted.length / 2)]!;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  console.log(
    `event delivery latency (${sampleCount} warm samples): p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
  );
  // This is deliberately a seconds-scale regression guard, not a latency
  // SLA: it includes both the append request and the callback push leg.
  expect(p50).toBeLessThan(1_000);
  await handle.close();
});
// Stream receivers: configure, record, replace, and recover.
test("configuring a subscription commits on the source alone; the receiver learns on first copy", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/receiver/${marker}`;
  const subscriptionKey = `source-to-receiver-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  const configured = await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
    description: "Receive matching test events from the source stream.",
  });

  expect(configured.subscriptionConfiguredEvent).toMatchObject({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      subscriptionKey,
      receiver: { action: "copy-to-stream", receivingStreamPath: receivingStreamPath },
    },
  });

  const sourceState = coreState(await source.runtimeState());
  expect(sourceState.subscriptions.outbound.byKey[subscriptionKey]).toMatchObject({
    configuration: configured.subscriptionConfiguredEvent.payload,
  });

  // No handshake: before the first copy arrives the receiver records nothing.
  expect(
    coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath],
  ).toBeUndefined();

  const [sourceProductEvent] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker },
  });
  const copied = await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    timeoutMs: 15_000,
  });
  expect(copied.source?.copiedFrom?.at(-1)?.offset).toBe(sourceProductEvent!.offset);

  // The committed copy's stamp is what creates the passive inbound record.
  expect(
    coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath]?.[
      subscriptionKey
    ],
  ).toMatchObject({
    streamId: sourceState.streamId,
    streamCreatedAt: sourceState.createdAt,
    cursorChangedAtSourceOffset: configured.subscriptionConfiguredEvent.offset,
    numEventsReceived: 1,
  });
});

test("an agent-scoped script can make any project stream receive from another", async () => {
  const marker = crypto.randomUUID();
  const agentPath = `/agents/subscription-author-${marker}`;
  const sourcePath = `/e2e/subscriptions/agent-authored/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/agent-authored/receiver/${marker}`;
  const subscriptionKey = `agent-authored-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using agent = project.agents.get(agentPath);
  await agent.create();

  // runScript executes with the agent scope's own ITX. Its stream catalog is
  // deliberately project-wide: the agent chooses the receiving stream and
  // source itself, without an admin configuring the rule on its behalf.
  const execution = await agent.capabilityHost.runScript(`async (itx) => {
    return await itx.streams.get(${JSON.stringify(receivingStreamPath)}).subscribeToEventsFrom({
      sourceStreamPath: ${JSON.stringify(sourcePath)},
      subscriptionKey: ${JSON.stringify(subscriptionKey)},
      filter: { eventTypes: [${JSON.stringify(MATCHING_EVENT_TYPE)}] },
    });
  }`);
  expect(execution.result).toMatchObject({
    subscriptionConfiguredEvent: {
      type: "events.iterate.com/stream/subscription-configured",
      payload: { subscriptionKey },
    },
  });

  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);
  const [sent] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, configuredBy: agentPath },
  });
  const copied = await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    timeoutMs: 15_000,
  });
  expect(copied).toMatchObject({
    payload: { marker, configuredBy: agentPath },
    source: {
      copiedFrom: [
        expect.objectContaining({ path: sourcePath, offset: sent!.offset, subscriptionKey }),
      ],
    },
  });
});

test("bare subscribeToEventsFrom generates an offset key, starts now, and copies wildcard control events", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/defaults/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/defaults/receiver/${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  const [historical] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, phase: "before-bare-receive" },
  });
  const configured = await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    idempotencyKey: `defaults-${marker}`,
  });
  const defaultSubscriptionKey = configured.subscriptionKey;
  expect(defaultSubscriptionKey).toBe(
    `subscription:${configured.subscriptionConfiguredEvent.offset}`,
  );
  expect(configured.subscriptionConfiguredEvent).toMatchObject({
    payload: {
      receiver: {
        action: "copy-to-stream",
        receivingStreamPath: receivingStreamPath,
        delivery: { start: "now", onFailingEvent: "halt" },
      },
    },
  });
  expect(configured.subscriptionConfiguredEvent.payload).not.toHaveProperty("subscriptionKey");

  const [liveControl] = await source.append({
    type: "events.iterate.com/stream/configured",
    payload: { config: {} },
  });
  const copiedControl = await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: ["events.iterate.com/stream/configured"],
    timeoutMs: 15_000,
  });
  expect(copiedControl.source?.copiedFrom?.at(-1)).toMatchObject({
    subscriptionKey: defaultSubscriptionKey,
    offset: liveControl!.offset,
    path: sourcePath,
  });

  const copiedSourceOffsets = (await receiver.getEvents({ afterOffset: 0 })).flatMap(
    (event) => event.source?.copiedFrom?.map((hop) => hop.offset) ?? [],
  );
  expect(copiedSourceOffsets).not.toContain(historical!.offset);
});

// Cloudflare documents ctx.abort() as unavailable in local Wrangler
// development. Reset deletes the source's storage and must then end that
// incarnation, so this proof belongs on a real preview deployment.
test.skipIf(deployedBaseUrl() === null)(
  "a receiver accepts the same offsets again after its source is deleted and recreated",
  { timeout: 45_000 },
  async () => {
    const marker = crypto.randomUUID();
    const sourcePath = `/e2e/subscriptions/source-recreated/source/${marker}`;
    const receivingStreamPath = `/e2e/subscriptions/source-recreated/receiver/${marker}`;
    const subscriptionKey = `source-recreated-${marker}`;

    using testProject = await openTestProject(marker);
    const { project } = testProject;
    using source = project.streams.get(sourcePath);
    using receiver = project.streams.get(receivingStreamPath);

    const desired = {
      sourceStreamPath: sourcePath,
      subscriptionKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      start: "beginning" as const,
    };
    await receiver.subscribeToEventsFrom(desired);
    const [firstSourceEvent] = await source.append({
      type: MATCHING_EVENT_TYPE,
      payload: { marker, sourceLifetime: 1 },
    });
    const firstCopy = await receiver.waitForEvent({
      afterOffset: 0,
      eventTypes: [MATCHING_EVENT_TYPE],
      predicate: (event) => event.payload?.marker === marker,
      timeoutMs: 15_000,
    });
    const firstSourceState = coreState(await source.runtimeState());
    const firstSourceId = firstSourceState.streamId;
    const firstSourceCreation = firstSourceState.createdAt;
    expect(firstSourceId).toBeDefined();
    expect(firstSourceCreation).toBeDefined();
    expect(firstCopy.source?.copiedFrom?.at(-1)).toMatchObject({
      path: sourcePath,
      streamId: firstSourceId,
      streamCreatedAt: firstSourceCreation,
      offset: firstSourceEvent!.offset,
    });

    await forceStreamReset(source).catch(() => undefined);
    const secondSourceState = coreState(await source.runtimeState());
    expect(secondSourceState.streamId).toBeDefined();
    expect(secondSourceState).not.toMatchObject({ streamId: firstSourceId });
    expect(secondSourceState.createdAt).toBeDefined();

    await receiver.subscribeToEventsFrom(desired);
    const [secondSourceEvent] = await source.append({
      type: MATCHING_EVENT_TYPE,
      payload: { marker, sourceLifetime: 2 },
    });
    expect(secondSourceEvent).toMatchObject({ offset: firstSourceEvent!.offset });

    const secondCopy = await receiver.waitForEvent({
      afterOffset: firstCopy.offset,
      eventTypes: [MATCHING_EVENT_TYPE],
      predicate: (event) => event.payload?.sourceLifetime === 2,
      timeoutMs: 15_000,
    });
    expect(secondCopy.source?.copiedFrom?.at(-1)).toMatchObject({
      path: sourcePath,
      streamId: secondSourceState.streamId,
      streamCreatedAt: secondSourceState.createdAt,
      offset: secondSourceEvent!.offset,
    });

    expect(
      coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath]?.[
        subscriptionKey
      ],
    ).toMatchObject({
      streamId: secondSourceState.streamId,
      streamCreatedAt: secondSourceState.createdAt,
      numEventsReceived: 1,
    });
  },
);

test("a receiver rejects a delayed batch after the same source key is reconfigured", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/stale-batch/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/stale-batch/receiver/${marker}`;
  const subscriptionKey = `stale-batch-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  const { projectId } = await project.__describe();
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  const first = await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
  });
  const [sourceEvent] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker },
  });
  await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    predicate: (event) => event.payload?.marker === marker,
    timeoutMs: 15_000,
  });

  const replacement = await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
    description: "Replacement configuration",
    start: "beginning",
  });
  expect(replacement.subscriptionConfiguredEvent.offset).toBeGreaterThan(
    first.subscriptionConfiguredEvent.offset,
  );
  // A copy delivered under the replacement generation stamps the receiver's
  // fence with the newer configure offset.
  const [afterReplacement] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, phase: "after-replacement" },
  });
  await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    predicate: (event) => event.payload?.phase === "after-replacement",
    timeoutMs: 15_000,
  });
  expect(afterReplacement).toBeDefined();

  const sourceState = coreState(await source.runtimeState());
  const receiverOffsetBeforeStaleBatch = coreState(await receiver.runtimeState()).maxOffset;
  const staleBatch: StreamDeliveryBatch = {
    projectId,
    path: sourcePath,
    streamId: sourceState.streamId!,
    streamCreatedAt: sourceState.createdAt!,
    events: [sourceEvent!],
    streamMaxOffset: sourceState.maxOffset,
    subscriptionKey,
    cursorChangedAtSourceOffset: first.subscriptionConfiguredEvent.offset,
    deliveryId: `stale-batch:${marker}`,
    attempt: 1,
    configuredEvent: subscriptionConfigurationForDelivery(first.subscriptionConfiguredEvent),
  };

  await expect(deliverTrustedStreamBatch(receiver, staleBatch)).rejects.toThrow(
    /already accepted a newer delivery/,
  );
  expect(coreState(await receiver.runtimeState())).toMatchObject({
    maxOffset: receiverOffsetBeforeStaleBatch,
  });
  expect(
    coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath]?.[
      subscriptionKey
    ],
  ).toMatchObject({ cursorChangedAtSourceOffset: replacement.subscriptionConfiguredEvent.offset });
});

test("repeating a receive command reuses its original now cursor", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/ambiguous-retry/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/ambiguous-retry/receiver/${marker}`;
  const subscriptionKey = `ambiguous-retry-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  await receiver.append({
    type: "events.iterate.com/stream/paused",
    payload: { reason: "hold product delivery while the receive command is repeated" },
  });
  const desired = {
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
    start: "now" as const,
  };
  const first = await receiver.subscribeToEventsFrom(desired);
  const firstConfiguration = (
    await source.getEvents({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/stream/subscription-configured"],
    })
  ).find((event) => event.payload?.subscriptionKey === subscriptionKey);
  expect(firstConfiguration).toBeDefined();

  const [betweenAttempts] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, phase: "between-ambiguous-attempts" },
  });
  const retried = await receiver.subscribeToEventsFrom(desired);

  expect(retried.subscriptionConfiguredEvent).toMatchObject({ offset: firstConfiguration!.offset });
  expect(retried).toMatchObject({ subscriptionKey: first.subscriptionKey });
  const configurations = (
    await source.getEvents({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/stream/subscription-configured"],
    })
  ).filter((event) => event.payload?.subscriptionKey === subscriptionKey);
  expect(configurations).toHaveLength(1);
  await receiver.append({ type: "events.iterate.com/stream/resumed", payload: {} });
  const delivered = await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    predicate: (event) => event.payload?.marker === marker,
    timeoutMs: 15_000,
  });
  expect(delivered.source?.copiedFrom?.at(-1)?.offset).toBe(betweenAttempts!.offset);
});

test("resumeSubscription restarts a halted rule at its existing cursor", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/resume/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/resume/receiver/${marker}`;
  const subscriptionKey = `resume-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  const configuredOffset = coreState(await source.runtimeState()).maxOffset + 1;
  await appendTrustedCoreEvents(source, [
    subscriptionConfigured({
      subscriptionKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      receiver: {
        action: "copy-to-stream",
        receivingStreamPath,
        delivery: deliveryPolicy("now"),
      },
    }),
    {
      type: "events.iterate.com/stream/subscription-delivery-halted",
      payload: {
        subscriptionKey,
        reason: "delivery-failed",
        afterOffset: configuredOffset,
        attempts: 15,
        error: "synthetic exhausted delivery retry ladder",
      },
    },
  ]);
  const [held] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker },
  });
  expect(
    coreState(await source.runtimeState()).subscriptions.outbound.byKey[subscriptionKey],
  ).toMatchObject({
    deliveryHalted: {
      afterOffset: configuredOffset,
      attempts: 15,
      reason: "delivery-failed",
    },
  });

  const resumed = await source.resumeSubscription({ subscriptionKey });
  expect(resumed).toMatchObject({
    type: "events.iterate.com/stream/subscription-delivery-resumed",
    payload: { subscriptionKey },
  });
  const delivered = await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    predicate: (event) => event.payload?.marker === marker,
    timeoutMs: 15_000,
  });
  expect(delivered.source?.copiedFrom?.at(-1)?.offset).toBe(held!.offset);
  expect(
    coreState(await source.runtimeState()).subscriptions.outbound.byKey[subscriptionKey],
  ).not.toHaveProperty("deliveryHalted");
});
// Stream copies: provenance, cursors, and end conditions.
test("chains longer than five copies retain provenance, cycles terminate, and removal revokes both sides", async () => {
  const marker = crypto.randomUUID();
  const pathA = `/e2e/subscriptions/cycle/a/${marker}`;
  const pathB = `/e2e/subscriptions/cycle/b/${marker}`;
  const pathC = `/e2e/subscriptions/cycle/c/${marker}`;
  const pathD = `/e2e/subscriptions/cycle/d/${marker}`;
  const pathE = `/e2e/subscriptions/cycle/e/${marker}`;
  const pathF = `/e2e/subscriptions/cycle/f/${marker}`;
  const pathG = `/e2e/subscriptions/cycle/g/${marker}`;
  const paths = [pathA, pathB, pathC, pathD, pathE, pathF, pathG];
  const forwardRuleKeys = paths
    .slice(0, -1)
    .map(
      (_, index) =>
        `${String.fromCharCode(97 + index)}-to-${String.fromCharCode(98 + index)}-${marker}`,
    );
  const gToA = `g-to-a-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using streamA = project.streams.get(pathA);
  using streamB = project.streams.get(pathB);
  using streamC = project.streams.get(pathC);
  using streamD = project.streams.get(pathD);
  using streamE = project.streams.get(pathE);
  using streamF = project.streams.get(pathF);
  using streamG = project.streams.get(pathG);
  const streams = [streamA, streamB, streamC, streamD, streamE, streamF, streamG];

  for (let index = 1; index < streams.length; index += 1) {
    await streams[index]!.subscribeToEventsFrom({
      sourceStreamPath: paths[index - 1]!,
      subscriptionKey: forwardRuleKeys[index - 1]!,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
    });
  }
  await streamA.subscribeToEventsFrom({
    sourceStreamPath: pathG,
    subscriptionKey: gToA,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
  });

  const [original] = await streamA.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, phase: "before-removal" },
  });
  const chained = await streamG.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    predicate: (event) => event.payload?.marker === marker,
    timeoutMs: 15_000,
  });
  expect(chained.source?.copiedFrom?.map((hop) => hop.path)).toEqual(paths.slice(0, -1));
  expect(chained.source?.copiedFrom?.map((hop) => hop.subscriptionKey)).toEqual(forwardRuleKeys);

  // G→A would complete a cycle. A acknowledges the source coordinate without
  // appending a duplicate product event, and records that decision as one
  // idempotent error event.
  const dropped = await streamA.waitForEvent({
    afterOffset: original!.offset,
    eventTypes: ["events.iterate.com/stream/error-occurred"],
    predicate: (event) => String(event.payload?.message).includes(gToA),
    timeoutMs: 15_000,
  });
  expect(String(dropped.payload?.message)).toContain(`dropped 1 copied event(s) from "${pathG}"`);
  const cycleCursor = runtimeState(await streamG.runtimeState()).runtime.subscriptions[gToA]!;
  expect(cycleCursor.acknowledgedOffset).toBeGreaterThanOrEqual(chained.offset);
  expect(
    (
      await streamA.getEvents({
        afterOffset: original!.offset - 1,
        eventTypes: [MATCHING_EVENT_TYPE],
      })
    ).map((event) => event.offset),
  ).toEqual([original!.offset]);

  const removed = await streamB.unsubscribeFromEvents({
    sourceStreamPath: pathA,
    subscriptionKey: forwardRuleKeys[0]!,
  });
  expect(removed).toMatchObject({
    status: "removed",
    subscriptionRemovedEvent: { type: "events.iterate.com/stream/subscription-removed" },
  });
  expect(
    coreState(await streamA.runtimeState()).subscriptions.outbound.byKey[forwardRuleKeys[0]!],
  ).toBeUndefined();

  const removalObserverPath = `/e2e/subscriptions/cycle/removal-observer/${marker}`;
  const removalObserverKey = `removal-observer-${marker}`;
  using removalObserver = project.streams.get(removalObserverPath);
  await removalObserver.subscribeToEventsFrom({
    sourceStreamPath: pathA,
    subscriptionKey: removalObserverKey,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
  });
  const [afterRemoval] = await streamA.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, phase: "after-removal" },
  });
  const observedAfterRemoval = await removalObserver.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    predicate: (event) => event.payload?.phase === "after-removal",
    timeoutMs: 15_000,
  });
  expect(observedAfterRemoval.source?.copiedFrom?.at(-1)).toMatchObject({
    offset: afterRemoval!.offset,
    path: pathA,
    subscriptionKey: removalObserverKey,
  });
  expect(
    (await streamB.getEvents({ afterOffset: 0, eventTypes: [MATCHING_EVENT_TYPE] })).map(
      (event) => event.payload?.phase,
    ),
  ).toEqual(["before-removal"]);
});

test("the stream-copy limit is an acknowledged durable drop whose audit event is not copied", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/hop-limit/source/${marker}`;
  const receiverPath = `/e2e/subscriptions/hop-limit/receiver/${marker}`;
  const observerPath = `/e2e/subscriptions/hop-limit/observer/${marker}`;
  const subscriptionKey = `hop-limit-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  const { projectId } = await project.__describe();
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receiverPath);
  using observer = project.streams.get(observerPath);

  const [historical] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, purpose: "synthetic event at the provenance boundary" },
  });
  const configured = await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
  });
  await observer.subscribeToEventsFrom({
    sourceStreamPath: receiverPath,
    subscriptionKey: `observe-hop-limit-${marker}`,
    filter: {
      eventTypes: [MATCHING_EVENT_TYPE, "events.iterate.com/stream/error-occurred"],
    },
  });

  const sourceState = coreState(await source.runtimeState());
  const eventAtLimit: StreamEvent = {
    ...historical!,
    source: {
      copiedFrom: Array.from({ length: MAX_COPIED_FROM_HOPS }, (_, index) => ({
        subscriptionKey: `prior-copy-${index}`,
        streamId: crypto.randomUUID(),
        streamCreatedAt: new Date(Date.parse(historical!.createdAt) - index).toISOString(),
        cursorChangedAtSourceOffset: 1,
        createdAt: historical!.createdAt,
        offset: index + 1,
        path: `/e2e/subscriptions/hop-limit/prior-${index}/${marker}`,
        projectId,
        type: MATCHING_EVENT_TYPE,
      })),
    },
  };
  const receipt = await deliverTrustedStreamBatch(receiver, {
    projectId,
    path: sourcePath,
    streamId: sourceState.streamId!,
    streamCreatedAt: sourceState.createdAt!,
    events: [eventAtLimit],
    streamMaxOffset: sourceState.maxOffset,
    subscriptionKey,
    cursorChangedAtSourceOffset: configured.subscriptionConfiguredEvent.offset,
    deliveryId: streamDeliveryId(
      sourceState.streamId!,
      subscriptionKey,
      configured.subscriptionConfiguredEvent.offset,
      historical!.offset,
      historical!.offset,
    ),
    attempt: 1,
    configuredEvent: subscriptionConfigurationForDelivery(configured.subscriptionConfiguredEvent),
  });
  expect(receipt).toEqual({ acknowledged: 1 });

  const dropped = await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: ["events.iterate.com/stream/error-occurred"],
    predicate: (event) => String(event.payload?.message).includes(subscriptionKey),
    timeoutMs: 15_000,
  });
  expect(String(dropped.payload?.message)).toContain(
    `dropped 1 copied event(s) from "${sourcePath}"`,
  );
  expect(String(dropped.payload?.message)).toContain(
    `offsets ${historical!.offset}-${historical!.offset}`,
  );

  const [sentinel] = await receiver.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, purpose: "prove the observer advanced beyond the withheld audit" },
  });
  await observer.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    predicate: (event) => event.payload?.marker === marker,
    timeoutMs: 15_000,
  });
  expect(sentinel).toBeDefined();
  expect(
    await observer.getEvents({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/stream/error-occurred"],
    }),
  ).toEqual([]);
});

test("a global subscription stays in the global namespace", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/global/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/global/receiver/${marker}`;

  using testProject = await openTestProject(marker);
  const { itx, project } = testProject;
  using globalSource = itx.streams.get(sourcePath);
  using globalReceiver = itx.streams.get(receivingStreamPath);
  using projectReceiver = project.streams.get(receivingStreamPath);

  await globalReceiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey: `global-${marker}`,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
  });
  await globalSource.append({ type: MATCHING_EVENT_TYPE, payload: { marker } });
  const copy = await globalReceiver.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    timeoutMs: 15_000,
  });
  expect(copy.source?.copiedFrom?.at(-1)).toMatchObject({
    projectId: null,
    path: sourcePath,
  });
  expect(
    await projectReceiver.getEvents({ afterOffset: 0, eventTypes: [MATCHING_EVENT_TYPE] }),
  ).toEqual([]);
});

test("a copy filters, records its source, and deduplicates a retried delivery", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/copy/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/copy/receiver/${marker}`;
  const subscriptionKey = `copy-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  const { projectId } = await project.__describe();
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  const configured = await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: {
      eventTypes: [MATCHING_EVENT_TYPE],
      jsonataCondition: "payload.selected = true",
    },
  });
  const [, selected] = await source.append(
    { type: MATCHING_EVENT_TYPE, payload: { selected: false, value: "ignored" } },
    { type: MATCHING_EVENT_TYPE, payload: { selected: true, value: marker } },
  );

  const copied = await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    timeoutMs: 15_000,
  });
  expect(copied).toMatchObject({
    payload: { selected: true, value: marker },
    source: {
      copiedFrom: [
        {
          subscriptionKey,
          cursorChangedAtSourceOffset: configured.subscriptionConfiguredEvent.offset,
          createdAt: selected!.createdAt,
          offset: selected!.offset,
          path: sourcePath,
          projectId,
          type: MATCHING_EVENT_TYPE,
        },
      ],
    },
  });

  // Replaying the exact same transport batch is not a new delivery run. The
  // receiver accepts the coordinate idempotently without another append or
  // another increment in its durable incoming count.
  const sourceStateAfterCopy = coreState(await source.runtimeState());
  const duplicateReceipt = await deliverTrustedStreamBatch(receiver, {
    projectId,
    path: sourcePath,
    streamId: sourceStateAfterCopy.streamId!,
    streamCreatedAt: sourceStateAfterCopy.createdAt!,
    events: [selected!],
    streamMaxOffset: sourceStateAfterCopy.maxOffset,
    subscriptionKey,
    cursorChangedAtSourceOffset: configured.subscriptionConfiguredEvent.offset,
    deliveryId: streamDeliveryId(
      sourceStateAfterCopy.streamId!,
      subscriptionKey,
      configured.subscriptionConfiguredEvent.offset,
      selected!.offset,
      selected!.offset,
    ),
    attempt: 2,
    configuredEvent: subscriptionConfigurationForDelivery(configured.subscriptionConfiguredEvent),
  });
  expect(duplicateReceipt).toMatchObject({ acknowledged: 1 });
  expect(
    await receiver.getEvents({
      afterOffset: 0,
      eventTypes: [MATCHING_EVENT_TYPE],
    }),
  ).toHaveLength(1);
  expect(
    coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath]?.[
      subscriptionKey
    ],
  ).toMatchObject({ numEventsReceived: 1 });
});

test("a copy transform shapes the committed copy, keeps provenance, and dedupes a retried delivery", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/copy-transform/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/copy-transform/receiver/${marker}`;
  const subscriptionKey = `copy-transform-${marker}`;
  const summaryType = "events.iterate.test/subscriptions/summary";

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  const { projectId } = await project.__describe();
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  const configured = await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: {
      eventTypes: [MATCHING_EVENT_TYPE],
      jsonataCondition: "payload.selected = true",
    },
    jsonataTransform: `{ "type": "${summaryType}", "payload": { "value": payload.value } }`,
  });
  const [, selected] = await source.append(
    { type: MATCHING_EVENT_TYPE, payload: { selected: false, value: "ignored" } },
    { type: MATCHING_EVENT_TYPE, payload: { selected: true, value: marker } },
  );

  const copied = await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: [summaryType],
    timeoutMs: 30_000,
  });
  expect(copied).toMatchObject({
    payload: { value: marker },
    source: {
      copiedFrom: [
        {
          subscriptionKey,
          cursorChangedAtSourceOffset: configured.subscriptionConfiguredEvent.offset,
          createdAt: selected!.createdAt,
          offset: selected!.offset,
          path: sourcePath,
          projectId,
          // The hop records the ORIGINAL source type; only the committed
          // body is reshaped.
          type: MATCHING_EVENT_TYPE,
        },
      ],
    },
  });

  // Replaying the exact same transport batch is not a new delivery run: the
  // dedupe identity is the source coordinate, which the transform cannot
  // touch, so the receiver accepts it idempotently without another append.
  const sourceStateAfterCopy = coreState(await source.runtimeState());
  const duplicateReceipt = await deliverTrustedStreamBatch(receiver, {
    projectId,
    path: sourcePath,
    streamId: sourceStateAfterCopy.streamId!,
    streamCreatedAt: sourceStateAfterCopy.createdAt!,
    events: [selected!],
    streamMaxOffset: sourceStateAfterCopy.maxOffset,
    subscriptionKey,
    cursorChangedAtSourceOffset: configured.subscriptionConfiguredEvent.offset,
    deliveryId: streamDeliveryId(
      sourceStateAfterCopy.streamId!,
      subscriptionKey,
      configured.subscriptionConfiguredEvent.offset,
      selected!.offset,
      selected!.offset,
    ),
    attempt: 2,
    configuredEvent: subscriptionConfigurationForDelivery(configured.subscriptionConfiguredEvent),
  });
  expect(duplicateReceipt).toMatchObject({ acknowledged: 1 });
  expect(
    await receiver.getEvents({
      afterOffset: 0,
      eventTypes: [summaryType],
    }),
  ).toHaveLength(1);
});

test("changing a subscription cursor deliberately copies the same source coordinate again", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/copy-after-seek/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/copy-after-seek/receiver/${marker}`;
  const subscriptionKey = `copy-after-seek-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  const configured = await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
  });
  const [selected] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { value: marker },
  });
  const firstCopy = await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    timeoutMs: 15_000,
  });

  // Rewind through the successfully delivered event. This is a deliberate new
  // delivery run, not a transport retry, so the receiving stream appends a second copy.
  const cursorSet = await source.setSubscriptionCursor({
    subscriptionKey,
    afterOffset: selected!.offset - 1,
  });
  await waitForCondition(
    async () =>
      runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]
        ?.acknowledgedOffset >= selected!.offset,
    { description: "the rewound stream subscription to acknowledge the event again" },
  );
  const copiesAfterSeek = await receiver.getEvents({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
  });
  expect(copiesAfterSeek).toHaveLength(2);
  const copiedAfterSeek = copiesAfterSeek[1]!;
  expect(copiedAfterSeek).toMatchObject({
    source: {
      copiedFrom: [
        expect.objectContaining({
          subscriptionKey,
          cursorChangedAtSourceOffset: cursorSet.offset,
          offset: selected!.offset,
        }),
      ],
    },
  });

  const receiverState = coreState(await receiver.runtimeState());
  expect(
    receiverState.subscriptions.inbound.bySourcePath[sourcePath]?.[subscriptionKey],
  ).toMatchObject({
    cursorChangedAtSourceOffset: cursorSet.offset,
    numEventsReceived: 2,
    lastEventReceivedAt: copiedAfterSeek.createdAt,
  });
  expect(configured).toMatchObject({ subscriptionKey });
  expect(firstCopy.offset).toBeLessThan(copiedAfterSeek.offset);
});

test("replacing a subscription starts a new copy run and keeps configuration out of runtime state", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/copy-after-replacement/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/copy-after-replacement/receiver/${marker}`;
  const subscriptionKey = `copy-after-replacement-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: {
      eventTypes: [MATCHING_EVENT_TYPE],
      jsonataCondition: "payload.selected = true",
    },
  });
  const [selected] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { selected: true, value: marker },
  });
  const firstCopy = await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    timeoutMs: 15_000,
  });

  // A same-key replacement is another deliberate delivery run. Its own
  // configure-event offset distinguishes the replay from the old copy.
  const replacement = await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: {
      eventTypes: [MATCHING_EVENT_TYPE],
      jsonataCondition: "payload.selected = true",
    },
    description: "Replacement run",
    start: "beginning",
  });
  await waitForCondition(
    async () =>
      (runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]
        ?.acknowledgedOffset ?? 0) >= selected!.offset,
    { description: "the replacement run to replay the existing source coordinate" },
  );
  expect(
    coreState(await source.runtimeState()).subscriptions.outbound.byKey[subscriptionKey],
  ).toMatchObject({
    configuration: replacement.subscriptionConfiguredEvent.payload,
  });
  expect(
    coreState(await source.runtimeState()).subscriptions.outbound.byKey[subscriptionKey],
  ).not.toHaveProperty("deliveryHalted");
  const copiedByReplacementReplay = await receiver.waitForEvent({
    afterOffset: firstCopy.offset,
    eventTypes: [MATCHING_EVENT_TYPE],
    predicate: (event) =>
      event.source?.copiedFrom?.at(-1)?.cursorChangedAtSourceOffset ===
      replacement.subscriptionConfiguredEvent.offset,
    timeoutMs: 15_000,
  });
  expect(copiedByReplacementReplay).toMatchObject({
    payload: { selected: true, value: marker },
    source: {
      copiedFrom: [
        expect.objectContaining({
          subscriptionKey,
          cursorChangedAtSourceOffset: replacement.subscriptionConfiguredEvent.offset,
          offset: selected!.offset,
        }),
      ],
    },
  });

  const [, newUnderReplacement] = await source.append(
    { type: MATCHING_EVENT_TYPE, payload: { selected: false, value: "still ignored" } },
    { type: MATCHING_EVENT_TYPE, payload: { selected: true, value: `${marker}-v2` } },
  );
  const copiedUnderReplacement = await receiver.waitForEvent({
    afterOffset: copiedByReplacementReplay.offset,
    eventTypes: [MATCHING_EVENT_TYPE],
    predicate: (event) => event.payload?.value === `${marker}-v2`,
    timeoutMs: 15_000,
  });
  expect(copiedUnderReplacement).toMatchObject({
    payload: { selected: true, value: `${marker}-v2` },
    source: {
      copiedFrom: [
        expect.objectContaining({
          subscriptionKey,
          offset: newUnderReplacement!.offset,
          path: sourcePath,
        }),
      ],
    },
  });

  // Configuration has one durable home; runtime contributes only mutable
  // cursor/health/metrics fields and does not repeat receiver or policy configuration.
  const sourceState = runtimeState(await source.runtimeState());
  expect(
    sourceState.coreProcessorState.subscriptions.outbound.byKey[subscriptionKey],
  ).toMatchObject({
    configuration: replacement.subscriptionConfiguredEvent.payload,
  });
  expect(sourceState.runtime.subscriptions[subscriptionKey]).not.toHaveProperty("configuration");
  expect(sourceState.runtime.subscriptions[subscriptionKey]).not.toHaveProperty("receiver");
  expect(sourceState.runtime.subscriptions[subscriptionKey]).not.toHaveProperty("mode");
});

test("a filter failure retries in order and never advances past later events", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/filter-failure/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/filter-failure/receiver/${marker}`;
  const subscriptionKey = `filter-failure-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: {
      eventTypes: [MATCHING_EVENT_TYPE],
      jsonataCondition: '($assert(payload.allowed, "filter rejected event"); true)',
    },
  });
  const [failed, later] = await source.append(
    { type: MATCHING_EVENT_TYPE, payload: { marker, allowed: false, sequence: 1 } },
    { type: MATCHING_EVENT_TYPE, payload: { marker, allowed: true, sequence: 2 } },
  );

  await waitForCondition(
    async () =>
      (runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]?.attempt ??
        0) >= 1,
    { description: "the filter exception to enter the normal retry loop" },
  );
  const runtime = runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]!;
  expect(runtime.acknowledgedOffset).toBeLessThan(failed!.offset);
  expect(runtime.acknowledgedOffset).toBeLessThan(later!.offset);
  expect(runtime.lastError).toContain("filter condition failed");
  expect(runtime.lastError).toContain("filter rejected event");
  expect(await receiver.getEvents({ afterOffset: 0, eventTypes: [MATCHING_EVENT_TYPE] })).toEqual(
    [],
  );
});

test("every project child stream is born with ordinary project-worker and PostHog ITX receivers", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/subscriptions/platform-defaults/${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  const { projectId } = await project.__describe();
  using stream = project.streams.get(streamPath);

  const state = coreState(await stream.runtimeState());
  expect(state.subscriptions.outbound.byKey["project-worker"]?.configuration).toMatchObject({
    subscriptionKey: "project-worker",
    receiver: {
      action: "itx-call",
      expression: ["processEventBatch"],
      delivery: {
        start: "beginning",
        onFailingEvent: "skip",
      },
    },
  });
  expect(
    state.subscriptions.outbound.byKey["iterate-platform-posthog"]?.configuration,
  ).toMatchObject({
    subscriptionKey: "iterate-platform-posthog",
    receiver: {
      action: "itx-call",
      expression: ["integrations", "posthog", "processEventBatch"],
      delivery: {
        start: "beginning",
        onFailingEvent: "halt",
      },
    },
  });

  const [appended] = await stream.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, purpose: "prove both default receivers acknowledge real stream data" },
  });
  await waitForCondition(
    async () => {
      const subscriptions = runtimeState(await stream.runtimeState()).runtime.subscriptions;
      return ["project-worker", "iterate-platform-posthog"].every(
        (key) => (subscriptions[key]?.acknowledgedOffset ?? 0) >= appended!.offset,
      );
    },
    {
      description: "the ordinary project-worker and PostHog feeds to acknowledge the append",
      timeoutMs: 30_000,
    },
  );

  await expect(
    project.processEventBatch({
      projectId,
      path: streamPath,
      streamId: crypto.randomUUID(),
      streamCreatedAt: new Date().toISOString(),
      events: [],
      streamMaxOffset: 0,
      subscriptionKey: "project-worker",
      cursorChangedAtSourceOffset: 1,
      deliveryId: `forged-project-worker:${marker}`,
      attempt: 1,
      configuredEvent: {
        type: "events.iterate.com/stream/subscription-configured",
        offset: 1,
        createdAt: new Date().toISOString(),
        path: streamPath,
        payload: {
          subscriptionKey: "project-worker",
          receiver: {
            action: "itx-call",
            expression: ["unused"],
            delivery: deliveryPolicy("now"),
          },
        },
      },
    }),
  ).rejects.toThrow("project worker ingestion is available only to stream delivery");

  using impersonatedSession = withItxSession();
  using impersonatedItx = impersonatedSession.authenticate({
    type: "impersonate",
    secret: adminSecret(),
    token: { type: "admin", principal: "trusted-internal" },
  });
  using impersonatedProject = impersonatedItx.projects.get(projectId);
  using impersonatedStream = impersonatedProject.streams.get(streamPath);
  const hiddenReceiver = impersonatedStream as unknown as {
    receiveCopiedEvents(batch: unknown): Promise<unknown>;
  };
  await expect(
    hiddenReceiver.receiveCopiedEvents({
      projectId,
      path: "/forged-source",
      events: [],
      streamMaxOffset: 1,
      subscriptionKey: "forged",
      cursorChangedAtSourceOffset: 1,
      deliveryId: `forged-copy:${marker}`,
      attempt: 1,
      configuredEvent: {
        type: "events.iterate.com/stream/subscription-configured",
        offset: 1,
        createdAt: new Date().toISOString(),
        path: "/forged-source",
        payload: {},
      },
    }),
  ).rejects.toThrow("copied stream events are accepted only from trusted internal senders");

  const hiddenProcessorWake = impersonatedProject.processor as unknown as {
    wakeStreamProcessor(request: unknown): Promise<unknown>;
  };
  await expect(
    hiddenProcessorWake.wakeStreamProcessor({
      stream: { projectId, path: "/", streamMaxOffset: 1 },
      subscriptionKey: "forged",
    }),
  ).rejects.toThrow("wakeStreamProcessor may be called only by trusted stream event sending");

  const posthog = (
    impersonatedProject.integrations as unknown as {
      posthog: { processEventBatch(batch: unknown): Promise<void> };
    }
  ).posthog;
  await expect(
    posthog.processEventBatch({
      attempt: 1,
      deliveryId: `forgery:${marker}`,
      events: [],
      path: streamPath,
      projectId,
      streamMaxOffset: 0,
      subscriptionKey: "iterate-platform-posthog",
    }),
  ).rejects.toThrow("PostHog ingestion is available only to stream delivery");
});

test("a hosted processor returns its callback, idles cleanly, and wakes again after idle and eviction", async () => {
  const marker = crypto.randomUUID();
  const connection = `e2e-${marker.slice(0, 8)}`;
  const streamPath = `/integrations/slack/${connection}`;
  const subscriptionKey = `hosted-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using stream = project.streams.get(streamPath);

  await stream.append(
    subscriptionConfigured({
      subscriptionKey,
      receiver: {
        action: "processor-wake",
        expression: [
          "integrations",
          "slack",
          ["get", connection],
          "processor",
          "wakeStreamProcessor",
        ],
        processorSlug: "slack",
      },
    }),
  );
  await waitForCondition(
    async () => {
      const state = runtimeState(await stream.runtimeState());
      return state.runtime.connections[subscriptionKey]?.kind === "hosted";
    },
    {
      description: "the hosted processor wake call to return its batch callback",
      timeoutMs: 30_000,
    },
  );
  expect(
    runtimeState(await stream.runtimeState()).runtime.connections[subscriptionKey],
  ).toMatchObject({
    kind: "hosted",
    subscriptionKey,
  });

  const [created] = await stream.append({
    type: "events.iterate.com/slack/created",
    payload: { config: { connection } },
  });
  await waitForCondition(
    async () => {
      const runtime = await stream.getProcessorRuntimeState({ subscriptionKey });
      return (
        (runtime?.snapshot.offset ?? 0) >= created!.offset &&
        (
          runtime?.snapshot.state as
            | { birthCertificate?: { config?: { connection?: string } } }
            | undefined
        )?.birthCertificate?.config?.connection === connection
      );
    },
    { description: "the Slack processor to reduce its own birth certificate" },
  );

  const ephemeralRouteKey = `C${marker.slice(0, 6)}:1712345678.000050`;
  const durableRouteKey = `C${marker.slice(0, 6)}:1712345678.000051`;
  const [, durableRouteConfigured] = await stream.append(
    {
      type: "events.iterate.com/slack/thread-route-configured",
      ephemeral: true,
      payload: {
        channel: ephemeralRouteKey.split(":")[0],
        threadTs: ephemeralRouteKey.split(":")[1],
        streamPath: `/agents/slack/${connection}/ephemeral-${marker}`,
      },
    },
    {
      type: "events.iterate.com/slack/thread-route-configured",
      payload: {
        channel: durableRouteKey.split(":")[0],
        threadTs: durableRouteKey.split(":")[1],
        streamPath: `/agents/slack/${connection}/durable-${marker}`,
      },
    },
  );
  await waitForCondition(
    async () => {
      const runtime = await stream.getProcessorRuntimeState({ subscriptionKey });
      const routes = (runtime?.snapshot.state as { routes?: Record<string, string> } | undefined)
        ?.routes;
      return (
        (runtime?.snapshot.offset ?? 0) >= durableRouteConfigured!.offset &&
        routes?.[durableRouteKey] === `/agents/slack/${connection}/durable-${marker}`
      );
    },
    { description: "the hosted processor to reduce the durable route after an ephemeral route" },
  );
  expect(
    (
      (await stream.getProcessorRuntimeState({ subscriptionKey }))?.snapshot.state as
        | { routes?: Record<string, string> }
        | undefined
    )?.routes?.[ephemeralRouteKey],
  ).toBeUndefined();

  await waitForCondition(
    async () =>
      runtimeState(await stream.runtimeState()).runtime.connections[subscriptionKey]
        ?.hasPendingDelivery === false,
    { description: "the hosted callback to settle before forced idle teardown" },
  );
  await forceStreamIdleTeardown(stream);
  await waitForCondition(
    async () =>
      runtimeState(await stream.runtimeState()).runtime.connections[subscriptionKey] === undefined,
    { description: "idle teardown to release the hosted callback" },
  );
  expect(
    (
      await stream.getEvents({
        afterOffset: created!.offset,
        eventTypes: ["events.iterate.com/stream/connection-closed"],
        limit: 100,
      })
    ).some(
      (event) =>
        event.payload?.connectionKey === subscriptionKey && event.payload?.reason === "idle",
    ),
  ).toBe(true);

  const routeKeyAfterIdle = `C${marker.slice(0, 6)}:1712345678.000100`;
  const [routeConfiguredAfterIdle] = await stream.append({
    type: "events.iterate.com/slack/thread-route-configured",
    payload: {
      channel: routeKeyAfterIdle.split(":")[0],
      threadTs: routeKeyAfterIdle.split(":")[1],
      streamPath: `/agents/slack/${connection}/after-idle-${marker}`,
    },
  });
  await waitForCondition(
    async () => {
      const runtime = await stream.getProcessorRuntimeState({ subscriptionKey });
      return (
        (runtime?.snapshot.offset ?? 0) >= routeConfiguredAfterIdle!.offset &&
        (runtime?.snapshot.state as { routes?: Record<string, string> } | undefined)?.routes?.[
          routeKeyAfterIdle
        ] === `/agents/slack/${connection}/after-idle-${marker}`
      );
    },
    {
      description: "the idled Slack processor to wake from its checkpoint",
      timeoutMs: 30_000,
    },
  );

  await stream.kill().catch(() => undefined);
  expect(
    coreState(await stream.runtimeState()).subscriptions.outbound.byKey[subscriptionKey],
  ).toBeDefined();

  const routeKey = `C${marker.slice(0, 6)}:1712345678.000200`;
  const [routeConfigured] = await stream.append({
    type: "events.iterate.com/slack/thread-route-configured",
    payload: {
      channel: routeKey.split(":")[0],
      threadTs: routeKey.split(":")[1],
      streamPath: `/agents/slack/${connection}/route-${marker}`,
    },
  });
  await waitForCondition(
    async () => {
      const runtime = await stream.getProcessorRuntimeState({ subscriptionKey });
      return (
        (runtime?.snapshot.offset ?? 0) >= routeConfigured!.offset &&
        (runtime?.snapshot.state as { routes?: Record<string, string> } | undefined)?.routes?.[
          routeKey
        ] === `/agents/slack/${connection}/route-${marker}`
      );
    },
    {
      description: "the evicted Slack processor to re-wake and reduce a routed-thread fact",
      timeoutMs: 30_000,
    },
  );
});

// The wake-socket cycle for session connections (wake-socket.ts): idle
// teardown severs the pinning RPC leg while the owner's Cap'n Web session
// stays open, and the next matching append makes the worker relay re-dial —
// the SAME processEventBatch callback receives it, with no client
// re-subscribe. Lifecycle facts and non-matching appends must not resurrect
// the dormant subscriber (the close→wake→open→idle-close loop).
test("an idle-torn session connection resumes on the next matching append without re-subscribing", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/subscriptions/session/wake/${marker}`;
  const connectionKey = `wake-${marker.slice(0, 8)}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using stream = project.streams.get(streamPath);

  const received: StreamEvent[] = [];
  const handle = await stream.openConnection({
    connectionKey,
    eventTypes: [MATCHING_EVENT_TYPE],
    processEventBatch: ({ events }) => {
      received.push(...events);
    },
  });
  try {
    const [first] = await stream.append({
      type: MATCHING_EVENT_TYPE,
      payload: { round: "before-idle" },
    });
    await waitForCondition(async () => received.some((event) => event.offset === first!.offset), {
      description: "the live session connection to deliver the first append",
    });

    await forceStreamIdleTeardown(stream);
    await waitForCondition(
      async () =>
        runtimeState(await stream.runtimeState()).runtime.connections[connectionKey] === undefined,
      { description: "idle teardown to sever the wake-socket-backed session connection" },
    );
    expect(
      (
        await stream.getEvents({
          eventTypes: ["events.iterate.com/stream/connection-closed"],
          limit: 100,
        })
      ).some(
        (event) =>
          event.payload?.connectionKey === connectionKey && event.payload?.reason === "idle",
      ),
    ).toBe(true);
    // The logical subscription stays live across dormancy: the relay-local
    // handle answers for it, not the severed RPC leg.
    await expect(Promise.resolve(handle.ping())).resolves.toBe(true);

    // A non-matching append must not resurrect the dormant subscriber…
    await stream.append({ type: OTHER_EVENT_TYPE, payload: { round: "while-dormant" } });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(
      runtimeState(await stream.runtimeState()).runtime.connections[connectionKey],
    ).toBeUndefined();

    // …while a matching one wakes the relay, which re-dials from its exact
    // cursor and delivers through the ORIGINAL callback.
    const [second] = await stream.append({
      type: MATCHING_EVENT_TYPE,
      payload: { round: "after-idle" },
    });
    await waitForCondition(async () => received.some((event) => event.offset === second!.offset), {
      description: "the wake re-dial to deliver the post-idle append to the original callback",
      timeoutMs: 30_000,
    });
    expect(received.map((event) => event.type)).toEqual([MATCHING_EVENT_TYPE, MATCHING_EVENT_TYPE]);
    expect(received.map((event) => event.offset)).toEqual([first!.offset, second!.offset]);
    await waitForCondition(
      async () =>
        runtimeState(await stream.runtimeState()).runtime.connections[connectionKey]?.kind ===
        "session",
      { description: "the re-dialed session connection to appear in runtime state" },
    );
  } finally {
    await handle.close();
    disposeRpc(handle);
  }
});

// The resurrection-loop regression (Bugbot 9d27eb22): a subscriber whose
// filter explicitly names connection-closed must NOT be woken by its own idle
// close fact — the teardown's nested reconcile runs before the dormancy stamp
// lands, so without the isTearingDown gate the close would wake the relay,
// re-dial, idle again, and cycle forever. The deferred close fact still
// arrives on the next real wake.
test("an idle close never wakes the subscriber it closed, even when its filter names connection-closed", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/subscriptions/session/wake-loop/${marker}`;
  const connectionKey = `wake-loop-${marker.slice(0, 8)}`;
  const CLOSED_EVENT_TYPE = "events.iterate.com/stream/connection-closed";

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using stream = project.streams.get(streamPath);

  const received: StreamEvent[] = [];
  const handle = await stream.openConnection({
    connectionKey,
    eventTypes: [MATCHING_EVENT_TYPE, CLOSED_EVENT_TYPE],
    processEventBatch: ({ events }) => {
      received.push(...events);
    },
  });
  try {
    // Deliver one matching event first so the relay has a concrete cursor;
    // tearing down before any delivery would make the eventual re-dial
    // replay from head and could miss the close fact the final assertion
    // requires.
    const [seed] = await stream.append({ type: MATCHING_EVENT_TYPE, payload: { phase: "seed" } });
    await waitForCondition(async () => received.some((event) => event.offset === seed!.offset), {
      description: "the live connection to deliver the seed event",
    });
    await forceStreamIdleTeardown(stream);
    await waitForCondition(
      async () =>
        runtimeState(await stream.runtimeState()).runtime.connections[connectionKey] === undefined,
      { description: "idle teardown to sever the lifecycle-filtered session connection" },
    );

    // The loop would re-open within one wake round trip; give it ample time
    // to manifest, then require the connection stayed dormant with exactly
    // one idle close on the record.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(
      runtimeState(await stream.runtimeState()).runtime.connections[connectionKey],
    ).toBeUndefined();
    const idleCloses = (
      await stream.getEvents({ eventTypes: [CLOSED_EVENT_TYPE], limit: 100 })
    ).filter(
      (event) => event.payload?.connectionKey === connectionKey && event.payload?.reason === "idle",
    );
    expect(idleCloses).toHaveLength(1);

    // A real matching append wakes the relay, and the replay delivers the
    // deferred close fact along with the new event.
    const [fresh] = await stream.append({
      type: MATCHING_EVENT_TYPE,
      payload: { round: "after-idle" },
    });
    await waitForCondition(async () => received.some((event) => event.offset === fresh!.offset), {
      description: "the wake re-dial to deliver the post-idle append",
      timeoutMs: 30_000,
    });
    expect(
      received.some(
        (event) =>
          event.type === CLOSED_EVENT_TYPE && event.payload?.connectionKey === connectionKey,
      ),
    ).toBe(true);
  } finally {
    await handle.close();
    disposeRpc(handle);
  }
});

// Reset ends one source-stream lifetime and starts another at the same path.
// Wrangler cannot model the required ctx.abort(), so this host-survival proof
// runs only against a real preview deployment.
test.skipIf(deployedBaseUrl() === null)(
  "a surviving hosted processor resets its checkpoint and folded state for a recreated source",
  { timeout: 45_000 },
  async () => {
    const marker = crypto.randomUUID();
    const connection = `e2e-recreated-${marker.slice(0, 8)}`;
    const streamPath = `/integrations/slack/${connection}`;
    const subscriptionKey = `hosted-recreated-${marker}`;
    const oldRouteKey = `C${marker.slice(0, 6)}:1712345678.000210`;
    const newRouteKey = `C${marker.slice(0, 6)}:1712345678.000220`;

    using testProject = await openTestProject(marker);
    const { project } = testProject;
    using stream = project.streams.get(streamPath);

    const configuredEvent = () =>
      subscriptionConfigured({
        subscriptionKey,
        receiver: {
          action: "processor-wake",
          expression: [
            "integrations",
            "slack",
            ["get", connection],
            "processor",
            "wakeStreamProcessor",
          ],
          processorSlug: "slack",
        },
      });

    await stream.append(configuredEvent());
    const [, oldRoute] = await stream.append(
      {
        type: "events.iterate.com/slack/created",
        payload: { config: { connection } },
      },
      {
        type: "events.iterate.com/slack/thread-route-configured",
        payload: {
          channel: oldRouteKey.split(":")[0],
          threadTs: oldRouteKey.split(":")[1],
          streamPath: `/agents/slack/${connection}/old-lifetime-${marker}`,
        },
      },
    );
    await waitForCondition(
      async () => {
        const snapshot = (await stream.getProcessorRuntimeState({ subscriptionKey }))?.snapshot;
        return (
          (snapshot?.offset ?? 0) >= oldRoute!.offset &&
          (snapshot?.state as { routes?: Record<string, string> } | undefined)?.routes?.[
            oldRouteKey
          ] === `/agents/slack/${connection}/old-lifetime-${marker}`
        );
      },
      {
        description: "the hosted processor to durably reduce the old source lifetime",
        timeoutMs: 30_000,
      },
    );
    const oldSourceId = coreState(await stream.runtimeState()).streamId;
    expect(oldSourceId).toBeDefined();

    await forceStreamReset(stream).catch(() => undefined);
    const recreatedSource = coreState(await stream.runtimeState());
    expect(recreatedSource.streamId).toBeDefined();
    expect(recreatedSource).not.toMatchObject({ streamId: oldSourceId });

    const [newConfiguration] = await stream.append(configuredEvent());
    await waitForCondition(
      async () => {
        const runtime = await stream.getProcessorRuntimeState({ subscriptionKey });
        const state = runtime?.snapshot.state as
          | {
              birthCertificate?: unknown;
              routes?: Record<string, string>;
            }
          | undefined;
        return (
          (runtime?.snapshot.offset ?? 0) >= newConfiguration!.offset &&
          state?.birthCertificate === null &&
          Object.keys(state.routes ?? {}).length === 0
        );
      },
      {
        description: "the surviving host to replace the old lifetime's checkpoint and folded state",
        timeoutMs: 30_000,
      },
    );

    const [, newRoute] = await stream.append(
      {
        type: "events.iterate.com/slack/created",
        payload: { config: { connection } },
      },
      {
        type: "events.iterate.com/slack/thread-route-configured",
        payload: {
          channel: newRouteKey.split(":")[0],
          threadTs: newRouteKey.split(":")[1],
          streamPath: `/agents/slack/${connection}/new-lifetime-${marker}`,
        },
      },
    );
    await waitForCondition(
      async () => {
        const snapshot = (await stream.getProcessorRuntimeState({ subscriptionKey }))?.snapshot;
        const state = snapshot?.state as
          | {
              birthCertificate?: { config?: { connection?: string } };
              routes?: Record<string, string>;
            }
          | undefined;
        return (
          (snapshot?.offset ?? 0) >= newRoute!.offset &&
          state?.birthCertificate?.config?.connection === connection &&
          state.routes?.[newRouteKey] === `/agents/slack/${connection}/new-lifetime-${marker}`
        );
      },
      {
        description: "the reset hosted processor to reduce the recreated source lifetime",
        timeoutMs: 30_000,
      },
    );
    const recreatedProcessorState = (await stream.getProcessorRuntimeState({ subscriptionKey }))
      ?.snapshot.state as { routes?: Record<string, string> } | undefined;
    expect(recreatedProcessorState?.routes?.[oldRouteKey]).toBeUndefined();
  },
);

test("hosted delivery intersects the stored filter with the processor's announced event types", async () => {
  const marker = crypto.randomUUID();
  const connection = `e2e-intersection-${marker.slice(0, 8)}`;
  const streamPath = `/integrations/slack/${connection}`;
  const subscriptionKey = `hosted-intersection-${marker}`;
  const excludedRouteKey = `C${marker.slice(0, 6)}:1712345678.000300`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using stream = project.streams.get(streamPath);

  await stream.append(
    subscriptionConfigured({
      subscriptionKey,
      filter: {
        // Slack announces `slack/created` and `thread-route-configured`, but not
        // MATCHING_EVENT_TYPE. This stored filter chooses the opposite side
        // for the latter two, so only `slack/created` survives both filters.
        eventTypes: ["events.iterate.com/slack/created", MATCHING_EVENT_TYPE],
      },
      receiver: {
        action: "processor-wake",
        expression: [
          "integrations",
          "slack",
          ["get", connection],
          "processor",
          "wakeStreamProcessor",
        ],
        processorSlug: "slack",
      },
    }),
  );
  await waitForCondition(
    async () =>
      runtimeState(await stream.runtimeState()).runtime.connections[subscriptionKey]?.kind ===
      "hosted",
    {
      description: "the filter-intersection hosted processor to open",
      timeoutMs: 30_000,
    },
  );

  const [, , created] = await stream.append(
    {
      // Accepted by the processor announcement, rejected by the stored filter.
      type: "events.iterate.com/slack/thread-route-configured",
      payload: {
        channel: excludedRouteKey.split(":")[0],
        threadTs: excludedRouteKey.split(":")[1],
        streamPath: `/agents/slack/${connection}/filter-excluded-${marker}`,
      },
    },
    {
      // Accepted by the stored filter, rejected by the processor announcement.
      type: MATCHING_EVENT_TYPE,
      payload: { marker, purpose: "announcement exclusion" },
    },
    {
      // Accepted by both; proves delivery continued past both excluded rows.
      type: "events.iterate.com/slack/created",
      payload: { config: { connection } },
    },
  );
  await waitForCondition(
    async () => {
      const runtime = await stream.getProcessorRuntimeState({ subscriptionKey });
      return (
        (runtime?.snapshot.offset ?? 0) >= created!.offset &&
        (
          runtime?.snapshot.state as
            | {
                birthCertificate?: { config?: { connection?: string } };
                routes?: Record<string, string>;
              }
            | undefined
        )?.birthCertificate?.config?.connection === connection
      );
    },
    {
      description: "the hosted processor to receive the event accepted by both filters",
      timeoutMs: 30_000,
    },
  );
  const processorState = (await stream.getProcessorRuntimeState({ subscriptionKey }))?.snapshot
    .state as { routes?: Record<string, string> } | undefined;
  expect(processorState?.routes?.[excludedRouteKey]).toBeUndefined();
  expect(
    runtimeState(await stream.runtimeState()).runtime.connections[subscriptionKey],
  ).toMatchObject({
    kind: "hosted",
  });
  expect(
    coreState(await stream.runtimeState()).subscriptions.outbound.byKey[subscriptionKey],
  ).not.toHaveProperty("deliveryHalted");
});

test("an ITX-expression receiver invokes the project worker in awaited batches", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/itx/source/${marker}`;
  const outputPath = `/e2e/subscriptions/itx/output/${marker}`;
  const subscriptionKey = `itx-${marker}`;
  const outputType = "events.iterate.test/subscriptions/itx-received";

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  await project.repo.commitFiles({
    message: "Add subscription delivery probe worker",
    changes: [
      {
        path: "worker.ts",
        content: `
            import { WorkerEntrypoint } from "cloudflare:workers";

            const SUBSCRIPTION_KEY = ${JSON.stringify(subscriptionKey)};
            const OUTPUT_PATH = ${JSON.stringify(outputPath)};
            const OUTPUT_TYPE = ${JSON.stringify(outputType)};

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch() { return new Response("subscription probe"); }

              async processEventBatch(batch) {
                if (batch.subscriptionKey !== SUBSCRIPTION_KEY) return;
                const itx = await this.env.ITX.get();
                await itx.streams.get(OUTPUT_PATH).append({
                  type: OUTPUT_TYPE,
                  idempotencyKey: batch.deliveryId,
                  payload: {
                    attempt: batch.attempt,
                    deliveryId: batch.deliveryId,
                    offsets: batch.events.map((event) => event.offset),
                    sourcePath: batch.path,
                    subscriptionKey: batch.subscriptionKey,
                  },
                });
              }
            }
          `,
      },
    ],
  });
  const workerProbe = await project.worker.fetch(
    new Request(`https://subscription-probe.invalid/ready/${marker}`),
  );
  expect(await workerProbe.text()).toBe("subscription probe");
  using source = project.streams.get(sourcePath);
  using output = project.streams.get(outputPath);

  await source.append(
    subscriptionConfigured({
      subscriptionKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      receiver: {
        action: "itx-call",
        expression: ["worker", "processEventBatch"],
        delivery: deliveryPolicy("now", { onFailingEvent: "skip" }),
      },
    }),
  );
  const appended = await source.append(
    { type: MATCHING_EVENT_TYPE, payload: { marker, sequence: 1 } },
    { type: MATCHING_EVENT_TYPE, payload: { marker, sequence: 2 } },
  );
  const observed = await output.waitForEvent({
    afterOffset: 0,
    eventTypes: [outputType],
    timeoutMs: 180_000,
  });
  expect(observed.payload).toMatchObject({
    attempt: 1,
    offsets: appended.map((event) => event.offset),
    sourcePath,
    subscriptionKey,
  });
  await waitForCondition(
    async () =>
      (runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]
        ?.acknowledgedOffset ?? 0) >= appended.at(-1)!.offset,
    { description: "the ITX receiver acknowledgement to advance the source cursor" },
  );
});

test("an ITX-expression receiver isolates one repeatedly failing event, skips it, and continues", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/itx-failing-event/source/${marker}`;
  const outputPath = `/e2e/subscriptions/itx-failing-event/output/${marker}`;
  const subscriptionKey = `itx-failing-event-${marker}`;
  const attemptType = "events.iterate.test/subscriptions/itx-failing-event-attempted";
  const acceptedType = "events.iterate.test/subscriptions/itx-failing-event-accepted";

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  await project.repo.commitFiles({
    message: "Add batched failing-event probe worker",
    changes: [
      {
        path: "worker.ts",
        content: `
            import { WorkerEntrypoint } from "cloudflare:workers";

            const SUBSCRIPTION_KEY = ${JSON.stringify(subscriptionKey)};
            const OUTPUT_PATH = ${JSON.stringify(outputPath)};
            const ATTEMPT_TYPE = ${JSON.stringify(attemptType)};
            const ACCEPTED_TYPE = ${JSON.stringify(acceptedType)};

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch() { return new Response("failing-event probe"); }

              async processEventBatch(batch) {
                if (batch.subscriptionKey !== SUBSCRIPTION_KEY) return;
                const itx = await this.env.ITX.get();
                const output = itx.streams.get(OUTPUT_PATH);
                await output.append({
                  type: ATTEMPT_TYPE,
                  payload: {
                    offsets: batch.events.map((event) => event.offset),
                    sequences: batch.events.map((event) => event.payload.sequence),
                  },
                });
                if (batch.events.some((event) => event.payload.shouldFail === true)) {
                  throw new Error("deliberate batch failure");
                }
                await output.append({
                  type: ACCEPTED_TYPE,
                  idempotencyKey: batch.deliveryId,
                  payload: {
                    offsets: batch.events.map((event) => event.offset),
                    sequences: batch.events.map((event) => event.payload.sequence),
                  },
                });
              }
            }
          `,
      },
    ],
  });
  const workerProbe = await project.worker.fetch(
    new Request(`https://failing-event-probe.invalid/ready/${marker}`),
  );
  expect(await workerProbe.text()).toBe("failing-event probe");
  using source = project.streams.get(sourcePath);
  using output = project.streams.get(outputPath);

  await source.append(
    subscriptionConfigured({
      subscriptionKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      receiver: {
        action: "itx-call",
        expression: ["worker", "processEventBatch"],
        delivery: deliveryPolicy("now", { onFailingEvent: "skip" }),
      },
    }),
  );
  const appended = await source.append(
    { type: MATCHING_EVENT_TYPE, payload: { marker, sequence: 1 } },
    { type: MATCHING_EVENT_TYPE, payload: { marker, shouldFail: true, sequence: 2 } },
    { type: MATCHING_EVENT_TYPE, payload: { marker, sequence: 3 } },
  );

  // Isolating the poisoned event takes the whole ladder: the batch failure
  // pins the next read to one event, healthy prefixes commit one at a time,
  // and FAILING_EVENT_CONFIRM_ATTEMPTS single-event confirmations follow —
  // each behind its own exponential backoff (~8s of pure
  // backoff nominally, more with jitter and slow preview invocations).
  await waitForCondition(
    async () =>
      (runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]
        ?.acknowledgedOffset ?? 0) >= appended.at(-1)!.offset,
    {
      description: "the ITX receiver to isolate the failing event and acknowledge later events",
      timeoutMs: 60_000,
    },
  );

  const attempts = await output.getEvents({ afterOffset: 0, eventTypes: [attemptType] });
  expect(
    attempts.some(
      (event) =>
        Array.isArray(event.payload?.offsets) &&
        event.payload.offsets.includes(appended[1]!.offset) &&
        event.payload.offsets.length > 1,
    ),
  ).toBe(true);
  expect(
    attempts.filter(
      (event) =>
        Array.isArray(event.payload?.offsets) &&
        event.payload.offsets.length === 1 &&
        event.payload.offsets[0] === appended[1]!.offset,
    ),
  ).toHaveLength(3);
  const accepted = await output.getEvents({ afterOffset: 0, eventTypes: [acceptedType] });
  expect(accepted.flatMap((event) => event.payload?.sequences ?? [])).toEqual([1, 3]);
  expect(
    (await source.getEvents({ afterOffset: appended[1]!.offset })).some(
      (event) =>
        event.type === "events.iterate.com/stream/error-occurred" &&
        String(event.payload?.message).includes(`offset ${appended[1]!.offset}`),
    ),
  ).toBe(true);
});

test("the consecutive-failure limit survives stream eviction and halts before mass-skipping", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/itx-failing-event/eviction/${marker}`;
  const subscriptionKey = `itx-failing-event-eviction-${marker}`;
  const releasePath = `/e2e/subscriptions/itx-failing-event/release/${marker}`;
  const releaseType = "events.iterate.test/subscriptions/fuse-released";

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  await project.repo.commitFiles({
    message: "Add consecutive-failure probe worker",
    changes: [
      {
        path: "worker.ts",
        content: `
            import { WorkerEntrypoint } from "cloudflare:workers";

            const SUBSCRIPTION_KEY = ${JSON.stringify(subscriptionKey)};
            const RELEASE_PATH = ${JSON.stringify(releasePath)};
            const RELEASE_TYPE = ${JSON.stringify(releaseType)};

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch() { return new Response("fuse probe"); }

              async processEventBatch(batch) {
                if (batch.subscriptionKey !== SUBSCRIPTION_KEY) return;
                const itx = await this.env.ITX.get();
                const released = await itx.streams.get(RELEASE_PATH).getEvents({
                  eventTypes: [RELEASE_TYPE],
                  limit: 1,
                });
                if (released.length === 0) throw new Error("deliberate consecutive failure");
              }
            }
          `,
      },
    ],
  });
  const workerProbe = await project.worker.fetch(
    new Request(`https://fuse-probe.invalid/ready/${marker}`),
  );
  expect(await workerProbe.text()).toBe("fuse probe");
  using source = project.streams.get(sourcePath);
  using release = project.streams.get(releasePath);

  await source.append(
    subscriptionConfigured({
      subscriptionKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      receiver: {
        action: "itx-call",
        expression: ["worker", "processEventBatch"],
        delivery: deliveryPolicy("now", { onFailingEvent: "skip" }),
      },
    }),
  );

  for (const sequence of [1, 2]) {
    const [failingEvent] = await source.append({
      type: MATCHING_EVENT_TYPE,
      payload: { marker, sequence },
    });
    await waitForCondition(
      async () =>
        (await source.getEvents({ afterOffset: failingEvent!.offset })).some(
          (event) =>
            event.type === "events.iterate.com/stream/error-occurred" &&
            String(event.payload?.message).includes(`offset ${failingEvent!.offset}`),
        ),
      {
        description: `failing event ${sequence} to be retried, confirmed, and skipped`,
        // Confirming the failing event takes FAILING_EVENT_CONFIRM_ATTEMPTS
        // worker invocations behind exponential backoff — milliseconds each
        // locally, but seconds each on a cold preview slot.
        timeoutMs: 60_000,
      },
    );
    await source.kill().catch(() => undefined);
  }

  const [thirdFailingEvent] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, sequence: 3 },
  });
  await waitForCondition(
    async () =>
      coreState(await source.runtimeState()).subscriptions.outbound.byKey[subscriptionKey]
        ?.deliveryHalted !== undefined,
    {
      description: "the durable consecutive-failure limit to halt event sending",
      timeoutMs: 60_000,
    },
  );
  const state = runtimeState(await source.runtimeState());
  expect(state.runtime.subscriptions[subscriptionKey]!.acknowledgedOffset).toBeLessThan(
    thirdFailingEvent!.offset,
  );
  expect(
    (await source.getEvents({ afterOffset: thirdFailingEvent!.offset })).some(
      (event) =>
        event.type === "events.iterate.com/stream/error-occurred" &&
        String(event.payload?.message).includes(
          `skipped failing event at offset ${thirdFailingEvent!.offset}`,
        ),
    ),
  ).toBe(false);

  await release.append({ type: releaseType, payload: { marker } });
  const seekAndResume = await source.setSubscriptionCursorAndResume({
    subscriptionKey,
    afterOffset: thirdFailingEvent!.offset - 1,
  });
  expect(seekAndResume).toMatchObject({
    cursorSet: { type: "events.iterate.com/stream/subscription-cursor-set" },
    resumed: { type: "events.iterate.com/stream/subscription-delivery-resumed" },
  });
  await waitForCondition(
    async () =>
      (runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]
        ?.acknowledgedOffset ?? 0) >= thirdFailingEvent!.offset,
    { description: "the audited seek and resume at its explicitly selected cursor" },
  );
  expect(
    coreState(await source.runtimeState()).subscriptions.outbound.byKey[subscriptionKey],
  ).not.toHaveProperty("deliveryHalted");
});

// Webhook receivers.
test("a webhook receives one ordered lean envelope per event", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/webhook/source/${marker}`;
  const subscriptionKey = `webhook-${marker}`;
  const deliveries: Array<Record<string, unknown>> = [];

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using _intercept = await project.egress.intercept(async (request) => {
    deliveries.push((await request.json()) as Record<string, unknown>);
    return new Response(null, { status: 204 });
  });
  using source = project.streams.get(sourcePath);

  await source.append(
    subscriptionConfigured({
      subscriptionKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      receiver: {
        action: "webhook-post",
        url: `https://webhook.example/${marker}`,
        delivery: deliveryPolicy("now"),
      },
    }),
  );
  const appended = await source.append(
    ...Array.from({ length: 3 }, (_, index) => ({
      type: MATCHING_EVENT_TYPE,
      payload: { marker, sequence: index + 1 },
    })),
  );
  await waitForCondition(() => deliveries.length === 3, {
    description: "three ordered webhook deliveries",
    timeoutMs: 30_000,
  });
  expect(
    deliveries.map(
      (delivery) => ((delivery.event as StreamEvent).payload as { sequence: number }).sequence,
    ),
  ).toEqual([1, 2, 3]);
  for (const [index, delivery] of deliveries.entries()) {
    expect(delivery).toMatchObject({
      attempt: 1,
      event: { offset: appended[index]!.offset },
      path: sourcePath,
      subscriptionKey,
      configuredEvent: {
        type: "events.iterate.com/stream/subscription-configured",
      },
    });
    expect(delivery).not.toHaveProperty("state");
    expect(delivery).not.toHaveProperty("events");
  }

  await waitForCondition(
    async () =>
      (runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]
        ?.acknowledgedOffset ?? 0) >= appended.at(-1)!.offset,
    {
      description: "the webhook acknowledgements to advance the source cursor",
      timeoutMs: 30_000,
    },
  );
  const state = runtimeState(await source.runtimeState());
  expect(state.runtime.subscriptions[subscriptionKey]).toMatchObject({ attempt: 0 });
  expect(state.coreProcessorState.subscriptions.outbound.byKey[subscriptionKey]).not.toHaveProperty(
    "deliveryHalted",
  );
});

test("skip policy confirms one repeatedly failing webhook event, skips it, and continues", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/webhook-failing-event/source/${marker}`;
  const subscriptionKey = `webhook-failing-event-${marker}`;
  const attempts: Array<{ attempt: number; shouldFail: boolean }> = [];

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using _intercept = await project.egress.intercept(async (request) => {
    const delivery = (await request.json()) as {
      attempt: number;
      event: { payload: { shouldFail?: boolean } };
    };
    const shouldFail = delivery.event.payload.shouldFail === true;
    attempts.push({ attempt: delivery.attempt, shouldFail });
    return new Response(null, { status: shouldFail ? 422 : 204 });
  });
  using source = project.streams.get(sourcePath);

  await source.append(
    subscriptionConfigured({
      subscriptionKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      receiver: {
        action: "webhook-post",
        url: `https://webhook-failing-event.example/${marker}`,
        delivery: deliveryPolicy("now", { onFailingEvent: "skip" }),
      },
    }),
  );
  const [failingEvent, healthyEvent] = await source.append(
    { type: MATCHING_EVENT_TYPE, payload: { marker, shouldFail: true } },
    { type: MATCHING_EVENT_TYPE, payload: { marker, shouldFail: false } },
  );
  // Confirming the failing event takes the ladder: webhook deliveries are
  // already single events, so FAILING_EVENT_CONFIRM_ATTEMPTS confirmations
  // run back-to-back, each behind its own exponential backoff.
  await waitForCondition(
    async () =>
      (runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]
        ?.acknowledgedOffset ?? 0) >= healthyEvent!.offset,
    {
      description: "the repeatedly failing event to be skipped and the next event acknowledged",
      timeoutMs: 60_000,
    },
  );
  expect(attempts.filter((entry) => entry.shouldFail).map((entry) => entry.attempt)).toEqual([
    1, 2, 3,
  ]);
  expect(attempts.filter((entry) => !entry.shouldFail)).toEqual([
    { attempt: 1, shouldFail: false },
  ]);
  expect(
    (await source.getEvents({ afterOffset: failingEvent!.offset })).find(
      (event) =>
        event.type === "events.iterate.com/stream/error-occurred" &&
        String(event.payload?.message).includes(`offset ${failingEvent!.offset}`),
    ),
  ).toBeDefined();
});

// Validation before a configuration event is appended.
test("invalid receiver-specific combinations and expressions never commit", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/validation/${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);

  const invalid = [
    {
      key: `call-tail-${marker}`,
      message: /property step/,
      event: subscriptionConfigured({
        subscriptionKey: `call-tail-${marker}`,
        receiver: {
          action: "itx-call",
          expression: ["repos", ["get", "/"]],
          delivery: deliveryPolicy("now"),
        },
      }),
    },
    ...(["__proto__", "constructor", "prototype"] as const).map((reservedProperty) => ({
      key: `reserved-itx-${reservedProperty}-${marker}`,
      message: new RegExp(`reserved property name.*${reservedProperty}`, "i"),
      event: subscriptionConfigured({
        subscriptionKey: `reserved-itx-${reservedProperty}-${marker}`,
        receiver: {
          action: "itx-call" as const,
          expression: ["repos", reservedProperty, "processEventBatch"],
          delivery: deliveryPolicy("now"),
        },
      }),
    })),
    {
      key: `webhook-url-${marker}`,
      message: /url|invalid/i,
      event: {
        type: "events.iterate.com/stream/subscription-configured",
        payload: {
          subscriptionKey: `webhook-url-${marker}`,
          receiver: {
            action: "webhook-post",
            url: `ftp://example.com/${marker}`,
            delivery: deliveryPolicy("now"),
          },
        },
      },
    },
    {
      key: `webhook-transform-${marker}`,
      message: /invalid JSONata expression/i,
      event: {
        type: "events.iterate.com/stream/subscription-configured",
        payload: {
          subscriptionKey: `webhook-transform-${marker}`,
          receiver: {
            action: "webhook-post",
            url: `https://example.com/${marker}`,
            jsonataTransform: "payload.(((",
            delivery: deliveryPolicy("now"),
          },
        },
      },
    },
    {
      key: `copy-transform-${marker}`,
      message: /invalid JSONata expression/i,
      event: subscriptionConfigured({
        subscriptionKey: `copy-transform-${marker}`,
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: `/e2e/subscriptions/validation/receiver/${marker}`,
          jsonataTransform: "payload.(((",
          delivery: { ...deliveryPolicy("now"), onFailingEvent: "halt" as const },
        },
      }),
    },
    {
      key: `itx-transform-${marker}`,
      message: /invalid JSONata expression/i,
      event: subscriptionConfigured({
        subscriptionKey: `itx-transform-${marker}`,
        receiver: {
          action: "itx-call",
          expression: ["worker", "processEventBatch"],
          jsonataTransform: "payload.(((",
          delivery: deliveryPolicy("now"),
        },
      }),
    },
    {
      // Wake delivery must feed the processor its committed log verbatim, so
      // the processor-wake receiver has no jsonataTransform field at all.
      key: `wake-transform-${marker}`,
      message: /unrecognized/i,
      event: subscriptionConfigured({
        subscriptionKey: `wake-transform-${marker}`,
        receiver: {
          action: "processor-wake",
          expression: ["agents", ["get", `/agents/${marker}`], "processor", "wakeStreamProcessor"],
          jsonataTransform: "payload",
        },
      }),
    },
    {
      key: `stream-skip-${marker}`,
      message: /onFailingEvent|halt|literal/i,
      event: {
        type: "events.iterate.com/stream/subscription-configured",
        payload: {
          subscriptionKey: `stream-skip-${marker}`,
          receiver: {
            action: "copy-to-stream",
            receivingStreamPath: `/e2e/subscriptions/validation/receiver/${marker}`,
            delivery: deliveryPolicy("now", { onFailingEvent: "skip" }),
          },
        },
      },
    },
    {
      key: `condition-${marker}`,
      message: /invalid JSONata expression.*Expected .*before end of expression/i,
      event: subscriptionConfigured({
        subscriptionKey: `condition-${marker}`,
        filter: { jsonataCondition: "payload.(((" },
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: `/e2e/subscriptions/validation/receiver/${marker}`,
          delivery: { ...deliveryPolicy("now"), onFailingEvent: "halt" as const },
        },
      }),
    },
    {
      key: `filter-typo-${marker}`,
      message: /unrecognized|eventType/i,
      event: {
        type: "events.iterate.com/stream/subscription-configured",
        payload: {
          subscriptionKey: `filter-typo-${marker}`,
          filter: { eventType: [MATCHING_EVENT_TYPE] },
          receiver: {
            action: "copy-to-stream",
            receivingStreamPath: `/e2e/subscriptions/validation/receiver/${marker}`,
            delivery: deliveryPolicy("now"),
          },
        },
      },
    },
  ] as const;

  for (const entry of invalid) {
    await expect(source.append(entry.event as StreamEventInput), entry.key).rejects.toThrow(
      entry.message,
    );
  }
  await expect(
    source.subscribeToEventsFrom({
      sourceStreamPath: sourcePath,
      subscriptionKey: `self-${marker}`,
    }),
  ).rejects.toThrow(/cannot receive events from itself/);
  const ownSegment = sourcePath.split("/").at(-1)!;
  await expect(
    source.append(
      subscriptionConfigured({
        subscriptionKey: `self-alias-${marker}`,
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: `${sourcePath}/../${ownSegment}`,
          delivery: { ...deliveryPolicy("now"), onFailingEvent: "halt" as const },
        },
      }),
    ),
  ).rejects.toThrow(/cannot receive events from itself/);

  const canonicalReceiverPath = `/e2e/subscriptions/validation/canonical/${marker}`;
  const canonicalSubscriptionKey = `canonical-${marker}`;
  const [canonical] = await source.append(
    subscriptionConfigured({
      subscriptionKey: ` ${canonicalSubscriptionKey} `,
      receiver: {
        action: "copy-to-stream",
        receivingStreamPath: ` e2e/subscriptions/validation/./canonical/${marker} `,
        delivery: { ...deliveryPolicy("now"), onFailingEvent: "halt" as const },
      },
    }),
  );
  expect(canonical).toMatchObject({
    payload: {
      subscriptionKey: canonicalSubscriptionKey,
      receiver: { action: "copy-to-stream", receivingStreamPath: canonicalReceiverPath },
    },
  });
  const sourceHeadBeforeFutureRead = coreState(await source.runtimeState()).maxOffset;
  await expect(
    source.setSubscriptionCursor({
      subscriptionKey: canonicalSubscriptionKey,
      afterOffset: sourceHeadBeforeFutureRead + 1_000_000,
    }),
  ).rejects.toThrow(/beyond this stream's current maximum offset/);

  const committedKeys = (await source.getEvents({ afterOffset: 0 }))
    .filter((event) => event.type === "events.iterate.com/stream/subscription-configured")
    .map((event) => event.payload?.subscriptionKey);
  expect(committedKeys).not.toEqual(expect.arrayContaining(invalid.map((entry) => entry.key)));
});

test("public callers cannot forge copied events or platform-authored stream facts", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/validation/forgery/${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  const { projectId } = await project.__describe();
  using source = project.streams.get(sourcePath);

  await expect(
    source.append({
      type: MATCHING_EVENT_TYPE,
      source: {
        copiedFrom: [
          {
            subscriptionKey: `forged-received-from-${marker}`,
            streamId: crypto.randomUUID(),
            streamCreatedAt: new Date().toISOString(),
            cursorChangedAtSourceOffset: 1,
            createdAt: new Date().toISOString(),
            offset: 1,
            path: "/forged",
            projectId,
            type: MATCHING_EVENT_TYPE,
          },
        ],
      },
    }),
  ).rejects.toThrow(/copy source information is platform-authored/);

  const forgedCoreFacts: StreamEventInput[] = [
    {
      type: "events.iterate.com/stream/subscription-delivery-halted",
      payload: {
        subscriptionKey: `forged-halted-${marker}`,
        reason: "delivery-failed",
        afterOffset: 0,
        attempts: 1,
        error: "forged",
      },
    },
    {
      type: "events.iterate.com/stream/connection-opened",
      payload: {
        connectionKey: `forged-connected-${marker}`,
        kind: "session",
      },
    },
    {
      type: "events.iterate.com/stream/connection-closed",
      payload: {
        connectionKey: `forged-disconnected-${marker}`,
        reason: "closed-by-owner",
      },
    },
  ];
  for (const event of forgedCoreFacts) {
    await expect(source.append(event), event.type).rejects.toThrow(/platform-authored/);
  }

  expect((await source.getEvents({ afterOffset: 0 })).map((event) => event.type)).not.toEqual(
    expect.arrayContaining(forgedCoreFacts.map((event) => event.type)),
  );
});

test("commands on a missing subscription key fail without appending state", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/validation/missing/${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);

  const missingKey = `missing-${marker}`;
  await expect(
    source.setSubscriptionCursor({ subscriptionKey: missingKey, afterOffset: 0 }),
  ).rejects.toThrow(/does not exist/);
  await expect(source.resumeSubscription({ subscriptionKey: missingKey })).rejects.toThrow(
    /does not exist/,
  );
  await expect(
    source.setSubscriptionCursorAndResume({ subscriptionKey: missingKey, afterOffset: 0 }),
  ).rejects.toThrow(/does not exist/);
  await expect(
    project.streams
      .get(`/e2e/subscriptions/validation/missing-receiver/${marker}`)
      .unsubscribeFromEvents({ sourceStreamPath: sourcePath, subscriptionKey: missingKey }),
  ).resolves.toEqual({ status: "already-absent" });

  const committedEvents = await source.getEvents({ afterOffset: 0 });
  expect(committedEvents.filter((event) => event.payload?.subscriptionKey === missingKey)).toEqual(
    [],
  );
});

async function openTestProject(marker: string) {
  const resources = new DisposableStack();
  const session = resources.adopt(withItxSession(), disposeRpc);
  const itx = resources.adopt(
    session.authenticate({ type: "admin-secret", secret: adminSecret() }),
    disposeRpc,
  );
  try {
    const project = resources.adopt(
      await itx.projects.get(`subscriptions-${RUN_SUFFIX}-${marker}`).create({}),
      disposeRpc,
    );
    return {
      itx,
      project,
      [Symbol.dispose]() {
        resources.dispose();
      },
    };
  } catch (error) {
    resources.dispose();
    throw error;
  }
}

function coreState(runtimeState: { coreProcessorState: unknown }): CoreProcessorState {
  return runtimeState.coreProcessorState as CoreProcessorState;
}

function runtimeState(value: unknown): StreamRuntimeDebugState {
  return value as StreamRuntimeDebugState;
}

type DeliveryPolicy = {
  start: "beginning" | "now";
  onFailingEvent: "halt" | "skip";
};

function subscriptionConfigured(input: {
  subscriptionKey: string;
  description?: string;
  filter?: { eventTypes?: string[]; jsonataCondition?: string };
  receiver: Record<string, unknown>;
}): StreamEventInput {
  return {
    type: "events.iterate.com/stream/subscription-configured",
    payload: input,
  };
}

function deliveryPolicy(
  start: "beginning" | "now",
  options: Partial<Pick<DeliveryPolicy, "onFailingEvent">> = {},
): DeliveryPolicy {
  return {
    start,
    onFailingEvent: options.onFailingEvent ?? "halt",
  };
}

async function openAndCloseConnection(
  stream: Stream,
  args: Parameters<Stream["openConnection"]>[0],
): Promise<void> {
  const handle = await stream.openConnection(args);
  try {
    await handle.connectionKey;
  } finally {
    await handle.close();
    disposeRpc(handle);
  }
}

async function forceStreamIdleTeardown(stream: Stream): Promise<void> {
  // Test-only operator path: exercise the five-minute production policy
  // without making this real-deployment test wait five minutes.
  await (
    stream as unknown as {
      testRunIdleTeardownNow(): Promise<void>;
    }
  ).testRunIdleTeardownNow();
}

async function forceStreamReset(stream: Stream): Promise<void> {
  await (
    stream as unknown as {
      testReset(): Promise<void>;
    }
  ).testReset();
}

async function appendTrustedCoreEvents(
  stream: Stream,
  events: StreamEventInput[],
): Promise<StreamEvent[]> {
  return await (
    stream as unknown as {
      testAppendCoreEvents(eventInputs: StreamEventInput[]): Promise<StreamEvent[]>;
    }
  ).testAppendCoreEvents(events);
}

async function deliverTrustedStreamBatch(
  stream: Stream,
  batch: StreamDeliveryBatch,
): Promise<CopyReceipt> {
  return await (
    stream as unknown as {
      testReceiveCopiedEvents(batch: StreamDeliveryBatch): Promise<CopyReceipt>;
    }
  ).testReceiveCopiedEvents(batch);
}

function disposeRpc(value: unknown): void {
  (value as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
}
