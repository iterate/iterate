import { disposeIgnoredRpcResult } from "../../lib/rpc/retain.ts";

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
    beforeDelete?: () => void;
    pollAttempts?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const pollAttempts = options.pollAttempts ?? DELETE_POLL_ATTEMPTS;
  const pollIntervalMs = options.pollIntervalMs ?? DELETE_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  // Callers must invalidate any cached view of the old repository before the
  // remote deletion begins. Keep this inside the helper's boundary so a
  // future refactor cannot accidentally move invalidation after the delete.
  options.beforeDelete?.();
  const deleted = await artifacts.delete(name);
  if (deleted) {
    let deletionApplied = false;

    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      try {
        const repo = await artifacts.get(name);
        // `Artifacts.get()` returns a Workers RPC repo handle. The handle is
        // useful only as the "still present" signal here; release it before
        // polling again so deletion waits cannot accumulate remote refs.
        disposeIgnoredRpcResult(repo);
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

  // Artifacts' read and create paths are not one consistency boundary. In
  // production, get() reported NOT_FOUND for the deleted repo while create()
  // still rejected the same name with ALREADY_EXISTS. Keep the stronger
  // NOT_FOUND barrier above (it protects the replacement from the queued
  // delete), then wait for the create plane to release the name as well.
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    try {
      await artifacts.create(name, { setDefaultBranch: "main" });
      return;
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "ALREADY_EXISTS") throw error;
      if (attempt + 1 < pollAttempts) await sleep(pollIntervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for Artifacts repository "${name}" name to become reusable after deletion.`,
  );
}
