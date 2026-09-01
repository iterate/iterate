import type { DynamicWorkerCapability, ItxBinding, StreamEvent } from "../../sdk.ts";
import { flakeDashboardWorkerRef, flakesStreamPath } from "./app-ref.ts";
import type { FlakeDashboardApp as FlakeDashboardWorker } from "./worker.ts";

export { flakeDashboardCreationEvents, flakesStreamPath } from "./app-ref.ts";

export const FlakeDashboardApp = {
  create(env: { ITX: Pick<ItxBinding, "get"> }) {
    return {
      async processEvent(event: StreamEvent): Promise<void> {
        if (event.path !== flakesStreamPath) return;
        using project = await env.ITX.get();
        using worker = project.workers.get(flakeDashboardWorkerRef) as DynamicWorkerCapability<
          Pick<FlakeDashboardWorker, "syncEvent">
        >;
        await worker.syncEvent(event);
      },
    };
  },
};
