export type E2ePhaseAnnotator = (message: string, type?: string) => Promise<unknown>;

/** Records an observed or derived phase without wrapping an operation. */
export function annotateE2ePhase(
  annotate: E2ePhaseAnnotator,
  phase: {
    name: string;
    category: string;
    durationMs: number;
    startedAt?: Date | string;
  },
) {
  return annotate(
    JSON.stringify({
      ...phase,
      startedAt: phase.startedAt instanceof Date ? phase.startedAt.toISOString() : phase.startedAt,
    }),
    "e2e-phase",
  );
}

/** Records one named operation for Vitest telemetry, including failed partial phases. */
export async function measureE2ePhase<Value>(
  annotate: E2ePhaseAnnotator,
  name: string,
  category: string,
  operation: () => Promise<Value>,
): Promise<Value> {
  const startedAt = new Date();
  const startedAtPerformance = performance.now();
  const recordPhase = () =>
    annotateE2ePhase(annotate, {
      name,
      category,
      startedAt,
      durationMs: performance.now() - startedAtPerformance,
    });
  let result: Value;
  try {
    result = await operation();
  } catch (operationError) {
    try {
      await recordPhase();
    } catch (annotationError) {
      console.error("[e2e-telemetry] failed to annotate an already-failed phase:", annotationError);
    }
    throw operationError;
  }
  await recordPhase();
  return result;
}
