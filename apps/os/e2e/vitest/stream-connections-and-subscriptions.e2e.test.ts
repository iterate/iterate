// Live event connections and stored subscriptions through the public ITX seam.
//
// This is intentionally a real live-deployment suite: product behavior enters
// through Stream capabilities and observes appended events, reduced state,
// runtime state, and delivered events. Guarded test capabilities are used only
// for deterministic fault/lifecycle injection. Pure reducer ordering and
// validation cases belong beside the core processor; cross-stream sending and
// callback behavior belong here. Local runs skip the three destructive-lifecycle
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
import { deliveryId as streamDeliveryId } from "../../src/domains/streams/delivery-math.ts";
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
      condition: "payload.selected = true",
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
    liveMatch!.offset,
    liveEphemeral!.offset,
  ]);
  expect(selectedOffsets).not.toContain(historicalEphemeral!.offset);
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
      condition: '($assert(false, "live filter rejected event"); true)',
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
      timeoutMs: 1_000,
    }),
  ).rejects.toThrow(/Timed out waiting for stream event/);
  expect(historicalEphemeral).toMatchObject({ ephemeral: true });

  const liveEphemeralWait = stream.waitForEvent({
    afterOffset: coreState(await stream.runtimeState()).maxOffset,
    eventTypes: [MATCHING_EVENT_TYPE],
    predicate: (event) => event.payload?.phase === "live-ephemeral",
    timeoutMs: 10_000,
  });
  // Ephemeral rows are never replayed, so the append must not race the wait's
  // arming: only an armed wait can observe it. The earlier waits in this test
  // have already closed their connections, so any waitForEvent connection
  // present now is this one.
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
          action: "webhook-post",
          url: "https://example.com/unused",
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
test("a receiver configures one subscription visible on both streams before delivery", async () => {
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
  expect(configured.copyListRecordedEvent).toMatchObject({
    type: "events.iterate.com/stream/copy-list-recorded",
    payload: {
      source: { path: sourcePath },
      sourceOffset: configured.subscriptionConfiguredEvent.offset,
      subscriptionsByKey: { [subscriptionKey]: expect.any(Object) },
    },
  });

  const sourceState = coreState(await source.runtimeState());
  expect(sourceState.subscriptions.outbound.byKey[subscriptionKey]).toMatchObject({
    configuration: configured.subscriptionConfiguredEvent.payload,
  });

  const receiverState = coreState(await receiver.runtimeState());
  expect(
    receiverState.subscriptions.inbound.bySourcePath[sourcePath]?.byKey[subscriptionKey],
  ).toMatchObject({
    configuration: incomingSubscriptionConfiguration(
      configured.copyListRecordedEvent,
      subscriptionKey,
    ),
    numEventsReceived: 0,
    numEventsDropped: 0,
  });

  const [sourceProductEvent] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker },
  });
  const copied = await receiver.waitForEvent({
    afterOffset: configured.copyListRecordedEvent.offset,
    eventTypes: [MATCHING_EVENT_TYPE],
    timeoutMs: 15_000,
  });
  expect(copied.offset).toBeGreaterThan(configured.copyListRecordedEvent.offset);
  expect(copied.source?.copiedFrom?.at(-1)?.offset).toBe(sourceProductEvent!.offset);
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
    copyListRecordedEvent: {
      type: "events.iterate.com/stream/copy-list-recorded",
      payload: { source: { path: sourcePath } },
    },
  });

  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);
  const receivingStreamEvent = (execution.result as { copyListRecordedEvent: StreamEvent })
    .copyListRecordedEvent;
  const [sent] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, configuredBy: agentPath },
  });
  const copied = await receiver.waitForEvent({
    afterOffset: receivingStreamEvent.offset,
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
        delivery: { start: "now", includeEphemeral: false, onFailingEvent: "halt" },
      },
    },
  });
  expect(configured.subscriptionConfiguredEvent.payload).not.toHaveProperty("subscriptionKey");

  const confirmation = (
    await source.getEvents({
      afterOffset: configured.subscriptionConfiguredEvent.offset,
      eventTypes: ["events.iterate.com/stream/copy-list-confirmed"],
    })
  ).find((event) => event.payload?.receivingStreamPath === receivingStreamPath);
  expect(confirmation).toBeDefined();

  const [liveControl] = await source.append({
    type: "events.iterate.com/stream/configured",
    payload: { config: {} },
  });
  const copiedControl = await receiver.waitForEvent({
    afterOffset: configured.copyListRecordedEvent.offset,
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
  expect(copiedSourceOffsets).not.toContain(confirmation!.offset);
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
      coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath],
    ).toMatchObject({
      source: {
        streamId: secondSourceState.streamId,
        streamCreatedAt: secondSourceState.createdAt,
      },
      byKey: { [subscriptionKey]: { numEventsReceived: 1, numEventsDropped: 0 } },
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
  });
  expect(replacement.subscriptionConfiguredEvent.offset).toBeGreaterThan(
    first.subscriptionConfiguredEvent.offset,
  );
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
    /has no current subscription/,
  );
  expect(coreState(await receiver.runtimeState())).toMatchObject({
    maxOffset: receiverOffsetBeforeStaleBatch,
  });
  expect(
    coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath]?.byKey[
      subscriptionKey
    ],
  ).toMatchObject({ configuredAtSourceOffset: replacement.subscriptionConfiguredEvent.offset });
});

test("a blocked subscription list resumes only after an explicit resend request", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/list-resend/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/list-resend/receiver/${marker}`;
  const subscriptionKey = `list-resend-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  await receiver.subscribeToEventsFrom({ sourceStreamPath: sourcePath, subscriptionKey });

  // The direct Durable Object recovery test exhausts all 15 real failures.
  // Here one atomic test-only append commits the same platform-authored
  // terminal state before reconciliation can win the race. The recovery path
  // itself remains the public resend command and real two-stream acknowledgement.
  const blockedDescription = "synthetic blocked copy-list generation";
  const blockedOffset = coreState(await source.runtimeState()).maxOffset + 1;
  const [replacement] = await appendTrustedCoreEvents(source, [
    subscriptionConfigured({
      subscriptionKey,
      description: blockedDescription,
      receiver: {
        action: "copy-to-stream",
        receivingStreamPath: receivingStreamPath,
        delivery: deliveryPolicy("now"),
      },
    }),
    {
      type: "events.iterate.com/stream/copy-list-delivery-blocked",
      payload: {
        receivingStreamPath,
        sourceOffset: blockedOffset,
        attempts: 15,
        error: "synthetic terminal receiver failure for live resend coverage",
      },
    },
  ]);
  expect(replacement).toMatchObject({ offset: blockedOffset });
  expect(
    coreState(await source.runtimeState()).copyListDeliveriesByReceivingStream[receivingStreamPath],
  ).toMatchObject({ sourceOffset: blockedOffset, status: "blocked", attempts: 15 });
  await expect(
    receiver.subscribeToEventsFrom({
      sourceStreamPath: sourcePath,
      subscriptionKey,
      description: blockedDescription,
    }),
  ).rejects.toThrow(/blocked after 15 attempts.*resendCopyList/s);

  const resend = await source.resendCopyList({ receivingStreamPath });
  await waitForCondition(
    async () =>
      coreState(await source.runtimeState()).copyListDeliveriesByReceivingStream[
        receivingStreamPath
      ]?.status === "confirmed",
    { description: "the explicit resend request to be acknowledged by the receiving stream" },
  );
  expect(
    coreState(await source.runtimeState()).copyListDeliveriesByReceivingStream[receivingStreamPath],
  ).toMatchObject({ sourceOffset: resend.offset, status: "confirmed" });
  expect(
    coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath]?.byKey[
      subscriptionKey
    ],
  ).toBeDefined();
});

test("each source change replaces that source's complete subscription list on the receiver", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/complete-list/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/complete-list/receiver/${marker}`;
  const alpha = `alpha-${marker}`;
  const beta = `beta-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  const configuredAlpha = await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey: alpha,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
  });
  const configuredBeta = await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey: beta,
    filter: { eventTypes: [OTHER_EVENT_TYPE] },
  });
  expect(Object.keys(subscriptionsFromSource(configuredAlpha.copyListRecordedEvent))).toEqual([
    alpha,
  ]);
  expect(Object.keys(subscriptionsFromSource(configuredBeta.copyListRecordedEvent)).sort()).toEqual(
    [alpha, beta].sort(),
  );

  let receiverSource = coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[
    sourcePath
  ]!;
  expect(receiverSource).toMatchObject({
    sourceOffset: configuredBeta.subscriptionConfiguredEvent.offset,
  });
  expect(Object.keys(receiverSource.byKey).sort()).toEqual([alpha, beta].sort());
  expect(receiverSource.byKey).toMatchObject({
    [alpha]: { configuredAtSourceOffset: configuredAlpha.subscriptionConfiguredEvent.offset },
    [beta]: { configuredAtSourceOffset: configuredBeta.subscriptionConfiguredEvent.offset },
  });

  const removedAlpha = await receiver.unsubscribeFromEvents({
    sourceStreamPath: sourcePath,
    subscriptionKey: alpha,
  });
  expect(removedAlpha).toMatchObject({ status: "removed" });
  if (removedAlpha.status !== "removed") throw new Error("alpha removal did not commit");
  expect(Object.keys(subscriptionsFromSource(removedAlpha.copyListRecordedEvent))).toEqual([beta]);
  receiverSource = coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[
    sourcePath
  ]!;
  expect(receiverSource).toMatchObject({
    sourceOffset: removedAlpha.subscriptionRemovedEvent.offset,
  });
  expect(Object.keys(receiverSource.byKey)).toEqual([beta]);

  const removedBeta = await receiver.unsubscribeFromEvents({
    sourceStreamPath: sourcePath,
    subscriptionKey: beta,
  });
  expect(removedBeta).toMatchObject({ status: "removed" });
  if (removedBeta.status !== "removed") throw new Error("beta removal did not commit");
  expect(subscriptionsFromSource(removedBeta.copyListRecordedEvent)).toEqual({});
  expect(
    coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath],
  ).toBeUndefined();
  expect(
    coreState(await source.runtimeState()).copyListDeliveriesByReceivingStream[receivingStreamPath],
  ).toBeUndefined();
});

test("concurrent receive commands share one send and follow the newest complete list", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/concurrent/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/concurrent/receiver/${marker}`;
  const alpha = `concurrent-alpha-${marker}`;
  const beta = `concurrent-beta-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using receiver = project.streams.get(receivingStreamPath);

  const [configuredAlpha, configuredBeta] = await Promise.all([
    receiver.subscribeToEventsFrom({
      sourceStreamPath: sourcePath,
      subscriptionKey: alpha,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
    }),
    receiver.subscribeToEventsFrom({
      sourceStreamPath: sourcePath,
      subscriptionKey: beta,
      filter: { eventTypes: [OTHER_EVENT_TYPE] },
    }),
  ]);

  expect(subscriptionsFromSource(configuredAlpha.copyListRecordedEvent)[alpha]).toBeDefined();
  expect(subscriptionsFromSource(configuredBeta.copyListRecordedEvent)[beta]).toBeDefined();
  expect(
    Math.max(
      Object.keys(subscriptionsFromSource(configuredAlpha.copyListRecordedEvent)).length,
      Object.keys(subscriptionsFromSource(configuredBeta.copyListRecordedEvent)).length,
    ),
  ).toBe(2);
  const receiverState = coreState(await receiver.runtimeState());
  expect(
    Object.keys(receiverState.subscriptions.inbound.bySourcePath[sourcePath]!.byKey).sort(),
  ).toEqual([alpha, beta].sort());

  const [repeatOne, repeatTwo] = await Promise.all([
    receiver.subscribeToEventsFrom({
      sourceStreamPath: sourcePath,
      subscriptionKey: alpha,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
    }),
    receiver.subscribeToEventsFrom({
      sourceStreamPath: sourcePath,
      subscriptionKey: alpha,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
    }),
  ]);
  expect(repeatOne.subscriptionConfiguredEvent).toMatchObject({
    offset: configuredAlpha.subscriptionConfiguredEvent.offset,
  });
  expect(repeatTwo.subscriptionConfiguredEvent).toMatchObject({
    offset: configuredAlpha.subscriptionConfiguredEvent.offset,
  });
  expect(repeatOne.copyListRecordedEvent).toMatchObject({
    offset: repeatTwo.copyListRecordedEvent.offset,
  });
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
  expect(retried.copyListRecordedEvent).toMatchObject({
    offset: first.copyListRecordedEvent.offset,
  });
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

test("reusing a source key moves the subscription without leaving it on the old receiver", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/replacement/source/${marker}`;
  const oldReceiverPath = `/e2e/subscriptions/replacement/old/${marker}`;
  const newReceiverPath = `/e2e/subscriptions/replacement/new/${marker}`;
  const subscriptionKey = `replace-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);
  using oldReceiver = project.streams.get(oldReceiverPath);
  using newReceiver = project.streams.get(newReceiverPath);

  await oldReceiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
  });
  const [historical] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, phase: "before-replacement" },
  });
  await oldReceiver.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    timeoutMs: 15_000,
  });
  await expect(
    newReceiver.unsubscribeFromEvents({ sourceStreamPath: sourcePath, subscriptionKey }),
  ).resolves.toEqual({ status: "already-absent" });
  const replacement = await newReceiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
    start: "beginning",
  });

  expect(
    coreState(await oldReceiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath]
      ?.byKey[subscriptionKey],
  ).toBeUndefined();
  expect(
    coreState(await newReceiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath]
      ?.byKey[subscriptionKey],
  ).toMatchObject({
    configuration: incomingSubscriptionConfiguration(
      replacement.copyListRecordedEvent,
      subscriptionKey,
    ),
  });
  expect(
    coreState(await source.runtimeState()).subscriptions.outbound.byKey[subscriptionKey],
  ).toMatchObject({
    configuration: replacement.subscriptionConfiguredEvent.payload,
  });
  await expect(
    oldReceiver.unsubscribeFromEvents({ sourceStreamPath: sourcePath, subscriptionKey }),
  ).resolves.toEqual({ status: "already-absent" });

  const replayed = await newReceiver.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    timeoutMs: 15_000,
  });
  expect(replayed.source?.copiedFrom?.at(-1)?.offset).toBe(historical!.offset);

  await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, phase: "after-replacement" },
  });
  await newReceiver.waitForEvent({
    afterOffset: replayed.offset,
    eventTypes: [MATCHING_EVENT_TYPE],
    timeoutMs: 15_000,
  });
  expect(
    (await oldReceiver.getEvents({ afterOffset: 0, eventTypes: [MATCHING_EVENT_TYPE] })).map(
      (event) => event.payload?.phase,
    ),
  ).toEqual(["before-replacement"]);
});

test("a stream-to-webhook replacement waits for the old stream to record removal", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/cross-kind-cutover/source/${marker}`;
  const oldReceiverPath = `/e2e/subscriptions/cross-kind-cutover/old/${marker}`;
  const subscriptionKey = `cross-kind-cutover-${marker}`;
  const sentinelKey = `cross-kind-sentinel-${marker}`;
  const deliveries: Array<{ event: StreamEvent; subscriptionKey: string }> = [];

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using _intercept = await project.egress.intercept(async (request) => {
    deliveries.push((await request.json()) as { event: StreamEvent; subscriptionKey: string });
    return new Response(null, { status: 204 });
  });
  using source = project.streams.get(sourcePath);
  using oldReceiver = project.streams.get(oldReceiverPath);

  await source.append(
    subscriptionConfigured({
      subscriptionKey: sentinelKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      receiver: {
        action: "webhook-post",
        url: `https://cross-kind-sentinel.example/${marker}`,
        delivery: deliveryPolicy("now"),
      },
    }),
  );
  await oldReceiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
  });

  // Atomically replace the copy destination and inject the final outcome of
  // its removal-list retry ladder. The real resend and cutover below still run
  // through public commands and the live receiver/webhook seams.
  const replacementOffset = coreState(await source.runtimeState()).maxOffset + 1;
  const [replacement] = await appendTrustedCoreEvents(source, [
    subscriptionConfigured({
      subscriptionKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      receiver: {
        action: "webhook-post",
        url: `https://cross-kind-target.example/${marker}`,
        delivery: deliveryPolicy("now"),
      },
    }),
    {
      type: "events.iterate.com/stream/copy-list-delivery-blocked",
      payload: {
        receivingStreamPath: oldReceiverPath,
        sourceOffset: replacementOffset,
        attempts: 15,
        error: "synthetic old-stream removal failure",
      },
    },
  ]);
  expect(replacement).toMatchObject({ offset: replacementOffset });
  expect(
    coreState(await source.runtimeState()).copyListDeliveriesByReceivingStream[oldReceiverPath],
  ).toMatchObject({
    sourceOffset: replacementOffset,
    status: "blocked",
    subscriptionKeysRecordedByReceiver: [subscriptionKey],
  });

  const [held] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker },
  });
  await waitForCondition(
    () =>
      deliveries.some(
        (delivery) =>
          delivery.subscriptionKey === sentinelKey && delivery.event.offset === held!.offset,
      ),
    { description: "the ungated webhook to prove the source send loop reached this event" },
  );
  expect(deliveries.filter((delivery) => delivery.subscriptionKey === subscriptionKey)).toEqual([]);

  await source.resendCopyList({ receivingStreamPath: oldReceiverPath });
  await waitForCondition(
    () =>
      deliveries.some(
        (delivery) =>
          delivery.subscriptionKey === subscriptionKey && delivery.event.offset === held!.offset,
      ),
    { description: "the replacement webhook to start only after the old stream records removal" },
  );
  expect(
    coreState(await oldReceiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath],
  ).toBeUndefined();
  expect(
    coreState(await source.runtimeState()).copyListDeliveriesByReceivingStream[oldReceiverPath],
  ).toBeUndefined();
});

test("an old in-flight failure cannot delay or fail a same-key replacement", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/replacement/in-flight/${marker}`;
  const subscriptionKey = `in-flight-${marker}`;
  const oldDeliveryStarted = Promise.withResolvers<void>();
  const releaseOldDelivery = Promise.withResolvers<void>();
  const deliveries: Array<{ attempt: number; event: StreamEvent; url: string }> = [];

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using _intercept = await project.egress.intercept(async (request) => {
    const delivery = (await request.json()) as { attempt: number; event: StreamEvent };
    deliveries.push({ ...delivery, url: request.url });
    if (request.url.includes("old-receiver")) {
      oldDeliveryStarted.resolve();
      await releaseOldDelivery.promise;
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 204 });
  });
  using source = project.streams.get(sourcePath);

  await source.append(
    subscriptionConfigured({
      subscriptionKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      receiver: {
        action: "webhook-post",
        url: `https://old-receiver.example/${marker}`,
        delivery: deliveryPolicy("now"),
      },
    }),
  );
  const [event] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker },
  });
  await oldDeliveryStarted.promise;

  await source.append(
    subscriptionConfigured({
      subscriptionKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      receiver: {
        action: "webhook-post",
        url: `https://new-receiver.example/${marker}`,
        delivery: deliveryPolicy("beginning"),
      },
    }),
  );
  releaseOldDelivery.resolve();

  await waitForCondition(
    () => deliveries.some((delivery) => delivery.url.includes("new-receiver")),
    { description: "the replacement receiver to acknowledge the held event" },
  );
  expect(deliveries.filter((delivery) => delivery.url.includes("old-receiver"))).toMatchObject([
    { attempt: 1, event: { offset: event!.offset } },
  ]);
  expect(deliveries.filter((delivery) => delivery.url.includes("new-receiver"))).toMatchObject([
    { attempt: 1, event: { offset: event!.offset } },
  ]);
  const runtime = runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]!;
  expect(runtime).toMatchObject({ attempt: 0, lastError: null });
  expect(runtime.acknowledgedOffset).toBeGreaterThanOrEqual(event!.offset);
});

// Cloudflare documents ctx.abort() as unavailable in local Wrangler
// development. The emulator rejects the call but does not preserve the alarm
// as a real runtime eviction does, so this lifecycle proof belongs on preview.
test.skipIf(deployedBaseUrl() === null)(
  "an in-flight source delivery keeps a durable watchdog across source eviction",
  { timeout: 45_000 },
  async () => {
    const marker = crypto.randomUUID();
    const sourcePath = `/e2e/subscriptions/in-flight-eviction/${marker}`;
    const subscriptionKey = `in-flight-eviction-${marker}`;
    const firstDeliveryStarted = Promise.withResolvers<void>();
    const releaseFirstDelivery = Promise.withResolvers<void>();
    const deliveries: Array<{ attempt: number; event: StreamEvent }> = [];

    using testProject = await openTestProject(marker);
    const { project } = testProject;
    using _intercept = await project.egress.intercept(async (request) => {
      const delivery = (await request.json()) as { attempt: number; event: StreamEvent };
      deliveries.push(delivery);
      if (deliveries.length === 1) {
        firstDeliveryStarted.resolve();
        await releaseFirstDelivery.promise;
      }
      return new Response(null, { status: 204 });
    });
    using source = project.streams.get(sourcePath);

    await source.append(
      subscriptionConfigured({
        subscriptionKey,
        filter: { eventTypes: [MATCHING_EVENT_TYPE] },
        receiver: {
          action: "webhook-post",
          url: `https://in-flight-eviction.example/${marker}`,
          delivery: deliveryPolicy("now"),
        },
      }),
    );
    const [event] = await source.append({
      type: MATCHING_EVENT_TYPE,
      payload: { marker },
    });
    await firstDeliveryStarted.promise;

    // The alarm that launched the first attempt has already fired. Killing the
    // source here destroys every in-memory drain reservation; only the watchdog
    // persisted while that attempt was in flight can wake a quiet replacement
    // incarnation. Do not poll the source until the second request arrives,
    // because any such request would mask a missing alarm.
    await source.kill().catch(() => undefined);
    releaseFirstDelivery.resolve();

    await waitForCondition(() => deliveries.length >= 2, {
      description: "the durable in-flight watchdog to redeliver after source eviction",
      timeoutMs: 30_000,
    });
    expect(deliveries.slice(0, 2)).toMatchObject([
      { attempt: 1, event: { offset: event!.offset } },
      { attempt: 1, event: { offset: event!.offset } },
    ]);
    const runtime = runtimeState(await source.runtimeState()).runtime.subscriptions[
      subscriptionKey
    ]!;
    expect(runtime).toMatchObject({
      attempt: 0,
      lastError: null,
    });
    // The revived incarnation appends its own woken fact, and the cursor may
    // acknowledge past that non-matching trailing event before this read.
    expect(runtime.acknowledgedOffset).toBeGreaterThanOrEqual(event!.offset);
  },
);

test("an old in-flight success cannot overwrite a newer cursor seek", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/seek/in-flight/${marker}`;
  const subscriptionKey = `seek-in-flight-${marker}`;
  const firstDeliveryStarted = Promise.withResolvers<void>();
  const releaseFirstDelivery = Promise.withResolvers<void>();
  const deliveries: Array<{ event: StreamEvent; attempt: number }> = [];

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using _intercept = await project.egress.intercept(async (request) => {
    const delivery = (await request.json()) as { event: StreamEvent; attempt: number };
    deliveries.push(delivery);
    if (deliveries.length === 1) {
      firstDeliveryStarted.resolve();
      await releaseFirstDelivery.promise;
    }
    return new Response(null, { status: 204 });
  });
  using source = project.streams.get(sourcePath);

  await source.append(
    subscriptionConfigured({
      subscriptionKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      receiver: {
        action: "webhook-post",
        url: `https://cursor-change.example/${marker}`,
        delivery: deliveryPolicy("now"),
      },
    }),
  );
  const [event] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker },
  });
  await firstDeliveryStarted.promise;

  // Rewind while the first awaited call is unresolved. Its eventual 2xx owns
  // the older cursor-setting event and must not advance over the explicit seek.
  await source.setSubscriptionCursor({ subscriptionKey, afterOffset: 0 });
  releaseFirstDelivery.resolve();

  await waitForCondition(
    async () => {
      const acked =
        runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]
          ?.acknowledgedOffset ?? 0;
      return deliveries.length >= 2 && acked >= event!.offset;
    },
    { description: "the post-seek cursor to redeliver and acknowledge the held event" },
  );
  expect(deliveries.slice(0, 2)).toMatchObject([
    { attempt: 1, event: { offset: event!.offset } },
    { attempt: 1, event: { offset: event!.offset } },
  ]);
});

test("resumeSubscription restarts a halted rule at its existing cursor", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/resume/source/${marker}`;
  const subscriptionKey = `resume-${marker}`;
  const deliveries: StreamEvent[] = [];

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using _intercept = await project.egress.intercept(async (request) => {
    deliveries.push(((await request.json()) as { event: StreamEvent }).event);
    return new Response(null, { status: 204 });
  });
  using source = project.streams.get(sourcePath);

  const configuredOffset = coreState(await source.runtimeState()).maxOffset + 1;
  await appendTrustedCoreEvents(source, [
    subscriptionConfigured({
      subscriptionKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      receiver: {
        action: "webhook-post",
        url: `https://resume.example/${marker}`,
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
  await waitForCondition(() => deliveries.some((event) => event.offset === held!.offset), {
    description: "the resumed rule to send the first unacknowledged event",
  });
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
  // appending a duplicate product event, and records that decision as an event.
  const dropped = await streamA.waitForEvent({
    afterOffset: original!.offset,
    eventTypes: ["events.iterate.com/stream/copied-events-dropped"],
    predicate: (event) => event.payload?.subscriptionKey === gToA,
    timeoutMs: 15_000,
  });
  expect(dropped).toMatchObject({
    payload: {
      source: { path: pathG },
      subscriptionKey: gToA,
      reason: "cycle",
      count: 1,
      firstOffset: chained.offset,
      lastOffset: chained.offset,
    },
  });
  expect(
    coreState(await streamA.runtimeState()).subscriptions.inbound.bySourcePath[pathG]?.byKey[gToA],
  ).toMatchObject({ numEventsReceived: 0, numEventsDropped: 1 });
  const cycleCursor = runtimeState(await streamG.runtimeState()).runtime.subscriptions[gToA]!;
  expect(cycleCursor).toMatchObject({ acknowledgedEvents: 1 });
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
    copyListRecordedEvent: {
      type: "events.iterate.com/stream/copy-list-recorded",
      payload: { subscriptionsByKey: {} },
    },
  });
  expect(
    coreState(await streamA.runtimeState()).subscriptions.outbound.byKey[forwardRuleKeys[0]!],
  ).toBeUndefined();
  expect(
    coreState(await streamB.runtimeState()).subscriptions.inbound.bySourcePath[pathA]?.byKey[
      forwardRuleKeys[0]!
    ],
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
      eventTypes: [MATCHING_EVENT_TYPE, "events.iterate.com/stream/copied-events-dropped"],
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
  expect(receipt).toEqual({
    accepted: 0,
    dropped: [{ offset: historical!.offset, reason: "hop-limit" }],
  });

  const dropped = await receiver.waitForEvent({
    afterOffset: configured.copyListRecordedEvent.offset,
    eventTypes: ["events.iterate.com/stream/copied-events-dropped"],
    timeoutMs: 15_000,
  });
  expect(dropped).toMatchObject({
    payload: {
      source: { path: sourcePath },
      subscriptionKey,
      reason: "hop-limit",
      count: 1,
      firstOffset: historical!.offset,
      lastOffset: historical!.offset,
    },
  });
  expect(
    coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath]?.byKey[
      subscriptionKey
    ],
  ).toMatchObject({ numEventsReceived: 0, numEventsDropped: 1 });

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
      eventTypes: ["events.iterate.com/stream/copied-events-dropped"],
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

test("a time condition is an independent OR boundary and removes the subscription from both streams", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/deadline/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/deadline/receiver/${marker}`;
  const subscriptionKey = `deadline-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
  });

  // Wait for both streams to record the subscription before starting the clock.
  // The replacement then proves that a time boundary is independent of cursor
  // progress without racing the initial source-to-receiver send.
  await source.append(
    subscriptionConfigured({
      subscriptionKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      endWhen: {
        any: [
          { kind: "acknowledged-events", count: 100 },
          { kind: "time", at: new Date(Date.now() + 2_000).toISOString() },
        ],
      },
      receiver: {
        action: "copy-to-stream",
        receivingStreamPath: receivingStreamPath,
        delivery: deliveryPolicy("now"),
      },
    }),
  );
  await waitForCondition(
    async () =>
      coreState(await source.runtimeState()).subscriptions.outbound.byKey[subscriptionKey] ===
        undefined &&
      coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath]
        ?.byKey[subscriptionKey] === undefined,
    { description: "the deadline to remove the subscription from both streams", timeoutMs: 30_000 },
  );
  expect(
    (await source.getEvents({ afterOffset: 0 })).find(
      (event) =>
        event.type === "events.iterate.com/stream/subscription-removed" &&
        event.payload?.subscriptionKey === subscriptionKey,
    ),
  ).toMatchObject({ payload: { reason: "expired" } });
});

test("a paused receiver records subscription changes immediately and receives product events after resuming", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/paused-product-delivery/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/paused-product-delivery/receiver/${marker}`;
  const subscriptionKey = `paused-product-delivery-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  await receiver.append({
    type: "events.iterate.com/stream/paused",
    payload: { reason: "separate subscription configuration from product delivery" },
  });
  const configured = await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
  });

  expect(
    coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath]?.byKey[
      subscriptionKey
    ],
  ).toMatchObject({ configuredAtSourceOffset: configured.subscriptionConfiguredEvent.offset });
  expect(copyListRetry(await source.runtimeState(), receivingStreamPath)).toBeUndefined();

  const [held] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, phase: "held-while-paused" },
  });

  await waitForCondition(
    async () => {
      const delivery = runtimeState(await source.runtimeState()).runtime.subscriptions[
        subscriptionKey
      ];
      return delivery !== undefined && delivery.attempt >= 1;
    },
    { description: "paused product delivery to acquire a durable retry schedule" },
  );
  const failed = runtimeState(await source.runtimeState());
  expect(failed.coreProcessorState.subscriptions.outbound.byKey[subscriptionKey]).toMatchObject({
    configuration: {
      subscriptionKey,
      receiver: { action: "copy-to-stream", receivingStreamPath: receivingStreamPath },
    },
  });
  expect(failed.runtime.subscriptions[subscriptionKey]).toMatchObject({
    attempt: expect.any(Number),
    lastError: expect.stringContaining("stream paused"),
  });

  await receiver.append({ type: "events.iterate.com/stream/resumed", payload: {} });
  const delivered = await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    predicate: (event) => event.payload?.marker === marker,
    timeoutMs: 15_000,
  });
  expect(delivered.source?.copiedFrom?.at(-1)?.offset).toBe(held!.offset);
  await waitForCondition(
    async () =>
      runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]?.attempt ===
      0,
    { description: "the resumed receiver to acknowledge the held product event" },
  );
  const recovered = runtimeState(await source.runtimeState());
  expect(copyListRetry(recovered, receivingStreamPath)).toBeUndefined();
  expect(
    recovered.coreProcessorState.copyListDeliveriesByReceivingStream[receivingStreamPath],
  ).toMatchObject({
    sourceOffset: configured.subscriptionConfiguredEvent.offset,
    status: "confirmed",
  });
});

test("a time boundary removes the subscription from both streams while product delivery is paused", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/paused-expiry/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/paused-expiry/receiver/${marker}`;
  const subscriptionKey = `paused-expiry-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  await receiver.append({
    type: "events.iterate.com/stream/paused",
    payload: { reason: "subscription updates remain available while product events stop" },
  });
  await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    endWhen: {
      any: [{ kind: "time", at: new Date(Date.now() + 1_000).toISOString() }],
    },
  });

  await waitForCondition(
    async () => {
      const sourceState = coreState(await source.runtimeState());
      const receiverState = coreState(await receiver.runtimeState());
      return (
        sourceState.subscriptions.outbound.byKey[subscriptionKey] === undefined &&
        receiverState.subscriptions.inbound.bySourcePath[sourcePath] === undefined
      );
    },
    {
      description: "the configured deadline to remove the subscription from both streams",
      timeoutMs: 15_000,
    },
  );
  const removed = (await source.getEvents({ afterOffset: 0 })).find(
    (event) =>
      event.type === "events.iterate.com/stream/subscription-removed" &&
      event.payload?.subscriptionKey === subscriptionKey,
  );
  expect(removed).toMatchObject({ payload: { reason: "expired" } });

  expect(
    coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath]?.byKey[
      subscriptionKey
    ],
  ).toBeUndefined();
});

test("a paused source still removes requested and expired subscriptions across eviction", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/paused-revocation/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/paused-revocation/receiver/${marker}`;
  const requestedKey = `paused-requested-${marker}`;
  const expiringKey = `paused-expiring-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey: requestedKey,
  });
  await source.append({
    type: "events.iterate.com/stream/paused",
    payload: { reason: "revocation must remain available while ordinary appends are closed" },
  });
  const removed = await receiver.unsubscribeFromEvents({
    sourceStreamPath: sourcePath,
    subscriptionKey: requestedKey,
  });
  expect(removed).toMatchObject({
    status: "removed",
    subscriptionRemovedEvent: { type: "events.iterate.com/stream/subscription-removed" },
    copyListRecordedEvent: {
      type: "events.iterate.com/stream/copy-list-recorded",
      payload: { subscriptionsByKey: {} },
    },
  });
  await expect(
    receiver.unsubscribeFromEvents({
      sourceStreamPath: sourcePath,
      subscriptionKey: requestedKey,
    }),
  ).resolves.toEqual({ status: "already-absent" });

  await source.append({ type: "events.iterate.com/stream/resumed", payload: {} });
  await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey: expiringKey,
    endWhen: { any: [{ kind: "time", at: new Date(Date.now() + 1_000).toISOString() }] },
  });
  await source.append({
    type: "events.iterate.com/stream/paused",
    payload: { reason: "expire after this incarnation is evicted" },
  });
  await source.kill().catch(() => undefined);

  await waitForCondition(
    async () =>
      coreState(await source.runtimeState()).subscriptions.outbound.byKey[expiringKey] ===
        undefined &&
      coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath]
        ?.byKey[expiringKey] === undefined,
    {
      description: "the paused source to expire and project removal after eviction",
      timeoutMs: 30_000,
    },
  );
  expect(
    (await source.getEvents({ afterOffset: 0 })).find(
      (event) =>
        event.type === "events.iterate.com/stream/subscription-removed" &&
        event.payload?.subscriptionKey === expiringKey,
    ),
  ).toMatchObject({ payload: { reason: "expired" } });
});

test("a copy filters, transforms, records its source, and deduplicates a retried delivery", async () => {
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
      condition: "payload.selected = true",
    },
    transform:
      '{ "type": "events.iterate.test/subscriptions/summary", "payload": { "value": payload.value } }',
  });
  const [, selected] = await source.append(
    { type: MATCHING_EVENT_TYPE, payload: { selected: false, value: "ignored" } },
    { type: MATCHING_EVENT_TYPE, payload: { selected: true, value: marker } },
  );

  const copied = await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: ["events.iterate.test/subscriptions/summary"],
    timeoutMs: 15_000,
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
  expect(duplicateReceipt).toMatchObject({ accepted: 1, dropped: [] });
  expect(
    await receiver.getEvents({
      afterOffset: 0,
      eventTypes: ["events.iterate.test/subscriptions/summary"],
    }),
  ).toHaveLength(1);
  expect(
    coreState(await receiver.runtimeState()).subscriptions.inbound.bySourcePath[sourcePath]?.byKey[
      subscriptionKey
    ],
  ).toMatchObject({ numEventsReceived: 1, numEventsDropped: 0 });
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
    transform:
      '{ "type": "events.iterate.test/subscriptions/summary", "payload": { "value": payload.value } }',
  });
  const [selected] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { value: marker },
  });
  const firstCopy = await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: ["events.iterate.test/subscriptions/summary"],
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
    eventTypes: ["events.iterate.test/subscriptions/summary"],
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
    receiverState.subscriptions.inbound.bySourcePath[sourcePath]?.byKey[subscriptionKey],
  ).toMatchObject({
    configuration: incomingSubscriptionConfiguration(
      configured.copyListRecordedEvent,
      subscriptionKey,
    ),
    numEventsReceived: 2,
    lastEventReceivedAt: copiedAfterSeek.createdAt,
  });
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
      condition: "payload.selected = true",
    },
    transform:
      '{ "type": "events.iterate.test/subscriptions/summary", "payload": { "value": payload.value } }',
  });
  const [selected] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { selected: true, value: marker },
  });
  await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: ["events.iterate.test/subscriptions/summary"],
    timeoutMs: 15_000,
  });

  // A same-key replacement is another deliberate delivery run. Its own
  // configure-event offset distinguishes the replay from both old copies.
  const replacement = await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: {
      eventTypes: [MATCHING_EVENT_TYPE],
      condition: "payload.selected = true",
    },
    transform:
      '{ "type": "events.iterate.test/subscriptions/summary-v2", "payload": { "changed": payload.value } }',
    start: "beginning",
  });
  await waitForCondition(
    async () =>
      (runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]
        ?.acknowledgedOffset ?? 0) >= selected!.offset,
    { description: "the replacement transform to replay the existing source coordinate" },
  );
  expect(
    coreState(await source.runtimeState()).subscriptions.outbound.byKey[subscriptionKey],
  ).toMatchObject({
    configuration: replacement.subscriptionConfiguredEvent.payload,
  });
  expect(
    coreState(await source.runtimeState()).copyListDeliveriesByReceivingStream[receivingStreamPath],
  ).toMatchObject({
    sourceOffset: replacement.subscriptionConfiguredEvent.offset,
    status: "confirmed",
  });
  expect(
    coreState(await source.runtimeState()).subscriptions.outbound.byKey[subscriptionKey],
  ).not.toHaveProperty("deliveryHalted");
  const replacementCopies = await receiver.getEvents({
    afterOffset: 0,
    eventTypes: ["events.iterate.test/subscriptions/summary-v2"],
  });
  expect(replacementCopies).toHaveLength(1);
  const copiedByReplacementReplay = replacementCopies[0]!;
  expect(copiedByReplacementReplay).toMatchObject({
    payload: { changed: marker },
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
    eventTypes: ["events.iterate.test/subscriptions/summary-v2"],
    timeoutMs: 15_000,
  });
  expect(copiedUnderReplacement).toMatchObject({
    payload: { changed: `${marker}-v2` },
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

test("a stream transform failure preserves the healthy batch prefix without creating a destination gap", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/transform-failure/source/${marker}`;
  const receivingStreamPath = `/e2e/subscriptions/transform-failure/receiver/${marker}`;
  const subscriptionKey = `transform-failure-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using source = project.streams.get(sourcePath);
  using receiver = project.streams.get(receivingStreamPath);

  await receiver.subscribeToEventsFrom({
    sourceStreamPath: sourcePath,
    subscriptionKey,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
    // Valid JSONata, but this event evaluates to a string instead of the
    // receiver's required `{ type?, payload?, metadata? }` object.
    transform: "payload.value",
  });
  const [healthy, failed] = await source.append(
    {
      type: MATCHING_EVENT_TYPE,
      payload: { value: { payload: { marker, phase: "healthy-prefix" } } },
    },
    { type: MATCHING_EVENT_TYPE, payload: { value: marker } },
  );

  const copiedHealthy = await receiver.waitForEvent({
    afterOffset: 0,
    eventTypes: [MATCHING_EVENT_TYPE],
    predicate: (event) => event.payload?.marker === marker,
    timeoutMs: 15_000,
  });
  expect(copiedHealthy.source?.copiedFrom?.at(-1)?.offset).toBe(healthy!.offset);

  await waitForCondition(
    async () =>
      (runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]?.attempt ??
        0) >= 1,
    { description: "the source to record the rejected stream delivery" },
  );
  const runtime = runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]!;
  expect(runtime).toMatchObject({ acknowledgedOffset: healthy!.offset });
  expect(runtime.acknowledgedOffset).toBeLessThan(failed!.offset);
  expect(runtime.lastError).toContain("copy transform");
  expect(
    (await receiver.getEvents({ afterOffset: 0, eventTypes: [MATCHING_EVENT_TYPE] })).map(
      (event) => event.offset,
    ),
  ).toEqual([copiedHealthy.offset]);
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
      condition: '($assert(payload.allowed, "filter rejected event"); true)',
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

// Hosted processors are separate: they report their own checkpoint, have no
// configurable start/ephemeral policy, and cannot use count or source-offset
// ending conditions. Their wake/checkpoint behavior has dedicated stories below.
test("copy, ITX-call, and webhook-post subscriptions share start positions and ephemeral-event inclusion", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/start/source/${marker}`;
  const itxOutputPath = `/e2e/subscriptions/start/itx-output/${marker}`;
  const itxOutputType = "events.iterate.test/subscriptions/start-itx-received";
  const subscriptionPrefix = `start-${marker}-`;
  const webhookDeliveries: Array<{ subscriptionKey: string; sequence: number }> = [];

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  await project.repo.commitFiles({
    message: "Add start-position matrix probe worker",
    changes: [
      {
        path: "worker.ts",
        content: `
            import { WorkerEntrypoint } from "cloudflare:workers";

            const SUBSCRIPTION_PREFIX = ${JSON.stringify(subscriptionPrefix)};
            const OUTPUT_PATH = ${JSON.stringify(itxOutputPath)};
            const OUTPUT_TYPE = ${JSON.stringify(itxOutputType)};

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch() { return new Response("start-position matrix probe"); }

              async processEventBatch(batch) {
                if (!batch.subscriptionKey.startsWith(SUBSCRIPTION_PREFIX + "itx-")) return;
                const itx = await this.env.ITX.get();
                await itx.streams.get(OUTPUT_PATH).append({
                  type: OUTPUT_TYPE,
                  idempotencyKey: batch.deliveryId,
                  payload: {
                    subscriptionKey: batch.subscriptionKey,
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
    new Request(`https://start-position-probe.invalid/ready/${marker}`),
  );
  expect(await workerProbe.text()).toBe("start-position matrix probe");
  using _intercept = await project.egress.intercept(async (request) => {
    const delivery = (await request.json()) as {
      subscriptionKey: string;
      event: { payload: { sequence: number } };
    };
    webhookDeliveries.push({
      subscriptionKey: delivery.subscriptionKey,
      sequence: delivery.event.payload.sequence,
    });
    return new Response(null, { status: 204 });
  });
  using source = project.streams.get(sourcePath);
  using itxOutput = project.streams.get(itxOutputPath);

  const [durableBefore, transientBefore] = await source.append(
    { type: MATCHING_EVENT_TYPE, payload: { marker, sequence: 1 } },
    { type: MATCHING_EVENT_TYPE, ephemeral: true, payload: { marker, sequence: 2 } },
  );
  const cases = [
    {
      name: "beginning durable only",
      slug: "beginning-durable",
      start: "beginning" as const,
      includeEphemeral: false,
      expected: [1, 3],
    },
    {
      name: "beginning including transient rows",
      slug: "beginning-all",
      start: "beginning" as const,
      includeEphemeral: true,
      expected: [1, 2, 3, 4],
    },
    {
      name: "live from now",
      slug: "now",
      start: "now" as const,
      includeEphemeral: false,
      expected: [3],
    },
    {
      name: "live from now including transient rows",
      slug: "now-all",
      start: "now" as const,
      includeEphemeral: true,
      expected: [3, 4],
    },
    {
      name: "after an explicit offset, durable only",
      slug: "after-durable",
      start: { afterOffset: durableBefore!.offset },
      includeEphemeral: false,
      expected: [3],
    },
    {
      name: "after an explicit offset, including transient rows",
      slug: "after-all",
      start: { afterOffset: durableBefore!.offset },
      includeEphemeral: true,
      expected: [2, 3, 4],
    },
  ];
  const receivingStreams = cases.map((entry) =>
    project.streams.get(`/e2e/subscriptions/start/${entry.slug}/${marker}`),
  );
  try {
    for (const [index, entry] of cases.entries()) {
      await receivingStreams[index]!.subscribeToEventsFrom({
        sourceStreamPath: sourcePath,
        subscriptionKey: `${subscriptionPrefix}stream-${index}`,
        filter: { eventTypes: [MATCHING_EVENT_TYPE] },
        start: entry.start,
        includeEphemeral: entry.includeEphemeral,
      });
      await source.append(
        subscriptionConfigured({
          subscriptionKey: `${subscriptionPrefix}itx-${index}`,
          filter: { eventTypes: [MATCHING_EVENT_TYPE] },
          receiver: {
            action: "itx-call",
            expression: ["worker", "processEventBatch"],
            delivery: deliveryPolicy(entry.start, {
              includeEphemeral: entry.includeEphemeral,
              onFailingEvent: "skip",
            }),
          },
        }),
        subscriptionConfigured({
          subscriptionKey: `${subscriptionPrefix}webhook-${index}`,
          filter: { eventTypes: [MATCHING_EVENT_TYPE] },
          receiver: {
            action: "webhook-post",
            url: `https://start-position-${index}.example/${marker}`,
            delivery: deliveryPolicy(entry.start, {
              includeEphemeral: entry.includeEphemeral,
            }),
          },
        }),
      );
    }

    await source.append(
      { type: MATCHING_EVENT_TYPE, payload: { marker, sequence: 3 } },
      { type: MATCHING_EVENT_TYPE, ephemeral: true, payload: { marker, sequence: 4 } },
    );

    for (const [index, entry] of cases.entries()) {
      const itxSubscriptionKey = `${subscriptionPrefix}itx-${index}`;
      const webhookSubscriptionKey = `${subscriptionPrefix}webhook-${index}`;
      await waitForCondition(
        async () => {
          const streamEvents = await receivingStreams[index]!.getEvents({
            afterOffset: 0,
            eventTypes: [MATCHING_EVENT_TYPE],
          });
          const itxSequences = (
            await itxOutput.getEvents({ afterOffset: 0, eventTypes: [itxOutputType] })
          )
            .filter((event) => event.payload?.subscriptionKey === itxSubscriptionKey)
            .flatMap((event) => event.payload?.sequences ?? []);
          const webhookSequences = webhookDeliveries.filter(
            (delivery) => delivery.subscriptionKey === webhookSubscriptionKey,
          );
          return (
            streamEvents.length >= entry.expected.length &&
            itxSequences.length >= entry.expected.length &&
            webhookSequences.length >= entry.expected.length
          );
        },
        {
          description: `${entry.name} deliveries through copy, ITX-call, and webhook-post subscriptions`,
          timeoutMs: 30_000,
        },
      );
      const streamSequences = (
        await receivingStreams[index]!.getEvents({
          afterOffset: 0,
          eventTypes: [MATCHING_EVENT_TYPE],
        })
      ).map((event) => (event.payload as { sequence: number }).sequence);
      const itxSequences = (
        await itxOutput.getEvents({ afterOffset: 0, eventTypes: [itxOutputType] })
      )
        .filter((event) => event.payload?.subscriptionKey === itxSubscriptionKey)
        .flatMap((event) => event.payload?.sequences ?? []);
      const webhookSequences = webhookDeliveries
        .filter((delivery) => delivery.subscriptionKey === webhookSubscriptionKey)
        .map((delivery) => delivery.sequence);
      expect(
        { stream: streamSequences, expression: itxSequences, webhook: webhookSequences },
        entry.name,
      ).toEqual({
        stream: entry.expected,
        expression: entry.expected,
        webhook: entry.expected,
      });
    }
  } finally {
    for (const receivingStream of receivingStreams) receivingStream[Symbol.dispose]();
  }

  expect(transientBefore).toMatchObject({ ephemeral: true });
});

test("copy, ITX-call, and webhook-post subscriptions stop at exact count and source-offset boundaries", async () => {
  const marker = crypto.randomUUID();
  const subscriptionPrefix = `finite-${marker}-`;
  const itxOutputPath = `/e2e/subscriptions/finite/itx-output/${marker}`;
  const itxOutputType = "events.iterate.test/subscriptions/finite-itx-received";
  const webhookDeliveries: Array<{ subscriptionKey: string; index: number }> = [];
  const cases = (["copy-to-stream", "itx-call", "webhook-post"] as const).flatMap(
    (subscriptionAction) =>
      (["acknowledged-events", "source-offset-acknowledged"] as const).map((endKind) => ({
        subscriptionAction,
        endKind,
        slug: `${subscriptionAction}-${endKind}`,
      })),
  );

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  await project.repo.commitFiles({
    message: "Add finite subscription matrix probe worker",
    changes: [
      {
        path: "worker.ts",
        content: `
            import { WorkerEntrypoint } from "cloudflare:workers";

            const SUBSCRIPTION_PREFIX = ${JSON.stringify(subscriptionPrefix)};
            const OUTPUT_PATH = ${JSON.stringify(itxOutputPath)};
            const OUTPUT_TYPE = ${JSON.stringify(itxOutputType)};

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch() { return new Response("finite subscription matrix probe"); }

              async processEventBatch(batch) {
                if (!batch.subscriptionKey.startsWith(SUBSCRIPTION_PREFIX + "itx-call-")) return;
                const itx = await this.env.ITX.get();
                await itx.streams.get(OUTPUT_PATH).append({
                  type: OUTPUT_TYPE,
                  idempotencyKey: batch.deliveryId,
                  payload: {
                    subscriptionKey: batch.subscriptionKey,
                    indexes: batch.events.map((event) => event.payload.index),
                  },
                });
              }
            }
          `,
      },
    ],
  });
  const workerProbe = await project.worker.fetch(
    new Request(`https://finite-subscription-probe.invalid/ready/${marker}`),
  );
  expect(await workerProbe.text()).toBe("finite subscription matrix probe");
  using _intercept = await project.egress.intercept(async (request) => {
    const delivery = (await request.json()) as {
      subscriptionKey: string;
      event: { payload: { index: number } };
    };
    webhookDeliveries.push({
      subscriptionKey: delivery.subscriptionKey,
      index: delivery.event.payload.index,
    });
    return new Response(null, { status: 204 });
  });
  using itxOutput = project.streams.get(itxOutputPath);
  const sources = cases.map((entry) =>
    project.streams.get(`/e2e/subscriptions/finite/source/${entry.slug}/${marker}`),
  );
  const receivingStreams = cases.map((entry) =>
    entry.subscriptionAction === "copy-to-stream"
      ? project.streams.get(`/e2e/subscriptions/finite/receiver/${entry.slug}/${marker}`)
      : undefined,
  );

  try {
    for (const [index, entry] of cases.entries()) {
      const source = sources[index]!;
      const sourcePath = `/e2e/subscriptions/finite/source/${entry.slug}/${marker}`;
      const subscriptionKey = `${subscriptionPrefix}${entry.slug}`;
      const appended = await source.append(
        ...Array.from({ length: 4 }, (_, eventIndex) => ({
          type: MATCHING_EVENT_TYPE,
          payload: { case: entry.slug, index: eventIndex, marker },
        })),
      );
      const endWhen =
        entry.endKind === "acknowledged-events"
          ? { any: [{ kind: "acknowledged-events" as const, count: 2 }] }
          : {
              any: [
                {
                  kind: "source-offset-acknowledged" as const,
                  offset: appended[1]!.offset,
                },
              ],
            };

      if (entry.subscriptionAction === "copy-to-stream") {
        await receivingStreams[index]!.subscribeToEventsFrom({
          sourceStreamPath: sourcePath,
          subscriptionKey,
          filter: { eventTypes: [MATCHING_EVENT_TYPE] },
          start: "beginning",
          endWhen,
        });
      } else {
        await source.append(
          subscriptionConfigured({
            subscriptionKey,
            filter: { eventTypes: [MATCHING_EVENT_TYPE] },
            endWhen,
            receiver:
              entry.subscriptionAction === "itx-call"
                ? {
                    action: "itx-call",
                    expression: ["worker", "processEventBatch"],
                    delivery: deliveryPolicy("beginning", { onFailingEvent: "skip" }),
                  }
                : {
                    action: "webhook-post",
                    url: `https://finite-${entry.endKind}.example/${marker}`,
                    delivery: deliveryPolicy("beginning"),
                  },
          }),
        );
      }
    }

    for (const [index, entry] of cases.entries()) {
      const source = sources[index]!;
      const sourcePath = `/e2e/subscriptions/finite/source/${entry.slug}/${marker}`;
      const subscriptionKey = `${subscriptionPrefix}${entry.slug}`;
      await waitForCondition(
        async () => {
          const sourceRemoved =
            coreState(await source.runtimeState()).subscriptions.outbound.byKey[subscriptionKey] ===
            undefined;
          if (!sourceRemoved) return false;
          if (entry.subscriptionAction !== "copy-to-stream") return true;
          return (
            coreState(await receivingStreams[index]!.runtimeState()).subscriptions.inbound
              .bySourcePath[sourcePath]?.byKey[subscriptionKey] === undefined
          );
        },
        {
          description: `${entry.subscriptionAction} subscription to stop at its ${entry.endKind} boundary`,
          timeoutMs: 30_000,
        },
      );

      const indexes =
        entry.subscriptionAction === "copy-to-stream"
          ? (
              await receivingStreams[index]!.getEvents({
                afterOffset: 0,
                eventTypes: [MATCHING_EVENT_TYPE],
              })
            ).map((event) => event.payload?.index)
          : entry.subscriptionAction === "itx-call"
            ? (await itxOutput.getEvents({ afterOffset: 0, eventTypes: [itxOutputType] }))
                .filter((event) => event.payload?.subscriptionKey === subscriptionKey)
                .flatMap((event) => event.payload?.indexes ?? [])
            : webhookDeliveries
                .filter((delivery) => delivery.subscriptionKey === subscriptionKey)
                .map((delivery) => delivery.index);
      expect(indexes, `${entry.subscriptionAction} / ${entry.endKind}`).toEqual([0, 1]);
      expect(
        (await source.getEvents({ afterOffset: 0 })).find(
          (event) =>
            event.type === "events.iterate.com/stream/subscription-removed" &&
            event.payload?.subscriptionKey === subscriptionKey,
        ),
      ).toMatchObject({ payload: { reason: "completed" } });
    }
  } finally {
    for (const source of sources) source[Symbol.dispose]();
    for (const receivingStream of receivingStreams) receivingStream?.[Symbol.dispose]();
  }
});

// Hosted processor, ITX call, and webhook receivers.
test("every project stream is born with ordinary project-worker and PostHog ITX receivers", async () => {
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
        includeEphemeral: false,
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
        includeEphemeral: false,
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

test("an ITX-expression receiver bisects a batch, skips one repeatedly failing event, and continues", async () => {
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

  // Isolating the poisoned event takes the whole ladder: the batch failure,
  // the bisect round, and FAILING_EVENT_CONFIRM_ATTEMPTS single-event
  // confirmations — each behind its own exponential backoff (~15s of pure
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
  }

  const state = runtimeState(await source.runtimeState());
  expect(state.runtime.subscriptions[subscriptionKey]).toMatchObject({
    acknowledgedEvents: 3,
    attempt: 0,
  });
  expect(state.coreProcessorState.subscriptions.outbound.byKey[subscriptionKey]).not.toHaveProperty(
    "deliveryHalted",
  );
});

test("a webhook time boundary removes the rule and prevents later delivery", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/webhook-deadline/source/${marker}`;
  const expiringKey = `webhook-deadline-${marker}`;
  const sentinelKey = `webhook-deadline-sentinel-${marker}`;
  const deliveries: Array<{ subscriptionKey: string; event: StreamEvent }> = [];

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  using _intercept = await project.egress.intercept(async (request) => {
    deliveries.push((await request.json()) as { subscriptionKey: string; event: StreamEvent });
    return new Response(null, { status: 204 });
  });
  using source = project.streams.get(sourcePath);

  await source.append(
    subscriptionConfigured({
      subscriptionKey: sentinelKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      receiver: {
        action: "webhook-post",
        url: `https://webhook-deadline-sentinel.example/${marker}`,
        delivery: deliveryPolicy("now"),
      },
    }),
    subscriptionConfigured({
      subscriptionKey: expiringKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      endWhen: {
        any: [{ kind: "time", at: new Date(Date.now() + 3_000).toISOString() }],
      },
      receiver: {
        action: "webhook-post",
        url: `https://webhook-deadline.example/${marker}`,
        delivery: deliveryPolicy("now"),
      },
    }),
  );
  const [beforeExpiry] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, phase: "before-expiry" },
  });
  await waitForCondition(
    () =>
      [sentinelKey, expiringKey].every((key) =>
        deliveries.some(
          (delivery) =>
            delivery.subscriptionKey === key && delivery.event.offset === beforeExpiry!.offset,
        ),
      ),
    { description: "both webhooks to receive the event before the deadline" },
  );

  await waitForCondition(
    async () =>
      coreState(await source.runtimeState()).subscriptions.outbound.byKey[expiringKey] ===
      undefined,
    { description: "the webhook deadline to remove its subscription", timeoutMs: 30_000 },
  );
  expect(
    (await source.getEvents({ afterOffset: beforeExpiry!.offset })).find(
      (event) =>
        event.type === "events.iterate.com/stream/subscription-removed" &&
        event.payload?.subscriptionKey === expiringKey,
    ),
  ).toMatchObject({ payload: { reason: "expired" } });

  const [afterExpiry] = await source.append({
    type: MATCHING_EVENT_TYPE,
    payload: { marker, phase: "after-expiry" },
  });
  await waitForCondition(
    () =>
      deliveries.some(
        (delivery) =>
          delivery.subscriptionKey === sentinelKey && delivery.event.offset === afterExpiry!.offset,
      ),
    { description: "the durable sentinel webhook to advance beyond the expired rule" },
  );
  expect(
    deliveries
      .filter((delivery) => delivery.subscriptionKey === expiringKey)
      .map((delivery) => delivery.event.offset),
  ).toEqual([beforeExpiry!.offset]);
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
  await waitForCondition(
    async () =>
      (runtimeState(await source.runtimeState()).runtime.subscriptions[subscriptionKey]
        ?.acknowledgedOffset ?? 0) >= healthyEvent!.offset,
    {
      description: "the repeatedly failing event to be skipped and the next event acknowledged",
      timeoutMs: 15_000,
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

test("the consecutive-failure limit survives stream eviction and halts before mass-skipping", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/subscriptions/webhook-failing-event/eviction/${marker}`;
  const subscriptionKey = `webhook-failing-event-eviction-${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  let rejecting = true;
  using _intercept = await project.egress.intercept(() =>
    Promise.resolve(new Response(null, { status: rejecting ? 422 : 204 })),
  );
  using source = project.streams.get(sourcePath);

  await source.append(
    subscriptionConfigured({
      subscriptionKey,
      filter: { eventTypes: [MATCHING_EVENT_TYPE] },
      receiver: {
        action: "webhook-post",
        url: `https://webhook-failing-event-eviction.example/${marker}`,
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
      { description: `failing event ${sequence} to be retried, confirmed, and skipped` },
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
    { description: "the durable consecutive-failure limit to halt event sending" },
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

  rejecting = false;
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
        filter: { condition: "payload.(((" },
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
    {
      key: `transform-${marker}`,
      message: /invalid JSONata expression.*Expected .*before end of expression/i,
      event: subscriptionConfigured({
        subscriptionKey: `transform-${marker}`,
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: `/e2e/subscriptions/validation/receiver/${marker}`,
          transform: "{ ((( ",
          delivery: { ...deliveryPolicy("now"), onFailingEvent: "halt" as const },
        },
      }),
    },
    {
      key: `hosted-end-${marker}`,
      message: /checkpoint|only time/i,
      event: subscriptionConfigured({
        subscriptionKey: `hosted-end-${marker}`,
        endWhen: { any: [{ kind: "acknowledged-events", count: 1 }] },
        receiver: {
          action: "processor-wake",
          expression: ["agents", ["get", "/agents/validator"], "processor", "wakeStreamProcessor"],
        },
      }),
    },
    {
      key: `hosted-offset-end-${marker}`,
      message: /checkpoint|only time/i,
      event: subscriptionConfigured({
        subscriptionKey: `hosted-offset-end-${marker}`,
        endWhen: { any: [{ kind: "source-offset-acknowledged", offset: 1 }] },
        receiver: {
          action: "processor-wake",
          expression: ["agents", ["get", "/agents/validator"], "processor", "wakeStreamProcessor"],
        },
      }),
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

  using futureStartReceiver = project.streams.get(
    `/e2e/subscriptions/validation/future-start/${marker}`,
  );
  const sourceHeadBeforeFutureStart = coreState(await source.runtimeState()).maxOffset;
  await expect(
    futureStartReceiver.subscribeToEventsFrom({
      sourceStreamPath: sourcePath,
      subscriptionKey: `future-start-${marker}`,
      start: { afterOffset: sourceHeadBeforeFutureStart + 1_000_000 },
    }),
  ).rejects.toThrow(/beyond this stream's current maximum offset/);

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
  const canonicalReceiverPath = `/e2e/subscriptions/validation/forgery-receiver/${marker}`;

  using testProject = await openTestProject(marker);
  const { project } = testProject;
  const { projectId } = await project.__describe();
  using source = project.streams.get(sourcePath);

  await expect(
    source.append({
      type: "events.iterate.com/stream/copy-list-recorded",
      payload: {
        source: {
          projectId,
          path: "/forged",
          streamId: crypto.randomUUID(),
          streamCreatedAt: new Date().toISOString(),
        },
        sourceOffset: 1,
        subscriptionsByKey: {},
      },
    }),
  ).rejects.toThrow(/platform-authored/);
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
      type: "events.iterate.com/stream/copy-list-confirmed",
      payload: {
        receivingStreamPath: canonicalReceiverPath,
        sourceOffset: 1,
        receivingStreamEvent: {
          type: "events.iterate.com/stream/copy-list-recorded",
          payload: {
            source: {
              projectId: "forged-project",
              path: sourcePath,
              streamId: crypto.randomUUID(),
              streamCreatedAt: new Date().toISOString(),
            },
            sourceOffset: 1,
            subscriptionsByKey: {},
          },
          offset: 1,
          createdAt: new Date().toISOString(),
          path: canonicalReceiverPath,
        },
      },
    },
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
      type: "events.iterate.com/stream/copy-list-delivery-blocked",
      payload: {
        receivingStreamPath: canonicalReceiverPath,
        sourceOffset: 1,
        attempts: 8,
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

test("a global stream rejects webhook egress before commit", async () => {
  const marker = crypto.randomUUID();
  const subscriptionKey = `global-webhook-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using stream = itx.streams.get(`/e2e/subscriptions/validation/global/${marker}`);

  await expect(
    stream.append(
      subscriptionConfigured({
        subscriptionKey,
        receiver: {
          action: "webhook-post",
          url: `https://example.com/${marker}`,
          delivery: deliveryPolicy("now"),
        },
      }),
    ),
  ).rejects.toThrow(/project-scoped/);
  expect(
    (await stream.getEvents({ afterOffset: 0 })).some(
      (event) => event.payload?.subscriptionKey === subscriptionKey,
    ),
  ).toBe(false);
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

function copyListRetry(value: unknown, receivingStreamPath: string) {
  return runtimeState(value).runtime.copyListRetries[receivingStreamPath];
}

function incomingSubscriptionConfiguration(event: StreamEvent, subscriptionKey: string): unknown {
  return subscriptionsFromSource(event)[subscriptionKey]?.configuration;
}

function subscriptionsFromSource(
  event: StreamEvent,
): Record<string, { configuredAtSourceOffset?: number; configuration?: unknown }> {
  const payload = event.payload as
    | {
        subscriptionsByKey?: Record<
          string,
          { configuredAtSourceOffset?: number; configuration?: unknown }
        >;
      }
    | undefined;
  return payload?.subscriptionsByKey ?? {};
}

type DeliveryPolicy = {
  start: "beginning" | "now" | { afterOffset: number };
  includeEphemeral: boolean;
  onFailingEvent: "halt" | "skip";
};

function subscriptionConfigured(input: {
  subscriptionKey: string;
  endWhen?: Record<string, unknown>;
  description?: string;
  filter?: { eventTypes?: string[]; condition?: string };
  receiver: Record<string, unknown>;
}): StreamEventInput {
  return {
    type: "events.iterate.com/stream/subscription-configured",
    payload: input,
  };
}

function deliveryPolicy(
  start: "beginning" | "now" | { afterOffset: number },
  options: Partial<Pick<DeliveryPolicy, "includeEphemeral" | "onFailingEvent">> = {},
): DeliveryPolicy {
  return {
    start,
    includeEphemeral: options.includeEphemeral ?? false,
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
