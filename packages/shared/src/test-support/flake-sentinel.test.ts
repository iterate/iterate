import { test } from "vitest";
import { createFlake } from "./flake-test.ts";

const flake = createFlake(test, /monthly flake sentinel/);

// A deliberately flaky test that validates the flake-tracking pipeline
// end-to-end. Until the month below ends it throws the allowed error ~10% of
// the time, so the dashboard should show a flake rate near 10% — if it shows
// 0% or the test ever goes red, the flake infrastructure itself is broken.
// When the month ends the sentinel passes every run; the unwrap automation
// should then propose removing the wrapper. Don't merge that proposal — roll
// the sentinel forward to the next month instead. That monthly cycle
// exercises detection, recording, and the lifecycle automation in turn.
flake("flake sentinel", () => {
  const monthEnd = new Date("2026-10-01");
  if (new Date() < monthEnd && Math.random() < 0.1) {
    throw new Error("hello I am September's monthly flake sentinel");
  }
});
