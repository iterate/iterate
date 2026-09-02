// stream/events.test.ts — `sameIdempotentEvent`, the retry-equality contract behind idempotency
// keys: same key + same body → the existing event comes back; a different body is a CONFLICT. The
// body is type + payload + metadata, compared with a key-order-insensitive deep-equal (the JSON
// equality apps/os's processors rely on), so a re-serialized retry is the same event.
import { expect, test } from "vitest";
import { sameIdempotentEvent } from "./events.ts";

test("payload key ORDER is insignificant — a reordered retry is the same event", () => {
  expect(
    sameIdempotentEvent(
      { type: "j", payload: { a: 1, b: { c: 2, d: 3 } } },
      { type: "j", payload: { b: { d: 3, c: 2 }, a: 1 } },
    ),
  ).toBe(true);
});

test("differing metadata makes it a DIFFERENT event (conflict, not dedupe)", () => {
  expect(
    sameIdempotentEvent(
      { type: "j", payload: { x: 1 }, metadata: { trace: "a" } },
      { type: "j", payload: { x: 1 }, metadata: { trace: "b" } },
    ),
  ).toBe(false);
});

test("metadata present on only one side is a DIFFERENT event", () => {
  expect(
    sameIdempotentEvent(
      { type: "j", payload: { x: 1 }, metadata: { trace: "a" } },
      { type: "j", payload: { x: 1 } },
    ),
  ).toBe(false);
});
