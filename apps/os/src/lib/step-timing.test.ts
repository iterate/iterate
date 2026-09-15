import { expect, test } from "vitest";
import { activeSpans, recordedSpans } from "../test/cloudflare-workers-shim.ts";
import { timedStep } from "./step-timing.ts";

test("creation steps keep their span open across asynchronous work and identify the project", async () => {
  const result = await timedStep(
    "create-timing",
    { projectId: "prj_creation" },
    "artifact-seed",
    async () => {
      await Promise.resolve();
      expect([...activeSpans]).toContainEqual({
        name: "create-timing.artifact-seed",
        attributes: { "iterate.projectId": "prj_creation", "iterate.step": "artifact-seed" },
      });
      return { commit: "seed-commit" };
    },
  );

  expect(result).toEqual({ commit: "seed-commit" });
  expect(recordedSpans.at(-1)).toMatchObject({
    name: "create-timing.artifact-seed",
    attributes: { "iterate.projectId": "prj_creation", "iterate.outcome": "ok" },
  });
  expect(activeSpans.size).toBe(0);
});

test("a failed step closes its span and preserves the original failure", async () => {
  const failure = new Error("artifact service unavailable");
  await expect(
    timedStep("create-timing", { projectId: "prj_failed" }, "artifact-import", async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);

  expect(recordedSpans.at(-1)).toMatchObject({
    name: "create-timing.artifact-import",
    attributes: { "iterate.projectId": "prj_failed", "iterate.outcome": "error" },
  });
  expect(activeSpans.size).toBe(0);
});
