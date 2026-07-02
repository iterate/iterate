/**
 * Deployment-targeted test for disposable admin projects driven through itx:
 * the admin handle creates a throwaway project and exercises project streams
 * (append/getEvents/subscribe) the same way the dashboard, REPL, and CLI reach
 * them on the next engine.
 */
import { expect, test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";
import type { StreamEvent } from "~/types.ts";

test("creates a disposable project and uses project streams through itx", async () => {
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

  // append creates the stream on first write and returns the committed events.
  const [appended] = await stream.append({
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

  await expect
    .poll(() => seen.some((event) => event.type === eventType && event.payload?.marker === marker))
    .toBe(true);

  subscription.unsubscribe();

  // The project processor folds the new stream into its reduced state.
  await expect
    .poll(async () => {
      const snapshot = await itx.processor.snapshot();
      return snapshot.state.streams.some((item) => item.path === streamPath);
    })
    .toBe(true);
});
