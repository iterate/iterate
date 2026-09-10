import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";

test("lint and autofix use shallow PR heads and pass credentials directly to lint", () => {
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
    const lint = steps
      .flatMap((step: any) => step.parallel || [step])
      .find((step: any) => step.run?.startsWith("pnpm exec oxlint"));
    expect(lint).toMatchObject({ env: { GH_TOKEN: "${{ github.token }}" } });
    expect(JSON.stringify(steps)).not.toContain("prepare-pr-lint");
  }
});
