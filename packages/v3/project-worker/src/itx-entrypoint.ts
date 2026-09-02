// itx-entrypoint.ts — a loaded worker's WHOLE WORLD. Every confined dynamic worker's `env.ITX` and
// `globalOutbound` are one stub of THIS entrypoint, minted via `ctx.exports.ItxEntrypoint({ props:
// { contextName } })` — never a raw `env.CONTEXT.getByName` DO stub — so the context it forwards
// to is a PROP of the stub, not a binding the loaded code could reach around.
//
// The surface is exactly what loaded code speaks: `get()` (the real `IterateContext` scope — the
// dotted door, which owns its own dispatch), the stream verbs the processor engine drives
// (`append`/`read`/`waitForEvent`), and `fetch` (globalOutbound egress → the DO's
// secret-substituting terminal).

import { WorkerEntrypoint } from "cloudflare:workers";
import { IterateContext } from "./iterate-context.ts";
import type { BuiltInsEnv } from "./context/built-ins.ts";
import { Parking } from "./context/rpc-stub-relay.ts";
import { DurableObjectNameCodec } from "./context/durable-object-names.ts";
import type { StreamEvent, StreamEventInput } from "./stream/events.ts";
import type { WaitForEventFilter } from "./stream/stream.ts";
import type { IterateContextDurableObject } from "./iterate-context-durable-object.ts";

export class ItxEntrypoint extends WorkerEntrypoint<BuiltInsEnv, { contextName: string }> {
  /** The owning context, re-resolved per call (never a retained stub — the back-channel rule).
   *  `ctx.props.contextName` is the ONE prop this entrypoint is minted with (`itxEntrypointFor`). */
  #context(): DurableObjectStub<IterateContextDurableObject> {
    return this.env.CONTEXT.getByName(this.ctx.props.contextName);
  }

  /** THE handoff: the genuine itx scope — the SAME `IterateContext` RpcTarget a capnweb client gets
   *  from `projects.get(id)` (capnweb's RpcTarget IS the native `cloudflare:workers` RpcTarget on
   *  workerd), so loaded code writes plain dotted access — `const itx = await env.ITX.get();
   *  itx.demo.timer.x(…)` — and mid-chain handles pipeline natively. A fresh Parking per call: this
   *  hop parks nothing session-long (a loaded worker's callbacks ride as Workers-RPC stubs through
   *  the call args, never the pager). */
  get(): IterateContext {
    return new IterateContext(
      this.env.CONTEXT,
      DurableObjectNameCodec.parse(this.ctx.props.contextName),
      new Parking(),
      (p) => this.ctx.waitUntil(p),
    );
  }

  append(...events: StreamEventInput[]): Promise<StreamEvent[]> {
    return this.#context().append(...events);
  }

  read(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: StreamEvent[]; scannedThroughOffset: number }> {
    return this.#context().read(afterOffset, limit);
  }

  /** Wait for the next matching event — loaded-worker parity with the edge `IterateContext` method (the
   *  contract lives in Stream.waitForEvent: type filter, afterOffset default = the head, 30s/120s
   *  timeout → WAIT_TIMEOUT). The parked wait lives on the DO; this call just holds the leg open. */
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent> {
    return this.#context().waitForEvent(filter);
  }

  /** globalOutbound: every fetch a loaded worker makes lands here → the DO's egress terminal
   *  (secret placeholder substitution → FALLBACK). */
  override fetch(request: Request): Promise<Response> {
    return this.#context().fetch(request);
  }
}

/** Mint the loopback stub for one context — `ctx.exports.ItxEntrypoint({ props })`. `ctx` is any
 *  ctx carrying `exports` (a worker ExecutionContext, a DurableObjectState: workers-types puts the
 *  worker's export table on both). Typed `unknown` only because built-ins.ts's dep record hands it
 *  over that way; `Cloudflare.Exports` is `{}` without a generated `GlobalProps`, hence the cast. */
export function itxEntrypointFor(ctx: unknown, contextName: string): Fetcher {
  const { exports } = ctx as {
    exports: { ItxEntrypoint(opts: { props: { contextName: string } }): Fetcher };
  };
  return exports.ItxEntrypoint({ props: { contextName } });
}
