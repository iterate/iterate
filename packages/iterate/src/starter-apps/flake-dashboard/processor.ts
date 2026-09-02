import type { Project } from "../../sdk.ts";
import {
  isIdempotencyConflict,
  StreamProcessor,
  type EmittedInput,
  type ProcessEventArgs,
  type ReduceArgs,
} from "../../processors/index.ts";
import {
  FlakeDashboardProcessorContract,
  flakeEventTypes,
  flakeTransitionThresholds,
  type FlakeDashboardRenderResult,
  type FlakeDashboardState,
} from "./contract.ts";

type FlakeDashboardProcessorDeps = {
  /**
   * Upsert the GitHub dashboard issue from folded state. Injected so the
   * harness tests run against a fake; the worker builds the real one over
   * itx's GitHub integration. Throwing settles the render as failed.
   */
  renderDashboard: (
    state: FlakeDashboardState,
  ) => Promise<Extract<FlakeDashboardRenderResult, { status: "succeeded" }>>;
};

/**
 * One instance runs on the project's `/flakes` stream. CI appends
 * `run-recorded` events; this processor folds them into per-test stats, owns
 * the GitHub issue render as its durable obligation, and proposes lifecycle
 * transitions when a default-branch streak crosses a threshold.
 */
export class FlakeDashboardProcessor extends StreamProcessor<
  FlakeDashboardProcessorContract,
  FlakeDashboardProcessorDeps
> {
  readonly contract = FlakeDashboardProcessorContract;

  /**
   * Runtime-only render attempt guard. The render-settled stream event is the
   * durable truth: after an eviction this is false and the next caught-up
   * pass re-drives any still-unrendered data.
   */
  #liveRender = false;

  protected override reduce({
    event,
    state,
  }: ReduceArgs<FlakeDashboardProcessorContract>): FlakeDashboardState {
    switch (event.type) {
      case flakeEventTypes.created:
        if (state.birthCertificate !== null) return state;
        return { ...state, birthCertificate: event.payload, lastDataOffset: event.offset };

      case flakeEventTypes.runRecorded: {
        const config = state.birthCertificate?.config;
        if (config === undefined) return state;
        const onDefaultBranch = event.payload.branch === config.defaultBranch;
        const tests = { ...state.tests };
        for (const record of event.payload.records) {
          const existing = tests[record.name];
          const counts = existing?.counts || { pass: 0, flakeFail: 0, unexpectedError: 0 };
          const streak = existing?.defaultBranchStreak || null;
          const nextStreak = !onDefaultBranch
            ? streak
            : record.outcome === "unexpected-error"
              ? null
              : streak !== null && streak.outcome === record.outcome
                ? { ...streak, runs: streak.runs + 1, lastAt: record.at }
                : { outcome: record.outcome, runs: 1, firstAt: record.at, lastAt: record.at };
          tests[record.name] = {
            pattern: record.pattern,
            suites: existing?.suites.includes(event.payload.suite)
              ? existing.suites
              : [...(existing?.suites || []), event.payload.suite],
            counts: {
              pass: counts.pass + (record.outcome === "pass" ? 1 : 0),
              flakeFail: counts.flakeFail + (record.outcome === "flake-fail" ? 1 : 0),
              unexpectedError:
                counts.unexpectedError + (record.outcome === "unexpected-error" ? 1 : 0),
            },
            lastFlakeAt:
              record.outcome === "flake-fail" ? record.at : existing?.lastFlakeAt || null,
            lastRecordedAt: record.at,
            defaultBranchStreak: nextStreak,
            proposed: existing?.proposed || [],
          };
        }
        return { ...state, tests, lastDataOffset: event.offset };
      }

      case flakeEventTypes.transitionProposed: {
        const test = state.tests[event.payload.testName];
        if (test === undefined) return { ...state, lastDataOffset: event.offset };
        const marker = `${event.payload.transition}:${event.payload.evidence.firstAt}`;
        return {
          ...state,
          tests: {
            ...state.tests,
            [event.payload.testName]: {
              ...test,
              proposed: test.proposed.includes(marker) ? test.proposed : [...test.proposed, marker],
            },
          },
          lastDataOffset: event.offset,
        };
      }

      case flakeEventTypes.dashboardRenderSettled: {
        // Deliberately does NOT bump lastDataOffset — a settled render must
        // not itself demand another render.
        if (event.payload.result.status !== "succeeded") return state;
        return {
          ...state,
          render: {
            throughOffset: event.payload.throughOffset,
            issueNumber: event.payload.result.issueNumber,
            issueUrl: event.payload.result.issueUrl,
          },
        };
      }
    }
  }

  protected override processEvent(
    args: ProcessEventArgs<FlakeDashboardProcessorContract>,
  ): undefined {
    const { append, blockProcessorWhile, delivery, event, runInBackground, state } = args;

    // Transition proposals are short durable appends that must land before
    // the processor advances past the run that crossed the threshold.
    if (event?.type === flakeEventTypes.runRecorded) {
      for (const [testName, test] of Object.entries(state.tests)) {
        const streak = test.defaultBranchStreak;
        if (streak === null) continue;
        const transition = streak.outcome === "pass" ? "unwrap" : "switch-to-failing";
        const threshold = flakeTransitionThresholds[transition];
        const spanMs = Date.parse(streak.lastAt) - Date.parse(streak.firstAt);
        if (streak.runs < threshold.runs || spanMs < threshold.minSpanMs) continue;
        const marker = `${transition}:${streak.firstAt}`;
        if (test.proposed.includes(marker)) continue;
        blockProcessorWhile(() =>
          this.#appendTolerantOfSettledRace(append, {
            type: flakeEventTypes.transitionProposed,
            // The streak's firstAt keys the proposal: as the streak keeps
            // growing, later runs re-derive the same key with fresher
            // evidence and lose the idempotency race below — one proposal
            // per streak.
            idempotencyKey: this.idempotencyKey(`transition:${testName}:${marker}`),
            payload: {
              testName,
              transition,
              evidence: {
                consecutiveRuns: streak.runs,
                firstAt: streak.firstAt,
                lastAt: streak.lastAt,
              },
            },
          }),
        );
      }
    }

    // Behind head, newer data (or an already-settled render) may exist in an
    // unseen page; rendering from partial state would thrash the issue.
    if (!delivery.caughtUp) return;
    if (state.birthCertificate === null) return;
    if (state.lastDataOffset <= (state.render?.throughOffset || 0)) return;
    if (this.#liveRender) return;

    const throughOffset = state.lastDataOffset;
    this.#liveRender = true;
    // A dropped attempt is recovered from the still-unrendered comparison on
    // the next caught-up/revival pass; the issue upsert itself is idempotent
    // (one issue, body overwritten), so a settle-append that never landed
    // only costs one redundant render.
    runInBackground(async () => {
      let result: FlakeDashboardRenderResult;
      try {
        result = await this.deps.renderDashboard(state);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = { status: "failed", error: message.slice(0, 8_000) || "Unknown render failure." };
      }
      try {
        await this.#appendTolerantOfSettledRace(append, {
          type: flakeEventTypes.dashboardRenderSettled,
          // The status is part of the key: a failed settlement must not claim
          // the offset's only key, or a retried render's SUCCESS at the same
          // offset would idempotency-conflict forever and the offset could
          // never be marked rendered.
          idempotencyKey: this.idempotencyKey(`dashboard-render:${throughOffset}:${result.status}`),
          payload: { throughOffset, result },
        });
      } finally {
        this.#liveRender = false;
      }
    });
  }

  /**
   * Growing streaks and overlapping render attempts can race on one
   * processor-owned key with fresher bodies. The first committed fact wins;
   * a same-key/different-body rejection means the work is already settled.
   */
  async #appendTolerantOfSettledRace(
    append: ProcessEventArgs<FlakeDashboardProcessorContract>["append"],
    event: EmittedInput<FlakeDashboardProcessorContract>,
  ): Promise<void> {
    try {
      await append(event);
    } catch (error) {
      if (!isIdempotencyConflict(error)) throw error;
    }
  }
}

const DASHBOARD_MARKER = "<!-- iterate-flake-dashboard -->";

/**
 * Upsert the GitHub "Flake dashboard" issue from folded state. Mechanical by
 * design (the AI-linter publication stance): all decisions were made when the
 * events reduced. The processor is the single writer, so a plain body
 * overwrite is race-free; the marker plus remembered issue number make the
 * upsert idempotent across retried renders.
 */
export async function renderFlakeDashboardIssue(
  itx: Project,
  state: FlakeDashboardState,
): Promise<Extract<FlakeDashboardRenderResult, { status: "succeeded" }>> {
  const config = state.birthCertificate?.config;
  if (config === undefined) throw new Error("Flake dashboard has no birth certificate.");

  const repos = await itx.repos.list();
  const links = await Promise.all(
    repos.map(async ({ path }) => (await itx.repos.get(path).processor.snapshot()).state.github),
  );
  const link = links.find(
    (candidate) =>
      candidate !== null &&
      candidate.owner === config.repository.owner &&
      candidate.repo === config.repository.repo,
  );
  if (link === null || link === undefined) {
    throw new Error(
      `No linked GitHub connection for ${config.repository.owner}/${config.repository.repo}; ` +
        "link a repo to that repository before the dashboard can render.",
    );
  }
  const octokit = itx.integrations.github.get(link.connection).octokit;
  const params = { owner: config.repository.owner, repo: config.repository.repo };
  const body = renderBody(state);

  const rememberedIssueNumber = state.render?.issueNumber || null;
  if (rememberedIssueNumber !== null) {
    const updated = await octokit.rest.issues.update({
      ...params,
      issue_number: rememberedIssueNumber,
      body,
      title: config.issueTitle,
    });
    return {
      status: "succeeded",
      issueNumber: rememberedIssueNumber,
      issueUrl: updated.data.html_url,
    };
  }

  // First render (or state predating a remembered number): find by marker
  // before creating — the marker, not the title, is authority, so a human
  // opening a same-titled issue cannot capture the dashboard.
  const issues = await octokit.paginate("GET /repos/{owner}/{repo}/issues", {
    ...params,
    state: "open",
    per_page: 100,
  });
  const existing = issues.find((issue) => issue.body?.includes(DASHBOARD_MARKER) === true);
  if (existing !== undefined) {
    await octokit.rest.issues.update({
      ...params,
      issue_number: existing.number,
      body,
      title: config.issueTitle,
    });
    return { status: "succeeded", issueNumber: existing.number, issueUrl: existing.html_url };
  }
  const created = await octokit.rest.issues.create({
    ...params,
    title: config.issueTitle,
    body,
  });
  return { status: "succeeded", issueNumber: created.data.number, issueUrl: created.data.html_url };
}

function renderBody(state: FlakeDashboardState): string {
  const tests = Object.entries(state.tests).sort(([a], [b]) => a.localeCompare(b));
  const lastRecordedAt = tests
    .map(([, test]) => test.lastRecordedAt)
    .sort()
    .at(-1);
  const rows = tests.map(([name, test]) => {
    const gated = test.counts.pass + test.counts.flakeFail;
    const rate = gated === 0 ? "—" : `${Math.round((test.counts.flakeFail / gated) * 100)}%`;
    const streak =
      test.defaultBranchStreak === null
        ? "—"
        : `${test.defaultBranchStreak.runs}× ${test.defaultBranchStreak.outcome}`;
    return [
      `\`${name}\``,
      `\`/${test.pattern}/\``,
      test.suites.join(", "),
      String(gated + test.counts.unexpectedError),
      rate,
      test.lastFlakeAt || "never",
      streak,
      test.proposed.length === 0 ? "" : test.proposed.map((p) => p.split(":")[0]).join(", "),
    ].join(" | ");
  });
  return [
    DASHBOARD_MARKER,
    "Per-test outcomes of every [`createFlake`](https://github.com/iterate/iterate/blob/main/packages/shared/src/test-support/flake-test.ts)-wrapped test, folded from CI-reported runs. Maintained automatically — edits to this body will be overwritten.",
    "",
    "test | allowed pattern | suites | runs | flake rate | last flake | default-branch streak | proposed",
    "--- | --- | --- | --- | --- | --- | --- | ---",
    ...(rows.length === 0 ? ["_no flake tests recorded yet_ | | | | | | |"] : rows),
    "",
    `_Last recorded outcome: ${lastRecordedAt || "none"}._`,
  ].join("\n");
}
