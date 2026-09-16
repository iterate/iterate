import type { Env } from "../env.ts";
import { PreviewTestRuns } from "./preview-test-runs.ts";

/** Stops repeated work; leaves the object's data available for inspection.
 * Retirement is remembered in DO storage so eviction or a stale KV read cannot
 * revive it. Only preview environments opt in; shared objects have no project.
 */
export class PreviewTestRetirement {
  constructor(
    private ctx: DurableObjectState,
    private env: Pick<Env, "DEPLOYMENT_ENV" | "PROJECT_DIRECTORY" | "PREVIEW_TEST_RETIREMENT">,
    private projectId: string | null,
  ) {}

  get enabled(): boolean {
    return Boolean(
      this.projectId &&
      this.env.PREVIEW_TEST_RETIREMENT === "1" &&
      this.env.DEPLOYMENT_ENV?.startsWith("preview_"),
    );
  }

  get retired(): boolean {
    return this.enabled && this.ctx.storage.kv.get<boolean>("ci:test-run-retired") === true;
  }

  /** Call before constructor recovery and each alarm; normal requests may finish. */
  async check(): Promise<boolean> {
    if (!this.enabled) return false;
    if (!this.retired) {
      const retired = await new PreviewTestRuns(this.env.PROJECT_DIRECTORY).isProjectRetired(
        this.projectId!,
      );
      if (!retired) return false;
      this.ctx.storage.kv.put("ci:test-run-retired", true);
      console.log("preview test object retired", {
        projectId: this.projectId,
        name: this.ctx.id.name,
      });
    }
    await this.ctx.storage.deleteAlarm();
    return true;
  }
}
