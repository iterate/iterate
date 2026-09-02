import type { DynamicWorkerCapability, ItxBinding, StreamEvent } from "../../sdk.ts";
import { flakeDashboardWorkerRef, flakesStreamPath } from "./app-ref.ts";
import type { FlakeDashboardApp as FlakeDashboardWorker } from "./worker.ts";
import {
  ingestWorkflowRunFlakeArtifacts,
  parseWorkflowRunWebhook,
} from "./workflow-artifact-ingestion.ts";

export { flakeDashboardCreationEvents, flakesStreamPath } from "./app-ref.ts";

export const FlakeDashboardApp = {
  create(env: { ITX: Pick<ItxBinding, "get"> }) {
    return {
      async processEvent(event: StreamEvent): Promise<void> {
        // CI runs report flake outcomes with no iterate credential: their
        // workflow artifacts are pulled here when GitHub's workflow_run
        // webhook lands on the connection stream. The parse gate is cheap and
        // runs before itx is opened.
        const webhook = parseWorkflowRunWebhook(event);
        if (webhook !== null) {
          using project = await env.ITX.get();
          await ingestWorkflowRunFlakeArtifacts(project, webhook);
          return;
        }
        if (event.path !== flakesStreamPath) return;
        using project = await env.ITX.get();
        // workers.get returns an untyped RPC capability; the assertion is the
        // only place to say what answers. It is safe because the ref pins
        // className to FlakeDashboardApp, whose own method surface is exactly
        // what is asserted here (same pattern as the guestbook app).
        using worker = project.workers.get(flakeDashboardWorkerRef) as DynamicWorkerCapability<
          Pick<FlakeDashboardWorker, "syncEvent">
        >;
        await worker.syncEvent(event);
      },
    };
  },
};
