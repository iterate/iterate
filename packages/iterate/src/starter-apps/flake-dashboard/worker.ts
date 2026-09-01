import {
  StreamProcessorDurableObject,
  type ProcessorHostDeps,
  type StreamEvent,
} from "../../sdk.ts";
import { flakesStreamPath } from "./app-ref.ts";
import type { FlakeDashboardState } from "./contract.ts";
import { FlakeDashboardProcessor } from "./processor.ts";
import { renderFlakeDashboardIssue } from "./render.ts";

/**
 * One stateful worker owns the `/flakes` processor. It serves no HTTP: CI
 * appends `run-recorded` events straight to the stream via the project API,
 * and the durable processor checkpoint keeps renders and transition
 * proposals exactly-once-ish across deployments and evictions.
 */
export class FlakeDashboardApp extends StreamProcessorDurableObject<FlakeDashboardState> {
  protected readonly streamPath = flakesStreamPath;
  protected readonly recovery = true;

  protected createProcessor(deps: ProcessorHostDeps) {
    return new FlakeDashboardProcessor({
      ...deps,
      renderDashboard: async (state) => {
        using itx = await this.env.ITX.get();
        return await renderFlakeDashboardIssue(itx, state);
      },
    });
  }

  /** Project-worker event delivery calls this after a durable `/flakes` event
   * commits. Catch-up owns validation, ordering, checkpointing, and dedupe. */
  async syncEvent(event: StreamEvent): Promise<void> {
    if (event.path !== flakesStreamPath) return;
    const registry = await this.registry();
    await registry.catchUp("flake-dashboard");
  }

  /** Internal RPC surface used by smoke checks and debugging. */
  async getState(): Promise<FlakeDashboardState> {
    const registry = await this.registry();
    await registry.catchUp("flake-dashboard");
    return (await this.snapshot()).state;
  }
}
