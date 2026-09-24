import { test } from "vitest";
import { flakeSentinel } from "@iterate-com/shared/test-support/flake-test";

// The preview e2e suite's sentinel: proves this suite's recorder -> artifact -> ingestion ->
// dashboard path (flakeSentinel has the rationale). Deliberately fixture-free: it measures the
// flake pipeline, not the deployment.
flakeSentinel(test, "flake sentinel (e2e)");
