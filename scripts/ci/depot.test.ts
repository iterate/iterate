// depot.test.ts — the state a job hands its next run: which run's artifact `newestArtifactFile`
// reads. Depot's API client itself is packages/shared/src/depot-api.test.ts's.
import { expect, test } from "vitest";
import { fakeDepot } from "../monitors/fake-depot.ts";
import { newestArtifactFile } from "./depot.ts";

const state = { workflow: "Health", artifact: "health-state", file: "state.json" };

test.for<{
  name: string;
  runs: { status: string; createdAt: string; state?: string }[];
  expected: string | undefined;
}>([
  {
    name: "the newest run's state, a running one's included",
    runs: [
      { status: "finished", createdAt: "2026-09-28T09:00:00Z", state: "older" },
      { status: "running", createdAt: "2026-09-28T10:00:00Z", state: "newest" },
    ],
    expected: "newest",
  },
  {
    name: "a failed run's state counts, and a run that kept none is passed over",
    runs: [
      { status: "failed", createdAt: "2026-09-28T09:00:00Z", state: "kept before it failed" },
      { status: "finished", createdAt: "2026-09-28T10:00:00Z" },
    ],
    expected: "kept before it failed",
  },
  {
    name: "a cancelled run's state is not read",
    runs: [{ status: "cancelled", createdAt: "2026-09-28T10:00:00Z", state: "cancelled" }],
    expected: undefined,
  },
  { name: "no run kept one", runs: [], expected: undefined },
])("the state a job hands on: $name", async ({ runs, expected }) => {
  const depot = fakeDepot({
    Health: runs.map((run, index) => ({
      workflowId: `wf-${index}`,
      runId: `run-${index}`,
      status: run.status,
      trigger: "schedule",
      sha: "a".repeat(40),
      createdAt: run.createdAt,
      artifacts: run.state ? { "health-state": { "state.json": run.state } } : undefined,
    })),
  });
  expect(await newestArtifactFile(depot, state)).toBe(expected);
});

test("a state artifact without its file fails, naming the run", async () => {
  const depot = fakeDepot({
    Health: [
      {
        workflowId: "wf-broken",
        runId: "run-broken",
        status: "finished",
        trigger: "schedule",
        sha: "a".repeat(40),
        createdAt: "2026-09-28T10:00:00Z",
        artifacts: { "health-state": { "other.json": "{}" } },
      },
    ],
  });
  await expect(newestArtifactFile(depot, state)).rejects.toThrow(
    "health-state of wf-broken holds no state.json",
  );
});
