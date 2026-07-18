import { expect, test } from "vitest";
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
  using project = itx.projects.create({ slug: `announce-birth-${marker}` });
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
});

test("a lost ancestor announcement heals on the stream's next wake", async () => {
  const marker = crypto.randomUUID();
  const childPath = `/announce-heal-${marker}/child`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `announce-heal-${marker}` });
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
    // Give the durable push attempt time to fail against the paused root before
    // resuming. Its source cursor must remain behind the request fact.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const lost = await root.getEvent({ idempotencyKey: announcementKey("/", childPath) });
    expect(lost).toBeUndefined();
  } finally {
    await root.append({ type: "events.iterate.com/stream/resumed", payload: {} });
  }

  // Next incarnation: the persisted subscription row and unacked request
  // redeliver. kill() proves the recovery does not live in the old isolate;
  // it aborts its own incarnation, so the RPC itself always rejects.
  await child.kill().catch(() => undefined);
  await child.getEvents({ limit: 1 });

  await waitForCondition(
    async () =>
      (await root.getEvent({ idempotencyKey: announcementKey("/", childPath) })) !== undefined,
    {
      description: `root child-stream-created announcement for ${childPath} after re-wake`,
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
//    connection stream and its chat stream — survives as an unacked durable
//    delivery and redelivers after the source stream itself is restarted.

const announcementKey = (ancestorPath: string, childPath: string) =>
  `child-stream-created:${ancestorPath}:${childPath}`;
