import { expect, test } from "vitest";

import { answerMetrics } from "./compare.ts";

test("measures an answer from its first through last speaking frame, including interior silence", () => {
  const metrics = answerMetrics([
    { atMs: 0, payloadMs: 100, hasSignal: false }, // pre-answer/terminal controls are absent
    { atMs: 100, payloadMs: 100, hasSignal: true },
    { atMs: 350, payloadMs: 100, hasSignal: false },
    { atMs: 450, payloadMs: 100, hasSignal: true },
    { atMs: 2_000, payloadMs: 100, hasSignal: false },
  ]);

  expect(metrics).toMatchObject({
    firstNonzeroAtMs: 100,
    lastNonzeroAtMs: 450,
    audioMs: 300,
    frames: 3,
    interiorSilentFrames: 1,
    additionalStartupDelayMs: 150,
  });
  expect(metrics?.arrivalGapsMs).toMatchObject({ count: 2, max: 250 });
});
