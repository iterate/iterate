/**
 * A fast-forward import must retain the Artifacts branch's previous head so
 * the ensuing queue event can diff `before` against `after`. GitHub's compare
 * response tells us exactly how many commits lead from the old head to the
 * new one; cloning that count plus the old head is the smallest safe history.
 * A caller-provided depth is a lower bound, never permission to drop the
 * commit needed by downstream projections.
 */
export function githubFastForwardTransferDepth(input: {
  aheadBy: number;
  requestedDepth?: number;
}): number {
  if (!Number.isInteger(input.aheadBy) || input.aheadBy < 1) {
    throw new Error(
      `GitHub fast-forward aheadBy must be a positive integer, got ${input.aheadBy}.`,
    );
  }
  return Math.max(input.requestedDepth ?? 1, input.aheadBy + 1);
}
