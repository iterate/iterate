// sdk/config-worker.ts — THE CONFIG WORKER base class, bundled into `processor.js` (sdk/index.ts).
// A project's ONE event handler: every context subscribes `itx.cd('/').worker.processEventBatch`, so
// the "/" context's config worker is called with every stream's committed batch. `itx.worker` is a
// platform row (itx-expression-rewriting.ts) a project re-points at its own source —
// `itx.provide("itx.worker", "itx.workers.get({ source: itx.repos.readFile('config','worker.ts'), cacheKey })")`
// — with no className: the module's DEFAULT export is the class, as in the bundled no-op default.
// An author writes:
//
//   import { ConfigWorker } from "./processor.js";
//   export default class extends ConfigWorker {
//     async processEvent({ event, itx }) {
//       if (event.type === "events.iterate.com/ping") await itx.builtins.append({ type: "…/pong" });
//     }
//   }
//
// STATELESS by design — it owns no stream and no checkpoint. The SUBSCRIBING context keeps the cursor
// (at-least-once), so `processEvent` must be IDEMPOTENT: an `idempotencyKey` on an appended reaction
// makes a redelivery a no-op. `range` is the contiguous `(after, through]` window the batch proves.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { ItxEntrypoint } from "../itx-entrypoint.ts";
import type { StreamEvent } from "../stream/events.ts";
import type { ScannedRange } from "../stream/processor.ts";

/** The itx scope handed to `processEvent`: `env.ITX.get()` for this batch — the genuine
 *  `IterateContext` RpcTarget, disposed after the batch so it does not pin the parent DO past the turn. */
export type ConfigWorkerItx = ReturnType<Service<ItxEntrypoint>["get"]>;

/** One committed event handed to the config worker, with the batch's range and the batch's itx scope. */
export type ConfigEventArgs = { event: StreamEvent; range: ScannedRange; itx: ConfigWorkerItx };

/** THE CONFIG WORKER — a stateless `WorkerEntrypoint`. Override `processEvent`; the platform calls
 *  `processEventBatch` (the subscription target). Nothing to construct, no contract, no reduce. */
export abstract class ConfigWorker<
  Env extends { ITX: Service<ItxEntrypoint> } = { ITX: Service<ItxEntrypoint> },
> extends WorkerEntrypoint<Env> {
  /** THE SUBSCRIBED METHOD: a committed batch, in offset order. One `env.ITX.get()` for the whole
   *  batch (the calls pipeline through it), disposed in the `finally` — bounded to this one turn. */
  async processEventBatch(events: StreamEvent[], range: ScannedRange): Promise<void> {
    const itx = this.env.ITX.get();
    try {
      for (const event of events) await this.processEvent({ event, range, itx });
    } finally {
      (itx as unknown as Disposable)[Symbol.dispose]?.();
    }
  }

  /** THE AUTHOR HOOK — one event at a time, in offset order. Append reactions through the itx scope;
   *  make them idempotent (a redelivery must be a no-op). Default: ignore the event. */
  processEvent(_args: ConfigEventArgs): void | Promise<void> {}
}
