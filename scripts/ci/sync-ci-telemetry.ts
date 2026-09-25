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
 * The attempts of the jobs that upload a test evidence folder (docs/test-evidence.md) also say
 * whether it reached R2: the upload step's line in the attempt's summary names its prefix, so an
 * attempt whose folder never arrived, for whatever reason, is `test_evidence_uploaded: false`.
 *
 * A sync reports what finished in [the previous successful scheduled sync's creation, its own
 * creation), both less `settleMs`, so successful syncs tile time with no stored cursor and a failed
 * sync leaves its window to the next one. A window is cut from its start to at most
 * `longestWindowMs` and to what Depot's listings reach (candidateRuns); a cut logs a
 * `ci-telemetry.unreported` warning naming the time whose work goes unreported, and the sync
 * still succeeds, so the next one starts after it. Event UUIDs derive from Depot's execution and
 * attempt IDs, so PostHog deduplicates an overlapping replay (`--since`).
 *
 *   DEPOT_CI_TELEMETRY_TOKEN=… GITHUB_TOKEN="$(gh auth token)" \
 *     pnpm tsx scripts/ci/sync-ci-telemetry.ts --dry-run --since 2026-09-24T00:00:00Z
 */
import { readFile, readdir } from "node:fs/promises";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { osEnvs } from "../../envs.ts";
import { DEPOT_ORG, depotCiApi, mapConcurrent } from "./depot.ts";
import { createOctokit } from "./github.ts";
import { durationMs, sendPostHogEvents, systemEvent } from "./posthog-events.ts";
import { testEvidenceJobs, testEvidenceUploadedPrefix } from "./test-evidence.ts";

const repository = "iterate/iterate";
/** Room for a Depot record that becomes visible after the finish time it carries. */
const settleMs = 5 * 60_000;
/** Candidates are workflows created up to this long before the window: every workflow that runs on
 *  a push, pull request or schedule has job timeouts that sum to less (os-e2e-soak is dispatch-only). */
const longestWorkflowMs = 2 * 3_600_000;
/** A sync that has failed for longer drops the oldest part of its window and says so. */
const longestWindowMs = 6 * 3_600_000;

/** Sync Depot CI's finished runs since the last sync to PostHog as CI telemetry events. */
export default async function syncCiTelemetry(
  values: {
    /** Print the events instead of sending them. */
    dryRun?: boolean;
    /** Start of the window (ISO time) instead of the last sync. */
    since?: string;
    /** End of the window (ISO time); default now minus the settle time. */
    until?: string;
  } = {},
) {
  const depotToken = z
    .string({ error: "DEPOT_CI_TELEMETRY_TOKEN is required (Doppler _shared/preview)" })
    .min(1)
    .parse(process.env.DEPOT_CI_TELEMETRY_TOKEN);
  const githubToken = z
    .string({ error: "GITHUB_TOKEN is required" })
    .min(1)
    .parse(process.env.GITHUB_TOKEN);
  const depot = (method: string, body: object) => depotCiApi(method, body, depotToken);

  const requested = values.since
    ? {
        start: Date.parse(values.since),
        end: values.until ? Date.parse(values.until) : Date.now() - settleMs,
      }
    : await scheduledWindow(depot, z.url().parse(process.env.DEPOT_JOB_URL));
  if (!Number.isFinite(requested.start) || !(requested.end > requested.start))
    throw new Error(`Invalid window: ${values.since} → ${values.until}`);
  const { window, runs: candidates } = await candidateRuns(depot, requested);
  console.log(
    `[ci-telemetry] window ${new Date(window.start).toISOString()} → ${new Date(window.end).toISOString()}`,
  );

  // A workflow that finished before the window has nothing left to report: its attempts finished
  // before it did.
  const reportable = ({ workflow }: RunMetrics["workflows"][number]) =>
    workflow.status === "running" || Date.parse(workflow.finishedAt) >= window.start;
  const runs = candidates.filter((run) => run.workflows.some(reportable));
  const workflows = await mapConcurrent(
    runs.flatMap((run) => run.workflows.filter(reportable)),
    8,
    async ({ workflow }) =>
      WorkflowDetail.parse(await depot("GetWorkflow", { workflowId: workflow.workflowId })),
  );

  const [owner, repo] = repository.split("/") as [string, string];
  const octokit = createOctokit(githubToken);
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

  const evidence = new Map(
    await mapConcurrent(testEvidenceAttemptIds(runs, window), 8, async (attemptId) => {
      const summary = JobSummary.parse(await depot("GetJobSummary", { attemptId }));
      return [attemptId, { prefix: testEvidenceUploadedPrefix(summary.markdown) }] as const;
    }),
  );

  const events = ciTelemetryEvents({ window, runs, workflows, sources, runners, evidence });
  const counts = Object.fromEntries(
    [...new Set(events.map(({ event }) => event))].map((name) => [
      name,
      events.filter(({ event }) => event === name).length,
    ]),
  );
  console.log(`[ci-telemetry] ${events.length} event(s): ${JSON.stringify(counts)}`);
  if (values.dryRun) {
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
  /** Each test evidence job attempt's (testEvidenceAttemptIds): the prefix its summary names. */
  evidence?: Map<string, { prefix: string | undefined }>;
}) {
  const inWindow = (time: string) => finishedIn(input.window, time);
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
          const evidence = input.evidence?.get(attempt.attemptId);
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
                ...(evidence && {
                  test_run_id: `testrun_${attempt.attemptId}`,
                  test_evidence_uploaded: !!evidence.prefix,
                  test_evidence_prefix: evidence.prefix,
                }),
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

/**
 * The attempts that finished in the window of the jobs that upload a test evidence folder
 * (testEvidenceJobs), whose summaries the sync reads.
 */
export function testEvidenceAttemptIds(runs: RunMetrics[], window: { start: number; end: number }) {
  return runs.flatMap(({ workflows }) =>
    workflows.flatMap(({ jobs }) =>
      jobs
        .filter(({ job }) => testEvidenceJobs.includes(job.jobKey))
        .flatMap(({ attempts }) =>
          attempts
            .filter(({ attempt }) => finishedIn(window, attempt.finishedAt))
            .map(({ attempt }) => attempt.attemptId),
        ),
    ),
  );
}

function finishedIn(window: { start: number; end: number }, time: string) {
  const at = Date.parse(time);
  return at >= window.start && at < window.end;
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
  console.warn({
    event: "ci-telemetry.unreported",
    from: new Date(start).toISOString(),
    until: new Date(end - longestWindowMs).toISOString(),
    reason: `no successful sync since ${new Date(start).toISOString()}; a sync reports at most its last ${longestWindowMs / 3_600_000}h`,
  });
  return { start: end - longestWindowMs, end };
}

/**
 * Every Depot run with a workflow created in the window or up to `longestWorkflowMs` before it,
 * with its workflows' jobs and attempts, and the window those runs cover. `ListWorkflows` returns
 * at most the newest 200 and has no paging, so the sync lists each workflow on main by name, and
 * one unnamed listing adds workflows that exist only on a branch. A named listing that fills its
 * 200 without reaching back far enough holds every workflow of its name created since its oldest,
 * so the window then starts `longestWorkflowMs` after that one, and what finished before goes
 * unreported with a warning. The listings take no time or branch filter to narrow them by.
 *
 * A re-run started more than `longestWorkflowMs` after its workflow was created is not reported.
 * Depot keeps the workflow's original `createdAt` for a re-run, and neither `ListWorkflows` nor
 * `ListRuns` exposes an update or finish time to list by
 * (https://github.com/depot/cli/blob/main/proto/depot/ci/v1/ci.proto), so finding one would mean
 * fetching every workflow of the horizon it could come from, every hour.
 */
export async function candidateRuns(
  depot: (method: string, body: object) => Promise<unknown>,
  requested: { start: number; end: number },
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
  const listings = await mapConcurrent([undefined, ...names], 8, async (name) => {
    const { workflows } = WorkflowList.parse(
      await depot("ListWorkflows", { repo: repository, pageSize: 200, name }),
    );
    return { name, workflows };
  });
  const short = listings.flatMap(({ name, workflows }) => {
    if (!name || workflows.length < 200) return [];
    const reach = Math.min(...workflows.map((workflow) => Date.parse(workflow.createdAt)));
    return reach + longestWorkflowMs > requested.start ? [{ name, reach }] : [];
  });
  const window = {
    start: Math.min(
      Math.max(requested.start, ...short.map(({ reach }) => reach + longestWorkflowMs)),
      requested.end,
    ),
    end: requested.end,
  };
  if (short.length)
    console.warn({
      event: "ci-telemetry.unreported",
      from: new Date(requested.start).toISOString(),
      until: new Date(window.start).toISOString(),
      reason: `Depot's 200 newest workflows of each name in listings reach back only to the time given, and one created before it may finish up to ${longestWorkflowMs / 3_600_000}h later`,
      listings: Object.fromEntries(
        short.map(({ name, reach }) => [name, new Date(reach).toISOString()]),
      ),
    });

  const oldest = window.start - longestWorkflowMs;
  const runIds = [
    ...new Set(
      listings
        .flatMap(({ workflows }) => workflows)
        .filter((workflow) => {
          const createdAt = Date.parse(workflow.createdAt);
          return createdAt >= oldest && createdAt < window.end && workflow.status !== "queued";
        })
        .map((workflow) => workflow.runId),
    ),
  ];
  const runs = await mapConcurrent(runIds, 8, async (runId) =>
    RunMetrics.parse(await depot("GetRunMetrics", { runId })),
  );
  return { window, runs };
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

/** GetJobSummary's answer for one attempt: its steps' summaries joined, empty when none wrote one. */
const JobSummary = z.object({ markdown: z.string().default("") });

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "sync-ci-telemetry" }).run();
