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
import {
  annotateE2ePhase,
  measureE2ePhase,
} from "@iterate-com/shared/test-support/measure-e2e-phase";
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
  async ({ annotate, expect }) => {
    const measurePhase = <Value>(name: string, category: string, operation: () => Promise<Value>) =>
      measureE2ePhase(annotate, name, category, operation);

    await using handle = await measurePhase("create test project", "fixture", () =>
      createTestProject({ slugPrefix: "script-concurrency" }),
    );
    using itx = handle.itx();

    const marker = crypto.randomUUID();
    const startedAt = performance.now();
    let executionDurationMs = 0;
    const executions = await measurePhase("execute concurrent scripts", "operation", async () => {
      const executionStartedAt = performance.now();
      const settled = await Promise.allSettled(
        Array.from({ length: SCRIPT_COUNT }, (_, index) =>
          itxScript(itx.capabilityHost)
            .vars({ holdMs: SCRIPT_HOLD_MS, index, marker })
            .execute(async (_itx, vars) => {
              await new Promise((resolve) => setTimeout(resolve, vars.holdMs));
              return { index: vars.index, marker: vars.marker };
            })
            .then((result) => ({ result, observedSettledAtMs: performance.now() })),
        ),
      );
      executionDurationMs = performance.now() - executionStartedAt;
      return settled;
    });
    const elapsedMs = performance.now() - startedAt;
    const { fulfilled, observedSettledAtMs, rejected } = formatSettledExecutions(executions);
    if (observedSettledAtMs.length > 1) {
      await annotateE2ePhase(annotate, {
        name: "client-observed completion spread",
        category: "client-observation",
        durationMs: Math.max(...observedSettledAtMs) - Math.min(...observedSettledAtMs),
      });
    }
    await annotateE2ePhase(annotate, {
      name: "configured deliberate remote hold",
      category: "configured-delay",
      durationMs: SCRIPT_HOLD_MS,
    });
    await annotateE2ePhase(annotate, {
      name: "non-hold execution overhead",
      category: "derived-overhead",
      durationMs: Math.max(0, executionDurationMs - SCRIPT_HOLD_MS),
    });

    expect({ fulfilled, rejected }).toEqual({
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
  executions: PromiseSettledResult<{
    result: { success(): { index: number; marker: string } };
    observedSettledAtMs: number;
  }>[],
): {
  fulfilled: Array<{ index: number; marker: string }>;
  observedSettledAtMs: number[];
  rejected: string[];
} {
  const successful = executions
    .filter((execution) => execution.status === "fulfilled")
    .map((execution) => ({
      ...execution.value.result.success(),
      observedSettledAtMs: execution.value.observedSettledAtMs,
    }));
  return {
    fulfilled: successful.map(({ index, marker }) => ({ index, marker })),
    observedSettledAtMs: successful.map(({ observedSettledAtMs }) => observedSettledAtMs),
    rejected: executions
      .filter((execution) => execution.status === "rejected")
      .map((execution) =>
        execution.reason instanceof Error ? execution.reason.message : String(execution.reason),
      ),
  };
}
