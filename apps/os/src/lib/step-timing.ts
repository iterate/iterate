import { tracing } from "cloudflare:workers";

/** Trace one awaited creation step. Project identity links background traces;
 * retain the completion log for unsampled requests and wrangler tail. */
export async function timedStep<T>(
  label: string,
  fields: Record<string, string | null | undefined>,
  step: string,
  fn: () => Promise<T>,
): Promise<T> {
  return tracing.enterSpan(`${label}.${step}`, async (span) => {
    for (const [key, value] of Object.entries(fields)) {
      if (value) span.setAttribute(`iterate.${key}`, value);
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
