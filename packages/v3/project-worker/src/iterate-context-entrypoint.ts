// iterate-context-entrypoint.ts — THE INTERPOSITION POINT between loaded userspace code and
// the platform. Every confined dynamic worker's whole world (`env.ITX` + `globalOutbound`) is
// a stub of THIS entrypoint, minted via `ctx.exports.IterateContextEntrypoint({ props:
// { contextName } })` — never a raw `env.CONTEXT.getByName` DO stub. Why (owner's call,
// 2026-08-18, "get ahead of that"):
//
//   • TODAY it forwards every call to the owning Stream DO by name — a swappable
//     implementation detail, not the stub's identity.
//   • TOMORROW it is where DO-free capabilities get served WITHOUT waking the DO (the
//     KV-cached-table future: bindings/kv/secrets/whoami answered right here; only genuinely
//     actor-shaped targets dial the stream).
//   • It is Kenton-aligned persistence-ready: `ctx.exports`-minted stubs are exactly the kind
//     the shipped persistent-stub machinery (`allow_irrevocable_stub_storage` + `[restore]`)
//     can store and replay — a raw env-binding getByName stub can NEVER be stored. When we
//     want stored itx capabilities, `[restore]` lands on this class and resolves through the
//     ROUTED door, keeping deletion-is-revocation for stored stubs.
//
// The surface is exactly what loaded code speaks: the dotted door (`invokeCapability` via the
// injected itx.js), the full-expression door (`invoke`), the SDK runner's stream verbs
// (`append`/`read`), and `fetch` (globalOutbound egress → the DO's secret-substituting
// terminal).

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Expression } from "./core/expression.ts";
import type { StreamEvent, StreamEventInput } from "./core/events.ts";
import type { StreamDurableObject } from "./stream-durable-object.ts";

interface Env {
  CONTEXT: DurableObjectNamespace<StreamDurableObject>;
}

export class IterateContextEntrypoint extends WorkerEntrypoint<Env> {
  /** The owning context, re-resolved per call (never a retained stub — the back-channel rule). */
  #host(): DurableObjectStub<StreamDurableObject> {
    const props = (this.ctx as unknown as { props?: { contextName?: string } }).props;
    if (!props?.contextName)
      throw new Error("IterateContextEntrypoint requires props.contextName (mint via ctx.exports)");
    return this.env.CONTEXT.getByName(props.contextName);
  }

  invokeCapability(callPath: string, args: unknown[] = []): Promise<unknown> {
    return this.#host().invokeCapability(callPath, args);
  }

  invoke(call: string | Expression, depth = 0): Promise<unknown> {
    return this.#host().invoke(call, depth);
  }

  append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    return this.#host().append(...inputs);
  }

  read(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: StreamEvent[]; scannedThroughOffset: number }> {
    return this.#host().read(afterOffset, limit);
  }

  /** globalOutbound: every fetch a loaded worker makes lands here → the DO's egress terminal
   *  (secret placeholder substitution → FALLBACK). */
  override fetch(request: Request): Promise<Response> {
    return this.#host().fetch(request);
  }
}

/** Mint the loopback stub for one context. `hostCtx` is any ctx carrying `exports` (worker
 *  ExecutionContext, DO state, facet state — all expose the worker's export table). */
export function itxEntrypointFor(hostCtx: unknown, contextName: string): Fetcher {
  const exports = (hostCtx as { exports?: Record<string, unknown> }).exports;
  const make = exports?.IterateContextEntrypoint as
    | ((opts: { props: { contextName: string } }) => Fetcher)
    | undefined;
  if (typeof make !== "function")
    throw new Error("IterateContextEntrypoint loopback unavailable on ctx.exports");
  return make({ props: { contextName } });
}
