import { expect, test } from "vitest";
import { MOSAIC_GAP, mosaicLayout } from "@iterate-com/ui/lib/mosaic-layout";

test("two landscape photos share one row at equal height", () => {
  const layout = mosaicLayout({ aspectRatios: [1.5, 1.5], maxWidth: 300 });
  expect(layout.rects[0]!.y).toBe(layout.rects[1]!.y);
  expect(layout.rects[0]!.height).toBeCloseTo(layout.rects[1]!.height);
  // Justified: the row fills the full width, gap included.
  expect(layout.rects[1]!.x + layout.rects[1]!.width).toBeCloseTo(300);
  expect(layout.width).toBeCloseTo(300);
});

test("four squares become a 2x2 grid, not a stack", () => {
  const layout = mosaicLayout({ aspectRatios: [1, 1, 1, 1], maxWidth: 300 });
  const rowYs = [...new Set(layout.rects.map((rect) => rect.y))];
  expect(rowYs).toHaveLength(2);
  expect(layout.rects.filter((rect) => rect.y === rowYs[0])).toHaveLength(2);
  expect(layout.rects.filter((rect) => rect.y === rowYs[1])).toHaveLength(2);
});

test("rows hold at most three photos", () => {
  const layout = mosaicLayout({
    aspectRatios: Array.from({ length: 7 }, () => 0.4),
    maxWidth: 300,
  });
  const byRow = new Map<number, number>();
  for (const rect of layout.rects) byRow.set(rect.y, (byRow.get(rect.y) || 0) + 1);
  expect(Math.max(...byRow.values())).toBeLessThanOrEqual(3);
  expect([...byRow.values()].reduce((a, b) => a + b, 0)).toBe(7);
});

test("a lone portrait is height-clamped instead of towering", () => {
  const layout = mosaicLayout({ aspectRatios: [0.5], maxWidth: 300 });
  expect(layout.rects[0]!.height).toBeLessThanOrEqual(320);
  expect(layout.height).toBe(layout.rects[0]!.height);
});

test("no rect ever overflows the container width", () => {
  for (const aspects of [[3, 3], [0.3, 0.3, 0.3, 2.5], [5], [1, 0.4, 2, 1, 1.7, 0.9]]) {
    const layout = mosaicLayout({ aspectRatios: aspects, maxWidth: 280 });
    for (const rect of layout.rects) {
      expect(rect.x + rect.width).toBeLessThanOrEqual(280 + 0.001);
    }
    expect(layout.height).toBeGreaterThan(0);
  }
});

test("garbage aspect ratios (0, NaN) are treated as squares", () => {
  const layout = mosaicLayout({ aspectRatios: [0, Number.NaN], maxWidth: 300 });
  expect(layout.rects[0]!.width).toBeCloseTo(layout.rects[0]!.height);
  expect(layout.rects[1]!.width).toBeCloseTo((300 - MOSAIC_GAP) / 2);
});
