import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import CiTrace, { duration } from "./cli.ts";

test.for([
  [
    { "ci.status": "finished", "ci.time_to_green_ms": "180400" },
    { state: "success", description: "Time to green 3m 00s · report in the job's artifacts" },
  ],
  [
    { "ci.status": "failed", "ci.time_to_red_ms": "40000" },
    { state: "failure", description: "Time to red 0m 40s · report in the job's artifacts" },
  ],
  [
    { "ci.status": "cancelled" },
    { state: "error", description: "No verdict (cancelled) · report in the job's artifacts" },
  ],
] as const)("a %o trace posts the CI trace status %o", async ([attributes, expected]) => {
  await using collected = await collectedTrace(attributes);

  await new CiTrace().publish(collected.directory);

  expect(collected.fetch).toHaveBeenCalledWith(
    `https://api.github.com/repos/iterate/iterate/statuses/${"a".repeat(40)}`,
    expect.objectContaining({ method: "POST" }),
  );
  const [, request] = collected.fetch.mock.calls[0] as unknown as [string, { body: string }];
  expect(JSON.parse(request.body)).toEqual({
    ...expected,
    context: "CI trace",
    target_url: "https://depot.dev/orgs/0p91s0lz49/workflows/w?job=j&attempt=a",
  });
});

test("the trace job collects the deploy and e2e jobs", async () => {
  await using depot = await previewOsDepot();

  await new CiTrace().current(depot.directory);

  const trace = JSON.parse(await readFile(join(depot.directory, "trace.json"), "utf8"));
  const spans: { name: string }[] = trace.resourceSpans[0].scopeSpans[0].spans;
  expect(spans.map((span) => span.name)).toEqual([
    "Preview OS",
    "Deploy",
    "E2E",
    "Setup",
    "Test",
    "Finish",
    "Run the e2e suite against the preview",
  ]);
  expect(spans[0]).toMatchObject({
    attributes: expect.arrayContaining([
      { key: "ci.time_to_green_ms", value: { stringValue: "180000" } },
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

/**
 * A collected trace.json whose workflow span has the given attributes, in the trace job's
 * environment, with GitHub's status endpoint answering 201.
 */
async function collectedTrace(attributes: Record<string, string>) {
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
                  attributes: Object.entries(attributes).map(([key, stringValue]) => ({
                    key,
                    value: { stringValue },
                  })),
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("CI_TRACE_STATUS_SHA", "a".repeat(40));
  vi.stubEnv("GITHUB_TOKEN", "token");
  vi.stubEnv("DEPOT_JOB_URL", "https://depot.dev/orgs/0p91s0lz49/workflows/w?job=j&attempt=a");
  return {
    directory,
    fetch,
    async [Symbol.asyncDispose]() {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Depot and GitHub as the Preview OS trace job sees them: a workflow whose deploy and e2e passed and
 * whose trace job (this one) is still running, the e2e job's marker lines, and the workflow source.
 */
async function previewOsDepot() {
  const directory = await mkdtemp(join(tmpdir(), "ci-trace-"));
  const at = (seconds: number) =>
    new Date(Date.UTC(2026, 8, 23, 12) + seconds * 1000).toISOString();
  const job = (key: string, status: string, startedAt: number, finishedAt: number) => ({
    jobId: `${key}-job`,
    jobKey: `preview-os-next.yml:${key}`,
    status,
    finishedAt: finishedAt ? at(finishedAt) : "",
    attempts: [
      {
        attemptId: `${key}-attempt`,
        attempt: 1,
        status,
        startedAt: at(startedAt),
        finishedAt: finishedAt ? at(finishedAt) : "",
      },
    ],
  });
  const marker = (event: object) => ({
    stepKey: "opaque-e2e",
    stepId: "e2e",
    stepName: "Run the e2e suite against the preview",
    body: `@@ci-trace ${JSON.stringify(event)}`,
  });
  const responses: Record<string, unknown> = {
    GetWorkflow: {
      workflowId: "workflow",
      workflowName: "Preview OS",
      workflowPath: "preview-os-next.yml",
      repo: "iterate/iterate",
      headSha: "head",
      sha: "merge",
      ref: "refs/pull/2898/merge",
      workflowStatus: "running",
      workflowCreatedAt: at(0),
      executions: [{ executionId: "execution", execution: 1, createdAt: at(0) }],
      jobs: [
        job("deploy", "finished", 3, 40),
        job("e2e", "finished", 41, 180),
        job("trace", "running", 181, 0),
      ],
    },
    "GetJobAttemptLogs:e2e-attempt": {
      lines: [
        marker({ kind: "shell-start", id: "suite", step: "e2e", time: Date.parse(at(52)) }),
        marker({ kind: "shell-end", id: "suite", time: Date.parse(at(170)), exitCode: 0 }),
      ],
    },
  };
  const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.startsWith("https://raw.githubusercontent.com/"))
      return new Response(
        "jobs:\n  e2e:\n    steps:\n      - id: e2e\n        run: doppler run -- pnpm preview e2e\n",
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
