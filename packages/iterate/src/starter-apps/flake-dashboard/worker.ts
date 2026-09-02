import {
  StreamProcessorDurableObject,
  type ProcessorHostDeps,
  type StreamEvent,
} from "../../sdk.ts";
import { flakesStreamPath } from "./app-ref.ts";
import type { FlakeDashboardState } from "./contract.ts";
import { FlakeDashboardProcessor, renderFlakeDashboardIssue } from "./processor.ts";
import {
  ingestWorkflowRunFlakeArtifacts,
  parseWorkflowRunWebhook,
} from "./workflow-artifact-ingestion.ts";

/**
 * One stateful worker owns ALL flake event processing. It serves no HTTP:
 * workflow_run webhooks become run-recorded events via artifact ingestion,
 * /flakes events drive the processor's catch-up, and the durable processor
 * checkpoint keeps renders and transition proposals exactly-once-ish across
 * deployments and evictions.
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

  /**
   * Every flake-relevant event lands here — the same override point the
   * platform's own delivery uses (widened public so the config worker can
   * forward events over RPC). A workflow_run webhook is ingested into
   * run-recorded events; a /flakes event is a wake hint — catch-up re-reads
   * committed events from the stream and owns validation, ordering,
   * checkpointing, and dedupe.
   */
  override async processEvent(event: StreamEvent): Promise<void> {
    const webhook = parseWorkflowRunWebhook(event);
    if (webhook !== null) {
      using itx = await this.env.ITX.get();
      await ingestWorkflowRunFlakeArtifacts(itx, webhook);
      return;
    }
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
