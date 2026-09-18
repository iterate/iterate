import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export const PreviewCiIdentity = z.object({
  headSha: z.string().min(1),
  runId: z.string().min(1),
  runAttempt: z.string().min(1),
  slot: z.string().min(1),
});
export type PreviewCiIdentity = z.infer<typeof PreviewCiIdentity>;

const PreviewCiReceipt = PreviewCiIdentity.extend({
  key: z.string().min(1),
  exitCode: z.number().int(),
  durationMs: z.number().nonnegative(),
  error: z.string().nullable(),
});

/** A result or worker may only use the deployment from its own CI attempt. */
export function assertPreviewCiIdentity(expected: PreviewCiIdentity, actual: PreviewCiIdentity) {
  for (const key of ["headSha", "runId", "runAttempt", "slot"] as const) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `Preview CI identity mismatch: ${key} expected ${expected[key]}, received ${actual[key]}`,
      );
    }
  }
}

/** Collect every required producer even when another failed or its artifact is absent. */
export async function readPreviewCiResults(
  identity: PreviewCiIdentity,
  keys: string[],
  directory: string,
) {
  const failures: string[] = [];
  let durationMs = 0;
  let complete = keys.length > 0;
  for (const key of keys) {
    try {
      const receipt = PreviewCiReceipt.parse(
        JSON.parse(await readFile(resolve(directory, `${key}.json`), "utf8")),
      );
      assertPreviewCiIdentity(identity, receipt);
      if (receipt.key !== key)
        throw new Error(`Expected result for ${key}, received ${receipt.key}`);
      durationMs = Math.max(durationMs, receipt.durationMs);
      // Ordinary test failures exit 1; killed/timed-out commands are inconclusive.
      if (![0, 1].includes(receipt.exitCode)) complete = false;
      if (receipt.exitCode !== 0)
        failures.push(receipt.error || `${key} failed with exit ${receipt.exitCode}`);
    } catch (error) {
      complete = false;
      failures.push(`Missing or invalid ${key} result: ${String(error)}`);
    }
  }
  return { failures, durationMs, complete };
}
