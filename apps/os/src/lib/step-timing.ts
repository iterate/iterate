/**
 * Log a single structured timing line for one awaited saga step.
 *
 * Emits `[<label>] {"...fields, step, ms}` on completion (success or failure),
 * so `wrangler tail --format json | grep create-timing` reconstructs per-step
 * saga cost on any deployment. Deliberately console.log-only: creates are rare
 * and the lines are the cheapest instrument that survives production.
 */
export async function timedStep<T>(
  label: string,
  fields: Record<string, string | null | undefined>,
  step: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  let ok = true;
  try {
    return await fn();
  } catch (error) {
    ok = false;
    throw error;
  } finally {
    console.log(`[${label}]`, JSON.stringify({ ...fields, step, ms: Date.now() - start, ok }));
  }
}
