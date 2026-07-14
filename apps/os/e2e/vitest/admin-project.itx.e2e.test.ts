/**
 * Deployment-targeted test for disposable admin projects driven through itx:
 * the admin handle creates a throwaway project and exercises project streams
 * (append/getEvents/subscribe) the same way the dashboard, REPL, and CLI reach
 * them on itx.
 */
import { test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";
import { appendEvents } from "../test-support/append-events.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import type { StreamEvent } from "../../src/domains/streams/schemas.ts";

test("creates a disposable project and uses project streams through itx", async ({ expect }) => {
  await using handle = await createTestProject({ slugPrefix: "admin-fixture" });
  using itx = handle.itx();

  const streamPath = `/e2e/admin-project/${crypto.randomUUID()}`;
  const eventType = "events.iterate.com/os/e2e-admin-stream-proof";
  const marker = crypto.randomUUID();
  const stream = itx.streams.get(streamPath);

  // The one subscription primitive replays history and tails live appends.
  const seen: StreamEvent[] = [];
  const subscription = await stream.subscribe({
    replayAfterOffset: 0,
    processEventBatch: (batch) => {
      seen.push(...batch.events);
    },
  });

  // append creates the stream on first write and can project committed events.
  const [appended] = await appendEvents(stream, {
    type: eventType,
    payload: { marker },
  });
  expect(appended).toMatchObject({
    offset: expect.any(Number),
    type: eventType,
    payload: { marker },
  });

  const events = await stream.getEvents({});
  expect(events.map((event) => event.type)).toContain(eventType);
  expect(events.find((event) => event.type === eventType)?.payload).toMatchObject({ marker });

  // waitForCondition, not expect.poll: expect.poll loses the test context on
  // vitest retry in the CI-parallel lane and turns any first-attempt flake
  // into a hard "expect.poll() must be called inside a test" failure. The
  // timeouts keep expect.poll's 1s default deadline.
  await waitForCondition(
    () => seen.some((event) => event.type === eventType && event.payload?.marker === marker),
    { description: "the subscription to deliver the appended event", timeoutMs: 1_000 },
  );

  subscription.unsubscribe();

  // The project processor folds the new stream into its reduced state.
  await waitForCondition(
    async () => {
      const snapshot = await itx.processor.snapshot();
      return snapshot.state.streams.some((item) => item.path === streamPath);
    },
    { description: "the project processor to fold the new stream into state", timeoutMs: 1_000 },
  );
});
