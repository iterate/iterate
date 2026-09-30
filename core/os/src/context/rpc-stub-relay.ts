// context/rpc-stub-relay.ts — THE RELAY: the edge side of a lent rpc stub. When a client hands the
// project a capnweb value (`itx.provide(match, stub)`), the client's stub must live in the
// STATELESS relay worker (this side of `/api`), NEVER in the Durable Object — else the DO can't
// hibernate while any client is connected. So the edge opens an RPC-STUB PAGER WebSocket to the DO
// (a standing offer to lend the key back on demand); when the DO wants the client — a delivery, a
// request/response call — it PAGES this worker, and this worker LENDS a fresh Workers-RPC leg
// wrapping the client's capnweb stub (`lendRpcStub`). The edge OWNS the stub for the session; the DO
// only borrows it. The DO half — the pager upgrade, the pages, the borrowed table — and the lend's
// state machine, with every recovery this file runs ([A] relend, [B] re-dial, [C] probe), are in
// rpc-stubs.ts.
//
// The whole dance is behind ONE function, `lendRpcStubOverPager` (open the pager, hand back a
// disposable the caller registers with its `SessionTeardown`).

import { RpcTarget as WorkersRpcTarget } from "cloudflare:workers";
import { failureKind, RELAY_BURST, retryPlatformFailures } from "iterate/platform-retry";
import { codedError } from "iterate/lib";
import type { StreamEventInput } from "iterate/stream/processor";
import { type ItxExpression, walkStepsOnRpcStub } from "iterate/expression";
import type { IterateContextDurableObject } from "../iterate-context-durable-object.ts";
import { dialRpcStubFetch } from "./fetch-upgrade.ts";
import { redial } from "./redial.ts";
import {
  disposeRpcStub,
  encodeRpcStubPagerAttachRequest,
  RPC_STUB_PAGER_KEEPALIVE_REQUEST,
  RPC_STUB_PAGER_WEBSOCKET_HEADER,
} from "./rpc-stubs.ts";

/** How long a dropped pager is re-dialed (redial.ts) before its lend ends, which pages: twelve tries
 *  over ~56 s, a dial with no answer given up at 60 s. All 555 pager re-dials on prd 2026-09-24–25
 *  were answered by the third try, 6 s after the drop; the tenfold headroom keeps a slower deploy's
 *  reset from paging. */
const RPC_STUB_PAGER_REDIAL_DEADLINE_MS = 60_000;

/** The context DO's Workers-RPC stub — what the edge proxies to and this relay pages against. */
export type IterateContextDurableObjectStub = DurableObjectStub<IterateContextDurableObject>;

/** The client's live capnweb stub, as the session holds it (`.dup()` keeps it past the call that
 *  handed it over; every other key is one of its remote members). ON THE WIRE it is a callable stub
 *  Proxy (`typeof === "function"`), so nothing structural can inspect it — typed at the use sites. */
export type ClientRpcStub = { dup(): ClientRpcStub; [k: string]: unknown };

/** WHAT THE EDGE LENDS (and the DO borrows as `BorrowedRpcStub`): a per-page Workers-RPC leg
 *  wrapping the session's capnweb stub, walking itx-expression steps on it (a DIRECT dotted dispatch
 *  — never `.apply`), so a call from the stream reaches the client's actual function over the capnweb
 *  WebSocket. Minted fresh per page and returned at the pins' release (context/residency.ts). */
class LentRpcStub extends WorkersRpcTarget {
  #clientRpcStub: ClientRpcStub;
  #rpcStubKey: string;
  /** THE ONE "the lend ended" reason, SHARED across every page of one pager (a `{ reason }` holder)
   *  and set ONCE by whatever ends the lend first — the single `onRpcBroken` registration in
   *  `lendRpcStubOverPager` or the pager's close — always BEFORE the session's dup is disposed, so a
   *  call already walking the dup re-codes below. Shared because capnweb has no `offRpcBroken`:
   *  registering per lent stub would accumulate a listener per page for the session's life. capnweb
   *  fires onRpcBroken BEFORE it rejects the in-flight import, so a caught call sees the reason set. */
  #lendEnded: { reason: string | null };
  /** Minted per dial: the upgrade leg re-dials after a reset (fetch-upgrade-splice.ts), and a stub
   *  that saw the reset replays it. */
  #durableObjectStub: () => IterateContextDurableObjectStub;
  constructor(
    clientRpcStub: ClientRpcStub,
    rpcStubKey: string,
    lendEnded: { reason: string | null },
    durableObjectStub: () => IterateContextDurableObjectStub,
  ) {
    super();
    this.#clientRpcStub = clientRpcStub;
    this.#rpcStubKey = rpcStubKey;
    this.#lendEnded = lendEnded;
    this.#durableObjectStub = durableObjectStub;
  }

  /** The lend ended mid-call — the client died, or the lender recalled the stub while the DO still
   *  held the rule naming it (its un-set lands one append AFTER the pager's close, and a call in that
   *  window walks the disposed dup): capnweb throws a raw, UNCODED error either way, so re-code
   *  LOCALLY to RPC_STUB_OFFLINE — the CODE crosses the Workers-RPC hop (lib.ts). A genuine
   *  app error propagates untouched. */
  #recodeIfLendEnded(e: unknown, what: string): never {
    if (this.#lendEnded.reason)
      throw codedError("RPC_STUB_OFFLINE", `the lent rpc stub ${this.#lendEnded.reason} ${what}`);
    throw e;
  }

  /** The rpc-stub fetch dial, TRANSPORT side — the whole mechanism (why it exists, the upgrade leg,
   *  the marker) lives in fetch-upgrade.ts. */
  async fetch(
    upgradeId: string,
    itxExpressionSteps: ItxExpression,
    request: Request,
  ): Promise<unknown> {
    try {
      return await whileClientAnswers(this.#clientRpcStub, this.#rpcStubKey, async () => {
        // The steps stop short of the terminal `fetch` the call named (terminalFetchOf split it
        // off), so the receiver is what the client serves `fetch` on; a client without one rejects.
        const receiver = (await walkStepsOnRpcStub(this.#clientRpcStub, itxExpressionSteps)) as {
          fetch(r: Request): Promise<unknown>;
        };
        return await dialRpcStubFetch(
          (r) => receiver.fetch(r),
          request,
          upgradeId,
          this.#durableObjectStub,
        );
      });
    } catch (e) {
      this.#recodeIfLendEnded(e, "mid-fetch");
    }
  }

  async invoke(itxExpressionSteps: ItxExpression): Promise<unknown> {
    try {
      return await whileClientAnswers(this.#clientRpcStub, this.#rpcStubKey, () =>
        walkStepsOnRpcStub(this.#clientRpcStub, itxExpressionSteps),
      );
    } catch (e) {
      this.#recodeIfLendEnded(e, "mid-invoke");
    }
  }
}

/** A LENT CALL THE CLIENT HAS NOT ANSWERED for 10 s is followed by a question (the lend's recovery
 *  [C], rpc-stubs.ts): a call on a member no client has (`itxLivenessProbe`), which a live client
 *  answers at once, with an error (capnweb's "is not a function", the kit firmware's "unknown
 *  device capability"). Any answer proves the client is there, and the call waits on (a slow local
 *  server is the client's business), asked again every 10 s. No answer within 10 s more means the
 *  client's network went away without a close — a laptop asleep, a NAT mapping expired — and its
 *  socket would stay open at the edge until the edge's TCP retransmits give up (12 to 16 minutes,
 *  measured on prd 2026-09-25). The call fails RPC_STUB_OFFLINE instead (a 502 on a fetch,
 *  `expression-fetch.rpc-stub-offline`). The lend stays: a client that was only slow answers the
 *  next call, and a dead one's session close ends it. */
async function whileClientAnswers(
  clientRpcStub: ClientRpcStub,
  rpcStubKey: string,
  makeCall: () => unknown,
): Promise<unknown> {
  const call = Promise.resolve().then(makeCall);
  const settled = call.then(
    () => "settled" as const,
    () => "settled" as const,
  );
  const within = <A>(answer: Promise<A>, ms: number): Promise<A | "silent"> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      answer,
      new Promise<"silent">((resolve) => (timer = setTimeout(() => resolve("silent"), ms))),
    ]).finally(() => clearTimeout(timer));
  };
  const startedAt = Date.now();
  while ((await within(settled, 10_000)) === "silent") {
    // A capnweb stub answers every member name as a remote callable, so this call goes to the
    // client, which has no such member: its rejection is the answer.
    const probe = Promise.resolve()
      .then(() => (clientRpcStub.itxLivenessProbe as () => Promise<unknown>)())
      .then(disposeRpcStub, () => undefined)
      .then(() => "answered" as const);
    if ((await within(Promise.race([settled, probe]), 10_000)) !== "silent") continue;
    console.warn({
      event: "rpc-stub-client-unanswered",
      namespace: "rpc-stubs",
      message:
        "a lent stub's client answered neither a call nor a liveness probe; the call fails RPC_STUB_OFFLINE",
      rpcStubKey,
      waitedMs: Date.now() - startedAt,
    });
    throw codedError(
      "RPC_STUB_OFFLINE",
      `rpc stub ${JSON.stringify(rpcStubKey)}: its client stopped answering`,
    );
  }
  return await call;
}

/** Offer the DO a lend of `clientRpcStub` under `rpcStubKey`: dup the client's stub for the session,
 *  open the pager WebSocket — its header carries the key AND `appendEvents`, the rows naming the key,
 *  which the DO appends as it accepts the pager (rpc-stubs.ts, the directory; a refusal comes back
 *  as the upgrade's answer with its code, and this function throws it with nothing lent) — and answer
 *  every page with a fresh `LentRpcStub`. The pager lives until disposed (explicitly, or at session
 *  end); its close makes the DO return the stub. THE LEND IS THE SESSION'S, NOT THE SOCKET'S: the
 *  pager is a connection between this isolate and the DO, never the client's own socket, and it
 *  drops while the session lives — a fault on the hop between colos, a DO reset (which kills every
 *  hibernatable socket with no close handler run). A pager that closes with neither side having
 *  ended the lend is RE-DIALED (redial.ts, the lend's recovery [B]): the DO's attach re-appends
 *  `appendEvents`, and the directory treats a second pager at the key as a reconnect, never a
 *  detach. */
export async function lendRpcStubOverPager(
  /** Minted per use, never held: a DurableObjectStub that saw a reset replays it on every later call
   *  (Cloudflare's error-handling guide), and a re-dial after a reset must reach the fresh incarnation. */
  durableObjectStub: () => IterateContextDurableObjectStub,
  clientRpcStub: ClientRpcStub,
  rpcStubKey: string,
  appendEvents: StreamEventInput[],
  waitUntil: (p: Promise<unknown>) => void,
): Promise<{ dispose(): void; lendEnded: Promise<string> }> {
  const sessionRpcStub = clientRpcStub.dup(); // dup FIRST: a value that is not a stub fails here, before any socket
  // the one shared "the lend ended" reason (LentRpcStub#lendEnded says why it is shared)
  const lendEnded: { reason: string | null } = { reason: null };
  // THE PAGER WEBSOCKET, opened through the DO's `fetch`: the header is the attach request — the
  // first dial here, every re-dial below.
  const dialPager = () =>
    durableObjectStub().fetch("https://rpc-stub-pager.internal/", {
      headers: {
        Upgrade: "websocket",
        [RPC_STUB_PAGER_WEBSOCKET_HEADER]: encodeRpcStubPagerAttachRequest({
          rpcStubKey,
          appendEvents,
        }),
      },
    });
  let response: Response;
  try {
    response = await dialPager();
  } catch (error) {
    // the DO never answered: nothing is lent, and the session's dup must not outlive the attempt
    disposeRpcStub(sessionRpcStub);
    throw error;
  }
  if (response.status !== 101 || !response.webSocket) {
    // The DO refused (a paused stream, a row the reduce rejects): nothing is lent, and the refusal's
    // CODE crosses to the caller as the same coded error the append would have thrown.
    disposeRpcStub(sessionRpcStub);
    // The body is the DO's own refusal, `{ code, message }` (rpc-stubs.ts
    // `acceptRpcStubPagerWebSocket`); each field is read as optional, and a body that is not JSON
    // reads as null.
    const refusal = (await response.json().catch(() => null)) as {
      code?: string | null;
      message?: string;
    } | null;
    throw Object.assign(
      new Error(
        refusal?.message ||
          `rpc stub pager upgrade returned ${response.status} without a WebSocket`,
      ),
      refusal?.code ? { code: refusal.code } : {},
    );
  }
  // THE ONE PLACE the session's dup is disposed, the reason set FIRST (the first reason wins) so a
  // call already walking the dup re-codes (LentRpcStub#recodeIfLendEnded) — and the lender's
  // `lendEnded()` answers with it.
  let resolveLendEnded = (_reason: string) => {};
  const lendEndedPromise = new Promise<string>((resolve) => (resolveLendEnded = resolve));
  const disposeSessionRpcStub = (reason: string) => {
    lendEnded.reason ||= reason;
    disposeRpcStub(sessionRpcStub);
    resolveLendEnded(lendEnded.reason);
  };
  /** THE PAGE ANSWER: a fresh Workers-RPC leg around the session's capnweb stub, lent to the DO.
   *  THE LEND'S RECOVERY [A]: a lend the platform failed (a relay's connection to the DO can drop
   *  under a burst of lends, failing every lend in flight with "Network connection lost."; a
   *  deploy's reset) is lent again on a fresh stub on the `RELAY_BURST` schedule, logged
   *  `rpc-stubs.platform-failure-retry`; re-lending a key replaces its stub, so a repeat is
   *  harmless. An overloaded DO is not lent to again at once. A lend that still fails is logged,
   *  the DO's page times out, and a push waiting on it is lost. */
  const answerPage = async (): Promise<void> => {
    try {
      await retryPlatformFailures(
        async () => {
          if (lendEnded.reason) return; // recalled while a repeat waited: there is nothing to lend
          await durableObjectStub().lendRpcStub({
            rpcStubKey,
            stub: new LentRpcStub(sessionRpcStub, rpcStubKey, lendEnded, durableObjectStub),
          });
        },
        {
          area: "rpc-stubs",
          schedule: RELAY_BURST,
          idempotent: true,
          // A lend recalled meanwhile has nothing left to lend: its failure is no platform failure.
          kind: (error) => (lendEnded.reason ? "failed" : failureKind(error)),
          describe: () => ({ name: "lendRpcStub", rpcStubKey }),
        },
      );
    } catch (error) {
      if (lendEnded.reason) return; // recalled meanwhile: there is nothing left to lend
      console.warn({
        event: "rpc-stub-lend-failed",
        namespace: "rpc-stubs",
        message: "a page's lend failed: the DO's page times out, and a push waiting on it is lost",
        rpcStubKey,
        error: String(error),
      });
    }
  };
  /** The pager in service — a re-dial replaces it. */
  let pagerWebSocket = response.webSocket;
  /** Take one accepted pager into service: the keepalive, the page answer, and what its close means. */
  const attachPager = (ws: WebSocket): void => {
    pagerWebSocket = ws;
    /** When the DO last answered on this pager (a keepalive ack or a page), and how many keepalives
     *  it has left unanswered since. */
    let answeredAt = Date.now();
    let unanswered = 0;
    /** Set once this pager is out of service; its late close event means nothing. */
    let retired = false;
    // THE PAGER'S LIVENESS (the lend's recovery [B]): a keepalive the DO auto-answers via
    // setWebSocketAutoResponse WITHOUT waking it, every 500 ms; a pager that leaves three in a row
    // unanswered is dropped and re-dialed. A deploy resets the DO and its end of every pager with
    // it, but this end may hear no close for a minute (measured on prd 2026-09-25), and every stub
    // lent over the pager is offline until it does. Counted in keepalives SENT, never wall time, so
    // an isolate that stalls does not read its own stall as the DO's silence. The keepalive also
    // keeps the /api isolate warm.
    const keepalive = setInterval(() => {
      if (unanswered >= 3) {
        retired = true;
        clearInterval(keepalive);
        // Re-dial BEFORE closing: a DO that was only slow sees the new pager replace this one (a
        // swap, never a detach that would un-set what names the key).
        waitUntil(
          redialPager({
            code: 4000,
            reason: `${unanswered} keepalives unanswered`,
            answeredAt,
          }).finally(() => {
            try {
              ws.close(4000, "keepalive unanswered");
            } catch {
              /* already closing */
            }
          }),
        );
        return;
      }
      unanswered += 1; // a send that throws is a keepalive the DO never answers
      try {
        ws.send(RPC_STUB_PAGER_KEEPALIVE_REQUEST);
      } catch {
        /* closing: its close event, or three unanswered keepalives, takes it out of service */
      }
    }, 500);
    // The keepalive ack rides this same socket, so anything that is not a page is ignored.
    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      answeredAt = Date.now();
      unanswered = 0;
      let page: unknown;
      try {
        page = JSON.parse(event.data);
      } catch {
        return;
      }
      // The DO sends one message down a pager, `{type:"page"}`; any other shape reads as not a page.
      if ((page as { type?: string } | null)?.type !== "page") return;
      waitUntil(answerPage());
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      clearInterval(keepalive);
      if (retired) return;
      retired = true;
      // The lender ended it (dispose, the session broke), or the DO closed it cleanly (a newer pager
      // at this key replaced it): the lend is over and the dup goes back with the pager.
      if (lendEnded.reason || event.code === 1000) {
        disposeSessionRpcStub("was returned (its pager closed)");
        return;
      }
      waitUntil(redialPager({ code: event.code, reason: event.reason, answeredAt }));
    });
  };
  /** The leg dropped under a live lend: re-dial it (redial.ts) and take the new pager into service.
   *  A lend recalled meanwhile ends the re-dial quietly: a session that is ending (a voice board
   *  gone, its /api socket closing) often loses its pager a moment before its own end reaches this
   *  lend, so the drop is logged with its outcome, only once the session proved live — back in
   *  service (a warn) or not (an ERROR: the client is still connected but unreachable through its
   *  key, and the prd fault alarm pages on errors). `downMs` counts from the pager's last answer,
   *  the last moment the key was known reachable: a close heard late is downtime too. */
  const redialPager = async (dropped: {
    code: number;
    reason: string;
    answeredAt: number;
  }): Promise<void> => {
    const redialed = await redial(
      dialPager,
      () => Boolean(lendEnded.reason),
      RPC_STUB_PAGER_REDIAL_DEADLINE_MS,
    );
    if (!redialed) return;
    const drop = {
      namespace: "rpc-stubs",
      rpcStubKey,
      code: dropped.code,
      reason: dropped.reason,
      downMs: Date.now() - dropped.answeredAt,
    };
    if ("socket" in redialed) {
      attachPager(redialed.socket);
      console.warn({
        event: "rpc-stub-pager-redialed",
        message:
          "a lent stub's pager dropped under a live session and is back in service; the DO re-appended what names the key",
        ...drop,
        attempt: redialed.dials,
      });
      return;
    }
    console.error({
      event: "rpc-stub-pager-redial-failed",
      message:
        "a lent stub's pager dropped under a live session and could not be re-dialed; the lend ends, and the DO un-sets what named it on the pager's close or, when the DO reset took the pager with no close run, on its next wake",
      ...drop,
      lastFailure: redialed.gaveUp,
    });
    disposeSessionRpcStub("went offline (its pager dropped and could not be re-dialed)");
  };
  pagerWebSocket.accept();
  attachPager(pagerWebSocket);
  // capnweb's own death signal, registered ONCE: set the shared reason AND close the pager NOW so the
  // DO returns the stub immediately — without this the presence list lies until a page times out.
  // `ClientRpcStub` types only `dup`; a capnweb stub also has `onRpcBroken`, and a stub without it
  // (a test's fake) skips the registration.
  (sessionRpcStub as { onRpcBroken?: (cb: () => void) => void }).onRpcBroken?.(() => {
    lendEnded.reason = "went offline (its client session broke)";
    try {
      pagerWebSocket.close(1000, "client session broke");
    } catch {
      /* already closing */
    }
  });
  return {
    dispose: () => {
      disposeSessionRpcStub("was recalled by its lender");
      try {
        pagerWebSocket.close(1000, "pager disposed");
      } catch {
        /* already closing */
      }
    },
    lendEnded: lendEndedPromise,
  };
}
