import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { stringify } from "yaml";
import CiTrace, { duration } from "./cli.ts";

test.for([
  [
    { "ci.status": "finished", "ci.time_to_green_ms": "180400" },
    { state: "success", description: "Time to green 3m 00s" },
  ],
  [
    { "ci.status": "failed", "ci.time_to_red_ms": "40000" },
    { state: "failure", description: "Time to red 0m 40s" },
  ],
  [{ "ci.status": "cancelled" }, { state: "error", description: "No verdict (cancelled)" }],
] as const)("a %o trace posts the CI trace status %o", async ([attributes, expected]) => {
  await using collected = await collectedTrace(attributes, [traceArtifact]);

  await new CiTrace().publish(collected.directory);

  expect(collected.statuses()).toEqual([
    {
      ...expected,
      context: "CI trace",
      target_url: `https://ci-reports.iterate-dev-preview.workers.dev/${traceArtifact.artifactId}/`,
    },
  ]);
});

test("the e2e job's Playwright report gets its own status, linking the newest upload", async () => {
  const report = (artifactId: string, createdAt: string) => ({
    artifactId,
    name: "public-playwright-report",
    createdAt,
  });
  await using collected = await collectedTrace({ "ci.time_to_green_ms": "180400" }, [
    report("01a0d207-c3c1-71d6-9f33-40becc9e3f37", "2026-09-24T06:08:39Z"),
    traceArtifact,
    // the e2e job's re-run
    report("01a0d209-0000-7000-8000-000000000000", "2026-09-24T06:20:00Z"),
  ]);

  await new CiTrace().publish(collected.directory);

  expect(collected.statuses()).toEqual([
    expect.objectContaining({ context: "CI trace" }),
    {
      state: "success",
      context: "Playwright report",
      description: "Every spec, and each failure's trace, screenshot and error context",
      target_url:
        "https://ci-reports.iterate-dev-preview.workers.dev/01a0d209-0000-7000-8000-000000000000/",
    },
  ]);
});

test("no status is posted until the trace's own artifact is in Depot", async () => {
  await using collected = await collectedTrace({ "ci.time_to_green_ms": "180400" }, []);

  await expect(new CiTrace().publish(collected.directory)).rejects.toThrow(
    "Depot lists no public-ci-trace-w-execution artifact in this run",
  );
  expect(collected.statuses()).toEqual([]);
});

test("the trace job collects the deploy and both test jobs", async () => {
  await using depot = await tracedWorkflow({
    workflowName: "Preview OS",
    workflowPath: "preview-os.yml",
    jobs: [
      ["deploy", "finished", 3, 40],
      ["e2e", "finished", 41, 180],
      ["specs", "finished", 41, 120],
      ["trace", "running", 181, 0],
    ],
    needs: ["deploy", "e2e", "specs"],
  });

  await new CiTrace().current(depot.directory);

  const trace = JSON.parse(await readFile(join(depot.directory, "trace.json"), "utf8"));
  const spans: { name: string }[] = trace.resourceSpans[0].scopeSpans[0].spans;
  expect(spans.map((span) => span.name)).toEqual([
    "Preview OS",
    "Deploy preview",
    "E2E tests",
    "Setup",
    "Test",
    "Finish",
    "Run the e2e suite against the preview",
    "Browser specs",
  ]);
  expect(spans[0]).toMatchObject({
    attributes: expect.arrayContaining([
      { key: "ci.time_to_green_ms", value: { stringValue: "180000" } },
    ]),
  });
});

test("on main, the trace covers the parent, deploy and both test jobs while alert still runs", async () => {
  await using depot = await tracedWorkflow({
    workflowName: "Main OS e2e",
    workflowPath: "main-os-e2e.yml",
    jobs: [
      ["parent", "finished", 3, 60],
      ["deploy", "finished", 61, 100],
      ["e2e", "finished", 101, 240],
      ["specs", "finished", 101, 180],
      ["alert", "running", 241, 0],
      ["trace", "running", 241, 0],
    ],
    needs: ["parent", "deploy", "e2e", "specs"],
  });

  await new CiTrace().current(depot.directory);

  const trace = JSON.parse(await readFile(join(depot.directory, "trace.json"), "utf8"));
  const spans: { name: string }[] = trace.resourceSpans[0].scopeSpans[0].spans;
  expect(spans.map((span) => span.name).slice(0, 4)).toEqual([
    "Main OS e2e",
    "Preview parent",
    "Deploy preview",
    "E2E tests",
  ]);
  expect(spans[0]).toMatchObject({
    attributes: expect.arrayContaining([
      { key: "ci.time_to_green_ms", value: { stringValue: "240000" } },
    ]),
  });
});

test.for([
  [0, "0m 00s"],
  [59_499, "0m 59s"],
  [59_500, "1m 00s"],
  [664_000, "11m 04s"],
] as const)("%d ms reads as %s", ([milliseconds, expected]) => {
  expect(duration(milliseconds)).toBe(expected);
});

const traceArtifact = {
  artifactId: "01a0d208-5706-711b-b168-ba7a00c8a25f",
  name: "public-ci-trace-w-execution",
  createdAt: "2026-09-24T06:09:17Z",
};

/**
 * A collected trace.json whose workflow span has the given attributes, in the trace job's
 * environment: Depot listing `artifacts` for the run, and GitHub's status endpoint answering 201.
 */
async function collectedTrace(
  attributes: Record<string, string>,
  artifacts: { artifactId: string; name: string; createdAt: string }[],
) {
  const directory = await mkdtemp(join(tmpdir(), "ci-trace-"));
  await writeFile(
    join(directory, "trace.json"),
    JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  attributes: Object.entries({ "ci.execution.id": "execution", ...attributes }).map(
                    ([key, stringValue]) => ({ key, value: { stringValue } }),
                  ),
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const fetch = vi.fn(async (url: string, _init?: { body?: string }) => {
    if (url.endsWith("/GetWorkflow")) return new Response(JSON.stringify({ runId: "run" }));
    if (url.endsWith("/ListArtifacts")) return new Response(JSON.stringify({ artifacts }));
    return new Response("{}", { status: 201 });
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("CI_TRACE_STATUS_SHA", "a".repeat(40));
  vi.stubEnv("GITHUB_TOKEN", "token");
  vi.stubEnv("DEPOT_CI_TELEMETRY_TOKEN", "token");
  vi.stubEnv("DEPOT_JOB_URL", "https://depot.dev/orgs/0p91s0lz49/workflows/w?job=j&attempt=a");
  return {
    directory,
    /** The commit statuses posted, in order. */
    statuses: () =>
      fetch.mock.calls
        .filter(
          ([url]) =>
            url === `https://api.github.com/repos/iterate/iterate/statuses/${"a".repeat(40)}`,
        )
        .map(([, init]) => JSON.parse(init?.body || "")),
    async [Symbol.asyncDispose]() {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Depot and GitHub as a trace job sees them: a workflow whose `jobs` ([key, status, started and
 * finished seconds]) include this trace job, still running, the e2e job's marker lines, and the
 * workflow source, whose trace job `needs`.
 */
async function tracedWorkflow(workflow: {
  workflowName: string;
  workflowPath: string;
  jobs: [key: string, status: string, startedAt: number, finishedAt: number][];
  needs: string[];
}) {
  const directory = await mkdtemp(join(tmpdir(), "ci-trace-"));
  const at = (seconds: number) =>
    new Date(Date.UTC(2026, 8, 23, 12) + seconds * 1000).toISOString();
  const job = ([key, status, startedAt, finishedAt]: (typeof workflow.jobs)[number]) => ({
    jobId: `${key}-job`,
    jobKey: `${workflow.workflowPath}:${key}`,
    status,
    finishedAt: finishedAt ? at(finishedAt) : "",
    attempts: startedAt
      ? [
          {
            attemptId: `${key}-attempt`,
            attempt: 1,
            status,
            startedAt: at(startedAt),
            finishedAt: finishedAt ? at(finishedAt) : "",
          },
        ]
      : [],
  });
  const e2e = workflow.jobs.find(([key]) => key === "e2e")!;
  const marker = (event: object) => ({
    stepKey: "opaque-e2e",
    stepId: "e2e",
    stepName: "Run the e2e suite against the preview",
    body: `@@ci-trace ${JSON.stringify(event)}`,
  });
  const responses: Record<string, unknown> = {
    GetWorkflow: {
      workflowId: "workflow",
      workflowName: workflow.workflowName,
      workflowPath: workflow.workflowPath,
      repo: "iterate/iterate",
      headSha: "head",
      sha: "merge",
      ref: "refs/pull/2898/merge",
      workflowStatus: "running",
      workflowCreatedAt: at(0),
      executions: [{ executionId: "execution", execution: 1, createdAt: at(0) }],
      jobs: workflow.jobs.map(job),
    },
    "GetJobAttemptLogs:e2e-attempt": {
      lines: [
        marker({
          kind: "shell-start",
          id: "suite",
          step: "e2e",
          time: Date.parse(at(e2e[2] + 11)),
        }),
        marker({ kind: "shell-end", id: "suite", time: Date.parse(at(e2e[3] - 10)), exitCode: 0 }),
      ],
    },
  };
  const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.startsWith("https://raw.githubusercontent.com/"))
      return new Response(
        stringify({
          jobs: {
            e2e: { steps: [{ id: "e2e", run: "doppler run -- pnpm preview e2e" }] },
            trace: { needs: workflow.needs, steps: [] },
          },
        }),
      );
    const method = url.split("/").at(-1)!;
    const attemptId = (JSON.parse(init?.body || "{}") as { attemptId?: string }).attemptId;
    const body = responses[attemptId ? `${method}:${attemptId}` : method] || { lines: [] };
    return new Response(JSON.stringify(body));
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("DEPOT_CI_TELEMETRY_TOKEN", "token");
  vi.stubEnv("GITHUB_OUTPUT", "");
  vi.stubEnv(
    "DEPOT_JOB_URL",
    "https://depot.dev/orgs/0p91s0lz49/workflows/workflow?job=trace-job&attempt=trace-attempt",
  );
  return {
    directory,
    async [Symbol.asyncDispose]() {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
