import { expect, test } from "vitest";
import { internalStreamId } from "../../src/domains/streams/stream-delivery-utils.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test("a newborn stream announces itself to every ancestor", async () => {
  const marker = crypto.randomUUID();
  const childPath = `/announce-birth-${marker}/child`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(`announce-birth-${marker}`).create({});
  using root = project.streams.get("/");
  using parent = project.streams.get(`/announce-birth-${marker}`);
  using child = project.streams.get(childPath);

  await child.append({
    type: "events.iterate.test/announce-probe",
    payload: { marker },
  });

  await waitForCondition(
    async () =>
      (await root.getEvent({ idempotencyKey: announcementKey("/", childPath) })) !== undefined &&
      (await parent.getEvent({
        idempotencyKey: announcementKey(`/announce-birth-${marker}`, childPath),
      })) !== undefined,
    {
      description: `child-stream-created announcements for ${childPath} on / and its parent`,
      timeoutMs: 10_000,
    },
  );
  const onRoot = await root.getEvent({ idempotencyKey: announcementKey("/", childPath) });
  expect(onRoot?.payload).toEqual({ childPath });
  await expect(
    root.append({
      type: "events.iterate.test/cannot-impersonate-child-announcement",
      idempotencyKey: announcementKey("/", childPath),
    }),
  ).rejects.toThrow(/iterate-internal idempotency keys are platform-authored/);
});

test("a failed ancestor announcement retries on the child stream's next append", async () => {
  const marker = crypto.randomUUID();
  const childPath = `/announce-heal-${marker}/child`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(`announce-heal-${marker}`).create({});
  using root = project.streams.get("/");
  using child = project.streams.get(childPath);

  // Simulate the lost announcement through public verbs: a paused root
  // rejects `child-stream-created`, so the birth announcement fails exactly
  // like one dropped by an isolate death — and the birth itself must still
  // succeed (a sick ancestor must never brick a newborn).
  await root.append({
    type: "events.iterate.com/stream/paused",
    payload: { reason: `announce-heal e2e ${marker}` },
  });
  try {
    await child.append({
      type: "events.iterate.test/announce-probe",
      payload: { marker },
    });
    // Give the (background) birth announcement time to fail against the
    // paused root before resuming; the heal below must come from the re-wake,
    // not from a slow first attempt landing after the resume.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const lost = await root.getEvent({ idempotencyKey: announcementKey("/", childPath) });
    expect(lost).toBeUndefined();
  } finally {
    await root.append({ type: "events.iterate.com/stream/resumed", payload: {} });
  }

  // The first failed background call must not mark this incarnation as done.
  // Another ordinary append re-runs the level check and retries the same
  // idempotent announcement; an eviction is not required for repair.
  await child.append({
    type: "events.iterate.test/announce-retry-probe",
    payload: { marker },
  });

  await waitForCondition(
    async () =>
      (await root.getEvent({ idempotencyKey: announcementKey("/", childPath) })) !== undefined,
    {
      description: `root child-stream-created announcement for ${childPath} after another append`,
      timeoutMs: 10_000,
    },
  );
  const healed = await root.getEvent({ idempotencyKey: announcementKey("/", childPath) });
  expect(healed?.payload).toEqual({ childPath });
});

// Ancestor announcements are load-bearing platform state: integration listing
// walks childPaths, and the project processor's birth reactions (mechanics,
// agent policy) trigger on the root's `child-stream-created` fold. These tests
// pin the two guarantees that keep a newborn stream from being orphaned:
//
// 1. A newborn stream announces itself to EVERY ancestor, root included.
// 2. An announcement lost in flight — the 2026-07-09 prd incident: a deploy
//    rollover recycled the isolate mid birth turn, orphaning a Telegram
//    connection stream and its chat stream — remains owed and retries on the
//    next append (and also on a fresh incarnation's `woken` append).

const announcementKey = (ancestorPath: string, childPath: string) =>
  internalStreamId("child-stream-created", ancestorPath, childPath);
