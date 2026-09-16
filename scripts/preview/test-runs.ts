import { previewTestRunsForEnvironment } from "../lib/preview-test-runs.ts";

/** Preview test-run control. Invoke with trpc-cli; callers hold the slot lifecycle lock. */
export default class TestRuns {
  /** Start an attempt; expiry is fixed even if CI is cancelled. */
  async begin(options: { env: string; id: string; expiresAt: number }) {
    const runs = await previewTestRunsForEnvironment(options.env);
    const run = { id: options.id, expiresAt: options.expiresAt };
    await runs.begin(run);
    return run;
  }

  /** Stop recurring test work, keeping the deployment and all its data. */
  async retire(options: { env: string; id: string }) {
    await (await previewTestRunsForEnvironment(options.env)).retire(options.id);
    return { retired: options.id, env: options.env };
  }
}
