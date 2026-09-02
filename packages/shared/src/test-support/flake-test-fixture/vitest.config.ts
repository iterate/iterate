import { defineConfig } from "vitest/config";

// Config for the child vitest run spawned by flake-test.test.ts's integration
// test. The fixture is deliberately NOT named *.test.ts so the main suite
// never runs it — it contains an intentionally red case, and registering
// flake tests permanently in the main suite would clog the expected-fail
// metrics the flake dashboard depends on.
export default defineConfig({
  test: { include: ["**/*.vitest-target.ts"], environment: "node" },
});
