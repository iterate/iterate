// cause.test.ts — a cause as the wire carries it: a chain id of any origin parses back, a mark (a
// header's text) never keys writes, and a malformed write key costs only itself.
import { expect, test } from "vitest";
import { causeHeader, newChain, parseCause } from "./cause.ts";

test("a chain begun from an origin of any length stays one a call and a mark carry", () => {
  const chain = newChain("x".repeat(10_000));
  expect(parseCause(chain)).toMatchObject(chain);
  expect(parseCause(causeHeader(chain))).toMatchObject(chain);
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
