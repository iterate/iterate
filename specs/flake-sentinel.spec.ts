import { flakeSentinel } from "@iterate-com/shared/test-support/flake-test";
import { test } from "./test-support/test.ts";

// The specs suite's sentinel: proves this suite's recorder -> artifact -> ingestion -> dashboard
// path (flakeSentinel has the rationale).
flakeSentinel(test, "flake sentinel (specs)");
