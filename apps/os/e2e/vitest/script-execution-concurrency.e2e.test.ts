/**
 * Regression coverage for Cloudflare Dynamic Worker Loader owner-side
 * saturation.
 *
 * Each runScript call below becomes a distinct inline Dynamic Worker source.
 * On deployed Workers, twenty concurrent long-lived scripts from one
 * capability-host scope must all complete instead of sharing one Durable Object
 * as the dynamic-loader owner and tripping "Too many concurrent dynamic
 * workers".
 */
import { test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";
import { itxScript } from "../test-support/itx-script-builder.ts";

const SCRIPT_COUNT = 20;
const SCRIPT_HOLD_MS = 30_000;
// Temporary allowance for the cold worker-bundler path under full preview
// load. tasks/restore-itx-script-concurrency-budget.md owns returning this to
// the original 50-second concurrency regression budget.
const MAX_CONCURRENT_COMPLETION_MS = 80_000;

test(
  "concurrent long-running itx scripts all complete",
  { timeout: 120_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "script-concurrency" });
    using itx = handle.itx();

    const marker = crypto.randomUUID();
    const startedAt = Date.now();
    const executions = await Promise.allSettled(
      Array.from({ length: SCRIPT_COUNT }, (_, index) =>
        itxScript(itx.capabilityHost)
          .vars({ holdMs: SCRIPT_HOLD_MS, index, marker })
          .execute(async (_itx, vars) => {
            await new Promise((resolve) => setTimeout(resolve, vars.holdMs));
            return { index: vars.index, marker: vars.marker };
          }),
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

function formatSettledExecutions(
  executions: PromiseSettledResult<{ success(): { index: number; marker: string } }>[],
): {
  fulfilled: unknown[];
  rejected: string[];
} {
  return {
    fulfilled: executions
      .filter((execution) => execution.status === "fulfilled")
      .map((execution) => execution.value.success()),
    rejected: executions
      .filter((execution) => execution.status === "rejected")
      .map((execution) =>
        execution.reason instanceof Error ? execution.reason.message : String(execution.reason),
      ),
  };
}
