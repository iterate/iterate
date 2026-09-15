import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { assertPreviewCiIdentity } from "./ci-identity.ts";
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
  const caller = parse(
    readFileSync(resolve(root, ".depot/workflows/cloudflare-previews.yml"), "utf8"),
  );
  const workflow = parse(
    readFileSync(resolve(root, ".depot/workflows/cloudflare-preview-sharded.yml"), "utf8"),
  );
  expect(caller.jobs.preview).toMatchObject({
    uses: "./.depot/workflows/cloudflare-preview-sharded.yml",
    concurrency: { "cancel-in-progress": false },
  });
  expect(workflow.jobs.playwright).toMatchObject({
    needs: "prepare",
    strategy: { "fail-fast": false, matrix: { shard: previewPlaywrightShards } },
  });
  expect(workflow.jobs.playwright.concurrency).toBeUndefined();
  expect(workflow.jobs.apps.needs).toBe("prepare");
  expect(workflow.jobs.finish).toMatchObject({
    needs: ["prepare", "apps", "playwright"],
    if: "always()",
  });
  expect(
    workflow.jobs.finish.steps.find((step: any) => step.name === "Erase slot data after all tests"),
  ).toMatchObject({ if: "always()" });
});
