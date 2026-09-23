import { test } from "vitest";
import { createFlake } from "@iterate-com/shared/test-support/flake-test";

const flake = createFlake(test, /monthly flake sentinel/);

// The preview e2e suite's deliberately flaky test: proves this suite's
// recorder -> artifact -> ingestion -> dashboard path monthly (see the unit
// sentinel in packages/shared for the full rationale). Deliberately
// fixture-free — it measures the flake pipeline, not the deployment.
flake("flake sentinel (e2e)", () => {
  const monthEnd = new Date("2026-10-01");
  if (new Date() < monthEnd && Math.random() < 0.1) {
    throw new Error("hello I am September's monthly flake sentinel (e2e)");
  }
});
