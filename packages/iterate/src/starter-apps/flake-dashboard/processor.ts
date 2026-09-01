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
            lanes: existing?.lanes.includes(event.payload.lane)
              ? existing.lanes
              : [...(existing?.lanes || []), event.payload.lane],
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
