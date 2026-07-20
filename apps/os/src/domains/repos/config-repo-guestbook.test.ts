// The seeded guestbook processor (config-repo-template/apps/guestbook —
// src/guestbook.ts) driven by the REAL runner over an in-memory stream — the
// same `iterate/processors/testing` step harness a project would use to test
// its own worker-hosted processors in plain node.
import { expect, test } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import {
  GuestbookProcessor,
  guestbookStreamPath,
  type GuestbookProcessorContract,
} from "../../../config-repo-template/apps/guestbook/src/guestbook.ts";

type GuestbookEventInput = ConsumedInput<GuestbookProcessorContract>;

// Event literals: the idempotency-keyed birth plus signature builders. These
// are event BUILDERS (data), not append wrappers — every test appends through
// the harness's typed append (or straight onto the stream for the cold-build
// shape).
const CREATED = {
  type: "events.iterate.com/guestbook/created",
  payload: { config: { title: "Guestbook" } },
  idempotencyKey: "guestbook/created",
} satisfies GuestbookEventInput;

function signed(n: number): GuestbookEventInput {
  return {
    type: "events.iterate.com/guestbook/entry-signed",
    payload: { message: `hello ${n}`, name: `visitor ${n}` },
    idempotencyKey: `guestbook/entry:${n}`,
  };
}

function entries(from: number, to: number): GuestbookEventInput[] {
  return Array.from({ length: to - from + 1 }, (_, i) => signed(from + i));
}

function makeGuestbookHarness(substrate?: HarnessSubstrate) {
  return makeProcessorHarness<GuestbookProcessorContract>({
    createProcessor: ({ stream, path, projectId }) =>
      new GuestbookProcessor({ stream, path, projectId }),
    path: guestbookStreamPath,
    substrate,
  });
}

test("reduces signatures and emits each milestone exactly once", async () => {
  const h = makeGuestbookHarness();
  await h.play(["append", CREATED, ...entries(1, 6)]);

  expect(h.state()).toMatchObject({
    birthCertificate: { config: { title: "Guestbook" } },
    lastMilestone: 5,
  });
  expect(h.state().entries).toHaveLength(6);
  expect(
    h.events("events.iterate.com/guestbook/milestone-reached").map((event) => event.payload),
  ).toEqual([{ count: 5 }]);

  // Another settle re-runs the at-head pass over the same state (the
  // at-least-once contract); the stable milestone key collapses it to the
  // one fact.
  await h.settle();
  expect(h.events("events.iterate.com/guestbook/milestone-reached")).toHaveLength(1);
});

test("a catch-up past several thresholds appends every crossed milestone", async () => {
  const h = makeGuestbookHarness();
  // All twelve entries land before the processor's first at-head pass — the
  // cold-build shape. Both crossings must land, in order.
  await h.stream.append(CREATED, ...entries(1, 12));
  await h.settle();

  expect(
    h.events("events.iterate.com/guestbook/milestone-reached").map((event) => event.payload),
  ).toEqual([{ count: 5 }, { count: 10 }]);
  expect(h.state().lastMilestone).toBe(10);
});

test("a milestone attempt lost to a crash is re-derived after revival", async () => {
  const h = makeGuestbookHarness();
  // The milestone append fails in the background (a transient stream outage),
  // and the incarnation dies owing it.
  h.stream.failAppendsOfType = "events.iterate.com/guestbook/milestone-reached";
  await h.play(["append", CREATED, ...entries(1, 5)]);
  expect(h.events("events.iterate.com/guestbook/milestone-reached")).toHaveLength(0);
  expect(h.state().lastMilestone).toBe(0);

  // The recovery keepalive appends the revival fact in a fresh incarnation;
  // its ordinary at-head delivery re-derives the milestone from state.
  h.stream.failAppendsOfType = undefined;
  await h.play(
    ["crash"],
    [
      "append",
      {
        type: "events.iterate.com/stream/processor-revived",
        payload: { processorSlug: "guestbook", revivals: 1, version: "test" },
      },
    ],
  );
  expect(
    h.events("events.iterate.com/guestbook/milestone-reached").map((event) => event.payload),
  ).toEqual([{ count: 5 }]);
  expect(h.state().lastMilestone).toBe(5);
});

test("replay: a fresh processor over the same stream appends nothing and converges", async () => {
  const h = makeGuestbookHarness();
  await h.play(["append", CREATED, ...entries(1, 5)]);
  const appended = h.events().length;

  // A fresh progress store over the same stream replays from offset zero —
  // the harshest at-least-once redelivery: every historical event re-runs.
  const replay = makeGuestbookHarness({ ...h.substrate, progress: makeMemoryProgressStore() });
  await replay.settle();

  expect(replay.events()).toHaveLength(appended);
  expect(replay.state()).toEqual(h.state());
});

test("a second, differently-keyed birth is a corrupt stream and throws", async () => {
  const h = makeGuestbookHarness();
  await h.play(["append", CREATED, signed(1)]);

  await expect(
    h.append({
      type: "events.iterate.com/guestbook/created",
      payload: { config: { title: "Impostor" } },
      idempotencyKey: "guestbook/created-again",
    }),
  ).rejects.toThrow(/more than one created event/);
});
