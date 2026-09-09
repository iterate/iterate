// context/rpc-stub-relay.ts — THE DON'T-PIN PLUMBING behind a lent rpc stub, EDGE side. When a client
// hands the project a capnweb value (`itx.provide(match, stub)`), the client's stub must live in the
// STATELESS relay worker (this side of `/api`), NEVER in the Durable Object — else the DO can't
// hibernate while any client is connected. So the edge opens an RPC-STUB PAGER WebSocket to the DO
// (a standing offer to lend the key back on demand); when the DO wants the client — a delivery, a
// request/response call — it PAGES this worker, and this worker LENDS a fresh Workers-RPC leg
// wrapping the client's capnweb stub (`lendRpcStub`). The edge OWNS the stub for the session; the DO
// only borrows it. The DO half — the pager door, the pages, the borrowed table — is
// context/rpc-stub-directory.ts.
//
// This module owns the whole dance behind ONE function — `lendRpcStubOverPager` (open the pager, hand
// back a disposable; the caller registers it with the session's `SessionTeardown`, session.ts) — so
// session.ts + iterate-context.ts read as its narrative, with the pager socket and the shared
// broken-flag hidden here.

import { RpcTarget as WorkersRpcTarget } from "cloudflare:workers";
import type { IterateContextDurableObject } from "../iterate-context-durable-object.ts";
import { dialRpcStubFetch } from "../fetch/rpc-stub-fetch.ts";
import { codedError } from "../lib/errors.ts";
import type { StreamEventInput } from "../stream/events.ts";
import type { ItxExpression } from "./expression.ts";
import { walkStepsOnRpcStub } from "./invoke-handle.ts";
import {
  disposeRpcStub,
  encodeRpcStubPagerAttachRequest,
  RPC_STUB_PAGER_KEEPALIVE_REQUEST,
  RPC_STUB_PAGER_WEBSOCKET_HEADER,
} from "./rpc-stub-directory.ts";

/** The context DO's Workers-RPC stub — what the edge proxies to and this relay pages against. */
export type IterateContextDurableObjectStub = DurableObjectStub<IterateContextDurableObject>;

/** The client's live capnweb stub, as the session holds it (`.dup()` keeps it past the call that
 *  handed it over; every other key is one of its remote members). ON THE WIRE it is a callable stub
 *  Proxy (`typeof === "function"`), so nothing structural can inspect it — typed at the use sites. */
export type ClientRpcStub = { dup(): ClientRpcStub; [k: string]: unknown };

/** WHAT THE EDGE LENDS (and the DO borrows as `BorrowedRpcStub`): a per-page Workers-RPC leg
 *  wrapping the session's capnweb stub, walking itx-expression steps on it (a DIRECT dotted dispatch
 *  — never `.apply`), so a call from the stream reaches the client's actual function over the capnweb
 *  WebSocket. Minted fresh per page and returned at the DO's idle quiesce. */
class LentRpcStub extends WorkersRpcTarget {
  #clientRpcStub: ClientRpcStub;
  /** SHARED across every page of one pager (a `{ reason }` holder), set ONCE by whatever ends the
   *  lend first — the ONE `onRpcBroken` registration in `lendRpcStubOverPager` (the client's session
   *  broke) or the pager's close (the lender recalled the stub; the DO returned it) — always BEFORE
   *  the session's dup is disposed, so a call already walking the dup re-codes below. capnweb has no
   *  `offRpcBroken`, so registering per lent stub would accumulate a listener per page for the
   *  session's life — the leak rpc-stub-relay.test.ts pins. capnweb fires onRpcBroken BEFORE it
   *  rejects the in-flight import, so a call caught below sees the reason already set — no race. */
  #lendEnded: { reason: string | null };
  #durableObject: IterateContextDurableObjectStub;
  constructor(
    clientRpcStub: ClientRpcStub,
    lendEnded: { reason: string | null },
    durableObject: IterateContextDurableObjectStub,
  ) {
    super();
    this.#clientRpcStub = clientRpcStub;
    this.#lendEnded = lendEnded;
    this.#durableObject = durableObject;
  }

  /** The lend ended mid-call — the client died (capnweb throws its raw, UNCODED close error), or the
   *  lender recalled the stub while the DO still held the rule naming it (the DO's un-set lands one
   *  append AFTER the pager's close; a call in that window walks the disposed dup and capnweb throws
   *  its raw "disposed" error — review round 2, edge#13). Re-code LOCALLY to RPC_STUB_OFFLINE so the
   *  CODE (never a message) crosses the Workers-RPC hop back to the caller (lib/errors.ts: classify
   *  by code across a hop). A genuine app error propagates untouched. */
  #recodeIfLendEnded(e: unknown, what: string): never {
    if (this.#lendEnded.reason)
      throw codedError("RPC_STUB_OFFLINE", `the lent rpc stub ${this.#lendEnded.reason} ${what}`);
    throw e;
  }

  /** The rpc-stub fetch dial, TRANSPORT side — the whole mechanism (why it exists, the upgrade leg,
   *  the marker) lives in fetch/rpc-stub-fetch.ts. */
  async fetch(
    upgradeId: string,
    itxExpressionSteps: ItxExpression,
    request: Request,
  ): Promise<unknown> {
    try {
      const receiver = (await walkStepsOnRpcStub(this.#clientRpcStub, itxExpressionSteps)) as {
        fetch(r: Request): Promise<unknown>;
      };
      return await dialRpcStubFetch(
        (r) => receiver.fetch(r),
        request,
        upgradeId,
        this.#durableObject,
      );
    } catch (e) {
      this.#recodeIfLendEnded(e, "mid-fetch");
    }
  }

  async invoke(itxExpressionSteps: ItxExpression): Promise<unknown> {
    try {
      return await walkStepsOnRpcStub(this.#clientRpcStub, itxExpressionSteps);
    } catch (e) {
      this.#recodeIfLendEnded(e, "mid-invoke");
    }
  }
}

/** Offer the DO a lend of `clientRpcStub` under `rpcStubKey`: dup the client's stub for the session,
 *  open the pager WebSocket — its header carries the key AND `appendEvents`, the rule / the row that
 *  names the key, which the DO appends in the turn it accepts the pager (ONE round trip; a refused
 *  append comes back as the upgrade's answer with its code, and this function throws it with nothing
 *  lent) — and answer every page with a fresh `LentRpcStub`. The pager lives until disposed
 *  (explicitly, or at session end — `SessionTeardown`); its close makes the DO return the stub; when
 *  it was the key's LAST pager, the DO also un-sets every rule and subscription naming the key
 *  (iterate-context-durable-object.ts onPresence). Otherwise nothing: a replaced pager is a
 *  reconnect, and the new session's rule stands. */
export async function lendRpcStubOverPager(
  durableObject: IterateContextDurableObjectStub,
  clientRpcStub: ClientRpcStub,
  rpcStubKey: string,
  appendEvents: StreamEventInput[],
  waitUntil: (p: Promise<unknown>) => void,
): Promise<{ dispose(): void }> {
  const sessionRpcStub = clientRpcStub.dup(); // dup FIRST: a value that is not a stub fails here, before any socket
  // ONE shared "the lend ended" reason for the whole pager — every lent stub reads it; set by the
  // single onRpcBroken registration below or by the one place the dup is disposed. (Registering
  // onRpcBroken per page would leak a listener per page: capnweb has no offRpcBroken.
  // rpc-stub-relay.test.ts pins it.)
  const lendEnded: { reason: string | null } = { reason: null };
  // THE PAGER WEBSOCKET, opened through the DO's fetch door: the header is the attach request.
  // Nothing but pages ever ride the socket (fetch-upgrade traffic has its own leg,
  // fetch/rpc-stub-fetch.ts).
  let response: Response;
  try {
    response = await durableObject.fetch("https://rpc-stub-pager.internal/", {
      headers: {
        Upgrade: "websocket",
        [RPC_STUB_PAGER_WEBSOCKET_HEADER]: encodeRpcStubPagerAttachRequest({
          rpcStubKey,
          appendEvents,
        }),
      },
    });
  } catch (error) {
    // The DO never answered (its constructor threw on a bad APP_CONFIG_* var, a reset mid-call):
    // nothing is lent, and the session's dup must not outlive the attempt.
    disposeRpcStub(sessionRpcStub);
    throw error;
  }
  const pagerWebSocket = response.webSocket;
  if (response.status !== 101 || !pagerWebSocket) {
    // The DO refused (a paused stream, a row the reduce rejects) or something is wrong with the
    // door: nothing is lent — release the session's dup — and the refusal's CODE crosses to the
    // caller as the same coded error the append door would have thrown.
    disposeRpcStub(sessionRpcStub);
    const refusal = (await response.json().catch(() => null)) as {
      code?: string | null;
      message?: string;
    } | null;
    throw Object.assign(
      new Error(
        refusal?.message ??
          `rpc stub pager upgrade returned ${response.status} without a WebSocket`,
      ),
      refusal?.code ? { code: refusal.code } : {},
    );
  }
  pagerWebSocket.accept();
  // Keep this leg warm: a 30s keepalive the DO auto-answers via setWebSocketAutoResponse WITHOUT
  // waking it — defeats the ~100s idle-close and keeps the /api isolate warm. Dies with the isolate.
  const keepalive = setInterval(() => {
    try {
      pagerWebSocket.send(RPC_STUB_PAGER_KEEPALIVE_REQUEST);
    } catch {
      clearInterval(keepalive);
    }
  }, 30_000);
  pagerWebSocket.addEventListener("close", () => clearInterval(keepalive));
  // The page answer: re-mint the Workers-RPC leg around the session's capnweb stub and lend it to
  // the DO, which keeps it borrowed until its idle quiesce. The keepalive ack rides this same
  // socket (a non-JSON string every 30 s), so anything that is not a page is ignored.
  pagerWebSocket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let page: unknown;
    try {
      page = JSON.parse(event.data);
    } catch {
      return;
    }
    if ((page as { type?: string } | null)?.type !== "page") return;
    waitUntil(
      durableObject
        .lendRpcStub({
          rpcStubKey,
          stub: new LentRpcStub(sessionRpcStub, lendEnded, durableObject),
        })
        .catch(() => undefined), // offline throws — ignore; the DO's page times out on its own
    );
  });
  // THE ONE PLACE the session's dup is disposed, the reason set FIRST (the first reason wins): a call
  // already walking the dup — the DO's un-set of what names the key lands one append after the
  // pager's close — re-codes to RPC_STUB_OFFLINE instead of surfacing capnweb's raw "disposed" error.
  const disposeSessionRpcStub = (reason: string) => {
    lendEnded.reason ??= reason;
    disposeRpcStub(sessionRpcStub);
  };
  // The library's own death signal, registered ONCE: the client's capnweb session broke → the
  // session's stub can never answer again. Set the shared reason (so in-flight invokes re-code to
  // RPC_STUB_OFFLINE) AND close the pager NOW so the DO returns the stub immediately — without this
  // the presence list lies until a page times out (10s).
  (sessionRpcStub as { onRpcBroken?: (cb: () => void) => void }).onRpcBroken?.(() => {
    lendEnded.reason = "went offline (its client session broke)";
    try {
      pagerWebSocket.close(1000, "client session broke");
    } catch {
      /* already closing */
    }
  });
  pagerWebSocket.addEventListener("close", () =>
    disposeSessionRpcStub("was returned (its pager closed)"),
  );
  return {
    dispose: () => {
      try {
        pagerWebSocket.close(1000, "pager disposed");
      } catch {
        /* already closing */
      }
      disposeSessionRpcStub("was recalled by its lender");
    },
  };
}
