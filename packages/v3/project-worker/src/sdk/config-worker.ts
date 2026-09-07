// sdk/config-worker.ts — THE CONFIG WORKER base class, bundled into `processor.js` (sdk/index.ts).
// A project's ONE event handler: every context subscribes `itx.cd('/').worker.processEventBatch`, so
// the "/" context's config worker is called with every stream's committed batch — the apps/os
// project-worker shape. SOURCE-IN-KV is the repo stand-in: the code lives at the KV key
// `/repos/config/worker.ts` and is loaded through the `itx.worker` rewrite
// (`itx.worker ⇒ itx.workers.get({ source: itx.builtins.kv.get('/repos/config/worker.ts'), cacheKey,
// className: 'ConfigWorker' })` — the KV value IS the module, reproduced from a data structure exactly
// as a repo reproduces it from an entrypoint reference).
//
// An author writes, in that KV module:
//
//   import { ConfigWorker } from "./processor.js";
//   export class Config extends ConfigWorker {
//     async processEvent({ event, itx }) {
//       if (event.type === "events.iterate.com/ping") await itx.builtins.append({ type: "…/pong" });
//     }
//   }
//
// STATELESS by design — it owns no stream and no checkpoint. The SUBSCRIBING context keeps the cursor
// (at-least-once, redelivered on a retry), so `processEvent` must be IDEMPOTENT: an `idempotencyKey`
// on an appended reaction makes a redelivery a no-op. `range` is the contiguous `(after, through]`
// window the batch proves, for a handler that keeps its own external cursor.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { ItxEntrypoint } from "../itx-entrypoint.ts";
import type { StreamEvent } from "../stream/events.ts";
import type { ScannedRange } from "../stream/processor.ts";

/** The itx scope handed to `processEvent`: `env.ITX.get()` for this batch — the genuine `IterateContext`
 *  RpcTarget (dotted access, `itx.builtins.append(…)` / `itx.cd('/x').append(…)`), disposed after the
 *  batch so it does not pin the parent DO past the turn (the 4A.2 release). */
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
