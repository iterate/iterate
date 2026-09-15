import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { NATIVE_FILTER_SOURCE } from "./native-runtime.generated.ts";
import type { NativeFilterSettings } from "./native-engine.ts";

test("flashcards preload only the next three cards in the current deck and style", () => {
  const current: string[] = [];
  const ahead: string[] = [];
  let canvas = 2;
  const engine = runInNewContext(`${NATIVE_FILTER_SOURCE}; NativeFilters`, {
    Date: { now: () => 681 },
    drawing: {
      createCanvas: () => canvas++,
      resize() {},
      draw() {},
      image(_key: string, url: string) {
        current.push(url);
        return null;
      },
      prefetch(_key: string, url: string) {
        ahead.push(url);
      },
    },
  });
  const settings: NativeFilterSettings = {
    filterId: "flashcards",
    dynamicFilters: [],
    backgroundIndex: 0,
    modeIndex: 0,
    modeIndex2: 0,
    action: null,
    tap: null,
    drag: null,
    adjust: { featureScale: 1, faceScale: 1 },
    maskStretch: { eyes: { x: 1, y: 1 }, lips: { x: 1, y: 1 }, nose: { x: 1, y: 1 } },
  };
  const frame = { width: 320, height: 480, timeMs: 0, pitchHz: null, face: null };
  engine.configure(settings);
  engine.frame(frame);
  expect(current).toHaveLength(1);
  expect(ahead).toHaveLength(2); // The third upcoming card is a drawn colour swatch.
  const nextCards = [...ahead];
  const cartoonCard = current[0];

  const visited: string[] = [];
  for (let step = 1; step <= 3; step++) {
    current.length = 0;
    ahead.length = 0;
    engine.configure({ ...settings, backgroundIndex: step });
    engine.frame(frame);
    visited.push(...current);
    expect(ahead.length).toBeLessThanOrEqual(3);
  }

  expect(visited).toEqual(nextCards);

  current.length = 0;
  ahead.length = 0;
  engine.configure({ ...settings, modeIndex: 1 });
  engine.frame(frame);
  expect(current).toHaveLength(1);
  expect(current[0]).not.toBe(cartoonCard);
  expect(ahead).toHaveLength(2); // The third upcoming card is a drawn colour swatch.
  expect(ahead.some((url) => nextCards.includes(url))).toBe(false);
});
