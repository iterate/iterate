export type PlaybackCounterPolicyViolationProblem =
  | "counter-regressed"
  | "counter-saturated"
  | "invalid-baseline"
  | "invalid-current"
  | "maximum-delta-exceeded"
  | "missing-baseline"
  | "missing-current";

export interface PlaybackCounterPolicyViolation {
  baseline: number | null;
  counter: string;
  current: number | null;
  delta: number | null;
  maximumDelta: number;
  problem: PlaybackCounterPolicyViolationProblem;
}

export type PlaybackCounterPolicyAssessment =
  | { kind: "healthy" }
  | {
      baseline: Readonly<Record<string, unknown>>;
      current: Readonly<Record<string, unknown>>;
      kind: "failure";
      maximumDeltas: Readonly<Record<string, number>>;
      reason: string;
      violations: PlaybackCounterPolicyViolation[];
    };

const uint32Maximum = 0xffff_ffff;

/**
 * Judges monotonic playback counters while a physical proof is still running.
 *
 * This is deliberately separate from the final endurance manifest. The final
 * judge remains authoritative, but a one-hertz device callback may already
 * prove that a no-loss invariant was violated. Continuing to stream and record
 * after that point adds unrelated evidence, delays diagnosis, and can obscure
 * the incident under later recovery. The caller therefore arms this evaluator
 * with one parsed pre-run snapshot and treats any returned failure as terminal.
 *
 * Historical nonzero values are allowed: the proof is scoped by deltas, not by
 * an assumption that the device was freshly flashed. Missing, malformed,
 * regressed, or saturated values fail closed because none can prove that the
 * configured maximum delta held during this run.
 */
export function assessPlaybackCounterPolicy(options: {
  baseline: Readonly<Record<string, unknown>>;
  current: Readonly<Record<string, unknown>>;
  maximumDeltas: Readonly<Record<string, number>>;
}): PlaybackCounterPolicyAssessment {
  const violations: PlaybackCounterPolicyViolation[] = [];

  for (const counter of Object.keys(options.maximumDeltas).sort()) {
    const maximumDelta = options.maximumDeltas[counter]!;
    if (!Number.isSafeInteger(maximumDelta) || maximumDelta < 0) {
      throw new Error(
        `Playback counter policy maximum for ${counter} must be a nonnegative safe integer.`,
      );
    }
    const baseline = options.baseline[counter];
    const current = options.current[counter];
    if (baseline === undefined) {
      violations.push(
        violation(counter, maximumDelta, "missing-baseline", null, numericOrNull(current), null),
      );
      continue;
    }
    if (!isUint32(baseline)) {
      violations.push(
        violation(counter, maximumDelta, "invalid-baseline", null, numericOrNull(current), null),
      );
      continue;
    }
    if (current === undefined) {
      violations.push(violation(counter, maximumDelta, "missing-current", baseline, null, null));
      continue;
    }
    if (!isUint32(current)) {
      violations.push(violation(counter, maximumDelta, "invalid-current", baseline, null, null));
      continue;
    }
    if (baseline === uint32Maximum || current === uint32Maximum) {
      violations.push(
        violation(
          counter,
          maximumDelta,
          "counter-saturated",
          baseline,
          current,
          current - baseline,
        ),
      );
      continue;
    }
    const delta = current - baseline;
    if (delta < 0) {
      violations.push(
        violation(counter, maximumDelta, "counter-regressed", baseline, current, delta),
      );
      continue;
    }
    if (delta > maximumDelta) {
      violations.push(
        violation(counter, maximumDelta, "maximum-delta-exceeded", baseline, current, delta),
      );
    }
  }

  if (violations.length === 0) return { kind: "healthy" };
  return {
    /*
     * A violation list is sufficient to stop the run but insufficient to
     * diagnose it: the coherent callback also contains timing maxima, queue
     * depths, heap, CPU, and stack evidence that may never recur. Snapshot all
     * three policy inputs now so the existing JSON terminal log preserves that
     * exact incident. These are host-side objects with scalar values; no
     * device memory or wire schema is added.
     */
    baseline: { ...options.baseline },
    current: { ...options.current },
    kind: "failure",
    maximumDeltas: { ...options.maximumDeltas },
    reason: `Playback proof counter policy failed: ${violations
      .map(describeViolation)
      .join("; ")}.`,
    violations,
  };
}

function isUint32(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= uint32Maximum;
}

function numericOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function violation(
  counter: string,
  maximumDelta: number,
  problem: PlaybackCounterPolicyViolationProblem,
  baseline: number | null,
  current: number | null,
  delta: number | null,
): PlaybackCounterPolicyViolation {
  return {
    baseline,
    counter,
    current,
    delta,
    maximumDelta,
    problem,
  };
}

function describeViolation(violation: PlaybackCounterPolicyViolation) {
  switch (violation.problem) {
    case "counter-regressed":
      return `${violation.counter} regressed by ${Math.abs(violation.delta ?? 0)}`;
    case "counter-saturated":
      return `${violation.counter} saturated at UINT32_MAX`;
    case "invalid-baseline":
      return `${violation.counter} has an invalid baseline`;
    case "invalid-current":
      return `${violation.counter} has an invalid current value`;
    case "maximum-delta-exceeded":
      return `${violation.counter} delta ${violation.delta} exceeds ${violation.maximumDelta}`;
    case "missing-baseline":
      return `${violation.counter} is missing from the baseline`;
    case "missing-current":
      return `${violation.counter} is missing from the current snapshot`;
  }
}
