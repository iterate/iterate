// itx stream subscriptions over Cap'n Web: the browser/Node reactivity seam.
// A callback crosses the session, the Stream DO pushes batches through the
// stateless worker, and the disposer tears the subscription down. This is
// the primitive the dashboard's live stream views are built on.

import { expect, test } from "vitest";
import { connectGlobal, registerCreatedProjectCleanup } from "./e2e-env.ts";
import { coreStateToStreamState } from "../../domains/streams/stream-runtime.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const PROJECT_SLUG = `itx-sub-e2e-${RUN_SUFFIX}`;
const STREAM_PATH = "/itx-e2e/subscribe";
const EVENT_TYPE = "events.iterate.test/itx/subscribe-e2e";

const createdProjectIds = registerCreatedProjectCleanup();

test("subscribe replays history, tails live appends, and unsubscribes", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: PROJECT_SLUG })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  const stream = projectItx.streams.get(STREAM_PATH);
  const before = `before-${RUN_SUFFIX}`;
  await stream.append({ event: { type: EVENT_TYPE, payload: { marker: before } } });

  // The callback lives in THIS Node process; batches are pushed to it.
  const seen: { marker: string; offset: number }[] = [];
  const batchStates: { eventCount: number; namespace: string; path: string }[] = [];
  const subscription = await stream.subscribe({
    replayAfterOffset: 0,
    processEventBatch: (batch) => {
      batchStates.push(coreStateToStreamState(batch.state));
      for (const event of batch.events) {
        seen.push({
          marker: (event.payload as { marker?: string }).marker ?? "",
          offset: event.offset,
        });
      }
    },
  });

  const during = `during-${RUN_SUFFIX}`;
  await stream.append({ event: { type: EVENT_TYPE, payload: { marker: during } } });

  await waitFor(
    () => seen.some((e) => e.marker === before) && seen.some((e) => e.marker === during),
    `replay + live markers; saw ${JSON.stringify(seen)}`,
  );

  // Offsets are strictly ordered and dedupe-able — what the multiplexer
  // relies on to merge history reads with replayed batches.
  const offsets = seen.map((e) => e.offset);
  expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);

  // Every batch carries the stream's public state (the getState shape):
  // the one subscription primitive serves events AND reduced state.
  expect(batchStates.length).toBeGreaterThanOrEqual(1);
  for (const state of batchStates) {
    expect(state.namespace).toBe(project.id);
    expect(state.path).toBe(STREAM_PATH);
  }
  expect(batchStates.at(-1)!.eventCount).toBeGreaterThanOrEqual(Math.max(...offsets));

  await subscription.unsubscribe();
  const countAtUnsubscribe = seen.length;
  await stream.append({ event: { type: EVENT_TYPE, payload: { marker: `after-${RUN_SUFFIX}` } } });
  // No delivery should arrive after unsubscribe; give a misbehaving
  // subscription a moment to prove us wrong.
  await new Promise((resolve) => setTimeout(resolve, 750));
  expect(seen.length).toBe(countAtUnsubscribe);
});

test("onStateChange pushes initial state immediately, then state after appends", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-state` })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  const stream = projectItx.streams.get(STREAM_PATH);
  await stream.append({ event: { type: EVENT_TYPE, payload: { marker: `seed-${RUN_SUFFIX}` } } });

  const states: { eventCount: number; namespace: string; path: string }[] = [];
  const subscription = await stream.subscribe({
    events: false,
    processEventBatch: (batch) => {
      states.push(coreStateToStreamState(batch.state));
    },
  });

  // The initial push: state arrives with NO post-subscribe append, so the
  // first render needs no separate getState call.
  await waitFor(() => states.length >= 1, "initial state push");
  expect(states[0]!.namespace).toBe(project.id);
  expect(states[0]!.path).toBe(STREAM_PATH);
  const initialEventCount = states[0]!.eventCount;
  expect(initialEventCount).toBeGreaterThanOrEqual(3); // created + woken + seed

  await stream.append({ event: { type: EVENT_TYPE, payload: { marker: `bump-${RUN_SUFFIX}` } } });
  await waitFor(
    () => (states.at(-1)?.eventCount ?? 0) > initialEventCount,
    `a state delivery after the append; saw ${JSON.stringify(states)}`,
  );

  await subscription.unsubscribe();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
