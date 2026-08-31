// core/rpc-stub-relay.ts — THE DON'T-PIN PLUMBING behind a live rpc stub. When a client hands the
// project a capnweb callback (`itx.rpcStubs.provide(fn, {key})`), the retained stub must live in the
// STATELESS relay worker (this side of `/api`), NEVER in the Durable Object — else the DO can't
// hibernate while any client is connected. So the stream DO records only a transport id; when it
// wants the client (a delivery, a request/response call), it PAGES the relay over a stub-pager
// WebSocket, and the relay answers with a fresh Workers-RPC leg wrapping the retained capnweb stub.
//
// This module owns that whole dance behind a TWO-SYMBOL API — `startRpcStubRelay` (park a stub, hand
// back a disposable relay) and `Parking` (the session-lived registry that keeps relays alive) — so
// itx-surface.ts reads as its narrative (ProjectSession → Itx → the built-in collections), with the
// pager sockets, the shared broken-flag, and shadow-relay disposal hidden here.

import { RpcTarget as WorkersRpcTarget } from "cloudflare:workers";
import type { StreamDurableObject } from "../stream-durable-object.ts";
import { codedError } from "./errors.ts";
import {
  disposeStub,
  openStubPagerWebSocket,
  type ProviderSocket,
} from "./hibernatable-rpc-stub.ts";

export type ItxHostStub = DurableObjectStub<StreamDurableObject>;

/** A retained provider stub (capnweb) from the client. ON THE WIRE it is a callable stub Proxy
 *  (`typeof === "function"` — capnweb pipelines property access through it), so a structural
 *  validator can never inspect it: validated permissively BY DESIGN, typed at the use sites
 *  (`.dup()` keeps it past the provide call; other keys are its remote methods). */
export type ProviderStub = unknown;
export type RetainedProviderStub = { dup(): RetainedProviderStub; [k: string]: unknown };

/** Is this a LIVE capnweb capability (a stub function or an RpcTarget) rather than an expression (a
 *  string or an Expression array)? Live things get parked as rpc stubs; expressions are mounted. */
export function isLiveStub(target: unknown): boolean {
  return typeof target === "function" || (typeof target === "object" && !Array.isArray(target));
}

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
  constructor(provider: RetainedProviderStub, broken: { value: boolean }) {
    super();
    this.#provider = provider;
    this.#broken = broken;
  }
  async invoke(capPath: string[], args: unknown[]): Promise<unknown> {
    try {
      // Empty path = the provider IS the callable (a bare callback parked as a capability).
      if (capPath.length === 0)
        return await (this.#provider as unknown as (...a: unknown[]) => unknown)(...args);
      let recv = this.#provider as unknown as Record<string, unknown>;
      for (let i = 0; i < capPath.length - 1; i++)
        recv = recv[capPath[i]] as Record<string, unknown>;
      return await (recv[capPath[capPath.length - 1]] as (...a: unknown[]) => unknown)(...args);
    } catch (e) {
      // The provider died mid-call: capnweb throws its raw, UNCODED close error here. Re-code
      // LOCALLY to CONNECTION_OFFLINE so the CODE (never a message) crosses the Workers-RPC hop
      // back to the caller — the same condition the offline pre-call paths throw (core/errors.ts:
      // classify by code across a hop). A genuine app error from a live client propagates untouched.
      if (this.#broken.value)
        throw codedError("CONNECTION_OFFLINE", "itx rpc stub provider went offline mid-invoke");
      throw e;
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

/** Session-lived registry of live relays (retained callbacks + pager sockets) so they aren't GC'd.
 *  `named` additionally keys a relay by subscription name so `unsubscribe` can dispose exactly it. */
export class Parking {
  readonly #relays = new Set<CapnwebCallbackRelay>();
  /** name → ALL relays parked under it. Re-subscribing the SAME name SHADOWS (the old callback
   *  stops receiving but its connection stays live — failing-delivery.test.ts:158), so the older
   *  relay is KEPT here, not disposed. `unsubscribe` then disposes the WHOLE set — else a shadowed
   *  relay lingers online and a restored shadowed mount resumes delivering to it (the zombie,
   *  probe_resub_zombie.mjs). */
  readonly #named = new Map<string, Set<CapnwebCallbackRelay>>();
  add(relay: CapnwebCallbackRelay): void {
    this.#relays.add(relay);
  }
  addNamed(name: string, relay: CapnwebCallbackRelay): void {
    this.#relays.add(relay);
    let set = this.#named.get(name);
    if (!set) {
      set = new Set();
      this.#named.set(name, set);
    }
    set.add(relay);
  }
  remove(relay: CapnwebCallbackRelay): void {
    this.#relays.delete(relay);
  }
  disposeNamed(name: string): void {
    const relays = this.#named.get(name);
    if (!relays) return;
    this.#named.delete(name);
    for (const relay of relays) {
      this.#relays.delete(relay);
      relay.dispose();
    }
  }
  disposeAll(): void {
    for (const relay of this.#relays) relay.dispose();
    this.#relays.clear();
    this.#named.clear();
  }
}

/** Park a live capnweb stub as an rpc stub under `key`: reserve a transport on the DO, dup the
 *  provider stub, open the stub pager WebSocket, and answer every page with a fresh stub. The
 *  relay lives until disposed (explicitly, or at session end); its close makes the DO drop the stub
 *  (⇒ any mount naming the key auto-revokes). */
export async function startRpcStubRelay(
  host: ItxHostStub,
  provider: RetainedProviderStub,
  key: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<CapnwebCallbackRelay> {
  const { transportId } = await host.rpcStubAttach({ key });
  const retained = provider.dup();
  // ONE shared broken flag for the whole relay — every paged-in invoker reads it; the single
  // onRpcBroken registration below flips it. (Registering per page would leak a listener per page:
  // capnweb has no offRpcBroken. See rpc-stub-broken-leak.failing.test.ts.)
  const broken = { value: false };
  // The bridge's provider dial (ws-open): forward the upgrade to the provider's fetch OVER THE
  // CAPNWEB SESSION — this closure runs in the session's own request context, the one place its
  // socket is legally touchable (workerd pins I/O to the creating context). The fork carries the
  // provider's webSocket-bearing 101 back as a tunneled socket.
  const openProviderSocket = async (
    url: string,
    headers: Record<string, string>,
  ): Promise<ProviderSocket> => {
    const response = (await (retained as unknown as { fetch(r: Request): Promise<unknown> }).fetch(
      new Request(url, { headers: { ...headers, Upgrade: "websocket" } }),
    )) as {
      status?: number;
      webSocket?: ProviderSocket | null;
    };
    const socket = response?.webSocket;
    if (!socket)
      throw new Error(`provider answered ${response?.status ?? "?"} without a webSocket`);
    socket.accept?.();
    return socket;
  };
  const pagerWebSocket = await openStubPagerWebSocket(
    host,
    transportId,
    () => {
      // The page answer: re-mint the Workers-RPC stub around the retained capnweb callback and
      // hand it to the DO, which keeps it warm until its idle quiesce.
      waitUntil(
        host
          .rpcStubActivate({ transportId, invoker: new RetainedCallbackInvoker(retained, broken) })
          .catch(() => undefined), // a stale page (nobody waiting) returns undefined; offline throws — ignore
      );
    },
    openProviderSocket,
  );
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
