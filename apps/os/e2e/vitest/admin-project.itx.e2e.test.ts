/**
 * Deployment-targeted test for disposable admin projects driven through itx.
 * Replaces the oRPC original preserved as admin-project.orpc-legacy.ts: the
 * admin handle has access "all", so it creates a throwaway project and exercises
 * project streams (create/append/read/subscribe) the same way the dashboard,
 * REPL, and CLI reach them.
 */
import { expect, test } from "vitest";
import type { Event } from "@iterate-com/shared/streams/types";
import { createTestProject } from "../test-support/create-test-project.ts";

test("creates a disposable project and uses project streams through itx", async () => {
  await using handle = await createTestProject({ slugPrefix: "admin-fixture" });
  using itx = handle.itx();

  const streamPath = `/e2e/admin-project/${crypto.randomUUID()}`;
  const eventType = "events.iterate.com/os/e2e-admin-stream-proof";
  const marker = crypto.randomUUID();
  const stream = itx.streams.get(streamPath);

  // Creating the stream proves the disposable project exists and is reachable
  // on this admin handle; the namespace is the project id.
  const created = (await itx.streams.create({ streamPath })) as { namespace: string; path: string };
  expect(created).toMatchObject({
    namespace: handle.project.id,
    path: streamPath,
  });

  // The one subscription primitive replays history and tails live appends.
  const seen: Event[] = [];
  const subscription = await stream.subscribe((batch) => seen.push(...batch.events), {
    afterOffset: "start",
  });

  // append returns the bare appended Event (offset, createdAt, …) — the Stream
  // DO's append result, unwrapped (oRPC added an { event } envelope; itx does
  // not). The cast is only needed because capnweb's stub-type mapper projects
  // the branded Event type down to a lossy record at the callsite.
  const appended = (await stream.append({
    type: eventType,
    payload: { marker },
  })) as unknown as Event;
  expect(appended).toMatchObject({
    offset: expect.any(Number),
    payload: { marker },
    type: eventType,
  });

  // read() likewise returns the Event[] directly (no { events } wrapper).
  const read = (await stream.read({ afterOffset: "start" })) as Event[];
  expect(read).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        offset: appended.offset,
        payload: { marker },
        type: eventType,
      }),
    ]),
  );

  await waitFor(
    () =>
      seen.some(
        (event) =>
          event.type === eventType && (event.payload as { marker?: unknown }).marker === marker,
      ),
    () => `stream subscription marker; saw ${JSON.stringify(seen)}`,
  );
  await subscription.unsubscribe();
});

async function waitFor(predicate: () => boolean, describe: () => string, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${describe()}`);
}
