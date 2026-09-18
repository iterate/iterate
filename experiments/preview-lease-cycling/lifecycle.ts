// EXPERIMENT ONLY: the live adapter persists publication and cleanup jobs on disk.
export async function replacePreview<T>(runtime: {
  acquire(): Promise<T>;
  deploy(candidate: T): Promise<void>;
  publish(candidate: T): Promise<{ accepted: boolean; previous: T | null }>;
  scheduleCleanup(candidate: T): Promise<void>;
}) {
  const candidate = await runtime.acquire();
  let published = false;
  try {
    await runtime.deploy(candidate);
    const result = await runtime.publish(candidate);
    published = result.accepted;
    if (!published) {
      await runtime.scheduleCleanup(candidate);
      return { accepted: false, candidate };
    }
    if (result.previous) await runtime.scheduleCleanup(result.previous);
    return { accepted: true, candidate };
  } catch (error) {
    // Once published, failure to launch old-slot cleanup must not destroy the new preview.
    if (!published) await runtime.scheduleCleanup(candidate);
    throw error;
  }
}

/** Keep exclusive ownership through every destructive operation and both cooling periods. */
export async function retirePreview(runtime: {
  assertOwned(): Promise<void>;
  park(): Promise<void>;
  waitAfterPark(): Promise<void>;
  remove(): Promise<void>;
  waitAfterRemoval(): Promise<void>;
  verifyRemoved(): Promise<void>;
  release(): Promise<void>;
}) {
  await runtime.assertOwned();
  await runtime.park();
  await runtime.waitAfterPark();
  await runtime.assertOwned();
  await runtime.remove();
  await runtime.waitAfterRemoval();
  await runtime.assertOwned();
  await runtime.verifyRemoved();
  await runtime.release();
}

/** Release is the generation marker: renewal also changes Semaphore's misleading lastAcquiredAt. */
export function releasedCleanup(
  receipt: { stage: string; deletedAt: number | null; releasedAt: number | null } | null,
  releasedBeforeClaim: number | null,
  releasedAfterClaim: number | null,
) {
  if (receipt?.stage !== "released" || !receipt.deletedAt || !receipt.releasedAt) return null;
  if (receipt.releasedAt !== releasedBeforeClaim || releasedBeforeClaim !== releasedAfterClaim)
    return null;
  return {
    kind: "deleted" as const,
    completedAt: receipt.deletedAt,
    releasedAt: receipt.releasedAt,
  };
}
