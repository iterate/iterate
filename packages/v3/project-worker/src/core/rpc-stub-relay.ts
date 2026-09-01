// core/rpc-stub-relay.ts — THE DON'T-PIN PLUMBING behind a live rpc stub. When a client hands the
// project a capnweb callback (`itx.provide(path, fn)`), the retained stub must live in the
// STATELESS relay worker (this side of `/api`), NEVER in the Durable Object — else the DO can't
// hibernate while any client is connected. So the stream DO records only a transport id; when it
// wants the client (a delivery, a request/response call), it PAGES the relay over a stub-pager
// WebSocket, and the relay answers with a fresh Workers-RPC leg wrapping the retained capnweb stub.
//
// The stub's identity IS the capability path it is mounted at (one canonicalized string — no
// separate key). This module owns the whole dance behind a TWO-SYMBOL API — `startRpcStubRelay`
// (park a stub, hand back a disposable relay) and `Parking` (the session-lived registry, keyed by
// path, that keeps relays alive) — so itx-surface.ts reads as its narrative (ProjectSession →
// IterateContext → the built-in collections), with the pager sockets and the shared broken-flag
// hidden here.

import { RpcTarget as WorkersRpcTarget } from "cloudflare:workers";
import type { IterateContextDurableObject } from "../stream-durable-object.ts";
import { codedError } from "./errors.ts";
import { dialLiveCapabilityFetch } from "./fetch-capabilities.ts";
import { disposeStub, openStubPagerWebSocket } from "./hibernatable-rpc-stub.ts";

export type ItxHostStub = DurableObjectStub<IterateContextDurableObject>;

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
  #host: ItxHostStub;
  constructor(provider: RetainedProviderStub, broken: { value: boolean }, host: ItxHostStub) {
    super();
    this.#provider = provider;
    this.#broken = broken;
    this.#host = host;
  }

  /** Walk dotted segments off the retained capnweb stub (property access pipelines through it). */
  #receiver(capPath: string[]): Record<string, unknown> {
    let recv = this.#provider as unknown as Record<string, unknown>;
    for (const seg of capPath) recv = recv[seg] as Record<string, unknown>;
    return recv;
  }

  /** The provider died mid-call: capnweb throws its raw, UNCODED close error. Re-code LOCALLY to
   *  CONNECTION_OFFLINE so the CODE (never a message) crosses the Workers-RPC hop back to the
   *  caller (core/errors.ts: classify by code across a hop). A genuine app error from a live
   *  client propagates untouched. */
  #recodeIfBroken(e: unknown, what: string): never {
    if (this.#broken.value)
      throw codedError("CONNECTION_OFFLINE", `itx rpc stub provider went offline ${what}`);
    throw e;
  }

  /** The live-capability fetch dial, TRANSPORT side — the whole mechanism (why it exists, the
   *  upgrade leg, the marker) lives in core/fetch-capabilities.ts. */
  async fetch(upgradeId: string, capPath: string[], request: Request): Promise<unknown> {
    try {
      const recv = this.#receiver(capPath) as { fetch(req: Request): Promise<unknown> };
      return await dialLiveCapabilityFetch((r) => recv.fetch(r), request, upgradeId, this.#host);
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

/** Session-lived registry of live relays (retained callbacks + pager sockets) so they aren't GC'd —
 *  ONE relay per mount path (the stub's identity). Re-providing the same path is a TRANSPORT
 *  REPLACEMENT: by the time the new relay's pager is open, the DO has already dropped the old
 *  transport as "replaced", so disposing the incumbent here is a harmless double-close that just
 *  keeps this map from accumulating dead relays. (The old shadow-a-relay bookkeeping died with the
 *  one-live-row-per-path reduce rule — the resub zombie is structurally impossible now.) */
export class Parking {
  readonly #relays = new Map<string, CapnwebCallbackRelay>();
  add(path: string, relay: CapnwebCallbackRelay): void {
    this.#relays.get(path)?.dispose();
    this.#relays.set(path, relay);
  }
  dispose(path: string): void {
    const relay = this.#relays.get(path);
    if (!relay) return;
    this.#relays.delete(path);
    relay.dispose();
  }
  disposeAll(): void {
    for (const relay of this.#relays.values()) relay.dispose();
    this.#relays.clear();
  }
}

/** Park a live capnweb stub as an rpc stub at its mount `path` (the canonicalized string — the
 *  stub's one identity): reserve a transport on the DO, dup the provider stub, open the stub pager
 *  WebSocket, and answer every page with a fresh stub. The relay lives until disposed (explicitly,
 *  or at session end); its close makes the DO drop the stub (⇒ the live mount at the path
 *  auto-revokes). */
export async function startRpcStubRelay(
  host: ItxHostStub,
  provider: RetainedProviderStub,
  path: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<CapnwebCallbackRelay> {
  const { transportId } = await host.rpcStubAttach({ path });
  const retained = provider.dup();
  // ONE shared broken flag for the whole relay — every paged-in invoker reads it; the single
  // onRpcBroken registration below flips it. (Registering per page would leak a listener per page:
  // capnweb has no offRpcBroken. See rpc-stub-broken-leak.failing.test.ts.)
  const broken = { value: false };
  const pagerWebSocket = await openStubPagerWebSocket(host, transportId, () => {
    // The page answer: re-mint the Workers-RPC stub around the retained capnweb callback and
    // hand it to the DO, which keeps it warm until its idle quiesce.
    waitUntil(
      host
        .rpcStubActivate({
          transportId,
          invoker: new RetainedCallbackInvoker(retained, broken, host),
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
