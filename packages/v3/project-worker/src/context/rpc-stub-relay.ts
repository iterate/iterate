// context/rpc-stub-relay.ts — THE DON'T-PIN PLUMBING behind a live rpc stub, EDGE side. When a client
// hands the project a capnweb callback (`itx.provide(path, fn)`), the client's stub must live in the
// STATELESS relay worker (this side of `/api`), NEVER in the Durable Object — else the DO can't
// hibernate while any client is connected. So the context DO records only a transport id; when it
// wants the client (a delivery, a request/response call), it PAGES the relay over a stub-pager
// WebSocket, and the relay LENDS it a fresh Workers-RPC leg wrapping the client's capnweb stub. The
// edge OWNS the stub for the session; the DO only borrows it. The DO half — the pager door, the
// pages, the borrowed stubs — is context/rpc-stub-directory.ts.
//
// The stub's DO-side identity is the string it is lent under in the `itx.rpcStubs` built-in — the
// canonicalized capability path, when it came through `itx.provide(path, fn)`. Lending is PHYSICAL
// and separate from mounting: the mount is an ordinary capability-table event whose target is
// `itx.rpcStubs.get('<path>')`. This module owns the whole dance behind ONE function —
// `lendStubOverRelay` (lend a stub, hand back a disposable relay; the caller registers it with the
// session's `SessionTeardown`, session.ts) — so session.ts + iterate-context.ts read as its
// narrative (Session → ProjectCollection → IterateContext), with the pager sockets and the shared
// broken-flag hidden here.

import { RpcTarget as WorkersRpcTarget } from "cloudflare:workers";
import type { IterateContextDurableObject } from "../iterate-context-durable-object.ts";
import { codedError } from "../lib/errors.ts";
import { dialLiveCapabilityFetch } from "../fetch/fetch-capabilities.ts";
import {
  disposeStub,
  STUB_PAGER_KEEPALIVE_REQUEST,
  STUB_PAGER_WEBSOCKET_HEADER,
} from "./rpc-stub-directory.ts";

/** The context DO's Workers-RPC stub — what the edge proxies to and this relay pages against. */
export type IterateContextStub = DurableObjectStub<IterateContextDurableObject>;

/** A provider stub (capnweb) from the client. ON THE WIRE it is a callable stub Proxy
 *  (`typeof === "function"` — capnweb pipelines property access through it), so a structural
 *  validator can never inspect it: validated permissively BY DESIGN, typed at the use sites
 *  (`.dup()` keeps it past the provide call; other keys are its remote methods). */
export type ProviderStub = unknown;
/** The session's own copy of a provider stub — `provider.dup()`, held here for the session's life.
 *  It is what every lend is backed by: each page wraps THIS in a fresh `BorrowedStub`. */
export type LentProviderStub = { dup(): LentProviderStub; [k: string]: unknown };

/** WHAT THE DO BORROWS: a per-burst Workers-RPC leg wrapping the session's capnweb stub, forwarding
 *  `invoke(capPath, args)` onto it (a DIRECT dotted dispatch — never `.apply`), so a call from the
 *  stream reaches the client's actual function over the capnweb WebSocket. Minted fresh per page and
 *  returned at the DO's idle quiesce. */
class BorrowedStub extends WorkersRpcTarget {
  #provider: LentProviderStub;
  /** SHARED across every page of one relay (a `{ value }` holder), flipped by the ONE `onRpcBroken`
   *  registration in `lendStubOverRelay`. capnweb has no `offRpcBroken`, so registering per borrowed
   *  stub would accumulate a listener per page for the session's life — the leak
   *  rpc-stub-relay.test.ts pins. capnweb fires onRpcBroken BEFORE it rejects the in-flight import, so a call caught below
   *  sees this already true — no race. */
  #broken: { value: boolean };
  #context: IterateContextStub;
  constructor(provider: LentProviderStub, broken: { value: boolean }, context: IterateContextStub) {
    super();
    this.#provider = provider;
    this.#broken = broken;
    this.#context = context;
  }

  /** Walk dotted segments off the session's capnweb stub (property access pipelines through it). */
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
      // Empty path = the provider IS the callable (a bare callback lent as a capability).
      if (capPath.length === 0)
        return await (this.#provider as unknown as (...a: unknown[]) => unknown)(...args);
      const recv = this.#receiver(capPath.slice(0, -1));
      return await (recv[capPath[capPath.length - 1]] as (...a: unknown[]) => unknown)(...args);
    } catch (e) {
      this.#recodeIfBroken(e, "mid-invoke");
    }
  }
}

/** LEND a live capnweb stub to the DO's `itx.rpcStubs` registry under `key` (the canonical
 *  capability path — the stub's one identity there): reserve a transport on the DO, dup the provider
 *  stub, open the stub pager WebSocket, and answer every page with a fresh `BorrowedStub`. The relay
 *  lives until disposed (explicitly, or at session end — `SessionTeardown`); its close makes the DO
 *  drop the stub — and nothing else: whatever mounts named it stay, answering CONNECTION_OFFLINE. */
export async function lendStubOverRelay(
  context: IterateContextStub,
  provider: LentProviderStub,
  key: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<{ dispose(): void }> {
  const { transportId } = await context.rpcStubAttach({ key });
  const lent = provider.dup();
  // ONE shared broken flag for the whole relay — every borrowed stub reads it; the single
  // onRpcBroken registration below flips it. (Registering per page would leak a listener per page:
  // capnweb has no offRpcBroken. rpc-stub-relay.test.ts pins it.)
  const broken = { value: false };
  // THE STUB PAGER WEBSOCKET, opened through the DO's fetch door carrying the transportId. Nothing
  // but pages ever ride it — the pager is a pager (fetch-upgrade traffic has its own leg,
  // fetch/fetch-capabilities.ts).
  const response = await context.fetch("https://stub-pager.internal/", {
    headers: { Upgrade: "websocket", [STUB_PAGER_WEBSOCKET_HEADER]: transportId },
  });
  const pagerWebSocket = response.webSocket;
  if (!pagerWebSocket)
    throw new Error(`stub pager upgrade returned ${response.status} without a WebSocket`);
  pagerWebSocket.accept();
  // Keep this leg warm: a 30s keepalive the DO auto-answers via setWebSocketAutoResponse WITHOUT
  // waking it — defeats the ~100s idle-close and keeps the /api isolate warm. Dies with the isolate.
  const keepalive = setInterval(() => {
    try {
      pagerWebSocket.send(STUB_PAGER_KEEPALIVE_REQUEST);
    } catch {
      clearInterval(keepalive);
    }
  }, 30_000);
  pagerWebSocket.addEventListener("close", () => clearInterval(keepalive));
  // The page answer: re-mint the Workers-RPC leg around the session's capnweb stub and lend it to
  // the DO, which keeps it borrowed until its idle quiesce.
  pagerWebSocket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let page: unknown;
    try {
      page = JSON.parse(event.data);
    } catch {
      return; // not a page — ignore
    }
    if ((page as { type?: string } | null)?.type !== "page") return;
    waitUntil(
      context
        .rpcStubLend({
          transportId,
          invoker: new BorrowedStub(lent, broken, context),
        })
        .catch(() => undefined), // a stale page (nobody waiting) returns undefined; offline throws — ignore
    );
  });
  const disposeLentStub = () => disposeStub(lent);
  // The library's own death signal, registered ONCE: the client's capnweb session broke → the
  // session's stub can never answer again. Flip the shared flag (so in-flight invokes re-code to
  // CONNECTION_OFFLINE) AND close the pager WebSocket NOW so the DO drops the stub immediately —
  // without this the presence list lies until a page times out (10s).
  (lent as { onRpcBroken?: (cb: () => void) => void }).onRpcBroken?.(() => {
    broken.value = true;
    try {
      pagerWebSocket.close(1000, "provider session broke");
    } catch {
      /* already closing */
    }
  });
  pagerWebSocket.addEventListener("close", disposeLentStub);
  return {
    dispose: () => {
      try {
        pagerWebSocket.close(1000, "relay disposed");
      } catch {
        /* already closing */
      }
      disposeLentStub();
    },
  };
}
