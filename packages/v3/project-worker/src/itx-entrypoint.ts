// itx-entrypoint.ts — a loaded worker's WHOLE WORLD. Every confined dynamic worker's `env.ITX` and
// `globalOutbound` are one stub of THIS entrypoint, minted via `ctx.exports.ItxEntrypoint({ props:
// { iterateContextName } })` — never a raw `env.ITERATE_CONTEXT.getByName` DO stub — so the context it forwards
// to is a PROP of the stub, not a binding the loaded code could reach around.
//
// TWO doors, nothing else: `get()` BUILDS the real `IterateContext` RpcTarget for the one context
// this stub was minted for (the dotted door — `append`, `readEvents`, `waitForEvent`, `kv`, … all ride
// it, the processor engine's included), and `fetch` is `globalOutbound` — a raw Request, handed to
// the context DO's fetch door, which sorts raw Requests. `env.ITERATE_CONTEXT` is this worker's own
// binding to the `IterateContextDurableObject` namespace — both doors address the DO through it.

import { WorkerEntrypoint } from "cloudflare:workers";
import { IterateContext } from "./iterate-context.ts";
import { SessionTeardown } from "./session.ts";
import { DurableObjectNameCodec } from "./context/durable-object-names.ts";
import type { Env } from "./iterate-context-durable-object.ts";

export class ItxEntrypoint extends WorkerEntrypoint<Env, { iterateContextName: string }> {
  /** THE handoff: the genuine itx scope — the SAME `IterateContext` RpcTarget a capnweb client gets
   *  from `projects.get(id)` (capnweb's RpcTarget IS the native `cloudflare:workers` RpcTarget on
   *  workerd), so loaded code writes plain dotted access — `const itx = await env.ITX.get();
   *  itx.demo.timer.x(…)` — and mid-chain handles pipeline natively. A fresh SessionTeardown per
   *  call: this hop lends nothing session-long (a loaded worker's callbacks ride as Workers-RPC
   *  stubs through the call args, never the pager). Re-resolved per call — never a stub held across
   *  calls (the back-channel rule); `ctx.props.iterateContextName` is the ONE prop this entrypoint is
   *  minted with (`itxEntrypointFor`). */
  get(): IterateContext {
    return new IterateContext(
      this.env.ITERATE_CONTEXT,
      DurableObjectNameCodec.parse(this.ctx.props.iterateContextName),
      new SessionTeardown(),
      (p) => this.ctx.waitUntil(p),
    );
  }

  /** globalOutbound: every RAW Request a loaded worker sends — a plain `fetch(url)` (egress) or a
   *  fetch-lane call it addressed itself with `x-itx-expression` (fetch-door-dynamic-live-ws.e2e) —
   *  lands here and goes to the context DO's fetch door unchanged, because THAT door is where raw
   *  Requests are sorted (pager · upgrade leg · `x-itx-expression` lane · egress), exactly as
   *  worker.ts's `/expression` route hands its Request over. Not `get().invoke(["itx",["fetch",…]])`:
   *  the edge's terminal-fetch fork would overwrite a lane header the loaded worker already set.
   *  This method exists because Cloudflare calls `fetch` on the globalOutbound binding. */
  override fetch(request: Request): Promise<Response> {
    return this.env.ITERATE_CONTEXT.getByName(this.ctx.props.iterateContextName).fetch(request);
  }
}

/** Mint the loopback stub for one context — `ctx.exports.ItxEntrypoint({ props })`. `ctx` is any
 *  ctx carrying `exports` (a worker ExecutionContext, a DurableObjectState: workers-types puts the
 *  worker's export table on both). Typed `unknown` only because built-ins.ts's dep record hands it
 *  over that way; `Cloudflare.Exports` is `{}` without a generated `GlobalProps`, hence the cast. */
export function itxEntrypointFor(ctx: unknown, iterateContextName: string): Fetcher {
  const { exports } = ctx as {
    exports: { ItxEntrypoint(opts: { props: { iterateContextName: string } }): Fetcher };
  };
  return exports.ItxEntrypoint({ props: { iterateContextName } });
}
