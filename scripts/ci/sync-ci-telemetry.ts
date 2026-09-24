/**
 * THE CI TELEMETRY SYNC (`.depot/workflows/ci-telemetry.yml`, hourly): one PostHog event per Depot
 * workflow run and one per job attempt, saying which workflow and job ran for which pull request,
 * branch and commit, on which runner size, how long it queued and ran, and how it ended. Nothing per
 * test: per-test events were over 70% of the PostHog project's ingestion when #2494 cut delivery to
 * zero, and test data stays in the Depot artifacts (docs/ci-test-telemetry.md).
 *
 * A schedule rather than a last step in every workflow: a step inside a workflow cannot see that
 * workflow's own outcome or duration, a cancelled workflow skips it, and it would boot one more
 * runner per workflow run. One hourly job reads everything that settled from Depot's API instead.
 *
 * A sync reports what finished in [the previous successful scheduled sync's creation, its own
 * creation), both less `settleMs`, so successful syncs tile time with no stored cursor and a failed
 * sync leaves its window to the next one. Event UUIDs derive from Depot's execution and attempt IDs, so PostHog
 * deduplicates an overlapping replay (`--since`).
 *
 *   DEPOT_CI_TELEMETRY_TOKEN=… GITHUB_TOKEN="$(gh auth token)" \
 *     pnpm tsx scripts/ci/sync-ci-telemetry.ts --dry-run --since 2026-09-24T00:00:00Z
 */
import { readFile, readdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Octokit } from "@octokit/rest";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { osEnvs } from "../../envs.ts";
import { DEPOT_ORG, depotCiApi, mapConcurrent } from "./depot.ts";
import { durationMs, sendPostHogEvents, systemEvent } from "./posthog-events.ts";

const repository = "iterate/iterate";
/** Room for a Depot record that becomes visible after the finish time it carries. */
const settleMs = 5 * 60_000;
/** Candidates are workflows created up to this long before the window: every workflow that runs on
 *  a push, pull request or schedule has job timeouts that sum to less (os-e2e-soak is dispatch-only). */
const longestWorkflowMs = 2 * 3_600_000;
/** A sync that has failed for longer drops the oldest part of its window and says so. */
const longestWindowMs = 6 * 3_600_000;

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      since: { type: "string" },
      until: { type: "string" },
    },
  });
  const depotToken = z
    .string({ error: "DEPOT_CI_TELEMETRY_TOKEN is required (Doppler _shared/preview)" })
    .min(1)
    .parse(process.env.DEPOT_CI_TELEMETRY_TOKEN);
  const githubToken = z
    .string({ error: "GITHUB_TOKEN is required" })
    .min(1)
    .parse(process.env.GITHUB_TOKEN);
  const depot = (method: string, body: object) => depotCiApi(method, body, depotToken);

  const window = values.since
    ? {
        start: Date.parse(values.since),
        end: values.until ? Date.parse(values.until) : Date.now() - settleMs,
      }
    : await scheduledWindow(depot, z.url().parse(process.env.DEPOT_JOB_URL));
  if (!Number.isFinite(window.start) || !(window.end > window.start))
    throw new Error(`Invalid window: ${values.since} → ${values.until}`);
  console.log(
    `[ci-telemetry] window ${new Date(window.start).toISOString()} → ${new Date(window.end).toISOString()}`,
  );

  // A workflow that finished before the window has nothing left to report: its attempts finished
  // before it did.
  const reportable = ({ workflow }: RunMetrics["workflows"][number]) =>
    workflow.status === "running" || Date.parse(workflow.finishedAt) >= window.start;
  const runs = (await candidateRuns(depot, window)).filter((run) => run.workflows.some(reportable));
  const workflows = await mapConcurrent(
    runs.flatMap((run) => run.workflows.filter(reportable)),
    8,
    async ({ workflow }) =>
      WorkflowDetail.parse(await depot("GetWorkflow", { workflowId: workflow.workflowId })),
  );

  const [owner, repo] = repository.split("/") as [string, string];
  const octokit = new Octokit({ auth: githubToken });
  const github = {
    pullRequest: async (number: number) =>
      (await octokit.rest.pulls.get({ owner, repo, pull_number: number })).data,
    pullRequestsForCommit: async (sha: string) =>
      (
        await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: sha,
        })
      ).data,
  };
  const sources = new Map(
    await mapConcurrent(runs, 4, async (run) => [run.run.runId, await runSource(run.run, github)]),
  );
  const workflowFiles = [
    ...new Set(
      runs.flatMap((run) =>
        run.workflows.flatMap(({ workflow }) =>
          workflow.workflowPath ? [`${run.run.sha}:${workflow.workflowPath}`] : [],
        ),
      ),
    ),
  ];
  const runners = new Map(
    await mapConcurrent(workflowFiles, 8, async (file) => {
      const [sha, path] = file.split(":") as [string, string];
      const response = await fetch(
        `https://raw.githubusercontent.com/${repository}/${sha}/.depot/workflows/${path}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      // A pull request's test-merge commit is dropped once a newer push replaces it; its runs then
      // report no runner size rather than one read from another commit.
      if (response.status === 404) return [file, new Map<string, string>()] as const;
      if (!response.ok) throw new Error(`${path}@${sha}: HTTP ${response.status}`);
      return [file, workflowRunners(await response.text())] as const;
    }),
  );

  const events = ciTelemetryEvents({ window, runs, workflows, sources, runners });
  const counts = Object.fromEntries(
    [...new Set(events.map(({ event }) => event))].map((name) => [
      name,
      events.filter(({ event }) => event === name).length,
    ]),
  );
  console.log(`[ci-telemetry] ${events.length} event(s): ${JSON.stringify(counts)}`);
  if (values["dry-run"]) {
    const hours = (window.end - window.start) / 3_600_000;
    console.log(
      `[ci-telemetry] dry run: ${Math.round((events.length / hours) * 24)} event(s)/day at this window's rate`,
    );
    console.log(JSON.stringify(events, null, 2));
    return;
  }
  // The iterate project in PostHog EU, the one production's apps report to.
  await sendPostHogEvents(events, {
    apiKey: z.string().parse(osEnvs.prd?.posthogProjectKey),
    host: "https://eu.i.posthog.com",
  });
  console.log(`[ci-telemetry] delivered ${events.length} event(s)`);
}

/**
 * The PostHog events for what finished inside `window`: one `ci workflow run finished` per settled
 * workflow execution (a re-run is a new execution, `attempt` 2), one `ci job attempt finished` per
 * finished job attempt (a retried job is a new attempt). A skipped job has no attempt.
 */
export function ciTelemetryEvents(input: {
  window: { start: number; end: number };
  runs: RunMetrics[];
  workflows: WorkflowDetail[];
  sources: Map<string, RunSource>;
  runners: Map<string, Map<string, string>>;
}) {
  const inWindow = (time: string) => {
    const at = Date.parse(time);
    return at >= input.window.start && at < input.window.end;
  };
  const context = (
    run: RunMetrics["run"],
    workflow: { workflowId: string; workflowPath: string; name: string },
  ) => ({
    schema_version: 3,
    repository,
    workflow_name: workflow.name,
    workflow_path: workflow.workflowPath || undefined,
    workflow_id: workflow.workflowId,
    depot_run_id: run.runId,
    trigger: run.trigger,
    sha: run.sha,
    head_sha: run.headSha,
    pull_request_number: input.sources.get(run.runId)?.pullRequestNumber,
    branch: input.sources.get(run.runId)?.branch,
  });

  const runsById = new Map(input.runs.map((run) => [run.run.runId, run.run]));
  const workflowRuns = input.workflows.flatMap((workflow) => {
    const run = runsById.get(workflow.runId);
    if (!run) throw new Error(`Workflow ${workflow.workflowId} has no run ${workflow.runId}`);
    return workflow.executions.flatMap((execution) => {
      const conclusion = executionConclusions[execution.status];
      if (!conclusion || !inWindow(execution.finishedAt)) return [];
      return [
        systemEvent(
          "ci workflow run finished",
          `depot-workflow-execution:${execution.executionId}`,
          `depot-workflow:${workflow.workflowId}`,
          {
            ...context(run, {
              workflowId: workflow.workflowId,
              workflowPath: workflow.workflowPath,
              name: workflow.workflowName,
            }),
            attempt: execution.execution,
            conclusion,
            queued_at: execution.createdAt,
            started_at: execution.startedAt || undefined,
            finished_at: execution.finishedAt,
            queue_duration_ms: durationMs(execution.createdAt, execution.startedAt),
            duration_ms: durationMs(execution.startedAt, execution.finishedAt),
            url: `https://depot.dev/orgs/${DEPOT_ORG}/workflows/${workflow.workflowId}`,
          },
          execution.finishedAt,
        ),
      ];
    });
  });

  const jobAttempts = input.runs.flatMap(({ run, workflows }) =>
    workflows.flatMap(({ workflow, jobs }) =>
      jobs.flatMap(({ job, attempts }) =>
        attempts.flatMap(({ attempt }) => {
          if (!inWindow(attempt.finishedAt)) return [];
          // `test.yml:test`, `kit-firmware.yml:build-firmware:matrix-5`, and `_inline_0.yaml:e2e`
          // for a workflow file run with `depot ci run`, which has no workflow path
          const jobName = job.jobKey.slice(job.jobKey.indexOf(":") + 1);
          return [
            systemEvent(
              "ci job attempt finished",
              `depot-job-attempt:${attempt.attemptId}`,
              `depot-workflow:${workflow.workflowId}`,
              {
                ...context(run, workflow),
                job_name: jobName,
                job_id: job.jobId,
                attempt_id: attempt.attemptId,
                attempt: attempt.attempt,
                runner_size: input.runners
                  .get(`${run.sha}:${workflow.workflowPath}`)
                  ?.get(jobName.split(":")[0]!),
                conclusion: attempt.conclusion,
                queued_at: attempt.createdAt,
                started_at: attempt.startedAt || undefined,
                finished_at: attempt.finishedAt,
                queue_duration_ms: durationMs(attempt.createdAt, attempt.startedAt),
                duration_ms: durationMs(attempt.startedAt, attempt.finishedAt),
                url: `https://depot.dev/orgs/${DEPOT_ORG}/workflows/${workflow.workflowId}?job=${job.jobId}&attempt=${attempt.attemptId}`,
              },
              attempt.finishedAt,
            ),
          ];
        }),
      ),
    ),
  );
  return [...workflowRuns, ...jobAttempts];
}

/** Depot's settled workflow statuses in the conclusion words its job attempts use. */
const executionConclusions: Partial<Record<string, string>> = {
  finished: "success",
  failed: "failure",
  cancelled: "cancelled",
};

type RunSource = { pullRequestNumber?: number; branch?: string };

/**
 * The pull request and branch a run belongs to. Depot records only the ref it ran: a pull request's
 * `refs/pull/<n>/merge`, the merge commit for a pull request's `closed` event, a bare SHA for a push
 * and nothing for a schedule. So a closed-event run is matched by its head commit, and a push by the
 * pull request whose merge made the commit, whose base is then the pushed branch.
 */
export async function runSource(
  run: RunMetrics["run"],
  github: {
    pullRequest(number: number): Promise<PullRequest>;
    pullRequestsForCommit(sha: string): Promise<PullRequest[]>;
  },
): Promise<RunSource> {
  const pullRequestNumber = /^refs\/pull\/(\d+)\//.exec(run.ref)?.[1];
  if (pullRequestNumber) {
    const pull = await github.pullRequest(Number(pullRequestNumber));
    return { pullRequestNumber: pull.number, branch: pull.head.ref };
  }
  const branch = /^refs\/heads\/(.+)$/.exec(run.ref)?.[1];
  if (run.trigger === "pull_request") {
    const pull = (await github.pullRequestsForCommit(run.headSha)).find(
      (candidate) => candidate.head.sha === run.headSha,
    );
    return pull ? { pullRequestNumber: pull.number, branch: pull.head.ref } : { branch };
  }
  if (run.trigger === "push") {
    const pull = (await github.pullRequestsForCommit(run.sha)).find(
      (candidate) => candidate.merge_commit_sha === run.sha,
    );
    return { pullRequestNumber: pull?.number, branch: branch || pull?.base.ref };
  }
  return { branch };
}

type PullRequest = {
  number: number;
  head: { ref: string; sha: string };
  base: { ref: string };
  merge_commit_sha: string | null;
};

/** Each job's `runs-on`: a Depot size (`4x16`) or a runner label (`depot-ubuntu-24.04`). */
export function workflowRunners(source: string) {
  const workflow = z
    .object({
      jobs: z.record(
        z.string(),
        z.object({
          "runs-on": z.union([z.string(), z.object({ size: z.string() })]).optional(),
        }),
      ),
    })
    .parse(parseYaml(source));
  return new Map(
    Object.entries(workflow.jobs).flatMap(([jobId, job]) => {
      const runsOn = job["runs-on"];
      if (!runsOn) return [];
      return [[jobId, typeof runsOn === "string" ? runsOn : runsOn.size] as const];
    }),
  );
}

/**
 * The window a sync reports without `--since`: from the previous successful scheduled sync's
 * creation to this one's, each less `settleMs`. The first sync reports its last hour.
 */
async function scheduledWindow(
  depot: (method: string, body: object) => Promise<unknown>,
  jobUrl: string,
) {
  const self = WorkflowDetail.parse(
    await depot("GetWorkflow", { workflowId: new URL(jobUrl).pathname.split("/").at(-1) }),
  );
  const { workflows } = WorkflowList.parse(
    await depot("ListWorkflows", {
      repo: repository,
      name: self.workflowName,
      status: ["finished"],
      pageSize: 50,
    }),
  );
  const previous = workflows
    // A dispatched sync may have replayed any window, so only scheduled ones mark progress.
    .filter(
      (workflow) =>
        workflow.workflowPath === self.workflowPath &&
        workflow.trigger === "schedule" &&
        workflow.createdAt < self.workflowCreatedAt,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const end = Date.parse(self.workflowCreatedAt) - settleMs;
  const start = previous ? Date.parse(previous.createdAt) - settleMs : end - 3_600_000;
  if (end - start <= longestWindowMs) return { start, end };
  console.warn(
    `[ci-telemetry] no successful sync since ${new Date(start).toISOString()}: reporting only the last ${longestWindowMs / 3_600_000}h; what finished before is not reported`,
  );
  return { start: end - longestWindowMs, end };
}

/**
 * Every Depot run with a workflow created in the window or up to `longestWorkflowMs` before it,
 * with its workflows' jobs and attempts. `ListWorkflows` returns at most the newest 200 and has no
 * paging, so the sync lists each workflow on main by name; a listing that fills its 200 without
 * reaching back far enough fails the sync. One unnamed listing adds workflows that exist only on a
 * branch.
 */
async function candidateRuns(
  depot: (method: string, body: object) => Promise<unknown>,
  window: { start: number; end: number },
) {
  const directory = new URL("../../.depot/workflows/", import.meta.url);
  const names = await Promise.all(
    (await readdir(directory))
      .filter((file) => file.endsWith(".yml"))
      .map(
        async (file) =>
          z
            .object({ name: z.string() })
            .parse(parseYaml(await readFile(new URL(file, directory), "utf8"))).name,
      ),
  );
  const oldest = window.start - longestWorkflowMs;
  const listings = await mapConcurrent([undefined, ...names], 8, async (name) => {
    const { workflows } = WorkflowList.parse(
      await depot("ListWorkflows", { repo: repository, pageSize: 200, name }),
    );
    const reachedBack = workflows.some((workflow) => Date.parse(workflow.createdAt) < oldest);
    if (name && workflows.length === 200 && !reachedBack)
      throw new Error(
        `Depot's 200 newest "${name}" workflows do not reach back to ${new Date(oldest).toISOString()}; sync a shorter window`,
      );
    return workflows;
  });
  const runIds = [
    ...new Set(
      listings
        .flat()
        .filter((workflow) => {
          const createdAt = Date.parse(workflow.createdAt);
          return createdAt >= oldest && createdAt < window.end && workflow.status !== "queued";
        })
        .map((workflow) => workflow.runId),
    ),
  ];
  return mapConcurrent(runIds, 8, async (runId) =>
    RunMetrics.parse(await depot("GetRunMetrics", { runId })),
  );
}

// Connect's JSON encoding omits empty strings and empty lists, so an unset time or conclusion is
// absent rather than "": https://protobuf.dev/programming-guides/json/ ("default values are omitted").
const WorkflowList = z.object({
  workflows: z
    .array(
      z.object({
        workflowId: z.string(),
        workflowPath: z.string().default(""),
        runId: z.string(),
        status: z.string(),
        trigger: z.string(),
        createdAt: z.string(),
      }),
    )
    .default([]),
});

const RunMetrics = z.object({
  run: z.object({
    runId: z.string(),
    ref: z.string().default(""),
    sha: z.string(),
    headSha: z.string(),
    trigger: z.string(),
  }),
  workflows: z
    .array(
      z.object({
        workflow: z.object({
          workflowId: z.string(),
          workflowPath: z.string().default(""),
          name: z.string(),
          status: z.string(),
          finishedAt: z.string().default(""),
        }),
        jobs: z
          .array(
            z.object({
              job: z.object({ jobId: z.string(), jobKey: z.string() }),
              attempts: z
                .array(
                  z.object({
                    attempt: z.object({
                      attemptId: z.string(),
                      attempt: z.number(),
                      conclusion: z.string().default(""),
                      createdAt: z.string(),
                      startedAt: z.string().default(""),
                      finishedAt: z.string().default(""),
                    }),
                  }),
                )
                .default([]),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});
type RunMetrics = z.infer<typeof RunMetrics>;

const WorkflowDetail = z.object({
  runId: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  workflowPath: z.string().default(""),
  workflowCreatedAt: z.string(),
  executions: z.array(
    z.object({
      executionId: z.string(),
      execution: z.number(),
      status: z.string(),
      createdAt: z.string(),
      startedAt: z.string().default(""),
      finishedAt: z.string().default(""),
    }),
  ),
});
type WorkflowDetail = z.infer<typeof WorkflowDetail>;

if (isMainModule(import.meta.url)) await main();
