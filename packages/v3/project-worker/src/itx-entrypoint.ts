// itx-entrypoint.ts — THE INTERPOSITION POINT between loaded userspace code and
// the platform. Every confined dynamic worker's whole world (`env.ITX` + `globalOutbound`) is
// a stub of THIS entrypoint, minted via `ctx.exports.ItxEntrypoint({ props:
// { contextName } })` — never a raw `env.CONTEXT.getByName` DO stub. Why (owner's call,
// 2026-08-18, "get ahead of that"):
//
//   • TODAY it forwards every call to the owning Stream DO by name — a swappable
//     implementation detail, not the stub's identity.
//   • TOMORROW it is where DO-free capabilities get served WITHOUT waking the DO (the
//     KV-cached-table future: kv/whoami answered right here; only genuinely
//     actor-shaped targets dial the stream).
//   • It is Kenton-aligned persistence-ready: `ctx.exports`-minted stubs are exactly the kind
//     the shipped persistent-stub machinery (`allow_irrevocable_stub_storage` + `[restore]`)
//     can store and replay — a raw env-binding getByName stub can NEVER be stored. When we
//     want stored itx capabilities, `[restore]` lands on this class and resolves through the
//     ROUTED door, keeping deletion-is-revocation for stored stubs.
//
// The surface is exactly what loaded code speaks: `get()` (hand back the real `IterateContext` scope — the
// dotted door, which owns its own dispatch), the SDK runner's stream verbs
// (`append`/`read`/`waitForEvent`), and `fetch` (globalOutbound egress → the DO's
// secret-substituting terminal).

import { WorkerEntrypoint } from "cloudflare:workers";
import { itxFor } from "./iterate-context.ts";
import type { StreamEvent, StreamEventInput } from "./stream/events.ts";
import type { WaitForEventFilter } from "./stream/stream.ts";
import type { IterateContextDurableObject } from "./iterate-context-durable-object.ts";

interface Env {
  CONTEXT: DurableObjectNamespace<IterateContextDurableObject>;
}

export class ItxEntrypoint extends WorkerEntrypoint<Env> {
  /** The owning context's canonical name — the ONE prop this entrypoint is minted with. */
  #contextName(): string {
    const props = (this.ctx as unknown as { props?: { contextName?: string } }).props;
    if (!props?.contextName)
      throw new Error("ItxEntrypoint requires props.contextName (mint via ctx.exports)");
    return props.contextName;
  }

  /** The owning context, re-resolved per call (never a retained stub — the back-channel rule). */
  #context(): DurableObjectStub<IterateContextDurableObject> {
    return this.env.CONTEXT.getByName(this.#contextName());
  }

  /** THE handoff for the Workers-RPC lane: hand back the genuine itx scope (an `IterateContext` RpcTarget), so
   *  loaded code writes plain dotted access — `const itx = await env.ITX.get(); itx.demo.timer.x(…)`
   *  — identical to a capnweb client after `session.get()`, and mid-chain handles pipeline natively.
   *  A service binding addresses THIS entrypoint class; `.get()` bridges it to the scope. */
  get(): unknown {
    return itxFor(this.env.CONTEXT, this.#contextName(), (p) => this.ctx.waitUntil(p));
  }

  append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    return this.#context().append(...inputs);
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

/** Mint the loopback stub for one context. `exportsCtx` is any ctx carrying `exports` (worker
 *  ExecutionContext, DO state, facet state — all expose the worker's export table). */
export function itxEntrypointFor(exportsCtx: unknown, contextName: string): Fetcher {
  const exports = (exportsCtx as { exports?: Record<string, unknown> }).exports;
  const make = exports?.ItxEntrypoint as
    | ((opts: { props: { contextName: string } }) => Fetcher)
    | undefined;
  if (typeof make !== "function")
    throw new Error("ItxEntrypoint loopback unavailable on ctx.exports");
  return make({ props: { contextName } });
}
