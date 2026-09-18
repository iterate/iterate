// EXPERIMENT ONLY: operator-created receipts, not a production Semaphore tagging protocol.
import assert from "node:assert/strict";
import { z } from "zod";
import { previewEnvironmentSlotNumbers } from "../../envs.ts";
import type { PreviewSemaphoreResourceClient } from "./preview.ts";

const Receipt = z.object({
  slug: z.enum(previewEnvironmentSlotNumbers.map((n) => `preview-${n}`)),
  parkedAt: z.number().int().positive(),
  releasedAt: z.number().int().positive(),
});

/** An absent opt-in preserves the ordinary 90s gate; other branches cannot enable the experiment. */
export function readLeaseCyclingReceipt(environment: NodeJS.ProcessEnv) {
  if (!environment.PREVIEW_LEASE_CYCLING_RECEIPT) return null;
  assert.equal(
    environment.GITHUB_REF_NAME,
    "codex/experiment-preview-lease-cycling",
    "A parked receipt is only valid on the experiment branch",
  );
  return Receipt.parse(JSON.parse(environment.PREVIEW_LEASE_CYCLING_RECEIPT));
}

/** Claim without force, verify the receipt again under ownership, and fail before deploying on any ambiguity. */
export async function claimRestedExperimentSlot(input: {
  receipt: z.infer<typeof Receipt>;
  holder: string;
  leaseMs: number;
  now: number;
  semaphore: Pick<PreviewSemaphoreResourceClient, "list" | "acquireSpecific" | "release">;
  verifyParked(slug: string): Promise<void>;
}) {
  const { receipt } = input;
  const identity = { type: "environment-config-lease", slug: receipt.slug };
  assert(input.holder.startsWith("lease-cycling-"), "Experiment requires an isolated holder");
  assert(input.now >= receipt.releasedAt, "Receipt release is in the future");
  assert(receipt.releasedAt - receipt.parkedAt >= 150_000, "Slot was not rested before release");
  const before = (await input.semaphore.list({ type: identity.type })).find(
    (r) => r.slug === receipt.slug,
  );
  assert.equal(before?.leaseState, "available", "Prepared slot is no longer available");
  assert.equal(before.lastReleasedAt, receipt.releasedAt, "Prepared slot release changed");
  const lease = await input.semaphore.acquireSpecific({
    ...identity,
    allowedSlugs: [receipt.slug],
    holder: input.holder,
    leaseMs: input.leaseMs,
  });
  assert(lease, "Prepared slot was acquired by another run");
  try {
    const after = (await input.semaphore.list({ type: identity.type })).find(
      (r) => r.slug === receipt.slug,
    );
    assert.equal(
      after?.lastReleasedAt,
      receipt.releasedAt,
      "Prepared slot release changed during claim",
    );
    assert.equal(after?.holder, input.holder, "Prepared slot ownership changed");
    assert.equal(after?.leaseState, "leased");
    await input.verifyParked(receipt.slug);
    console.log(
      "EXPERIMENT: claimed aged parked slot without erasing",
      JSON.stringify({
        ...receipt,
        holder: input.holder,
        parkedAgeMs: input.now - receipt.parkedAt,
      }),
    );
    return lease;
  } catch (error) {
    const released = await input.semaphore.release({ ...identity, leaseId: lease.leaseId });
    assert(released.released, "Failed preparation verification; could not return our lease");
    throw error;
  }
}
