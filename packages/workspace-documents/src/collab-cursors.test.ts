import { describe, expect, test } from "vitest";
import { cursorDecorations } from "./collab-cursors.ts";

describe("remote cursor decorations", () => {
  test("keeps an overlapping peer cursor after an earlier selection's head", () => {
    const decorations = cursorDecorations(
      [
        { anchor: 0, at: 0, clientId: "u-alice-a1", head: 10 },
        { anchor: 5, at: 0, clientId: "u-bob-b2", head: 5 },
      ],
      "u-mine-c3",
      12,
    );
    const ranges: { from: number; to: number; widget: boolean }[] = [];
    decorations.between(0, 12, (from, to, value) => {
      ranges.push({ from, to, widget: value.spec.widget !== undefined });
    });

    expect(ranges.sort((left, right) => left.from - right.from || left.to - right.to)).toEqual([
      { from: 0, to: 10, widget: false },
      { from: 5, to: 5, widget: true },
      { from: 10, to: 10, widget: true },
    ]);
  });
});
