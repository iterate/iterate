// OS stream e2e migration guards, ported to the v4 stream contract.
//
// These deliberately cover only deployment-style ITX/WebSocket behavior: project
// stream access, append/read, replay/live subscriptions, unsubscribe, and
// state-only subscription pushes. Unit and workerd-only stream regression tests
// stay out of this file.

import { expect, test } from "vitest";
import type { StreamEvent, StreamEventBatch } from "../../src/types.ts";
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
  const projectDescription = await project.describe();
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

  const read = await stream.getEvents({ afterOffset: 0 });
  expect(read).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        offset: appended!.offset,
        payload: { marker },
        type: STREAM_EVENT_TYPE,
      }),
    ]),
  );

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

test("stream subscribe replays history, tails live appends, and unsubscribes", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/os-port/subscribe/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `os-stream-subscribe-${RUN_SUFFIX}-${marker}` });
  const projectDescription = await project.describe();
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
  const projectDescription = await project.describe();
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

test("stream rules cross-post matching events with source provenance", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/os-port/cross-post/source/${marker}`;
  const targetPath = `/e2e/os-port/cross-post/target/${marker}`;
  const ruleId = `copy-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `os-stream-cross-post-${RUN_SUFFIX}-${marker}` });
  const projectDescription = await project.describe();
  using source = project.streams.get(sourcePath);
  using target = project.streams.get(targetPath);

  await source.append({
    type: "events.iterate.com/stream/rule-configured",
    payload: {
      eventTypes: [CROSS_POST_EVENT_TYPE],
      path: targetPath,
      ruleId,
      type: "cross-post",
    },
  });

  const copied = target.waitForEvent({
    afterOffset: 0,
    eventTypes: [CROSS_POST_EVENT_TYPE],
    timeoutMs: 10_000,
  });
  const [sourceEvent] = await source.append({
    type: CROSS_POST_EVENT_TYPE,
    payload: { marker },
  });
  const copiedEvent = await copied;

  expect(copiedEvent).toMatchObject({
    idempotencyKey: `cross-post:${ruleId}:${projectDescription.projectId}:${sourcePath}:${sourceEvent!.offset}`,
    payload: { marker },
    source: {
      crossPost: {
        ruleId,
        from: {
          createdAt: sourceEvent!.createdAt,
          offset: sourceEvent!.offset,
          path: sourcePath,
          projectId: projectDescription.projectId,
          type: CROSS_POST_EVENT_TYPE,
        },
      },
    },
    type: CROSS_POST_EVENT_TYPE,
  });
});

test("stream rules do not recursively cross-post events that are already cross-posted", async () => {
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

  await Promise.all([
    source.append({
      type: "events.iterate.com/stream/rule-configured",
      payload: {
        eventTypes: [CROSS_POST_EVENT_TYPE],
        path: targetPath,
        ruleId: `source-to-target-${marker}`,
        type: "cross-post",
      },
    }),
    target.append({
      type: "events.iterate.com/stream/rule-configured",
      payload: {
        eventTypes: [CROSS_POST_EVENT_TYPE],
        path: sourcePath,
        ruleId: `target-to-source-${marker}`,
        type: "cross-post",
      },
    }),
  ]);

  const copied = target.waitForEvent({
    afterOffset: 0,
    eventTypes: [CROSS_POST_EVENT_TYPE],
    timeoutMs: 10_000,
  });
  await source.append({
    type: CROSS_POST_EVENT_TYPE,
    payload: { marker },
  });
  await copied;

  await new Promise((resolve) => setTimeout(resolve, 750));
  const sourceEvents = await source.getEvents({ afterOffset: 0 });
  const sourceCopies = sourceEvents.filter(
    (event) => event.type === CROSS_POST_EVENT_TYPE && event.source?.crossPost !== undefined,
  );
  expect(sourceCopies).toEqual([]);
});

test("stream rules cannot cross-post project stream events into global streams", async () => {
  const marker = crypto.randomUUID();
  const sourcePath = `/e2e/os-port/cross-post-global/source/${marker}`;
  const globalPath = `/e2e/os-port/cross-post-global/target/${marker}`;
  const ruleId = `project-to-global-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({
    slug: `os-stream-cross-post-global-${RUN_SUFFIX}-${marker}`,
  });
  using source = project.streams.get(sourcePath);
  using globalTarget = itx.streams.get(globalPath);

  // A cross-post writes into the target stream using the source Stream DO's own
  // authority. A project-scoped stream must therefore NOT be able to configure a
  // rule targeting a global (projectId: null) stream: that would let any project
  // principal inject events into deployment-wide streams, which are otherwise
  // admin-only. The rule-configured append must be rejected before it commits.
  await expect(
    source.append({
      type: "events.iterate.com/stream/rule-configured",
      payload: {
        eventTypes: [CROSS_POST_EVENT_TYPE],
        path: globalPath,
        projectId: null,
        ruleId,
        type: "cross-post",
      },
    }),
  ).rejects.toThrow(/does not match stream projectId/);

  // Because the rule never committed, appending a matching event cross-posts
  // nothing to the global stream.
  await source.append({ type: CROSS_POST_EVENT_TYPE, payload: { marker } });
  await new Promise((resolve) => setTimeout(resolve, 750));

  const globalEvents = await globalTarget.getEvents({ afterOffset: 0 });
  expect(globalEvents.some((event) => event.type === CROSS_POST_EVENT_TYPE)).toBe(false);
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

function waitFor(predicate: () => boolean, describe: () => string, timeoutMs = 10_000) {
  return waitForCondition(predicate, { description: describe, intervalMs: 100, timeoutMs });
}
