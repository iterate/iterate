import { z } from "zod";
import { PreviewTestRun } from "@iterate-com/shared/preview-test-run";

/** Small control records, stored in the preview slot's PROJECT_DIRECTORY KV.
 * All callers of begin() must hold the existing preview lifecycle lock.
 * Records have no KV TTL: forgetting ownership must never revive old work.
 */
export class PreviewTestRuns {
  private store: TestRunStore;

  constructor(store: TestRunStore) {
    this.store = store;
  }

  /** Start an attempt, retiring a predecessor whose finalizer may have been killed. */
  async begin(input: { id: string; expiresAt: number }): Promise<void> {
    const run = PreviewTestRun.parse(input);
    if (run.expiresAt <= Date.now()) throw new Error("Cannot start an expired test run.");
    const existing = await this.store.get(runKey(run.id));
    if (existing) {
      const previous = PreviewTestRun.parse(JSON.parse(existing));
      if (await this.store.get(`ci:retired-test-run:${run.id}`))
        throw new Error("A retired attempt cannot be restarted; use a new attempt.");
      if (previous.expiresAt !== run.expiresAt)
        throw new Error("A test run's expiry is immutable.");
    }
    const predecessor = await this.store.get("ci:current-test-run");
    if (predecessor && predecessor !== run.id) await this.retire(predecessor);
    if (!existing) await this.store.put(runKey(run.id), JSON.stringify(run));
    await this.store.put("ci:current-test-run", run.id);
  }

  /** The root stream calls this before project birth starts recurring work. */
  async registerProject(
    projectId: string,
    input: { id: string; expiresAt: number },
  ): Promise<void> {
    // The authenticated test creator carries the immutable descriptor. We do
    // not require a just-published run record to have reached this KV location.
    const run = PreviewTestRun.parse(input);
    const runId = run.id;
    if (run.expiresAt <= Date.now() || (await this.store.get(`ci:retired-test-run:${runId}`)))
      throw new Error("Test run has finished.");
    const key = `ci:project:${projectId}`;
    const previous = await this.store.get(key);
    if (previous) {
      const owner = ProjectOwner.parse(JSON.parse(previous));
      if (owner.runId !== runId || owner.expiresAt !== run.expiresAt) {
        throw new Error("A project cannot move between test runs or extend its expiry.");
      }
    }
    if (!previous) {
      await this.store.put(key, JSON.stringify({ runId, expiresAt: run.expiresAt }));
    }
  }

  /** A late finalizer touches only its own attempt. No DO listing or data deletion. */
  async retire(runId: string): Promise<void> {
    runId = PreviewTestRun.shape.id.parse(runId);
    // Write-only tombstone: a late finalizer cannot overwrite newer run state.
    await this.store.put(`ci:retired-test-run:${runId}`, "retired");
  }

  async isProjectRetired(projectId: string): Promise<boolean> {
    const rawOwner = await this.store.get(`ci:project:${projectId}`);
    if (!rawOwner) return false; // Human-created or legacy project.
    const owner = ProjectOwner.parse(JSON.parse(rawOwner));
    // The immutable deadline also covers cancellation with no subsequent CI run.
    if (owner.expiresAt <= Date.now()) return true;
    // A missing/stale tombstone can only delay retirement, never stop a live run.
    return Boolean(await this.store.get(`ci:retired-test-run:${owner.runId}`));
  }
  async canReuseEnvironment(holder: string): Promise<boolean> {
    return (await this.store.get("ci:retirement-protocol")) === `v1:${holder}`;
  }

  /** Called after deploying supporting code into an initially erased slot. */
  async markEnvironmentReusable(holder: string): Promise<void> {
    await this.store.put("ci:retirement-protocol", `v1:${holder}`);
  }
}

type TestRunStore = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
};

const ProjectOwner = z.object({
  runId: z.string().min(1),
  expiresAt: z.number().int().positive(),
});

function runKey(id: string) {
  return `ci:test-run:${id}`;
}
