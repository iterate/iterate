import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";

test("lint and autofix use shallow PR heads and prepare comparison before linting", () => {
  for (const name of ["lint-typecheck", "autofix"]) {
    const workflow = parse(
      readFileSync(resolve(import.meta.dirname, `../../.depot/workflows/${name}.yml`), "utf8"),
    );
    const steps = workflow.jobs[name].steps;
    expect(steps.find((step: any) => step.uses === "actions/checkout@v4")).toMatchObject({
      with: {
        "fetch-depth": "${{ github.event_name == 'pull_request' && 1 || 0 }}",
        ref: "${{ github.event.pull_request.head.sha || github.sha }}",
      },
    });
    const prepare = steps.findIndex(
      (step: any) => step.run === "pnpm tsx scripts/ci/prepare-pr-lint.ts",
    );
    expect(steps[prepare]).toMatchObject({
      if: "github.event_name == 'pull_request'",
      env: { GITHUB_TOKEN: "${{ github.token }}" },
    });
    const lint = steps.findIndex((step: any) => JSON.stringify(step).includes("pnpm exec oxlint"));
    expect(prepare).toBeLessThan(lint);
  }
});
