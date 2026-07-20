// The seeded guestbook processor (config-repo-template/apps/guestbook —
// src/guestbook.ts) driven by the REAL runner over an in-memory journal — the
// same `iterate/processors/testing` harness a project would use to test its
// own worker-hosted processors in plain node.
import { expect, test } from "vitest";
import { driveProcessor, eventsOfType, MemoryStream } from "iterate/processors/testing";
import {
  GuestbookProcessor,
  guestbookStreamPath,
} from "../../../config-repo-template/apps/guestbook/src/guestbook.ts";

function guestbookDriver(stream: MemoryStream) {
  return driveProcessor(
    new GuestbookProcessor({ path: stream.path, projectId: "proj_test", stream }),
    stream,
  );
}

async function sign(stream: MemoryStream, n: number) {
  await stream.append(
    {
      type: "events.iterate.com/guestbook/created",
      payload: { config: { title: "Guestbook" } },
      idempotencyKey: "guestbook/created",
    },
    {
      type: "events.iterate.com/guestbook/entry-signed",
      payload: { message: `hello ${n}`, name: `visitor ${n}` },
      idempotencyKey: `guestbook/entry:${n}`,
    },
  );
}

test("folds signatures and emits each milestone exactly once", async () => {
  const stream = new MemoryStream(guestbookStreamPath);
  const driver = guestbookDriver(stream);

  for (let n = 1; n <= 6; n++) await sign(stream, n);
  await driver.deliver();
  // The reconcile's emitted milestone lands at the journal head AFTER the
  // pass that decided it — the next delivery folds the processor's own
  // append (the consume-your-own-appends loop).
  await driver.deliver();

  expect(driver.state.birthCertificate).toEqual({ config: { title: "Guestbook" } });
  expect(driver.state.entries).toHaveLength(6);
  expect(driver.state.lastMilestone).toBe(5);
  expect(
    eventsOfType(stream, "events.iterate.com/guestbook/milestone-reached").map(
      (event) => event.payload,
    ),
  ).toEqual([{ count: 5 }]);

  // Redelivery of the same journal (the at-least-once contract) re-runs the
  // reconcile; the stable milestone key collapses it to the one fact.
  await driver.deliver();
  expect(eventsOfType(stream, "events.iterate.com/guestbook/milestone-reached")).toHaveLength(1);
});

test("a catch-up past several thresholds journals every crossed milestone", async () => {
  const stream = new MemoryStream(guestbookStreamPath);
  const driver = guestbookDriver(stream);

  // All twelve entries land before the processor's first at-head pass — the
  // cold-build shape. Both crossings must be journaled, in order.
  for (let n = 1; n <= 12; n++) await sign(stream, n);
  await driver.deliver();
  await driver.deliver();

  expect(
    eventsOfType(stream, "events.iterate.com/guestbook/milestone-reached").map(
      (event) => event.payload,
    ),
  ).toEqual([{ count: 5 }, { count: 10 }]);
  expect(driver.state.lastMilestone).toBe(10);
});

test("refold: a fresh processor over the same journal appends nothing and converges", async () => {
  const stream = new MemoryStream(guestbookStreamPath);
  const live = guestbookDriver(stream);
  for (let n = 1; n <= 5; n++) await sign(stream, n);
  await live.deliver();
  await live.deliver(); // fold the emitted milestone (see the first test)
  const journaled = stream.events.length;

  const refold = guestbookDriver(stream);
  await refold.deliver();

  expect(stream.events).toHaveLength(journaled);
  expect(refold.state).toEqual(live.state);
});

test("a second, differently-keyed birth is a corrupt journal and throws", async () => {
  const stream = new MemoryStream(guestbookStreamPath);
  const driver = guestbookDriver(stream);
  await sign(stream, 1);
  await stream.append({
    type: "events.iterate.com/guestbook/created",
    payload: { config: { title: "Impostor" } },
    idempotencyKey: "guestbook/created-again",
  });

  await expect(driver.deliver()).rejects.toThrow(/more than one created event/);
});
