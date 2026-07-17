/**
 * Regression coverage for Cloudflare Dynamic Worker Loader owner-side
 * saturation.
 *
 * Each runScript call below becomes a distinct inline Dynamic Worker source.
 * Each call gets its own ITX session so this test isolates loader ownership
 * from Cloudflare's fixed per-request Worker-invocation budget: one Cap'n Web
 * frame containing all twenty calls can spend that budget before the
 * executions reach the loader. On deployed Workers, twenty concurrent
 * long-lived scripts from one capability-host scope must all complete instead
 * of sharing one Durable Object as the dynamic-loader owner and tripping "Too
 * many concurrent dynamic workers".
 */
import { test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";
import { itxScript } from "../test-support/itx-script-builder.ts";

const SCRIPT_COUNT = 20;
const SCRIPT_HOLD_MS = 30_000;
const MAX_CONCURRENT_COMPLETION_MS = 50_000;

test(
  "concurrent long-running itx scripts all complete",
  { timeout: 90_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "script-concurrency" });

    const marker = crypto.randomUUID();
    const startedAt = Date.now();
    const executions = await Promise.allSettled(
      Array.from({ length: SCRIPT_COUNT }, async (_, index) => {
        // A fresh WebSocket gives every execution an independent Cloudflare
        // request lineage while all twenty still converge on the exact same
        // capability-host Durable Object and script-executor service.
        using itx = handle.itx();
        return await itxScript(itx.capabilityHost)
          .vars({ holdMs: SCRIPT_HOLD_MS, index, marker })
          .execute(async (_itx, vars) => {
            await new Promise((resolve) => setTimeout(resolve, vars.holdMs));
            return { index: vars.index, marker: vars.marker };
          });
      }),
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
