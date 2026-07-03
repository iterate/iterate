// Processor reactivity over the real deployment transport: `onStateChange`
// pushes checkpoint snapshots into a live callback, and the returned handle's
// `ping()` is the liveness lever the dashboard's watchdog uses to detect
// silently dead subscriptions (DO restarts, replaced connections).

import { expect, test } from "vitest";
import type { ProcessorSnapshot, ProjectProcessorState } from "../../src/types.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const STREAM_EVENT_TYPE = "events.iterate.test/minimal-v4/processor-reactivity";

test("project processor pushes offset-carrying snapshots and the handle pings while live", async () => {
  const marker = crypto.randomUUID().slice(0, 8);

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `processor-reactivity-${RUN_SUFFIX}-${marker}` });
  await project.describe();

  const pushes: ProcessorSnapshot<ProjectProcessorState>[] = [];
  using subscription = await project.processor.onStateChange(
    (snapshot: ProcessorSnapshot<ProjectProcessorState>) => {
      pushes.push(snapshot);
    },
  );

  // The subscribe-time push: current state is the first paint.
  await waitForCondition(() => pushes.length >= 1, {
    description: "the initial onStateChange push",
  });
  expect(pushes[0]).toMatchObject({
    offset: expect.any(Number),
    state: expect.objectContaining({ createRequest: expect.anything() }),
  });

  // Bootstrap continues to fold; every state change arrives as a push, and
  // `created` flipping true is the lifecycle fact the dashboard waits on.
  await waitForCondition(() => pushes.some((push) => push.state.created), {
    description: () => `a push with created=true (got ${pushes.length} pushes)`,
    timeoutMs: 60_000,
  });

  // Offsets are monotonic — the client-side merge relies on this.
  const offsets = pushes.map((push) => push.offset);
  expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);

  // A new child stream changes project processor state (streams[]) → a push.
  const before = pushes.length;
  const streamPath = `/e2e/reactivity/${marker}`;
  using stream = project.streams.get(streamPath);
  await stream.append({ type: STREAM_EVENT_TYPE, payload: { marker } });
  await waitForCondition(
    () => pushes.length > before && pushes.at(-1)!.state.streams.some((s) => s.path === streamPath),
    { description: "a push reflecting the new child stream", timeoutMs: 30_000 },
  );

  // ping(): true while registered, false after unsubscribe — the watchdog's
  // re-subscribe signal.
  await expect(Promise.resolve(subscription.ping())).resolves.toBe(true);
  await subscription.unsubscribe();
  await expect(Promise.resolve(subscription.ping())).resolves.toBe(false);
});

test("a replaced stream subscription's old handle stops pinging true", async () => {
  const marker = crypto.randomUUID().slice(0, 8);

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({
    slug: `stream-ping-${RUN_SUFFIX}-${marker}`,
  });
  await project.describe();

  using stream = project.streams.get(`/e2e/stream-ping/${marker}`);
  const subscriptionKey = `e2e-ping-${marker}`;

  using first = await stream.subscribe({
    subscriptionKey,
    processEventBatch: () => {},
  });
  await expect(Promise.resolve(first.ping())).resolves.toBe(true);

  // Re-subscribing under the same key replaces the connection server-side —
  // exactly the shape of a silent server-side death from the first
  // subscriber's point of view. Its handle must stop answering true.
  using second = await stream.subscribe({
    subscriptionKey,
    processEventBatch: () => {},
  });
  await expect(Promise.resolve(second.ping())).resolves.toBe(true);
  await expect(Promise.resolve(first.ping())).resolves.toBe(false);

  await second.unsubscribe();
  await expect(Promise.resolve(second.ping())).resolves.toBe(false);
});
