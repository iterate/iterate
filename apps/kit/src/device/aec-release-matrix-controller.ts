import type { AecReleaseFixturePhase, AecReleaseFixturePlan } from "./aec-release-fixture-plan.ts";

type AwaitSourceCompletion = () => Promise<void>;

interface MatrixClock {
  now(): number;
  wait(durationMs: number): Promise<void>;
}

export interface AecReleaseMatrixAdapter {
  beginPhase(phase: AecReleaseFixturePhase): Promise<void>;
  capturePhase(phase: AecReleaseFixturePhase): Promise<void>;
  endPhase(phase: AecReleaseFixturePhase): Promise<void>;
  performLifecycleAction(phase: AecReleaseFixturePhase): Promise<void>;
  sourcesStarted(phase: AecReleaseFixturePhase): Promise<void>;
  startFarSource(phase: AecReleaseFixturePhase): Promise<AwaitSourceCompletion>;
  startNearSource(phase: AecReleaseFixturePhase): Promise<AwaitSourceCompletion>;
}

/**
 * Executes the immutable matrix while target adapters own only physical I/O.
 *
 * HAVPE and StackChan differ in codec/AEC hardware, not in which experiments
 * constitute release evidence. Keeping iteration and source choreography here
 * prevents either target from reimplementing the matrix or silently omitting
 * a phase. Completion callbacks are awaited before the durable end marker, so
 * a late provider or afplay failure leaves an honestly partial phase.
 */
export async function runAecReleaseMatrixController(
  plan: AecReleaseFixturePlan,
  adapter: AecReleaseMatrixAdapter,
  clock: MatrixClock = monotonicMatrixClock,
): Promise<void> {
  for (const phase of plan.phases) {
    if (phase.lifecycleAction !== null) await adapter.performLifecycleAction(phase);
    await adapter.beginPhase(phase);
    const completions: AwaitSourceCompletion[] = [];
    if (phase.farSource !== null) completions.push(await adapter.startFarSource(phase));
    if (phase.nearSource !== null) completions.push(await adapter.startNearSource(phase));
    await adapter.sourcesStarted(phase);
    const phaseStartedAtMs = clock.now();
    await adapter.capturePhase(phase);
    await Promise.all(completions.map((complete) => complete()));
    /*
     * Duration belongs to the shared experiment, not a target adapter. In
     * particular, ambient has no source completion to keep it open, and a
     * short trace buffer must not silently shorten an eight-second physical
     * phase. Source completion may legitimately overrun the nominal boundary;
     * retain that overrun instead of cancelling physical playback to make the
     * manifest look punctual.
     */
    const remainingMs = phase.durationMs - (clock.now() - phaseStartedAtMs);
    if (remainingMs > 0) await clock.wait(remainingMs);
    await adapter.endPhase(phase);
  }
}

const monotonicMatrixClock: MatrixClock = {
  now: () => performance.now(),
  wait: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
};
