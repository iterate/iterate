// OS stream e2e migration guards, ported to the v4 stream contract.
//
// These deliberately cover only deployment-style ITX/WebSocket behavior: project
// stream access, append/read, replay/live subscriptions, unsubscribe,
// state-only subscription pushes, and cross-posting (durable push subscriptions
// targeting another stream's acceptCrossPost sink, via the crossPostTo sugar). Unit and
// workerd-only stream regression tests stay out of this file.

import { expect, test } from "vitest";
import type { StreamEventBatch } from "../../src/domains/streams/rpc-types.ts";
import type { StreamEvent } from "../../src/domains/streams/schemas.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const STREAM_EVENT_TYPE = "events.iterate.test/minimal-v4/stream-e2e";
const CROSS_POST_EVENT_TYPE = "events.iterate.test/minimal-v4/cross-post";

type CoreStreamState = {
  eventCount: number;
  maxOffset: number;
  path: string;
  projectId: string | null;
};

test("creates a project and uses project streams through v4 ITX", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/os-port/admin-project/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `os-stream-smoke-${RUN_SUFFIX}-${marker}` });
  const projectDescription = await project.__describe();
  using stream = project.streams.get(streamPath);

  const seen: StreamEvent[] = [];
  using subscription = await stream.subscribe({
    replayAfterOffset: 0,
    processEventBatch: (batch) => {
      seen.push(...batch.events);
    },
  });

  const [appended] = await stream.append({
    type: STREAM_EVENT_TYPE,
    payload: { marker },
  });
  expect(appended).toMatchObject({
    offset: expect.any(Number),
    payload: { marker },
    type: STREAM_EVENT_TYPE,
  });
  const head = await stream.head();
  expect(Object.keys(head).sort()).toEqual(["createdAt", "maxOffset"]);
  expect(head).toEqual({
    createdAt: expect.any(String),
    maxOffset: appended!.offset,
  });

  const ackMarker = crypto.randomUUID();
  expect(
    await stream.appendAck({
      type: STREAM_EVENT_TYPE,
      payload: { marker: ackMarker },
      idempotencyKey: `stream-e2e-ack:${ackMarker}`,
    }),
  ).toBeUndefined();
  const headAfterAck = await stream.head();
  expect(headAfterAck.maxOffset).toBe(appended!.offset + 1);
  expect(
    await stream.appendAck({
      type: STREAM_EVENT_TYPE,
      payload: { marker: `${ackMarker}-duplicate` },
      idempotencyKey: `stream-e2e-ack:${ackMarker}`,
    }),
  ).toBeUndefined();
  expect(await stream.head()).toEqual(headAfterAck);

  const sameBatchKey = `stream-e2e-ack-batch:${ackMarker}`;
  await stream.appendAck(
    {
      type: STREAM_EVENT_TYPE,
      payload: { marker: `${ackMarker}-batch` },
      idempotencyKey: sameBatchKey,
    },
    {
      type: STREAM_EVENT_TYPE,
      payload: { marker: `${ackMarker}-batch-duplicate` },
      idempotencyKey: sameBatchKey,
    },
  );
  const headAfterSameBatch = await stream.head();
  expect(headAfterSameBatch.maxOffset).toBe(headAfterAck.maxOffset + 1);

  const mixedKey = `stream-e2e-ack-mixed:${ackMarker}`;
  await stream.appendAck(
    {
      type: STREAM_EVENT_TYPE,
      payload: { marker: `${ackMarker}-duplicate` },
      idempotencyKey: `stream-e2e-ack:${ackMarker}`,
    },
    {
      type: STREAM_EVENT_TYPE,
      payload: { marker: `${ackMarker}-mixed` },
      idempotencyKey: mixedKey,
    },
  );
  const headAfterMixed = await stream.head();
  expect(headAfterMixed.maxOffset).toBe(headAfterSameBatch.maxOffset + 1);

  const read = await stream.getEvents({ afterOffset: 0 });
  expect(read).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        offset: appended!.offset,
        payload: { marker },
        type: STREAM_EVENT_TYPE,
      }),
      expect.objectContaining({
        offset: headAfterAck.maxOffset,
        payload: { marker: ackMarker },
        type: STREAM_EVENT_TYPE,
      }),
      expect.objectContaining({
        offset: headAfterSameBatch.maxOffset,
        payload: { marker: `${ackMarker}-batch` },
        type: STREAM_EVENT_TYPE,
      }),
      expect.objectContaining({
        offset: headAfterMixed.maxOffset,
        payload: { marker: `${ackMarker}-mixed` },
        type: STREAM_EVENT_TYPE,
      }),
    ]),
  );
  const markers = read.map((event) => (event.payload as { marker?: unknown }).marker);
  expect(markers).not.toContain(`${ackMarker}-duplicate`);
  expect(markers).not.toContain(`${ackMarker}-batch-duplicate`);

  await waitFor(
    () =>
      seen.some(
        (event) =>
          event.type === STREAM_EVENT_TYPE &&
          (event.payload as { marker?: unknown }).marker === marker,
      ),
    () => `stream subscription marker; saw ${JSON.stringify(seen)}`,
  );

  const runtimeState = await stream.runtimeState();
  expect(coreState(runtimeState.coreProcessorState)).toMatchObject({
    path: streamPath,
    projectId: projectDescription.projectId,
  });

  await subscription.unsubscribe();
});

test("stream getEvents defaults to a bounded page and supports event type filters", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/os-port/get-events/${marker}`;
  const selectedType = `${STREAM_EVENT_TYPE}/selected`;
  const otherType = `${STREAM_EVENT_TYPE}/other`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `os-stream-get-events-${RUN_SUFFIX}-${marker}` });
  using stream = project.streams.get(streamPath);

  const appendedEvents = await stream.append(
    ...Array.from({ length: 505 }, (_, index) => ({
      type: index % 2 === 0 ? selectedType : otherType,
      payload: { index, marker },
    })),
  );
  expect(new Set(appendedEvents.map((event) => event.createdAt)).size).toBe(1);
  const firstAppendedOffset = appendedEvents[0]!.offset;
  const afterOffset = firstAppendedOffset - 1;
  const beforeOffset = appendedEvents.at(-1)!.offset + 1;

  using pager = stream.readEvents({ afterOffset, beforeOffset });
  const firstPage = await pager.next();
  expect(firstPage).toHaveLength(500);

  const secondPage = await pager.next();
  expect(secondPage).toHaveLength(5);
  expect([...firstPage, ...secondPage].map((event) => event.offset)).toEqual(
    appendedEvents.map((event) => event.offset),
  );
  expect(await pager.next()).toEqual([]);

  const selectedEvents = await stream.getEvents({
    afterOffset,
    beforeOffset,
    eventTypes: [selectedType],
    limit: 300,
  });
  expect(selectedEvents).toHaveLength(253);
  expect(selectedEvents.every((event) => event.type === selectedType)).toBe(true);

  using newestPager = stream.readEvents({
    afterOffset,
    beforeOffset,
    eventTypes: [selectedType],
    limit: 200,
    order: "desc",
  });
  const newestPage = await newestPager.next();
  const olderPage = await newestPager.next();
  expect(newestPage).toHaveLength(200);
  expect(olderPage).toHaveLength(53);
  expect([...newestPage, ...olderPage].map((event) => event.offset)).toEqual(
    appendedEvents
      .filter((event) => event.type === selectedType)
      .map((event) => event.offset)
      .reverse(),
  );
  expect(await newestPager.next()).toEqual([]);
  await expect(stream.getEvents({ limit: 501 })).rejects.toThrow("getEvents limit");
});

test("cold activation catches core state up from the journal tail", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/os-port/checkpoint-tail/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `os-stream-checkpoint-${RUN_SUFFIX}-${marker}` });
  using stream = project.streams.get(streamPath);

  const appended = await stream.append(
    ...Array.from({ length: 65 }, (_, index) => ({
      type: STREAM_EVENT_TYPE,
      payload: { index, marker },
    })),
  );
  const tailOffset = appended.at(-1)!.offset;
  await stream.kill().catch(() => undefined);

  const state = coreState((await stream.runtimeState()).coreProcessorState);
  expect(state.maxOffset).toBeGreaterThanOrEqual(tailOffset);
  expect(state.path).toBe(streamPath);
});

test("variadic ordinary appends preserve the exact circuit-breaker trip event", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/os-port/variadic-breaker/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `os-stream-breaker-${RUN_SUFFIX}-${marker}` });
  using stream = project.streams.get(streamPath);

  const [configured] = await stream.append({
    type: "events.iterate.com/stream/configured",
    payload: {
      config: { circuitBreaker: { burstCapacity: 1, refillRatePerMinute: 1 } },
    },
  });
  const burst = await stream.append(
    ...Array.from({ length: 3 }, (_, index) => ({
      type: STREAM_EVENT_TYPE,
      payload: { index, marker },
    })),
  );

  expect(burst.map((event) => event.offset)).toEqual([
    configured!.offset + 1,
    configured!.offset + 2,
    configured!.offset + 3,
  ]);
  const trippedAtOffset = burst[1]!.offset;
  const paused = await stream.getEvent({
    idempotencyKey: `stream-paused:${trippedAtOffset}`,
  });
  expect(paused).toMatchObject({
    offset: burst[2]!.offset + 1,
    type: "events.iterate.com/stream/paused",
    payload: { reason: "circuit breaker tripped: burst rate limit exceeded" },
  });
  expect((await stream.runtimeState()).coreProcessorState).toMatchObject({
    maxOffset: paused!.offset,
    paused: true,
  });
});

test("stream subscribe replays history, tails live appends, and unsubscribes", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/os-port/subscribe/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `os-stream-subscribe-${RUN_SUFFIX}-${marker}` });
  const projectDescription = await project.__describe();
  using stream = project.streams.get(streamPath);

  const before = `before-${marker}`;
  await stream.append({ type: STREAM_EVENT_TYPE, payload: { marker: before } });

  const seen: { marker: string; offset: number }[] = [];
  const batchStates: CoreStreamState[] = [];
  using subscription = await stream.subscribe({
    replayAfterOffset: 0,
    processEventBatch: (batch) => {
      batchStates.push(coreState(batch.state));
      for (const event of batch.events) {
        seen.push({
          marker: (event.payload as { marker?: string }).marker ?? "",
          offset: event.offset,
        });
      }
    },
  });

  const during = `during-${marker}`;
  await stream.append({ type: STREAM_EVENT_TYPE, payload: { marker: during } });

  await waitFor(
    () =>
      seen.some((event) => event.marker === before) &&
      seen.some((event) => event.marker === during),
    () => `replay + live markers; saw ${JSON.stringify(seen)}`,
  );

  const offsets = seen.map((event) => event.offset);
  expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);

  expect(batchStates.length).toBeGreaterThanOrEqual(1);
  for (const state of batchStates) {
    expect(state.projectId).toBe(projectDescription.projectId);
    expect(state.path).toBe(streamPath);
  }
  expect(batchStates.at(-1)!.eventCount).toBeGreaterThanOrEqual(Math.max(...offsets));

  await subscription.unsubscribe();
  const countAtUnsubscribe = seen.length;
  await stream.append({ type: STREAM_EVENT_TYPE, payload: { marker: `after-${marker}` } });
  await new Promise((resolve) => setTimeout(resolve, 750));
  expect(seen.length).toBe(countAtUnsubscribe);
});

test("state-only stream subscribe pushes initial state immediately, then state after appends", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/os-port/state/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `os-stream-state-${RUN_SUFFIX}-${marker}` });
  const projectDescription = await project.__describe();
  using stream = project.streams.get(streamPath);

  await stream.append({ type: STREAM_EVENT_TYPE, payload: { marker: `seed-${marker}` } });

  const states: CoreStreamState[] = [];
  using subscription = await stream.subscribe({
    events: false,
    processEventBatch: (batch: StreamEventBatch) => {
      states.push(coreState(batch.state));
    },
  });

  await waitFor(
    () => states.length >= 1,
    () => "initial state push",
  );
  expect(states[0]).toMatchObject({
    path: streamPath,
    projectId: projectDescription.projectId,
  });
  const initialMaxOffset = states[0]!.maxOffset;
  expect(initialMaxOffset).toBeGreaterThanOrEqual(3);

  await stream.append({ type: STREAM_EVENT_TYPE, payload: { marker: `bump-${marker}` } });
  await waitFor(
    () => (states.at(-1)?.maxOffset ?? 0) > initialMaxOffset,
    () => `a state delivery after the append; saw ${JSON.stringify(states)}`,
  );

  await subscription.unsubscribe();
});

test("ephemeral events are second-class rows: excluded from default reads, delivered on ephemeral subscriptions", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/os-port/ephemeral/${marker}`;
  const ephemeralType = `${STREAM_EVENT_TYPE}/chunk`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `os-stream-ephemeral-${RUN_SUFFIX}-${marker}` });
  using stream = project.streams.get(streamPath);

  // A live watcher attached BEFORE the appends.
  const live: StreamEvent[] = [];
  using liveSubscription = await stream.subscribe({
    processEventBatch: (batch) => {
      live.push(...batch.events);
    },
  });

  const [before] = await stream.append({
    type: STREAM_EVENT_TYPE,
    payload: { marker, position: "before" },
  });
  const [chunk] = await stream.append({
    type: ephemeralType,
    ephemeral: true,
    idempotencyKey: `chunk-${marker}`,
    payload: { marker },
  });
  const [singleDeduped] = await stream.append({
    type: ephemeralType,
    ephemeral: true,
    idempotencyKey: `chunk-${marker}`,
    payload: { marker },
  });
  const [after] = await stream.append({
    type: STREAM_EVENT_TYPE,
    payload: { marker, position: "after" },
  });

  // An ordinary commit: consecutive offsets, self-describing flag, and
  // idempotency dedup works (it is a row like any other).
  expect(chunk!.offset).toBe(before!.offset + 1);
  expect(singleDeduped).toEqual(chunk);
  expect(after!.offset).toBe(chunk!.offset + 1);
  expect(chunk).toMatchObject({ ephemeral: true, type: ephemeralType });
  const [mixedBefore, deduped, mixedAfter] = await stream.append(
    { type: STREAM_EVENT_TYPE, payload: { marker, position: "mixed-before" } },
    {
      type: ephemeralType,
      ephemeral: true,
      idempotencyKey: `chunk-${marker}`,
      payload: { marker },
    },
    { type: STREAM_EVENT_TYPE, payload: { marker, position: "mixed-after" } },
  );
  expect(deduped!.offset).toBe(chunk!.offset);
  expect(mixedBefore!.offset).toBe(after!.offset + 1);
  expect(mixedAfter!.offset).toBe(mixedBefore!.offset + 1);

  // Default reads skip it; includeEphemeral opts in.
  const readWindow = { afterOffset: before!.offset - 1, beforeOffset: after!.offset + 1 };
  const defaultRead = await stream.getEvents(readWindow);
  expect(defaultRead.map((event) => event.offset)).toEqual([before!.offset, after!.offset]);
  const rawRead = await stream.getEvents({ ...readWindow, includeEphemeral: true });
  expect(rawRead.map((event) => event.offset)).toEqual([
    before!.offset,
    chunk!.offset,
    after!.offset,
  ]);

  // The live watcher saw all three, in offset order, the chunk flagged.
  await waitFor(
    () => live.some((event) => event.offset === after!.offset),
    () =>
      `live tail through offset ${after!.offset}; saw ${JSON.stringify(live.map((e) => e.offset))}`,
  );
  const window = live.filter(
    (event) => event.offset >= before!.offset && event.offset <= after!.offset,
  );
  expect(window.map((event) => [event.offset, event.ephemeral === true])).toEqual([
    [before!.offset, false],
    [chunk!.offset, true],
    [after!.offset, false],
  ]);

  // Ephemeral subscriptions get them on REPLAY too (the browser mirror stays
  // dense as long as no eviction has swept the rows).
  const replayed: StreamEvent[] = [];
  using replaySubscription = await stream.subscribe({
    replayAfterOffset: 0,
    processEventBatch: (batch) => {
      replayed.push(...batch.events);
    },
  });
  await waitFor(
    () => replayed.some((event) => event.offset === after!.offset),
    () =>
      `replay through offset ${after!.offset}; saw ${JSON.stringify(replayed.map((e) => e.offset))}`,
  );
  expect(replayed.some((event) => event.offset === chunk!.offset && event.ephemeral === true)).toBe(
    true,
  );

  // Control facts can never be ephemeral.
  await expect(
    stream.append({
      type: "events.iterate.com/stream/paused",
      ephemeral: true,
      payload: { reason: "nope" },
    }),
  ).rejects.toThrow(/cannot be ephemeral/);

  await liveSubscription.unsubscribe();
  await replaySubscription.unsubscribe();

  // Restart: ephemeral rows recover the allocator like any other row — the
  // next offsets continue past the ephemeral head.
  const burst = await stream.append({
    type: ephemeralType,
    ephemeral: true,
    payload: { marker, sequence: 2 },
  });
  const burstHead = burst.at(-1)!.offset;
  await stream.kill().catch(() => undefined);
  const [reborn] = await stream.append({
    type: STREAM_EVENT_TYPE,
    payload: { marker, position: "post-kill" },
  });
  expect(reborn!.offset).toBeGreaterThan(burstHead);
});

test("crossPostTo copies matching events with source provenance", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/os-port/cross-post/source/${marker}`;
  const targetPath = `/e2e/os-port/cross-post/target/${marker}`;
  const subscriptionKey = `copy-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `os-stream-cross-post-${RUN_SUFFIX}-${marker}` });
  const projectDescription = await project.__describe();
  using source = project.streams.get(sourcePath);
  using target = project.streams.get(targetPath);

  await source.crossPostTo({
    path: targetPath,
    key: subscriptionKey,
    eventTypes: [CROSS_POST_EVENT_TYPE],
  });

  const copied = target.waitForEvent({
    afterOffset: 0,
    eventTypes: [CROSS_POST_EVENT_TYPE],
    timeoutMs: 15_000,
  });
  const [sourceEvent] = await source.append({
    type: CROSS_POST_EVENT_TYPE,
    payload: { marker },
  });
  const copiedEvent = await copied;

  // The idempotency key is derived from the source coordinate, so the durable
  // subscription's at-least-once delivery collapses to exactly-once appends.
  expect(copiedEvent).toMatchObject({
    idempotencyKey: `xpost:${subscriptionKey}:${projectDescription.projectId}:${sourcePath}:${sourceEvent!.offset}`,
    payload: { marker },
    source: {
      crossPostedFrom: [
        {
          subscriptionKey,
          createdAt: sourceEvent!.createdAt,
          offset: sourceEvent!.offset,
          path: sourcePath,
          projectId: projectDescription.projectId,
          type: CROSS_POST_EVENT_TYPE,
        },
      ],
    },
    type: CROSS_POST_EVENT_TYPE,
  });
});

test("cross-post conditions gate cross-posting on event content", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/os-port/cross-post-condition/source/${marker}`;
  const targetPath = `/e2e/os-port/cross-post-condition/target/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({
    slug: `os-stream-cross-post-cond-${RUN_SUFFIX}-${marker}`,
  });
  using source = project.streams.get(sourcePath);
  using target = project.streams.get(targetPath);

  // The GitHub-backed-repo shape: one connection stream carries webhooks for
  // every repository of an installation; a JSONata condition on the cross-post
  // subscription's selector narrows the copies to one repository.
  await source.crossPostTo({
    path: targetPath,
    key: `condition-${marker}`,
    eventTypes: [CROSS_POST_EVENT_TYPE],
    condition: `payload.repository = "acme/widgets"`,
  });

  const copied = target.waitForEvent({
    afterOffset: 0,
    eventTypes: [CROSS_POST_EVENT_TYPE],
    timeoutMs: 15_000,
  });
  await source.append(
    { type: CROSS_POST_EVENT_TYPE, payload: { marker, repository: "acme/other" } },
    { type: CROSS_POST_EVENT_TYPE, payload: { marker, repository: "acme/widgets" } },
  );
  const copiedEvent = await copied;
  expect(copiedEvent.payload).toMatchObject({ repository: "acme/widgets" });

  // The non-matching event must never arrive, in any order relative to the
  // matching one — give in-flight deliveries a beat, then read the whole log.
  await new Promise((resolve) => setTimeout(resolve, 750));
  const targetEvents = await target.getEvents({ afterOffset: 0 });
  const copies = targetEvents.filter((event) => event.type === CROSS_POST_EVENT_TYPE);
  expect(copies.map((event) => event.payload?.repository)).toEqual(["acme/widgets"]);
});

test("cross-post subscriptions reject unparseable conditions before they commit", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/os-port/cross-post-bad-condition/source/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({
    slug: `os-stream-cross-post-bad-${RUN_SUFFIX}-${marker}`,
  });
  using source = project.streams.get(sourcePath);

  // crossPostTo is sugar over appending subscription-configured; an
  // uncompilable selector condition must fail the append, not become durable
  // desired state that errors on every later event.
  await expect(
    source.crossPostTo({
      path: `/e2e/os-port/cross-post-bad-condition/target/${marker}`,
      key: `bad-${marker}`,
      eventTypes: [CROSS_POST_EVENT_TYPE],
      condition: "payload.((((",
    }),
  ).rejects.toThrow();
});

test("cross-post chains accumulate provenance hops and removeCrossPost stops forwarding", async () => {
  const marker = crypto.randomUUID();
  const pathA = `/e2e/os-port/cross-post-chain/a/${marker}`;
  const pathB = `/e2e/os-port/cross-post-chain/b/${marker}`;
  const pathC = `/e2e/os-port/cross-post-chain/c/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({
    slug: `os-stream-cross-post-chain-${RUN_SUFFIX}-${marker}`,
  });
  using streamA = project.streams.get(pathA);
  using streamB = project.streams.get(pathB);
  using streamC = project.streams.get(pathC);

  await streamA.crossPostTo({
    path: pathB,
    key: `a-to-b-${marker}`,
    eventTypes: [CROSS_POST_EVENT_TYPE],
  });
  await streamB.crossPostTo({
    path: pathC,
    key: `b-to-c-${marker}`,
    eventTypes: [CROSS_POST_EVENT_TYPE],
  });

  const arrived = streamC.waitForEvent({
    afterOffset: 0,
    eventTypes: [CROSS_POST_EVENT_TYPE],
    timeoutMs: 15_000,
  });
  await streamA.append({ type: CROSS_POST_EVENT_TYPE, payload: { marker } });
  const chained = await arrived;

  // Two hops, oldest first: A's subscription copied A→B, then B's copied B→C.
  expect(chained.source?.crossPostedFrom?.map((hop) => hop.path)).toEqual([pathA, pathB]);
  expect(chained.source?.crossPostedFrom?.map((hop) => hop.subscriptionKey)).toEqual([
    `a-to-b-${marker}`,
    `b-to-c-${marker}`,
  ]);

  // Removing A's cross-post stops the chain at its first hop.
  await streamA.removeCrossPost({ key: `a-to-b-${marker}` });
  await streamA.append({ type: CROSS_POST_EVENT_TYPE, payload: { marker: `${marker}-after` } });
  await new Promise((resolve) => setTimeout(resolve, 750));
  const bEvents = await streamB.getEvents({ afterOffset: 0 });
  const bCopies = bEvents.filter((event) => event.type === CROSS_POST_EVENT_TYPE);
  expect(bCopies.map((event) => event.payload?.marker)).toEqual([marker]);
});

test("cross-posts do not recursively copy events that are already cross-posted", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/os-port/cross-post-loop/source/${marker}`;
  const targetPath = `/e2e/os-port/cross-post-loop/target/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({
    slug: `os-stream-cross-post-loop-${RUN_SUFFIX}-${marker}`,
  });
  using source = project.streams.get(sourcePath);
  using target = project.streams.get(targetPath);

  // Loop protection is structural: acceptCrossPost never appends an event whose
  // provenance chain already contains the receiving stream, so wiring two
  // streams at each other is safe.
  await Promise.all([
    source.crossPostTo({
      path: targetPath,
      key: `source-to-target-${marker}`,
      eventTypes: [CROSS_POST_EVENT_TYPE],
    }),
    target.crossPostTo({
      path: sourcePath,
      key: `target-to-source-${marker}`,
      eventTypes: [CROSS_POST_EVENT_TYPE],
    }),
  ]);

  const copied = target.waitForEvent({
    afterOffset: 0,
    eventTypes: [CROSS_POST_EVENT_TYPE],
    timeoutMs: 15_000,
  });
  await source.append({
    type: CROSS_POST_EVENT_TYPE,
    payload: { marker },
  });
  await copied;

  await new Promise((resolve) => setTimeout(resolve, 750));
  const sourceEvents = await source.getEvents({ afterOffset: 0 });
  const sourceCopies = sourceEvents.filter(
    (event) => event.type === CROSS_POST_EVENT_TYPE && event.source?.crossPostedFrom !== undefined,
  );
  expect(sourceCopies).toEqual([]);
});

test("global cross-posts stay in the global namespace — a project stream is unreachable", async () => {
  const marker = crypto.randomUUID();
  const globalPath = `/e2e/os-port/cross-post-global/source/${marker}`;
  const targetPath = `/e2e/os-port/cross-post-global/target/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({
    slug: `os-stream-cross-post-global-${RUN_SUFFIX}-${marker}`,
  });
  using globalSource = itx.streams.get(globalPath);
  using globalTarget = itx.streams.get(targetPath);
  using projectTarget = project.streams.get(targetPath);

  // A delivery expression evaluates against the source stream's OWN authority
  // root. For a global (projectId: null) stream that is the deployment root,
  // whose `streams` collection is the deployment-wide (projectId: null)
  // namespace — so `["streams", ["get", path], "acceptCrossPost"]` from a global source
  // can only ever name another GLOBAL stream. A project stream at the same
  // path is a different coordinate entirely: smuggling events across the
  // project boundary is unexpressible, not checked.
  await globalSource.crossPostTo({
    path: targetPath,
    key: `global-to-global-${marker}`,
    eventTypes: [CROSS_POST_EVENT_TYPE],
  });
  await globalSource.append({ type: CROSS_POST_EVENT_TYPE, payload: { marker } });

  // The copy lands on the GLOBAL stream at the target path, provenance
  // intact... (waitForCondition, not expect.poll: expect.poll loses the test
  // context on vitest retry in this lane and turns any first-attempt flake
  // into a hard "expect.poll() must be called inside a test" failure.)
  await waitForCondition(
    async () => {
      const events = await globalTarget.getEvents({ afterOffset: 0 });
      return events.some(
        (event) =>
          event.type === CROSS_POST_EVENT_TYPE && event.source?.crossPostedFrom !== undefined,
      );
    },
    { description: "cross-posted copy to land on the global target stream", timeoutMs: 15_000 },
  );

  // ...and the PROJECT stream at the same path never sees anything.
  const projectEvents = await projectTarget.getEvents({ afterOffset: 0 });
  expect(projectEvents.some((event) => event.type === CROSS_POST_EVENT_TYPE)).toBe(false);
});

test("crossPostTo transform reshapes the copied event and keeps the provenance chain intact", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/os-port/cross-post-transform/source/${marker}`;
  const targetPath = `/e2e/os-port/cross-post-transform/target/${marker}`;
  const subscriptionKey = `transform-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({
    slug: `os-stream-cross-post-xform-${RUN_SUFFIX}-${marker}`,
  });
  const projectDescription = await project.__describe();
  using source = project.streams.get(sourcePath);
  using target = project.streams.get(targetPath);

  // The transform is a JSONata expression CONSTRUCTING the copied event's
  // body ({type?, payload?, metadata?}) from the original event.
  await source.crossPostTo({
    path: targetPath,
    key: subscriptionKey,
    eventTypes: [CROSS_POST_EVENT_TYPE],
    transform: '{ "type": "e2e/summary", "payload": { "from": payload.original } }',
  });

  const copied = target.waitForEvent({
    afterOffset: 0,
    eventTypes: ["e2e/summary"],
    timeoutMs: 15_000,
  });
  const [sourceEvent] = await source.append({
    type: CROSS_POST_EVENT_TYPE,
    payload: { original: marker },
  });
  const copiedEvent = await copied;

  // The body is reshaped, but provenance is stamped AFTER the transform: the
  // chain still names the ORIGINAL event's type and source coordinate, and a
  // transform can never forge or drop it.
  expect(copiedEvent).toMatchObject({
    payload: { from: marker },
    source: {
      crossPostedFrom: [
        {
          subscriptionKey,
          createdAt: sourceEvent!.createdAt,
          offset: sourceEvent!.offset,
          path: sourcePath,
          projectId: projectDescription.projectId,
          type: CROSS_POST_EVENT_TYPE,
        },
      ],
    },
    type: "e2e/summary",
  });
});

function coreState(value: unknown): CoreStreamState {
  const state = value as Partial<CoreStreamState>;
  if (
    typeof state.eventCount !== "number" ||
    typeof state.maxOffset !== "number" ||
    typeof state.path !== "string" ||
    !("projectId" in state)
  ) {
    throw new Error(`Unexpected stream core state: ${JSON.stringify(value)}`);
  }
  return state as CoreStreamState;
}

function waitFor(
  predicate: () => boolean | Promise<boolean>,
  describe: () => string,
  timeoutMs = 10_000,
) {
  return waitForCondition(predicate, { description: describe, intervalMs: 100, timeoutMs });
}
