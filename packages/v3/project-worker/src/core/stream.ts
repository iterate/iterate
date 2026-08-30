// core/stream.ts — THE STREAM / CONTEXT SEAM, uniform-async and REAL-typed.
//
// What one context reaches another THROUGH — a sibling by name, or the own-path parent. Naming it
// with the REAL event types (StreamEventInput / StreamEvent / StreamPage) and making the whole
// surface Promise-returning is what lets every backing satisfy it with ZERO casts:
//   • a sibling `DurableObjectStub<StreamDurableObject>` — Workers-RPC methods already return
//     Promises of these exact types, so it IS a Context structurally (no `as unknown as`);
//   • the own parent — `localContext(this)`, whose only wrap is `read` (sync on the class, async
//     on the wire — one microtask on a path that then does real I/O anyway);
//   • an off-platform Pi — its `RpcTarget` returns Promises over capnweb.
//
// This replaces the old `deps.context` typed `{ append; read }` + a re-cast to add `invoke` with
// `unknown` returns — the sync-own-vs-async-sibling mud that the loose type papered over.

import type { Expression, ItxExpression } from "./expression.ts";
import type { StreamEvent, StreamEventInput } from "./events.ts";

/** One page of the log: the events after an offset, plus how far the scan reached (the range a
 *  client chains for contiguity). Structurally identical to StreamDurableObject.read's return. */
interface StreamPage {
  events: StreamEvent[];
  scannedThroughOffset: number;
}

/** The bare STREAM surface: a log you append to and read back. Arg/return types are the real
 *  event types (not `unknown[]`), so a DO stub, the own-path adapter, and a Pi RpcTarget all
 *  satisfy it without a cast. */
export interface Stream {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(afterOffset?: number, limit?: number): Promise<StreamPage>;
}

/** A CONTEXT reachable over the wire: the stream surface above, plus `invoke` for capability
 *  dispatch. This is what `itx.cd('/x')` routes through and what `deps.context(path)`
 *  returns. The StreamDurableObject is one; a sibling DO stub and the own-path adapter satisfy it. */
export interface Context extends Stream {
  invoke(call: ItxExpression): Promise<unknown>;
}

/** The own StreamDurableObject (same isolate) as a uniform-async Context. The ONLY wrap is `read`
 *  (sync on the class, async on the seam); `append` and `invoke` are already async. Built once per
 *  DO, never per call. */
export function localContext(self: {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(afterOffset?: number, limit?: number): StreamPage;
  invoke(call: ItxExpression): Promise<unknown>;
}): Context {
  return {
    append: (...events) => self.append(...events),
    read: async (afterOffset, limit) => self.read(afterOffset, limit),
    invoke: (call) => self.invoke(call),
  };
}
