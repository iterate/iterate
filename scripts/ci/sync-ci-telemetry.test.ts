import { expect, test, vi } from "vitest";
import {
  candidateRuns,
  ciTelemetryEvents,
  runSource,
  testEvidenceAttemptIds,
  workflowRunners,
} from "./sync-ci-telemetry.ts";

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

test("a test evidence job's attempt says whether its folder reached R2, by the prefix its summary names", () => {
  const runs = [
    {
      run,
      workflows: [
        {
          workflow: {
            workflowId: "wf3",
            workflowPath: "test.yml",
            name: "Test",
            status: "finished",
            finishedAt: "2026-09-24T05:40:00Z",
          },
          jobs: [
            {
              job: { jobId: "job4", jobKey: "test.yml:test" },
              attempts: [
                attempt("uploaded", "2026-09-24T05:35:00.000Z"),
                attempt("not-uploaded", "2026-09-24T05:36:00.000Z", "failure", 2),
                attempt("before-window", "2026-09-24T04:59:00.000Z"),
              ],
            },
            {
              job: { jobId: "job5", jobKey: "test.yml:lint" },
              attempts: [attempt("no-evidence", "2026-09-24T05:37:00.000Z")],
            },
          ],
        },
      ],
    },
  ];
  // the attempts whose summaries the sync reads: the evidence job's, in the window
  expect(testEvidenceAttemptIds(runs, window)).toEqual(["uploaded", "not-uploaded"]);

  const prefix = "evidence/ci/trust=pr/date=2026-09-24/job=job4/testrun_uploaded/";
  const events = ciTelemetryEvents({
    window,
    runs,
    workflows: [],
    sources: new Map(),
    runners: new Map(),
    evidence: new Map([
      ["uploaded", { prefix }],
      ["not-uploaded", { prefix: undefined }],
    ]),
  });
  expect(events.map(({ properties }) => properties)).toEqual([
    expect.objectContaining({
      attempt_id: "uploaded",
      test_run_id: "testrun_uploaded",
      test_evidence_uploaded: true,
      test_evidence_prefix: prefix,
    }),
    expect.objectContaining({
      attempt_id: "not-uploaded",
      test_run_id: "testrun_not-uploaded",
      test_evidence_uploaded: false,
      test_evidence_prefix: undefined,
    }),
    // a job that uploads nothing says nothing about evidence
    expect.not.objectContaining({ test_evidence_uploaded: expect.anything() }),
  ]);
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

test("a full listing that does not reach back starts the window two hours after its oldest workflow, and warns", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const requested = {
    start: Date.parse("2026-09-24T16:24:00Z"),
    end: Date.parse("2026-09-24T22:24:00Z"),
  };
  const { window: covered, runs } = await candidateRuns(busyDepot, requested);
  expect(covered).toEqual({ start: Date.parse("2026-09-24T21:01:00Z"), end: requested.end });
  expect(warn).toHaveBeenCalledWith({
    event: "ci-telemetry.unreported",
    from: "2026-09-24T16:24:00.000Z",
    until: "2026-09-24T21:01:00.000Z",
    reason: expect.any(String),
    listings: { "Lint and Typecheck": "2026-09-24T19:01:00.000Z" },
  });
  expect(runs).toHaveLength(200);
  warn.mockRestore();
});

test("a full listing that reaches back leaves the window whole", async () => {
  const warn = vi.spyOn(console, "warn");
  const requested = {
    start: Date.parse("2026-09-24T21:30:00Z"),
    end: Date.parse("2026-09-24T22:24:00Z"),
  };
  const { window: covered, runs } = await candidateRuns(busyDepot, requested);
  expect(covered).toEqual(requested);
  expect(warn).not.toHaveBeenCalled();
  // created from 19:30, two hours before the window
  expect(runs).toHaveLength(171);
  warn.mockRestore();
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

/** Depot's API with 200 "Lint and Typecheck" workflows, one a minute from 19:01 to 22:20, and no others. */
async function busyDepot(method: string, body: object) {
  const { name, runId } = body as { name?: string; runId?: string };
  if (method === "GetRunMetrics")
    return { run: { runId, sha: "sha", headSha: "sha", trigger: "pull_request" } };
  if (name !== "Lint and Typecheck") return { workflows: [] };
  return {
    workflows: Array.from({ length: 200 }, (_, index) => ({
      workflowId: `wf${index}`,
      runId: `run${index}`,
      status: "finished",
      trigger: "pull_request",
      createdAt: new Date(Date.parse("2026-09-24T22:20:00Z") - index * 60_000).toISOString(),
    })),
  };
}
