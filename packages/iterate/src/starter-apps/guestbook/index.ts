import type { DynamicWorkerCapability, ItxBinding, StreamEvent } from "../../sdk.ts";
import { guestbookStreamPath, guestbookWorkerRef } from "./app-ref.ts";
import type { GuestbookApp as GuestbookWorker } from "./worker.ts";

export const GuestbookApp = {
  create(env: { ITX: Pick<ItxBinding, "fetch" | "get"> }) {
    return {
      async fetch(request: Request): Promise<Response> {
        const headers = new Headers(request.headers);
        headers.set(
          "x-iterate-worker-dispatch",
          JSON.stringify({ buildBudgetMs: 15_000, ref: guestbookWorkerRef }),
        );
        return await env.ITX.fetch(new Request(request, { headers }));
      },
      async processEvent(event: StreamEvent): Promise<void> {
        if (event.path !== guestbookStreamPath) return;
        using project = await env.ITX.get();
        using worker = project.workers.get(guestbookWorkerRef) as DynamicWorkerCapability<
          Pick<GuestbookWorker, "syncEvent">
        >;
        await worker.syncEvent(event);
      },
    };
  },
};
