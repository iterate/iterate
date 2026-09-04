import { createFlake } from "@iterate-com/shared/test-support/flake-test";
import { test } from "./test-support/test.ts";

const flake = createFlake(test, /monthly flake sentinel/);

// The specs suite's deliberately flaky test: proves this suite's
// recorder -> artifact -> ingestion -> dashboard path monthly (see the unit
// sentinel in packages/shared for the full rationale). When the month ends
// and the unwrap proposal fires, roll it forward — don't merge the unwrap.
flake("flake sentinel (specs)", async () => {
  const monthEnd = new Date("2026-10-01");
  if (new Date() < monthEnd && Math.random() < 0.1) {
    throw new Error("hello I am September's monthly flake sentinel (specs)");
  }
});
