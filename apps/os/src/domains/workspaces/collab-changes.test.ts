import { describe, expect, test } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { attributedChanges } from "./collab-changes.ts";

const BASE = "alpha beta gamma";
const base = () => Text.of([BASE]);
const op = (
  clientId: string,
  spec: { from: number; insert?: string; to?: number },
  length: number,
) => ({
  changes: ChangeSet.of(
    { from: spec.from, insert: spec.insert ?? "", to: spec.to ?? spec.from },
    length,
  ).toJSON(),
  clientId,
});

describe("attributedChanges", () => {
  test("insertion → one attributed span in current coordinates", () => {
    const segments = attributedChanges(base(), [op("a", { from: 6, insert: "NEW " }, BASE.length)]);
    expect(segments).toEqual([{ clientId: "a", from: 6, kind: "inserted", to: 10 }]);
  });

  test("deletion of base text → marker carrying the deleted text", () => {
    const segments = attributedChanges(base(), [op("a", { from: 6, to: 11 }, BASE.length)]);
    expect(segments).toEqual([{ at: 6, clientId: "a", kind: "deleted", text: "beta " }]);
  });

  test("replace = deletion + insertion at one site", () => {
    const segments = attributedChanges(base(), [
      op("a", { from: 6, insert: "BETA", to: 10 }, BASE.length),
    ]);
    expect(segments).toEqual([
      { at: 6, clientId: "a", kind: "deleted", text: "beta" },
      { clientId: "a", from: 6, kind: "inserted", to: 10 },
    ]);
  });

  test("two authors: earlier spans map through later ops", () => {
    const segments = attributedChanges(base(), [
      op("a", { from: 16, insert: " delta" }, BASE.length), // at the end
      op("b", { from: 0, insert: "ZERO " }, BASE.length + 6), // shifts everything
    ]);
    expect(segments).toEqual([
      { clientId: "b", from: 0, kind: "inserted", to: 5 },
      { clientId: "a", from: 21, kind: "inserted", to: 27 },
    ]);
  });

  test("deleting your own fresh insertion cancels instead of double-reporting", () => {
    const segments = attributedChanges(base(), [
      op("a", { from: 0, insert: "OOPS " }, BASE.length),
      op("a", { from: 0, to: 5 }, BASE.length + 5),
    ]);
    expect(segments).toEqual([]);
  });

  test("deleting ANOTHER author's fresh text shrinks their span, no base deletion", () => {
    const segments = attributedChanges(base(), [
      op("a", { from: 0, insert: "FRESH " }, BASE.length),
      op("b", { from: 0, to: 6 }, BASE.length + 6),
    ]);
    expect(segments).toEqual([]);
  });

  test("a deletion spanning fresh AND base text reports only the base part", () => {
    const segments = attributedChanges(base(), [
      op("a", { from: 6, insert: "XX" }, BASE.length), // "alpha XXbeta gamma"
      op("b", { from: 6, to: 12 }, BASE.length + 2), // deletes "XXbeta"
    ]);
    expect(segments).toEqual([{ at: 6, clientId: "b", kind: "deleted", text: "beta" }]);
  });

  test("contiguous typing coalesces into one span per author", () => {
    let length = BASE.length;
    const ops = ["o", "n", "e"].map((char, index) =>
      op("a", { from: index, insert: char }, length++),
    );
    const segments = attributedChanges(base(), ops);
    expect(segments).toEqual([{ clientId: "a", from: 0, kind: "inserted", to: 3 }]);
  });

  test("typing INSIDE another author's fresh span splits it — no stolen text", () => {
    // A inserts AAAA at 0; B inserts BB strictly inside A's span.
    const segments = attributedChanges(base(), [
      op("a", { from: 0, insert: "AAAA" }, BASE.length),
      op("b", { from: 2, insert: "BB" }, BASE.length + 4),
    ]);
    expect(segments).toEqual([
      { clientId: "a", from: 0, kind: "inserted", to: 2 },
      { clientId: "b", from: 2, kind: "inserted", to: 4 },
      { clientId: "a", from: 4, kind: "inserted", to: 6 },
    ]);
  });

  test("empty op list → no segments", () => {
    expect(attributedChanges(base(), [])).toEqual([]);
  });
});
