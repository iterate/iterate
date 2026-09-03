import type { DynamicWorkerCapability, ItxBinding, StreamEvent } from "../../sdk.ts";
import { flakeDashboardWorkerRef, flakesStreamPath } from "./app-ref.ts";
import { WorkflowRunWebhookEvent } from "./contract.ts";
import type { FlakeDashboardApp as FlakeDashboardWorker } from "./worker.ts";

export { flakeDashboardCreationEvents, flakesStreamPath } from "./app-ref.ts";

export const FlakeDashboardApp = {
  create(env: { ITX: Pick<ItxBinding, "get"> }) {
    return {
      async processEvent(event: StreamEvent): Promise<void> {
        // Pure routing: /flakes events and completed workflow_run webhooks
        // (CI's credential-free reporting signal) both dispatch to the
        // worker's processEvent; everything else returns before itx opens.
        if (event.path !== flakesStreamPath && !WorkflowRunWebhookEvent.safeParse(event).success) {
          return;
        }
        using project = await env.ITX.get();
        // workers.get returns an untyped RPC capability; the assertion is the
        // only place to say what answers. It is safe because the ref pins
        // className to FlakeDashboardApp, whose own method surface is exactly
        // what is asserted here (same pattern as the guestbook app).
        using worker = project.workers.get(flakeDashboardWorkerRef) as DynamicWorkerCapability<
          Pick<FlakeDashboardWorker, "processEvent">
        >;
        await worker.processEvent(event);
      },
    };
  },
};
