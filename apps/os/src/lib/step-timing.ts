import { tracing } from "cloudflare:workers";

/** Time one creation step, including its awaited work. Project identity lets
 * operators find related spans even when an alarm continues in another trace.
 * Keep the structured completion log for unsampled invocations and tail users. */
export async function timedStep<T>(
  label: string,
  fields: Record<string, string | number | null | undefined>,
  step: string,
  fn: () => Promise<T>,
): Promise<T> {
  return tracing.enterSpan(`${label}.${step}`, async (span) => {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== null) span.setAttribute(`iterate.${key}`, value);
    }
    span.setAttribute("iterate.step", step);
    const start = Date.now();
    let ok = true;
    try {
      return await fn();
    } catch (error) {
      ok = false;
      throw error;
    } finally {
      span.setAttribute("iterate.outcome", ok ? "ok" : "error");
      console.log(`[${label}]`, JSON.stringify({ ...fields, step, ms: Date.now() - start, ok }));
    }
  });
}
