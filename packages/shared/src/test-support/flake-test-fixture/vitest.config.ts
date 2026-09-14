import { defineConfig } from "vitest/config";

// Config for the child vitest run spawned by flake-test.test.ts's integration
// test. The fixture is deliberately NOT named *.test.ts so the main suite
// never runs it — it contains an intentionally red case, and registering
// flake tests permanently in the main suite would clog the expected-fail
// metrics the flake dashboard depends on.
export default defineConfig({
  test: {
    include: ["**/*.vitest-target.ts"],
    environment: "node",
    // Mirrors the CI e2e suites' retry policy. The wrapper must pin per-test
    // retry to zero or every green outcome here would run (and record) twice
    // — the parent test asserts exactly one record per case.
    retry: { count: 1, delay: 10 },
  },
});
