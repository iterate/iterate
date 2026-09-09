// itx-entrypoint.ts — a loaded worker's WHOLE WORLD. Every confined dynamic worker's `env.ITX` and
// `globalOutbound` are one stub of THIS entrypoint, minted via `ctx.exports.ItxEntrypoint({ props:
// { iterateContextName } })` — never a raw `env.ITERATE_CONTEXT.getByName` DO stub — so the context it forwards
// to is a PROP of the stub, not a binding the loaded code could reach around.
//
// TWO doors, nothing else — `get()` (the itx scope) and `fetch` (`globalOutbound`) — both addressing
// the DO through `env.ITERATE_CONTEXT`, this worker's own binding to its namespace.

import { WorkerEntrypoint } from "cloudflare:workers";
import { IterateContext } from "./iterate-context.ts";
import { SessionTeardown } from "./session-teardown.ts";
import { DurableObjectNameCodec } from "./context/durable-object-names.ts";
import type { Env } from "./iterate-context-durable-object.ts";
import { ITX_PRINCIPAL_HEADER } from "./principal.ts";

export class ItxEntrypoint extends WorkerEntrypoint<Env, { iterateContextName: string }> {
  /** THE handoff: the genuine itx scope — the SAME `IterateContext` RpcTarget a capnweb client gets
   *  from `projects.get(id)` (capnweb's RpcTarget IS the native `cloudflare:workers` RpcTarget on
   *  workerd), so loaded code writes plain dotted access and mid-chain handles pipeline natively. A
   *  fresh SessionTeardown per call: this hop lends nothing session-long (a loaded worker's callbacks
   *  ride as Workers-RPC stubs through the call args, never the pager). Re-resolved per call — never
   *  a stub held across calls (the back-channel rule). */
  get(): IterateContext {
    return new IterateContext(
      this.env.ITERATE_CONTEXT,
      DurableObjectNameCodec.parse(this.ctx.props.iterateContextName),
      new SessionTeardown(),
      (p) => this.ctx.waitUntil(p),
    );
  }

  /** globalOutbound: every RAW Request a loaded worker sends — a plain `fetch(url)` (egress) or a
   *  fetch-lane call it addressed itself with `x-itx-expression` — goes to the context DO's fetch
   *  door unchanged, because THAT door is where raw Requests are sorted. Not
   *  `get().invoke(["itx",["fetch",…]])`: the edge's terminal-fetch fork would overwrite a lane header
   *  the loaded worker already set. */
  override fetch(request: Request): Promise<Response> {
    // A loaded worker speaks for the project, never for a person: the principal header is the
    // edge's stamp (worker.ts, iterate-context.ts), stripped here so loaded code cannot forge one.
    const headers = new Headers(request.headers);
    headers.delete(ITX_PRINCIPAL_HEADER);
    return this.env.ITERATE_CONTEXT.getByName(this.ctx.props.iterateContextName).fetch(
      new Request(request, { headers }),
    );
  }
}

/** Mint the loopback stub for one context — `ctx.exports.ItxEntrypoint({ props })` on the DO's own
 *  state (workers-types puts the worker's export table on it). `Cloudflare.Exports` is `{}` without a
 *  generated `GlobalProps`, hence the cast. */
export function itxEntrypointFor(ctx: DurableObjectState, iterateContextName: string): Fetcher {
  const { exports } = ctx as unknown as {
    exports: { ItxEntrypoint(opts: { props: { iterateContextName: string } }): Fetcher };
  };
  return exports.ItxEntrypoint({ props: { iterateContextName } });
}
