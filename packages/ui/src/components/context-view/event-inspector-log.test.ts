// The inspector's pure halves: the inspected offset's place in a sparse log, the gaps between
// events, and the raw event's key order.
import { expect, test } from "vitest";
import { elapsedBetween, inspectedPlace, orderEventKeys } from "./event-inspector-log.ts";
import type { ContextViewEvent } from "./types.tsx";

// offsets 3, 4, 7, 9: 5, 6 and 8 were ephemeral
const log = [3, 4, 7, 9].map((offset): ContextViewEvent => ({
  offset,
  type: "t",
  createdAt: "2026-09-25T00:00:00.000Z",
}));

test.for([
  [3, { event: 3, previous: undefined, next: 4, missing: undefined }],
  [4, { event: 4, previous: 3, next: 7, missing: undefined }],
  [9, { event: 9, previous: 7, next: undefined, missing: undefined }],
  [5, { event: undefined, previous: 4, next: 7, missing: "gap" }],
  [1, { event: undefined, previous: undefined, next: 3, missing: "below" }],
  [12, { event: undefined, previous: 9, next: undefined, missing: "above" }],
] as const)("offset %i in a sparse log", ([offset, expected]) => {
  expect(offsets(inspectedPlace(log, offset))).toEqual(expected);
});

test("an empty log has nothing either side", () => {
  expect(offsets(inspectedPlace([], 4))).toEqual({
    event: undefined,
    previous: undefined,
    next: undefined,
    missing: "above",
  });
});

test.for([
  [0, "+0ms"],
  [950, "+950ms"],
  [3_249, "+3.2s"],
  [5_000, "+5s"],
  [100_000, "+1m40s"],
  [7_500_000, "+2h5m"],
  [-20, "+0ms"],
] as const)("%i ms reads %s", ([ms, expected]) => {
  const from = "2026-09-25T00:00:00.000Z";
  expect(elapsedBetween(from, new Date(Date.parse(from) + ms).toISOString())).toBe(expected);
});

test("an unparseable time has no gap", () => {
  expect(elapsedBetween("never", "2026-09-25T00:00:00.000Z")).toBeUndefined();
});

test("the raw event reads type and payload first, the envelope after, the rest last", () => {
  const event = {
    path: "/demo/one",
    source: { grant: "g" },
    offset: 15,
    createdAt: "2026-09-25T00:00:00.000Z",
    payload: { n: 1 },
    type: "manual/first-added",
  } as ContextViewEvent;
  expect(Object.keys(orderEventKeys(event))).toEqual([
    "type",
    "payload",
    "offset",
    "createdAt",
    "path",
    "source",
  ]);
});

function offsets(place: ReturnType<typeof inspectedPlace>) {
  return {
    event: place.event?.offset,
    previous: place.previous?.offset,
    next: place.next?.offset,
    missing: place.missing,
  };
}
