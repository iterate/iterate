// context/rpc-stub-relay.ts — THE DON'T-PIN PLUMBING behind a live rpc stub. When a client hands the
// project a capnweb callback (`itx.provide(path, fn)`), the retained stub must live in the
// STATELESS relay worker (this side of `/api`), NEVER in the Durable Object — else the DO can't
// hibernate while any client is connected. So the stream DO records only a transport id; when it
// wants the client (a delivery, a request/response call), it PAGES the relay over a stub-pager
// WebSocket, and the relay answers with a fresh Workers-RPC leg wrapping the retained capnweb stub.
//
// The stub's DO-side identity is the string it is parked under in the `itx.rpcStubs` built-in —
// the canonicalized capability path, when it came through `itx.provide(path, fn)`. Parking is
// PHYSICAL and separate from mounting: the mount is an ordinary capability-table event whose
// target is `itx.rpcStubs.get('<path>')`. This module owns the whole dance behind a TWO-SYMBOL
// API — `startRpcStubRelay` (park a stub, hand back a disposable relay) and `Parking` (the
// session-lived registry that keeps relays alive; the caller keys it) — so iterate-context.ts reads as
// its narrative (ProjectSession → IterateContext → the built-in collections), with the pager
// sockets and the shared broken-flag hidden here.

import { RpcTarget as WorkersRpcTarget } from "cloudflare:workers";
import type { IterateContextDurableObject } from "../iterate-context-durable-object.ts";
import { codedError } from "../lib/errors.ts";
import { dialLiveCapabilityFetch } from "../fetch/fetch-capabilities.ts";
import { disposeStub, openStubPagerWebSocket } from "./hibernatable-rpc-stub.ts";

/** The context DO's Workers-RPC stub — what the edge proxies to and this relay pages against. */
export type IterateContextStub = DurableObjectStub<IterateContextDurableObject>;

/** A retained provider stub (capnweb) from the client. ON THE WIRE it is a callable stub Proxy
 *  (`typeof === "function"` — capnweb pipelines property access through it), so a structural
 *  validator can never inspect it: validated permissively BY DESIGN, typed at the use sites
 *  (`.dup()` keeps it past the provide call; other keys are its remote methods). */
export type ProviderStub = unknown;
export type RetainedProviderStub = { dup(): RetainedProviderStub; [k: string]: unknown };

/** The per-burst borrowed Workers-RPC leg: wraps the RETAINED CAPNWEB CALLBACK STUB and forwards
 *  `invoke(capPath, args)` onto it (a DIRECT dotted dispatch — never `.apply`), so a call from the
 *  stream reaches the client's actual function over the capnweb WebSocket. */
class RetainedCallbackInvoker extends WorkersRpcTarget {
  #provider: RetainedProviderStub;
  /** SHARED across every page of one relay (a `{ value }` holder), flipped by the ONE `onRpcBroken`
   *  registration in `startRpcStubRelay`. capnweb has no `offRpcBroken`, so registering per paged-in
   *  invoker would accumulate a listener per page for the session's life — the leak the failing test
   *  pins. capnweb fires onRpcBroken BEFORE it rejects the in-flight import, so a call caught below
   *  sees this already true — no race. */
  #broken: { value: boolean };
  #context: IterateContextStub;
  constructor(
    provider: RetainedProviderStub,
    broken: { value: boolean },
    context: IterateContextStub,
  ) {
    super();
    this.#provider = provider;
    this.#broken = broken;
    this.#context = context;
  }

  /** Walk dotted segments off the retained capnweb stub (property access pipelines through it). */
  #receiver(capPath: string[]): Record<string, unknown> {
    let recv = this.#provider as unknown as Record<string, unknown>;
    for (const seg of capPath) recv = recv[seg] as Record<string, unknown>;
    return recv;
  }

  /** The provider died mid-call: capnweb throws its raw, UNCODED close error. Re-code LOCALLY to
   *  CONNECTION_OFFLINE so the CODE (never a message) crosses the Workers-RPC hop back to the
   *  caller (lib/errors.ts: classify by code across a hop). A genuine app error from a live
   *  client propagates untouched. */
  #recodeIfBroken(e: unknown, what: string): never {
    if (this.#broken.value)
      throw codedError("CONNECTION_OFFLINE", `itx rpc stub provider went offline ${what}`);
    throw e;
  }

  /** The live-capability fetch dial, TRANSPORT side — the whole mechanism (why it exists, the
   *  upgrade leg, the marker) lives in fetch/fetch-capabilities.ts. */
  async fetch(upgradeId: string, capPath: string[], request: Request): Promise<unknown> {
    try {
      const recv = this.#receiver(capPath) as { fetch(req: Request): Promise<unknown> };
      return await dialLiveCapabilityFetch((r) => recv.fetch(r), request, upgradeId, this.#context);
    } catch (e) {
      this.#recodeIfBroken(e, "mid-fetch");
    }
  }

  async invoke(capPath: string[], args: unknown[]): Promise<unknown> {
    try {
      // Empty path = the provider IS the callable (a bare callback parked as a capability).
      if (capPath.length === 0)
        return await (this.#provider as unknown as (...a: unknown[]) => unknown)(...args);
      const recv = this.#receiver(capPath.slice(0, -1));
      return await (recv[capPath[capPath.length - 1]] as (...a: unknown[]) => unknown)(...args);
    } catch (e) {
      this.#recodeIfBroken(e, "mid-invoke");
    }
  }
}

/** One CAPNWEB CALLBACK RELAY: the retained capnweb callback stub + the stub pager WebSocket into
 *  one stream DO + a fresh RetainedCallbackInvoker per page. One relay per (rpc stub, stream) pair;
 *  a client's capnweb WebSocket carries many. */
export interface CapnwebCallbackRelay {
  transportId: string;
  dispose(): void;
}

/** Session-lived registry of what dies with the session: live relays (retained callbacks + pager
 *  sockets, so they aren't GC'd) and anything else the session must undo at its end (an anonymous
 *  subscription's removal) — ONE entry per key. THE CALLER OWNS THE KEY: one session's Parking spans
 *  every IterateContext it hands out, and a capability path is only unique PER CONTEXT, so
 *  IterateContext keys by the composite `"<contextName> <capabilityPath>"` (see #parkingKey) — the
 *  bare path would let two contexts providing at the same path destroy each other's relay. Re-adding
 *  the SAME key is a TRANSPORT REPLACEMENT (a re-park at the same context + path — a reconnect): by
 *  the time the new relay's pager is open, the DO has already dropped the old transport as
 *  "replaced", so disposing the incumbent here is a harmless double-close that just keeps this map
 *  from accumulating dead relays. */
export class Parking {
  readonly #relays = new Map<string, { dispose(): void }>();
  add(key: string, relay: { dispose(): void }): void {
    this.#relays.get(key)?.dispose();
    this.#relays.set(key, relay);
  }
  dispose(key: string): void {
    const relay = this.#relays.get(key);
    if (!relay) return;
    this.#relays.delete(key);
    relay.dispose();
  }
  disposeAll(): void {
    for (const relay of this.#relays.values()) relay.dispose();
    this.#relays.clear();
  }
}

/** Park a live capnweb stub in the DO's `itx.rpcStubs` registry under `path` (the canonicalized
 *  string — the stub's one identity there): reserve a transport on the DO, dup the provider stub,
 *  open the stub pager WebSocket, and answer every page with a fresh stub. The relay lives until
 *  disposed (explicitly, or at session end); its close makes the DO drop the stub — and nothing
 *  else: whatever mounts named it stay, answering CONNECTION_OFFLINE. */
export async function startRpcStubRelay(
  context: IterateContextStub,
  provider: RetainedProviderStub,
  path: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<CapnwebCallbackRelay> {
  const { transportId } = await context.rpcStubAttach({ path });
  const retained = provider.dup();
  // ONE shared broken flag for the whole relay — every paged-in invoker reads it; the single
  // onRpcBroken registration below flips it. (Registering per page would leak a listener per page:
  // capnweb has no offRpcBroken. See rpc-stub-broken-leak.failing.test.ts.)
  const broken = { value: false };
  const pagerWebSocket = await openStubPagerWebSocket(context, transportId, () => {
    // The page answer: re-mint the Workers-RPC stub around the retained capnweb callback and
    // hand it to the DO, which keeps it warm until its idle quiesce.
    waitUntil(
      context
        .rpcStubActivate({
          transportId,
          invoker: new RetainedCallbackInvoker(retained, broken, context),
        })
        .catch(() => undefined), // a stale page (nobody waiting) returns undefined; offline throws — ignore
    );
  });
  const disposeRetained = () => disposeStub(retained);
  // The library's own death signal, registered ONCE: the client's capnweb session broke → the
  // retained callback can never answer again. Flip the shared flag (so in-flight invokes re-code to
  // CONNECTION_OFFLINE) AND close the pager WebSocket NOW so the DO drops the stub immediately —
  // without this the presence list lies until a page times out (10s).
  (retained as { onRpcBroken?: (cb: () => void) => void }).onRpcBroken?.(() => {
    broken.value = true;
    try {
      pagerWebSocket.close(1000, "provider session broke");
    } catch {
      /* already closing */
    }
  });
  pagerWebSocket.addEventListener("close", disposeRetained);
  return {
    transportId,
    dispose: () => {
      try {
        pagerWebSocket.close(1000, "relay disposed");
      } catch {
        /* already closing */
      }
      disposeRetained();
    },
  };
}
