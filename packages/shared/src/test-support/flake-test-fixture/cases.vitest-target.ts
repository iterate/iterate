import { test } from "vitest";
import { createFailing } from "../failing-test.ts";
import { createFlake } from "../flake-test.ts";

// Run only by the child vitest spawned from flake-test.test.ts — see
// vitest.config.ts next to this file. One case per outcome the wrapper must
// produce through vitest's REAL expected-fail machinery.
const flake = createFlake(test, /the dice came up bad/);

flake("matched flake failure is green", () => {
  throw new Error("boom: the dice came up bad this run");
});

flake("a pass is green", () => {});

flake("an unexpected error is red", () => {
  throw new Error("ECONNREFUSED: the infra broke");
});

// createFailing through the same real machinery: the pinned error keeps the
// expected-fail verdict green (and records a kind-failing line).
const fail = createFailing(test, /foo bar exploded/);
fail("a pinned failure is green (createFailing)", () => {
  throw new Error("boom: foo bar exploded (as pinned)");
});
