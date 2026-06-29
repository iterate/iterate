// OS stream e2e migration guards, ported to the v4 stream contract.
//
// These deliberately cover only deployment-style ITX/WebSocket behavior: project
// stream access, append/read, replay/live subscriptions, unsubscribe, and
// state-only subscription pushes. Unit and workerd-only stream regression tests
// stay out of this file.

import { expect, test } from "vitest";
import { TRUSTED_INTERNAL_ITX_TOKEN } from "./src/auth.ts";
import type { StreamEvent, StreamEventBatch } from "./src/domains/streams/types.ts";
import { withItxSession } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const STREAM_EVENT_TYPE = "events.iterate.test/minimal-v4/stream-e2e";

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
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  });
  using project = itx.projects.create({ slug: `os-stream-smoke-${RUN_SUFFIX}-${marker}` });
  const projectDescription = await project.describe();
  using stream = project.streams.get(streamPath);

  const seen: StreamEvent[] = [];
  const subscription = await stream.subscribe({
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
  (subscription as Partial<Disposable>)[Symbol.dispose]?.();
});

test("stream subscribe replays history, tails live appends, and unsubscribes", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/os-port/subscribe/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  });
  using project = itx.projects.create({ slug: `os-stream-subscribe-${RUN_SUFFIX}-${marker}` });
  const projectDescription = await project.describe();
  using stream = project.streams.get(streamPath);

  const before = `before-${marker}`;
  await stream.append({ type: STREAM_EVENT_TYPE, payload: { marker: before } });

  const seen: { marker: string; offset: number }[] = [];
  const batchStates: CoreStreamState[] = [];
  const subscription = await stream.subscribe({
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
  (subscription as Partial<Disposable>)[Symbol.dispose]?.();
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
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  });
  using project = itx.projects.create({ slug: `os-stream-state-${RUN_SUFFIX}-${marker}` });
  const projectDescription = await project.describe();
  using stream = project.streams.get(streamPath);

  await stream.append({ type: STREAM_EVENT_TYPE, payload: { marker: `seed-${marker}` } });

  const states: CoreStreamState[] = [];
  const subscription = await stream.subscribe({
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
  (subscription as Partial<Disposable>)[Symbol.dispose]?.();
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

async function waitFor(predicate: () => boolean, describe: () => string, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${describe()}`);
}
