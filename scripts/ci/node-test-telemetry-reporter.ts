import { relative } from "node:path";
import type { TestEvent } from "node:test/reporters";
import { readPostHogConfig, sendPostHogEvents, systemEvent } from "./posthog-events.ts";

type ResultEvent = Extract<TestEvent, { type: "test:pass" | "test:fail" }>;

/**
 * Silent secondary reporter for Node's native test runner. The normal `spec`
 * reporter still owns console output; this reporter only emits the same CI
 * test events used by Vitest and Playwright.
 */
export default async function* nodeTestTelemetryReporter(source: AsyncIterable<TestEvent>) {
  const attempts = new Map<string, ResultEvent[][]>();
  let summary: Extract<TestEvent, { type: "test:summary" }> | undefined;

  for await (const event of source) {
    if (event.type === "test:pass" || event.type === "test:fail") {
      if (event.data.details.type !== "suite") {
        // Node's name is only the leaf title, locations can point at a shared
        // helper, and testNumber is only ordinal within the parent. Preserve
        // every first attempt as a distinct observation. Only Node's explicit
        // rerun attempt number is allowed to join two result events.
        const key = testIdentityCandidate(event);
        const observations = attempts.get(key) ?? [];
        const attempt = event.data.details.attempt;
        if (attempt === undefined || attempt === 0) {
          observations.push([event]);
        } else {
          const observation = observations.find(
            (candidate) => (candidate.at(-1)?.data.details.attempt ?? 0) === attempt - 1,
          );
          if (!observation) {
            throw new Error(
              `Node test telemetry received rerun attempt ${attempt} without its prior attempt: ${key}`,
            );
          }
          observation.push(event);
        }
        attempts.set(key, observations);
      }
    } else if (event.type === "test:summary" && event.data.file === undefined) {
      summary = event;
    }
  }

  if (process.env.TEST_TELEMETRY_ENABLED !== "1") return;
  if (!summary) throw new Error("Node test telemetry did not receive a run summary");
  const observedTestCount = [...attempts.values()].reduce(
    (count, observations) => count + observations.length,
    0,
  );
  if (observedTestCount !== summary.data.counts.tests) {
    throw new Error(
      `Node test telemetry completeness failure: observed ${observedTestCount} tests, summary reported ${summary.data.counts.tests}`,
    );
  }

  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
  const workspace =
    process.env.TEST_TELEMETRY_WORKSPACE ?? process.env.npm_package_name ?? process.cwd();
  const distinctId = `ci-test:${runId}:${runAttempt}:${workspace}:node-test`;
  const repositoryRoot = process.env.GITHUB_WORKSPACE;
  const common = {
    repository: process.env.GITHUB_REPOSITORY ?? "iterate/iterate",
    framework: "node-test",
    test_kind: process.env.TEST_TELEMETRY_KIND ?? "unit",
    lane: process.env.TEST_TELEMETRY_LANE ?? "unit",
    workspace,
    head_sha: process.env.GITHUB_SHA,
    branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME,
    workflow_name: process.env.GITHUB_WORKFLOW,
    workflow_run_id: runId,
    workflow_run_attempt: runAttempt,
    pull_request_number: pullRequestNumber(process.env.GITHUB_REF),
    runner_provider: process.env.DEPOT_JOB_URL ? "depot" : "github-actions",
    execution_context: process.env.GITHUB_RUN_ID ? "ci" : "local",
    depot_job_url: process.env.DEPOT_JOB_URL,
  };
  const events = [];
  for (const [key, observations] of attempts) {
    for (const [observationIndex, testAttempts] of observations.entries()) {
      const final = testAttempts.at(-1)!;
      const moduleId = normalizeModuleId(final.data.file, repositoryRoot);
      const finalState = testState(final);
      const shared = {
        ...common,
        test_name: final.data.name,
        test_module: moduleId,
        test_number: final.data.testNumber,
        test_line: final.data.line,
      };
      events.push(
        systemEvent(
          "ci test finished",
          `${distinctId}:test:${key}:${observationIndex}`,
          distinctId,
          {
            ...shared,
            test_state: finalState,
            duration_ms: final.data.details.duration_ms,
            retry_count: Math.max(0, testAttempts.length - 1),
            passed_after_retry: finalState === "passed" && testAttempts.length > 1,
            error_count: final.type === "test:fail" ? 1 : 0,
            error_name: final.type === "test:fail" ? final.data.details.error.name : undefined,
            error_message:
              final.type === "test:fail"
                ? String(final.data.details.error.message).slice(0, 2_000)
                : undefined,
          },
        ),
      );
      for (const [index, attempt] of testAttempts.entries()) {
        events.push(
          systemEvent(
            "ci test attempt finished",
            `${distinctId}:attempt:${key}:${observationIndex}:${index}`,
            distinctId,
            {
              ...shared,
              attempt_index: index,
              is_retry: index > 0,
              test_state: testState(attempt),
              duration_ms: attempt.data.details.duration_ms,
            },
          ),
        );
      }
    }
  }
  events.push(
    systemEvent("ci test run finished", `${distinctId}:run`, distinctId, {
      ...common,
      status: summary.data.success ? "passed" : "failed",
      duration_ms: summary.data.duration_ms,
      test_count: summary.data.counts.tests,
      failed_test_count:
        summary.data.counts.tests - summary.data.counts.passed - summary.data.counts.skipped,
      skipped_test_count: summary.data.counts.skipped,
    }),
  );
  await sendPostHogEvents(events, readPostHogConfig());
  // Node's reporter contract requires an async iterator. Human output comes
  // from the parallel `spec` reporter, so this destination stays silent.
  yield "";
}

function testIdentityCandidate(event: ResultEvent) {
  return [
    event.data.file ?? "unknown",
    event.data.line ?? 0,
    event.data.column ?? 0,
    event.data.nesting,
    event.data.testNumber,
    event.data.name,
  ].join(":");
}

function testState(event: ResultEvent) {
  if (event.data.skip) return "skipped";
  if (event.data.todo) return "todo";
  return event.type === "test:pass" ? "passed" : "failed";
}

function normalizeModuleId(moduleId: string | undefined, repositoryRoot: string | undefined) {
  if (!moduleId) return "unknown";
  return repositoryRoot && moduleId.startsWith(repositoryRoot)
    ? relative(repositoryRoot, moduleId)
    : moduleId;
}

function pullRequestNumber(githubRef: string | undefined): number | undefined {
  const match = githubRef?.match(/^refs\/pull\/(\d+)\/(?:merge|head)$/u);
  return match ? Number(match[1]) : undefined;
}
