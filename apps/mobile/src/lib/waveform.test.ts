import { expect, test } from "vitest";
import { WAVEFORM_BAR_COUNT, waveformBars } from "./waveform.ts";

test("bars are deterministic per seed and differ across seeds", () => {
  const a = waveformBars("voice-1.m4a", WAVEFORM_BAR_COUNT);
  expect(a).toEqual(waveformBars("voice-1.m4a", WAVEFORM_BAR_COUNT));
  expect(a).not.toEqual(waveformBars("voice-2.m4a", WAVEFORM_BAR_COUNT));
  expect(a).toHaveLength(WAVEFORM_BAR_COUNT);
});

test("every bar is visible and within bounds, with real variation", () => {
  const bars = waveformBars("anything at all", 100);
  for (const bar of bars) {
    expect(bar).toBeGreaterThanOrEqual(0.15);
    expect(bar).toBeLessThanOrEqual(1);
  }
  expect(Math.max(...bars) - Math.min(...bars)).toBeGreaterThan(0.2);
});
