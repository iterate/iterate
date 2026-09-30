// cause.test.ts — a cause as the wire carries it; the guard it drives: test/vitest/os-workers/loop-guard.
import { expect, test } from "vitest";
import { causeHeader, causeOfDelivery, newChain, parseCause, storedCause } from "./cause.ts";

test("a chain begun from an origin of any length stays one a call and a mark carry", () => {
  const chain = newChain("x".repeat(10_000));
  expect(parseCause(chain)).toMatchObject(chain);
  expect(parseCause(causeHeader(chain))).toMatchObject(chain);
});

test("who a script runs for rides a call, never a mark, a stored event or a delivery's cause", () => {
  const cause = { chain: "c", depth: 1, onBehalfOf: "token.signature" };
  expect(parseCause(cause)).toMatchObject({ onBehalfOf: "token.signature" });
  expect(parseCause(JSON.stringify(cause))).not.toHaveProperty("onBehalfOf");
  expect(causeHeader({ ...cause, hops: 0 })).not.toContain("token");
  expect(storedCause(cause)).toEqual({ chain: "c", depth: 1 });
  expect(causeOfDelivery([{ source: { cause } }])).not.toHaveProperty("onBehalfOf");
});

test("a mark never keys writes, and a bad write key is dropped alone", () => {
  const cause = { chain: "c", depth: 3, writeKey: "row:/@1" };
  expect(parseCause(cause)).toEqual({ chain: "c", depth: 3, hops: 0, writeKey: "row:/@1" });
  expect(parseCause(JSON.stringify(cause))).toEqual({ chain: "c", depth: 3, hops: 0 });
  expect(parseCause({ ...cause, writeKey: 7 })).toEqual({ chain: "c", depth: 3, hops: 0 });
  expect(parseCause("not json")).toBeUndefined();
});

test("a chain is printable ASCII, so our mark is plain JSON on any header: one begun from other text keeps its shape, and a mark whose chain is not is forged, no mark", () => {
  expect(newChain("a request to élise.example").chain).toMatch(/^[\x20-\x7e]+$/);
  expect(parseCause('{"chain":"café","depth":0}')).toBeUndefined();
});

test("a mark whose hop count is not a whole number is no mark, so a forged count cannot defeat the hop budget", () => {
  for (const hops of ['"NaN"', "-1", "1.5", "1e400"])
    expect(parseCause(`{"chain":"c","depth":0,"hops":${hops}}`), hops).toBeUndefined();
});

test("code run for events runs one deeper with the deepest of them as its parent; for a call, with the call's own parent", () => {
  const event = (offset: number, depth?: number) => ({
    path: "/agents/a",
    offset,
    ...(depth !== undefined && { source: { cause: { chain: "c", depth, parent: "/@1" } } }),
  });
  expect(causeOfDelivery([event(4, 1), event(5, 3), event(6, 3)])).toEqual({
    chain: "c",
    depth: 4,
    parent: "/agents/a@5",
  });
  expect(causeOfDelivery([event(7)])).toMatchObject({ depth: 1, parent: "/agents/a@7" });
  expect(causeOfDelivery([{ source: { cause: { chain: "c", depth: 2, parent: "/@1" } } }])).toEqual(
    { chain: "c", depth: 3, parent: "/@1" },
  );
});

test("an event stores its chain, depth and parent, and a mark carries the parent when a header can", () => {
  const cause = { chain: "c", depth: 2, parent: "/x@4", hops: 3, writeKey: "row:/x@4" };
  expect(storedCause(cause)).toEqual({ chain: "c", depth: 2, parent: "/x@4" });
  expect(parseCause(causeHeader(cause))).toEqual({ chain: "c", depth: 2, parent: "/x@4", hops: 3 });
  expect(JSON.parse(causeHeader({ ...cause, parent: "/é@4" }))).not.toHaveProperty("parent");
  expect(parseCause({ chain: "c", depth: 0, parent: 7 })).toEqual({
    chain: "c",
    depth: 0,
    hops: 0,
  });
});
