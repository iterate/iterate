import { expect, test, vi } from "vitest";
import { ciTelemetryEvents, runSource, workflowRunners } from "./sync-ci-telemetry.ts";

const window = {
  start: Date.parse("2026-09-24T05:00:00Z"),
  end: Date.parse("2026-09-24T06:00:00Z"),
};
const run = {
  runId: "run1",
  ref: "refs/pull/2953/merge",
  sha: "merge-sha",
  headSha: "head-sha",
  trigger: "pull_request",
};
const pull = {
  number: 2953,
  head: { ref: "sdk-drop-os-next-api", sha: "head-sha" },
  base: { ref: "main" },
  merge_commit_sha: "main-sha",
};

test("reports only executions and attempts that settled inside the window", () => {
  expect(fixtureEvents().map((event) => event.properties.$insert_id)).toEqual([
    "depot-workflow-execution:ex2",
    "depot-job-attempt:in-window",
    "depot-job-attempt:api-run",
  ]);
});

test("a workflow run says which pull request, branch and commit it ran for and how it ended", () => {
  expect(fixtureEvents()[0]).toMatchObject({
    event: "ci workflow run finished",
    timestamp: "2026-09-24T05:20:00Z",
    properties: {
      workflow_name: "Kit Firmware",
      workflow_path: "kit-firmware.yml",
      depot_run_id: "run1",
      trigger: "pull_request",
      sha: "merge-sha",
      head_sha: "head-sha",
      pull_request_number: 2953,
      branch: "sdk-drop-os-next-api",
      attempt: 2,
      conclusion: "failure",
      queue_duration_ms: 30_000,
      duration_ms: 1_170_000,
    },
  });
});

test("a job attempt carries its job, runner size, queue time and duration", () => {
  expect(fixtureEvents()[1]).toMatchObject({
    event: "ci job attempt finished",
    properties: {
      job_name: "build-firmware:matrix-5",
      attempt: 2,
      runner_size: "2x8",
      conclusion: "failure",
      queue_duration_ms: 4_000,
      duration_ms: 296_000,
    },
  });
  // a workflow file run with `depot ci run` has no path to read a runner size from
  expect(fixtureEvents()[2]?.properties).toMatchObject({ job_name: "e2e", runner_size: undefined });
});

test("a pull request run is that pull request's branch", async () => {
  const github = { pullRequest: vi.fn(async () => pull), pullRequestsForCommit: vi.fn() };
  expect(await runSource(run, github)).toEqual({
    pullRequestNumber: 2953,
    branch: "sdk-drop-os-next-api",
  });
  expect(github.pullRequest).toHaveBeenCalledWith(2953);
});

test("a closed pull request's run, recorded at the merge commit, is matched by its head", async () => {
  const github = {
    pullRequest: vi.fn(),
    pullRequestsForCommit: vi.fn(async () => [pull]),
  };
  expect(await runSource({ ...run, ref: "main-sha", sha: "main-sha" }, github)).toEqual({
    pullRequestNumber: 2953,
    branch: "sdk-drop-os-next-api",
  });
  expect(github.pullRequestsForCommit).toHaveBeenCalledWith("head-sha");
});

test("a push is on the base branch of the pull request whose merge made the commit", async () => {
  const github = { pullRequest: vi.fn(), pullRequestsForCommit: vi.fn(async () => [pull]) };
  const push = { ...run, trigger: "push", ref: "main-sha", sha: "main-sha", headSha: "main-sha" };
  expect(await runSource(push, github)).toEqual({ pullRequestNumber: 2953, branch: "main" });
  expect(
    await runSource({ ...push, sha: "other", headSha: "other", ref: "other" }, github),
  ).toEqual({ pullRequestNumber: undefined, branch: undefined });
});

test("a scheduled run has no pull request", async () => {
  const github = { pullRequest: vi.fn(), pullRequestsForCommit: vi.fn() };
  expect(await runSource({ ...run, trigger: "schedule", ref: "" }, github)).toEqual({
    branch: undefined,
  });
  expect(github.pullRequestsForCommit).not.toHaveBeenCalled();
});

test("reads each job's runner size or label from the workflow file", () => {
  expect(
    workflowRunners(
      [
        "jobs:",
        "  test:",
        "    runs-on: { size: 4x16, image: example }",
        "  alarm:",
        "    runs-on: depot-ubuntu-24.04",
        "  reusable:",
        "    uses: ./.depot/workflows/other.yml",
      ].join("\n"),
    ),
  ).toEqual(
    new Map([
      ["test", "4x16"],
      ["alarm", "depot-ubuntu-24.04"],
    ]),
  );
});

/** One run: Kit Firmware re-run (execution 2) with a retried matrix job, and a `depot ci run` workflow. */
function fixtureEvents() {
  return ciTelemetryEvents({
    window,
    runs: [
      {
        run,
        workflows: [
          {
            workflow: {
              workflowId: "wf1",
              workflowPath: "kit-firmware.yml",
              name: "Kit Firmware",
              status: "failed",
              finishedAt: "2026-09-24T05:20:00Z",
            },
            jobs: [
              {
                job: { jobId: "job1", jobKey: "kit-firmware.yml:build-firmware:matrix-5" },
                attempts: [
                  attempt("before-window", "2026-09-24T04:59:59.999Z", "failure"),
                  attempt("in-window", "2026-09-24T05:15:00.000Z", "failure", 2),
                  attempt("still-running", ""),
                ],
              },
              // skipped: no attempt, so no event
              { job: { jobId: "job2", jobKey: "kit-firmware.yml:notify" }, attempts: [] },
            ],
          },
          {
            workflow: {
              workflowId: "wf2",
              workflowPath: "",
              name: "Main OS e2e",
              status: "finished",
              finishedAt: "2026-09-24T05:30:00Z",
            },
            jobs: [
              {
                job: { jobId: "job3", jobKey: "_inline_0.yaml:e2e" },
                attempts: [attempt("api-run", "2026-09-24T05:29:00.000Z")],
              },
            ],
          },
        ],
      },
    ],
    workflows: [
      {
        runId: "run1",
        workflowId: "wf1",
        workflowName: "Kit Firmware",
        workflowPath: "kit-firmware.yml",
        workflowCreatedAt: "2026-09-24T04:00:00Z",
        executions: [
          {
            executionId: "ex1",
            execution: 1,
            status: "cancelled",
            createdAt: "2026-09-24T04:00:00Z",
            startedAt: "2026-09-24T04:00:03Z",
            finishedAt: "2026-09-24T04:30:00Z",
          },
          {
            executionId: "ex2",
            execution: 2,
            status: "failed",
            createdAt: "2026-09-24T05:00:00Z",
            startedAt: "2026-09-24T05:00:30Z",
            finishedAt: "2026-09-24T05:20:00Z",
          },
        ],
      },
      {
        runId: "run1",
        workflowId: "wf2",
        workflowName: "Main OS e2e",
        workflowPath: "",
        workflowCreatedAt: "2026-09-24T05:25:00Z",
        executions: [
          {
            executionId: "ex3",
            execution: 1,
            status: "running",
            createdAt: "2026-09-24T05:25:00Z",
            startedAt: "2026-09-24T05:25:01Z",
            finishedAt: "",
          },
        ],
      },
    ],
    sources: new Map([["run1", { pullRequestNumber: 2953, branch: "sdk-drop-os-next-api" }]]),
    runners: new Map([["merge-sha:kit-firmware.yml", new Map([["build-firmware", "2x8"]])]]),
  });
}

function attempt(id: string, finishedAt: string, conclusion = "success", number = 1) {
  return {
    attempt: {
      attemptId: id,
      attempt: number,
      conclusion,
      createdAt: "2026-09-24T05:10:00.000Z",
      startedAt: "2026-09-24T05:10:04.000Z",
      finishedAt,
    },
  };
}
