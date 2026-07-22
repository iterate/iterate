import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import { durationMs, sendPostHogEvents, systemEvent, type PostHogEvent } from "./posthog-events.ts";
import { buildReviewEvents, reviewProviderKey, selectReviewSources } from "./review-telemetry.ts";
import { collectTelemetrySources } from "./telemetry-source-sync.ts";

const execFile = promisify(execFileCallback);
const repository = process.env.GITHUB_REPOSITORY ?? "iterate/iterate";
const [owner, repo] = repository.split("/") as [string, string];
const lookbackDays = Number.parseInt(process.env.CI_TELEMETRY_LOOKBACK_DAYS ?? "7", 10);
const cutoff = Date.now() - lookbackDays * 86_400_000;
const githubLimit = Number.parseInt(process.env.CI_TELEMETRY_GITHUB_LIMIT ?? "500", 10);
const dryRun = process.argv.includes("--dry-run");

async function main() {
  const telemetrySyncStartedAt = new Date().toISOString();
  const { events, failures } = await collectTelemetrySources({
    repository,
    lookbackDays,
    telemetrySyncId: process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
      : `local:${telemetrySyncStartedAt}`,
    collectorHeadSha: process.env.GITHUB_SHA,
    sourceGroups: [
      [
        {
          name: "github-actions",
          dataSource: "github-actions-api",
          collect: githubActionsEvents,
        },
        {
          name: "github-reviews",
          dataSource: "github-checks-reviews-and-threads-api",
          collect: githubReviewEvents,
        },
      ],
      [{ name: "depot", dataSource: "depot-api", collect: depotEvents }],
    ],
  });
  console.log(`[ci-telemetry] collected ${events.length} idempotent event(s)`);
  if (dryRun) {
    console.log(JSON.stringify(summarize(events), null, 2));
  } else {
    await sendPostHogEvents(events);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `CI telemetry source collection failed: ${failures.map((failure) => failure.source).join(", ")}`,
    );
  }
}

function githubClient() {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GH_TOKEN is required to sync GitHub Actions and review telemetry");
  return new Octokit({ auth: token });
}

async function githubActionsEvents(): Promise<PostHogEvent[]> {
  const octokit = githubClient();
  const events: PostHogEvent[] = [];
  const runs = (
    await octokit.paginate(octokit.rest.actions.listWorkflowRunsForRepo, {
      owner,
      repo,
      per_page: 100,
      created: `>=${new Date(cutoff).toISOString()}`,
    })
  ).slice(0, githubLimit);
  for (const run of runs.slice(0, githubLimit)) {
    if (Date.parse(run.updated_at) < cutoff) break;
    if (run.status !== "completed") continue;
    const common = {
      repository,
      automation_platform: "github-actions",
      data_source: "github-actions-api",
      workflow_name: run.name ?? run.path,
      workflow_path: run.path,
      workflow_run_id: String(run.id),
      workflow_run_attempt: run.run_attempt,
      workflow_run_url: run.html_url,
      trigger: run.event,
      head_sha: run.head_sha,
      branch: run.head_branch,
      pull_request_number: run.pull_requests?.[0]?.number,
      conclusion: run.conclusion,
    };
    events.push(
      systemEvent(
        "ci workflow finished",
        `github-workflow:${run.id}:${run.run_attempt}:${run.updated_at}`,
        `ci-workflow:github:${run.id}`,
        {
          ...common,
          created_at: run.created_at,
          started_at: run.run_started_at,
          finished_at: run.updated_at,
          queue_duration_ms: durationMs(run.created_at, run.run_started_at),
          duration_ms: durationMs(run.run_started_at, run.updated_at),
          total_wall_duration_ms: durationMs(run.created_at, run.updated_at),
        },
        run.updated_at,
      ),
    );
    const jobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
      owner,
      repo,
      run_id: run.id,
      filter: "all",
      per_page: 100,
    });
    for (const job of jobs) {
      if (job.status !== "completed") continue;
      events.push(
        systemEvent(
          "ci job finished",
          `github-job:${job.id}:${job.completed_at}:${job.conclusion}`,
          `ci-job:github:${job.id}`,
          {
            ...common,
            job_id: String(job.id),
            job_name: job.name,
            job_url: job.html_url,
            runner_name: job.runner_name,
            runner_group_name: job.runner_group_name,
            started_at: job.started_at,
            finished_at: job.completed_at,
            duration_ms: durationMs(job.started_at, job.completed_at),
            conclusion: job.conclusion,
            step_count: job.steps?.length ?? 0,
            failed_step_count:
              job.steps?.filter(
                (step) => !["success", "skipped", "neutral"].includes(step.conclusion ?? ""),
              ).length ?? 0,
          },
          job.completed_at ?? run.updated_at,
        ),
      );
    }
  }

  return events;
}

async function githubReviewEvents(): Promise<PostHogEvent[]> {
  const octokit = githubClient();
  const events: PostHogEvent[] = [];
  const pulls = await recentPullRequests(octokit);
  for (const pull of pulls) {
    if (Date.parse(pull.updated_at) < cutoff) break;
    const checks = await octokit.paginate(octokit.rest.checks.listForRef, {
      owner,
      repo,
      ref: pull.head.sha,
      per_page: 100,
    });
    // Iterate Review is a GitHub App review, not a check-run. Capture the
    // review submission itself so the shared review model does not silently
    // cover Cursor while omitting our own bot.
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pull.number,
      per_page: 100,
    });
    const reviewSources = selectReviewSources(checks, reviews, pull.head.sha);
    if (reviewSources.checks.length === 0 && reviewSources.reviews.length === 0) continue;
    const threadCounts = await reviewThreadCounts(octokit, pull.number, pull.head.sha);
    events.push(
      ...buildReviewEvents({
        repository,
        pull,
        ...reviewSources,
        threadCounts,
        observedAt: new Date().toISOString(),
      }),
    );
  }
  return events;
}

async function recentPullRequests(octokit: Octokit) {
  const pulls: Awaited<ReturnType<typeof octokit.rest.pulls.list>>["data"] = [];
  for (let page = 1; pulls.length < githubLimit; page += 1) {
    const batch = (
      await octokit.rest.pulls.list({
        owner,
        repo,
        state: "all",
        sort: "updated",
        direction: "desc",
        per_page: 100,
        page,
      })
    ).data;
    for (const pull of batch) {
      if (Date.parse(pull.updated_at) < cutoff) return pulls;
      pulls.push(pull);
      if (pulls.length >= githubLimit) return pulls;
    }
    if (batch.length < 100) return pulls;
  }
  return pulls;
}

async function reviewThreadCounts(octokit: Octokit, pullRequestNumber: number, headSha: string) {
  type ReviewThreadPage = {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: Array<{
            isResolved: boolean;
            comments: {
              nodes: Array<{
                author: { login: string } | null;
                originalCommit: { oid: string } | null;
              }>;
            };
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    };
  };
  const threads: Array<
    NonNullable<ReviewThreadPage["repository"]["pullRequest"]>["reviewThreads"]["nodes"][number]
  > = [];
  let after: string | null = null;
  for (;;) {
    const result: ReviewThreadPage = await octokit.graphql(
      `query($owner:String!,$repo:String!,$number:Int!,$after:String) {
      repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
        reviewThreads(first:100,after:$after) { nodes { isResolved comments(first:1) {
          nodes { author { login } originalCommit { oid } }
        } } pageInfo { hasNextPage endCursor } }
      } }
    }`,
      { owner, repo, number: pullRequestNumber, after },
    );
    const page = result.repository.pullRequest?.reviewThreads;
    if (!page) break;
    threads.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
    after = page.pageInfo.endCursor;
  }
  const currentHeadThreads = threads.filter(
    (thread) => thread.comments.nodes[0]?.originalCommit?.oid === headSha,
  );
  const byProvider = new Map<string, number>();
  const unresolvedByProvider = new Map<string, number>();
  for (const thread of currentHeadThreads) {
    const author = thread.comments.nodes[0]?.author?.login;
    if (!author) continue;
    const provider = reviewProviderKey(author);
    byProvider.set(provider, (byProvider.get(provider) ?? 0) + 1);
    if (!thread.isResolved)
      unresolvedByProvider.set(provider, (unresolvedByProvider.get(provider) ?? 0) + 1);
  }
  return {
    total: currentHeadThreads.length,
    unresolved: currentHeadThreads.filter((thread) => !thread.isResolved).length,
    byProvider,
    unresolvedByProvider,
  };
}

type DepotDetail = {
  run: { run_id: string; trigger: string; head_sha: string };
  workflow: {
    workflow_id: string;
    workflow_path: string;
    name: string;
    status: string;
    error_message: string;
    created_at: string;
    started_at: string;
    finished_at: string;
  };
};
type DepotMetrics = {
  workflows: Array<{
    workflow: { workflow_id: string };
    jobs: Array<{
      job: {
        job_id: string;
        job_key: string;
        status: string;
        conclusion: string;
        created_at: string;
        started_at: string;
        finished_at: string;
      };
      attempts: Array<{
        attempt: {
          attempt_id: string;
          attempt: number;
          status: string;
          conclusion: string;
          created_at: string;
          started_at: string;
          finished_at: string;
        };
        availability?: { code?: string };
        stats?: {
          sample_count?: number;
          peak_cpu_utilization?: number;
          average_cpu_utilization?: number;
          peak_memory_utilization?: number;
          average_memory_utilization?: number;
        };
      }>;
    }>;
  }>;
};

async function depotEvents(): Promise<PostHogEvent[]> {
  const token = process.env.DEPOT_CI_TELEMETRY_TOKEN;
  if (!token && process.env.CI) {
    throw new Error(
      "DEPOT_CI_TELEMETRY_TOKEN is required for Depot timing and utilization telemetry",
    );
  }
  // Developer runs may use the Depot CLI's local login. CI uses a dedicated
  // organization API token scoped to this repository and workflow as a Depot
  // CI secret; Depot does not currently offer a read-only metrics token.
  const environment = token ? { ...process.env, DEPOT_TOKEN: token } : process.env;
  const list = await depotJson<Array<{ workflow_id: string; status: string; created_at: string }>>(
    [
      "ci",
      "workflow",
      "list",
      "--org",
      "0p91s0lz49",
      "--repo",
      repository,
      "--output",
      "json",
      "-n",
      "200",
    ],
    environment,
  );
  const limit = Number.parseInt(process.env.CI_TELEMETRY_DEPOT_LIMIT ?? "200", 10);
  const recent = list
    .filter(
      (workflow) => workflow.status !== "running" && Date.parse(workflow.created_at) >= cutoff,
    )
    .slice(0, limit);
  const details = await mapConcurrent(recent, 12, (item) =>
    depotJson<DepotDetail>(
      ["ci", "workflow", "show", item.workflow_id, "--org", "0p91s0lz49", "--output", "json"],
      environment,
    ),
  );
  const runIds = [...new Set(details.map((detail) => detail.run.run_id))];
  const metricsEntries = await mapConcurrent(
    runIds,
    8,
    async (runId) =>
      [
        runId,
        await depotJson<DepotMetrics>(
          ["ci", "metrics", "--run", runId, "--org", "0p91s0lz49", "--output", "json"],
          environment,
        ),
      ] as const,
  );
  const runMetrics = new Map(metricsEntries);
  const events: PostHogEvent[] = [];
  for (const detail of details) {
    const metrics = runMetrics.get(detail.run.run_id);
    if (!metrics) throw new Error(`Depot metrics missing for run ${detail.run.run_id}`);
    const workflowMetrics = metrics.workflows.find(
      (candidate) => candidate.workflow.workflow_id === detail.workflow.workflow_id,
    );
    const common = {
      repository,
      automation_platform: "depot",
      data_source: "depot-api",
      workflow_name: detail.workflow.name,
      workflow_path: detail.workflow.workflow_path,
      workflow_id: detail.workflow.workflow_id,
      workflow_run_id: detail.run.run_id,
      workflow_run_url: `https://depot.dev/orgs/0p91s0lz49/workflows/${detail.workflow.workflow_id}`,
      trigger: detail.run.trigger,
      head_sha: detail.run.head_sha,
    };
    events.push(
      systemEvent(
        "ci workflow finished",
        `depot-workflow:${detail.workflow.workflow_id}:${detail.workflow.finished_at}:${detail.workflow.status}`,
        `ci-workflow:depot:${detail.workflow.workflow_id}`,
        {
          ...common,
          status: detail.workflow.status,
          error_message: detail.workflow.error_message || undefined,
          created_at: detail.workflow.created_at,
          started_at: detail.workflow.started_at,
          finished_at: detail.workflow.finished_at,
          queue_duration_ms: durationMs(detail.workflow.created_at, detail.workflow.started_at),
          duration_ms: durationMs(detail.workflow.started_at, detail.workflow.finished_at),
          total_wall_duration_ms: durationMs(
            detail.workflow.created_at,
            detail.workflow.finished_at,
          ),
        },
        detail.workflow.finished_at,
      ),
    );
    for (const entry of workflowMetrics?.jobs ?? []) {
      const job = entry.job;
      events.push(
        systemEvent(
          "ci job finished",
          `depot-job:${job.job_id}:${job.finished_at}:${job.conclusion}`,
          `ci-job:depot:${job.job_id}`,
          {
            ...common,
            job_id: job.job_id,
            job_name: job.job_key,
            status: job.status,
            conclusion: job.conclusion,
            created_at: job.created_at,
            started_at: job.started_at,
            finished_at: job.finished_at,
            queue_duration_ms: durationMs(job.created_at, job.started_at),
            duration_ms: durationMs(job.started_at, job.finished_at),
            total_wall_duration_ms: durationMs(job.created_at, job.finished_at),
            attempt_count: entry.attempts.length,
          },
          job.finished_at,
        ),
      );
      for (const entryAttempt of entry.attempts) {
        const attempt = entryAttempt.attempt;
        events.push(
          systemEvent(
            "ci job attempt finished",
            `depot-attempt:${attempt.attempt_id}:${attempt.finished_at}:${attempt.conclusion}`,
            `ci-job-attempt:depot:${attempt.attempt_id}`,
            {
              ...common,
              job_id: job.job_id,
              job_name: job.job_key,
              attempt_id: attempt.attempt_id,
              attempt_number: attempt.attempt,
              status: attempt.status,
              conclusion: attempt.conclusion,
              created_at: attempt.created_at,
              started_at: attempt.started_at,
              finished_at: attempt.finished_at,
              queue_duration_ms: durationMs(attempt.created_at, attempt.started_at),
              duration_ms: durationMs(attempt.started_at, attempt.finished_at),
              total_wall_duration_ms: durationMs(attempt.created_at, attempt.finished_at),
              metrics_availability: entryAttempt.availability?.code,
              metrics_sample_count: entryAttempt.stats?.sample_count,
              peak_cpu_utilization: entryAttempt.stats?.peak_cpu_utilization,
              average_cpu_utilization: entryAttempt.stats?.average_cpu_utilization,
              peak_memory_utilization: entryAttempt.stats?.peak_memory_utilization,
              average_memory_utilization: entryAttempt.stats?.average_memory_utilization,
            },
            attempt.finished_at,
          ),
        );
      }
    }
  }
  return events;
}

async function depotJson<T>(args: string[], environment: NodeJS.ProcessEnv): Promise<T> {
  const { stdout } = await execFile("depot", args, {
    env: environment,
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

async function mapConcurrent<Input, Output>(
  inputs: Input[],
  concurrency: number,
  operation: (input: Input) => Promise<Output>,
) {
  const outputs = new Array<Output>(inputs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= inputs.length) return;
        outputs[index] = await operation(inputs[index]!);
      }
    }),
  );
  return outputs;
}

function summarize(events: PostHogEvent[]) {
  return Object.fromEntries(
    [...new Set(events.map((event) => event.event))].map((name) => [
      name,
      events.filter((event) => event.event === name).length,
    ]),
  );
}

await main();
