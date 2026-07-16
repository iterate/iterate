import { e2eWorkerUrl } from "./helpers.ts";

/**
 * Fail-fast reachability gate for the vitest e2e suite. The suites run
 * unconditionally against the playground named by WORKER_URL (deployed, as in
 * the preview CI lane) or the local `pnpm dev` server — there is deliberately
 * no env-var gate that could skip them silently (docs/testing.md#lanes). When
 * the target is down, fail once with one actionable error instead of a page
 * of identical per-test connection stacks.
 */
export default async function setup() {
  const url = e2eWorkerUrl();
  try {
    // Any HTTP response (including 401/redirect on admin-gated deployed
    // playgrounds) proves the target is up; only transport errors throw.
    await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new Error(
      `Streams playground is not reachable at ${url}. ` +
        "Start the local server (`pnpm dev` in apps/streams-example-app) or point WORKER_URL " +
        `at a deployed playground. Original error: ${String(error)}`,
    );
  }
}
