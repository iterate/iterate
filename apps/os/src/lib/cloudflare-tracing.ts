import { tracing } from "cloudflare:workers";

type ApplicationSpan = {
  setAttribute(name: string, value: boolean | number | string): void;
};

const NOOP_SPAN: ApplicationSpan = { setAttribute() {} };

/**
 * Use Workers custom spans in production while keeping transport-free domain
 * harnesses runnable in plain Node, whose cloudflare:workers shim has no tracer.
 * This fallback is deliberately not sampling: the Workers runtime records every
 * invocation and span; only the test shim receives the no-op span.
 */
export function enterCloudflareSpan<T>(
  name: string,
  callback: (span: ApplicationSpan) => Promise<T>,
): Promise<T> {
  return tracing?.enterSpan(name, callback) ?? callback(NOOP_SPAN);
}
