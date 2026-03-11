import { describe } from "vitest";
import { test } from "../../test-support/e2e-test.ts";

describe("artifact harness", () => {
  test("records a passing test result", async ({ expect, e2e }) => {
    console.log(`[artifact-harness] passing test dir: ${e2e.outputDir}`);
    console.log(`[artifact-harness] passing output log: ${e2e.outputLogPath}`);
    console.log(`[artifact-harness] passing test slug: ${e2e.testSlug}`);
    console.log(`[artifact-harness] passing deployment slug: ${e2e.deploymentSlug}`);
    expect(e2e.outputDir).toContain("e2e-vitest-");
    expect(e2e.outputLogPath).toContain("vitest-output.log");
    expect(e2e.testSlug.length).toBeGreaterThan(0);
    expect(e2e.deploymentSlug).toMatch(/^\d{8}-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  test("records a failing test result", async ({ expect, e2e }) => {
    console.log(`[artifact-harness] failing test dir: ${e2e.outputDir}`);
    expect(e2e.outputDir).toContain("e2e-vitest-");
    expect("intentional failure").toBe("different");
  });
});
