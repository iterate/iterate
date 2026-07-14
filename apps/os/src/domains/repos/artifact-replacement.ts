const DELETE_POLL_INTERVAL_MS = 500;
const DELETE_POLL_ATTEMPTS = 60;

/**
 * Replace one Artifacts repository with a new empty repository under the same
 * name. Artifacts deletion is acknowledged before it is applied, so creating
 * immediately after `delete()` can race the queued deletion and destroy the
 * replacement. The NOT_FOUND read is the deletion-complete barrier.
 */
export async function replaceArtifactWithEmptyRepo(
  artifacts: Pick<Artifacts, "create" | "delete" | "get">,
  name: string,
  options: {
    pollAttempts?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const deleted = await artifacts.delete(name);
  if (deleted) {
    const pollAttempts = options.pollAttempts ?? DELETE_POLL_ATTEMPTS;
    const pollIntervalMs = options.pollIntervalMs ?? DELETE_POLL_INTERVAL_MS;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let deletionApplied = false;

    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      try {
        await artifacts.get(name);
      } catch (error) {
        if ((error as { code?: unknown })?.code !== "NOT_FOUND") throw error;
        deletionApplied = true;
        break;
      }
      await sleep(pollIntervalMs);
    }

    if (!deletionApplied) {
      throw new Error(
        `Timed out waiting for Artifacts repository "${name}" deletion to become visible.`,
      );
    }
  }

  await artifacts.create(name, { setDefaultBranch: "main" });
}
