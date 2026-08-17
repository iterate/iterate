import { expect, test } from "vitest";
import { createSyncPassTracker } from "./media-sync-core.ts";

test("stops after a run of consecutive knowns — a new item resets the run", () => {
  const tracker = createSyncPassTracker({ consecutiveKnownToStop: 3, maxNewPerPass: 100 });
  tracker.markKnown();
  tracker.markKnown();
  expect(tracker.shouldContinue()).toBe(true);
  tracker.markNew(); // resets the known run
  tracker.markKnown();
  tracker.markKnown();
  tracker.markKnown();
  expect(tracker.shouldContinue()).toBe(false);
  expect(tracker.summary()).toEqual({ processed: 1, stoppedOnKnownRun: true });
});

test("stops at the per-pass cap so a huge first sync stays a polite bite", () => {
  const tracker = createSyncPassTracker({ consecutiveKnownToStop: 10, maxNewPerPass: 2 });
  tracker.markNew();
  tracker.markNew();
  expect(tracker.shouldContinue()).toBe(false);
  expect(tracker.summary()).toEqual({ processed: 2, stoppedOnKnownRun: false });
});
