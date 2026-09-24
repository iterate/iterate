import { test } from "vitest";
import { flakeSentinel } from "./flake-test.ts";

// The unit suite's sentinel; flakeSentinel says what a sentinel proves and how to roll it.
flakeSentinel(test, "flake sentinel");
