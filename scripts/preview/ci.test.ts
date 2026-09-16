import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { assertPreviewCiIdentity, readPreviewCiResults } from "./ci-identity.ts";
import {
  assertPlaywrightCapacity,
  previewPlaywrightShards,
} from "./playwright-capacity-reporter.ts";

test("distributed preview work refuses another head, run attempt, or slot", () => {
  const plan = { headSha: "candidate", runId: "run-1", runAttempt: "1", slot: "preview-2" };
  expect(() => assertPreviewCiIdentity(plan, { ...plan })).not.toThrow();
  for (const changed of [
    { headSha: "new-push" },
    { runId: "run-2" },
    { runAttempt: "2" },
    { slot: "preview-3" },
  ]) {
    expect(() => assertPreviewCiIdentity(plan, { ...plan, ...changed })).toThrow(
      /Preview CI identity mismatch/,
    );
  }
});

test("fixed capacity rejects catalogue growth and an overloaded individual shard", () => {
  expect(() => assertPlaywrightCapacity({ tests: 92, workers: 16, shard: null })).not.toThrow();
  expect(() => assertPlaywrightCapacity({ tests: 97, workers: 16, shard: null })).toThrow(
    /96 slots/,
  );
  expect(() =>
    assertPlaywrightCapacity({ tests: 16, workers: 16, shard: { current: 1, total: 6 } }),
  ).not.toThrow();
  expect(() =>
    assertPlaywrightCapacity({ tests: 17, workers: 16, shard: { current: 1, total: 6 } }),
  ).toThrow(/16 slots/);
  expect(() =>
    assertPlaywrightCapacity({ tests: 10, workers: 16, shard: { current: 1, total: 2 } }),
  ).toThrow(/six shards/);
});

test("the lifecycle owner encloses every fixed shard and cleanup waits for their completion", () => {
  const root = resolve(import.meta.dirname, "../..");
  const caller = parse(readFileSync(resolve(root, ".depot/workflows/preview.yml"), "utf8"));
  const workflow = parse(readFileSync(resolve(root, ".depot/workflows/preview-run.yml"), "utf8"));
  expect(caller.jobs.preview).toMatchObject({
    uses: "./.depot/workflows/preview-run.yml",
    concurrency: { "cancel-in-progress": false },
  });
  expect(workflow.jobs.playwright).toMatchObject({
    strategy: { "fail-fast": false, matrix: { shard: previewPlaywrightShards } },
  });
  expect(workflow.jobs.playwright.concurrency).toBeUndefined();
  expect(caller.on.pull_request.paths).toBeUndefined();
  expect(workflow.jobs.plan.steps[0].with["fetch-depth"]).toBe(0);
  for (const job of ["prepare", "apps", "playwright"]) {
    expect(workflow.jobs[job]).toMatchObject({
      needs: "plan",
      if: "needs.plan.outputs.tests == 'true'",
    });
  }
  expect(workflow.jobs.finish).toMatchObject({
    needs: ["plan", "prepare"],
    if: "always() && needs.plan.outputs.tests == 'true'",
  });
  expect(
    workflow.jobs.finish.steps
      .flatMap((step: any) => step.parallel || [])
      .find((step: any) => step.name === "Erase slot data after all tests"),
  ).toMatchObject({ if: "always() && steps.consumers.outputs.settled == 'true'" });
});

test("result collection retains failures and rejects missing or foreign shard receipts", async () => {
  const identity = { headSha: "candidate", runId: "run", runAttempt: "1", slot: "preview-2" };
  const directory = await mkdtemp(join(tmpdir(), "preview-receipts-"));
  try {
    const passed = { ...identity, key: "playwright-1", exitCode: 0, error: null, durationMs: 123 };
    await writeFile(join(directory, "playwright-1.json"), JSON.stringify(passed));
    expect(await readPreviewCiResults(identity, ["playwright-1"], directory)).toEqual({
      failures: [],
      durationMs: 123,
    });
    await writeFile(
      join(directory, "playwright-2.json"),
      JSON.stringify({ ...passed, key: "playwright-2", exitCode: 1, error: "browser crashed" }),
    );
    await writeFile(
      join(directory, "playwright-3.json"),
      JSON.stringify({ ...passed, key: "playwright-3", headSha: "other-commit" }),
    );
    const result = await readPreviewCiResults(
      identity,
      ["playwright-1", "playwright-2", "playwright-3", "playwright-4"],
      directory,
    );
    expect(result.failures).toEqual([
      "browser crashed",
      expect.stringContaining("identity mismatch"),
      expect.stringContaining("Missing or invalid playwright-4"),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
