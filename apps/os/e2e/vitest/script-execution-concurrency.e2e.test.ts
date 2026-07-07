/**
 * Repro for Cloudflare Dynamic Worker Loader owner-side saturation.
 *
 * Each runScript call below becomes a distinct inline Dynamic Worker source.
 * On deployed Workers, five concurrent long-lived script starts from one
 * capability-host DO currently trips "Too many concurrent dynamic workers".
 */
import { test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";

const SCRIPT_COUNT = 5;
const SCRIPT_HOLD_MS = 30_000;
const MAX_CONCURRENT_COMPLETION_MS = 50_000;

test(
  "concurrent long-running ITX scripts all complete",
  { timeout: 90_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "script-concurrency" });
    using itx = handle.itx();

    const marker = crypto.randomUUID();
    const startedAt = Date.now();
    const executions = await Promise.allSettled(
      Array.from({ length: SCRIPT_COUNT }, (_, index) =>
        itx.capabilityHost.runScript(`async () => {
          const marker = ${JSON.stringify(marker)};
          const index = ${index};
          await new Promise((resolve) => setTimeout(resolve, ${SCRIPT_HOLD_MS}));
          return { index, marker };
        }`),
      ),
    );
    const elapsedMs = Date.now() - startedAt;

    expect(formatSettledExecutions(executions)).toEqual({
      fulfilled: Array.from({ length: SCRIPT_COUNT }, (_, index) => ({
        index,
        marker,
      })),
      rejected: [],
    });
    expect(elapsedMs).toBeLessThan(MAX_CONCURRENT_COMPLETION_MS);
  },
);

function formatSettledExecutions(executions: PromiseSettledResult<{ result: unknown }>[]): {
  fulfilled: unknown[];
  rejected: string[];
} {
  return {
    fulfilled: executions
      .filter((execution) => execution.status === "fulfilled")
      .map((execution) => execution.value.result),
    rejected: executions
      .filter((execution) => execution.status === "rejected")
      .map((execution) =>
        execution.reason instanceof Error ? execution.reason.message : String(execution.reason),
      ),
  };
}
