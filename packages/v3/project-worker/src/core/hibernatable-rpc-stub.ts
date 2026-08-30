// core/hibernatable-rpc-stub.ts — THE HIBERNATABLE RPC STUB, and its manager.
//
// THE PROBLEM: a stream DO wants to call back into a client (browser tab, device, another
// worker) whose live capnweb callback stub exists ONLY inside the stateless edge worker's
// session (capnweb terminates at /api, never in the DO). Workers RPC can pass a stub across the
// boundary — but a DO that RETAINS one is pinned awake forever, which breaks the
// 1000-idle-devices property.
//
// THE MECHANIC (the whole design in four sentences): the edge worker opens ONE WebSocket to the
// DO per stub — THE STUB PAGER WEBSOCKET — accepted through the DO's hibernation API, carrying
// a small durable record in its attachment and NOTHING else. When the DO needs the stub, it
// sends `{type: "page"}` down that socket — it PAGES the stateless edge worker — and the edge
// answers over Workers RPC with a fresh stub (`activate`). The DO uses the stub for as long as
// traffic flows — event-batch delivery, state changes, request/response calls all ride this ONE
// stub via `invoke(path, args)` — and DISPOSES it at its idle quiesce, knowing a page always
// gets it back. Between pages the DO holds nothing but hibernatable sockets, so it hibernates
// while any number of clients stay attached.
//
// This is a poor-man's sturdy ref: the durable half is the socket attachment (survives
// hibernation), the restore hook is the page. A native ctx.exports sturdy ref cannot express it
// because the real capability lives inside a BROWSER's WebSocket session — only the edge worker
// holding that socket can re-mint the stub, so restore MUST route through it.
//
// The manager is the partial-fetch helper the DO composes in (`#rpcStubs.fetch(req)`
// first, own doors after) — stub mechanics live here, domain meaning (RpcStubDirectory, session
// facts) stays in the DO. It is record-AGNOSTIC: callers stamp what they need and read it back.

export const STUB_PAGER_WEBSOCKET_HEADER = "x-itx-stub-pager";
const STUB_PAGER_WEBSOCKET_TAG = "itx-stub-pager-websocket";

/** The ONE message the stub pager WebSocket ever carries (DO → edge): "I ought to have your
 *  RPC stub but I don't — send it." Everything else rides Workers RPC on the paged-in stub. */
type StubPageMessage = { type: "page" };

/** The Workers-RPC stub the paged edge worker hands back: it forwards `invoke(path, args)`
 *  onto the retained capnweb callback (a DIRECT dotted dispatch — never `.apply`). */
export type RetainedCallbackInvoker = {
  invoke(path: string[], args: unknown[]): Promise<unknown>;
  dup?(): RetainedCallbackInvoker;
};

/** One stub's durable record — the socket attachment (survives hibernation). `stubKey` is the
 *  manager's identity for it; every other field is the caller's own stamp. */
export type HibernatableRpcStubRecord = { stubKey: string; [k: string]: unknown };

// `Symbol.dispose` isn't in the current lib target; reference it defensively. THE one disposer
// for any RPC-ish stub (Workers-RPC legs here, retained capnweb callbacks in itx-surface.ts).
const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
export function disposeStub(x: unknown): void {
  const f = DISPOSE ? (x as Record<symbol, unknown>)[DISPOSE] : undefined;
  if (typeof f === "function") (f as () => void).call(x);
}

import { codedError } from "./errors.ts";
import { createLogger } from "./logs.ts";

const stubLog = createLogger("hibernatable-rpc-stub");
const PAGE_TIMEOUT_MS = 10_000; // a paged edge worker has this long to hand back its stub

type Hooks = {
  acceptWebSocket(ws: WebSocket, tags: string[]): void;
  getWebSockets(tag: string): WebSocket[];
};

export class HibernatableRpcStubManager {
  readonly #hooks: Hooks;
  // The PAGED-IN stubs, in memory ONLY and kept WARM: steady traffic pays ONE page, then every
  // delivery is a plain RPC call. Disposal is the caller's idle quiesce
  // (disposeRetainedStubs()) — never per-call, never a timer (a pending timer would itself pin
  // the DO out of hibernation).
  #retained = new Map<string, { invoker: RetainedCallbackInvoker; inFlight: number }>();
  // One entry per stub awaiting its page answer; CONCURRENT cold invokes share it (`arrived`) —
  // a second caller must never replace the first's resolver (it would hang forever).
  #pagesPending = new Map<
    string,
    {
      resolve(): void;
      reject(e: Error): void;
      timer: ReturnType<typeof setTimeout>;
      arrived: Promise<void>;
    }
  >();

  constructor(hooks: Hooks) {
    this.#hooks = hooks;
  }

  /** PARTIAL FETCH: accept a stub pager WebSocket upgrade, or `undefined` when the request
   *  isn't one (the composing DO then runs its own doors). */
  fetch(request: Request): Response | undefined {
    const stubKey = request.headers.get(STUB_PAGER_WEBSOCKET_HEADER);
    if (stubKey === null) return undefined;
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket")
      return new Response(
        `stub pager: expected a websocket upgrade with ${STUB_PAGER_WEBSOCKET_HEADER}\n`,
        { status: 400 },
      );
    const pair = new WebSocketPair();
    this.#hooks.acceptWebSocket(pair[1], [STUB_PAGER_WEBSOCKET_TAG]);
    pair[1].serializeAttachment({ stubKey } satisfies HibernatableRpcStubRecord);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Stamp a stub's record onto its (already-open) pager socket — carried through hibernation. */
  attach(stubKey: string, record: Record<string, unknown>): void {
    const ws = this.#socketFor(stubKey);
    if (ws === undefined)
      throw new Error(`hibernatable rpc stub ${stubKey} has no pager websocket`);
    ws.serializeAttachment({ stubKey, ...record });
  }

  /** Every attached stub — DERIVED from the surviving pager sockets, so a fresh DO incarnation
   *  reads them straight back with nothing to reconcile. */
  all(): HibernatableRpcStubRecord[] {
    return this.#sockets()
      .map((ws) => this.#attachment(ws))
      .filter((r): r is HibernatableRpcStubRecord => r !== undefined && Object.keys(r).length > 1);
  }

  /** THE one call door: page the stub in if absent, then `invoke(path, args)` on it. The stub
   *  stays warm afterwards — steady traffic is pure RPC, no socket round-trips. Fire-and-forget
   *  callers just don't await (a failed delivery is the client's heal-by-pull). */
  async invoke(stubKey: string, path: string[], args: unknown[]): Promise<unknown> {
    const retained = await this.#pageIn(stubKey);
    retained.inFlight += 1;
    try {
      // A provider that dies mid-call is re-coded to CONNECTION_OFFLINE at the RELAY
      // (RetainedCallbackInvoker.invoke), where the break is LOCAL — so the CODE, never a message,
      // crosses this hop (core/errors.ts).
      return await retained.invoker.invoke(path, args);
    } finally {
      retained.inFlight -= 1;
    }
  }

  /** The edge's answer to a page: it hands back a fresh stub over Workers RPC. Returns
   *  undefined for a stale page (none pending). */
  activate(input: { stubKey: string; invoker: RetainedCallbackInvoker }): { ok: true } | undefined {
    const pending = this.#pagesPending.get(input.stubKey);
    if (pending === undefined) return undefined;
    const prev = this.#retained.get(input.stubKey);
    this.#retained.set(input.stubKey, {
      invoker: input.invoker.dup?.() ?? input.invoker,
      inFlight: 0,
    });
    if (prev) disposeStub(prev.invoker);
    clearTimeout(pending.timer);
    this.#pagesPending.delete(input.stubKey);
    pending.resolve();
    return { ok: true };
  }

  /** THE IDLE DISPOSAL (call from the DO's quiesce alarm): drop every paged-in stub so the DO
   *  can hibernate. Losing them costs exactly one page on the next call — that is the deal. */
  disposeRetainedStubs(): void {
    for (const [stubKey, retained] of this.#retained) {
      if (retained.inFlight > 0)
        stubLog.warn("disposing a stub with calls in flight (idle quiesce)", {
          event: "stub.disposed-in-flight",
          stubKey,
          inFlight: retained.inFlight,
        });
      this.#retained.delete(stubKey);
      disposeStub(retained.invoker);
    }
  }

  /** Close a stub's pager WebSocket (revoke / kick / replace) and forget it. */
  drop(stubKey: string, reason: string): void {
    const ws = this.#socketFor(stubKey);
    if (ws)
      try {
        ws.close(1000, reason);
      } catch {
        /* already closing */
      }
    this.#forget(stubKey);
  }

  /** A pager WebSocket closed — the stub is gone with it. Hands back the record so the caller
   *  can run its own lifecycle (ephemeral facts, auto-revoke, session settlement). */
  closed(ws: WebSocket): HibernatableRpcStubRecord | undefined {
    const record = this.#attachment(ws);
    if (record) this.#forget(record.stubKey);
    return record;
  }

  /** Observability: `dormant` ⇒ nothing paged in (the DO can hibernate; stubs stay attached). */
  state(): Record<string, unknown> {
    return {
      stubs: this.all().length,
      pagedIn: this.#retained.size,
      pagesPending: this.#pagesPending.size,
      dormant: this.#retained.size === 0 && this.#pagesPending.size === 0,
    };
  }

  #sockets(): WebSocket[] {
    return this.#hooks
      .getWebSockets(STUB_PAGER_WEBSOCKET_TAG)
      .filter((ws) => ws.readyState === WebSocket.OPEN);
  }
  #socketFor(stubKey: string): WebSocket | undefined {
    return this.#sockets().find((ws) => this.#attachment(ws)?.stubKey === stubKey);
  }
  #attachment(ws: WebSocket): HibernatableRpcStubRecord | undefined {
    try {
      const a = ws.deserializeAttachment() as HibernatableRpcStubRecord | null;
      return a && typeof a.stubKey === "string" ? a : undefined;
    } catch {
      // A malformed attachment reads as "no attachment" — the socket is then invisible to the
      // registry and dies at its next close; better than wedging every enumeration.
      return undefined;
    }
  }

  async #pageIn(stubKey: string): Promise<{ invoker: RetainedCallbackInvoker; inFlight: number }> {
    let retained = this.#retained.get(stubKey);
    if (retained === undefined) {
      const ws = this.#socketFor(stubKey);
      if (ws === undefined)
        throw codedError(
          "CONNECTION_OFFLINE",
          `hibernatable rpc stub ${stubKey} offline (no pager websocket)`,
        );
      let pending = this.#pagesPending.get(stubKey);
      if (pending === undefined) {
        let resolve!: () => void;
        let reject!: (e: Error) => void;
        const arrived = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
        const timer = setTimeout(() => {
          if (this.#pagesPending.delete(stubKey))
            reject(new Error(`hibernatable rpc stub ${stubKey}: page timed out`));
        }, PAGE_TIMEOUT_MS);
        pending = { resolve, reject, timer, arrived };
        this.#pagesPending.set(stubKey, pending);
        try {
          ws.send(JSON.stringify({ type: "page" } satisfies StubPageMessage));
        } catch {
          ws.close(1011, "page send failed");
        }
      }
      await pending.arrived;
      retained = this.#retained.get(stubKey);
      if (retained === undefined)
        throw new Error(`hibernatable rpc stub ${stubKey}: page answered empty`);
    }
    return retained;
  }

  #forget(stubKey: string): void {
    const retained = this.#retained.get(stubKey);
    if (retained) {
      this.#retained.delete(stubKey);
      disposeStub(retained.invoker);
    }
    const pending = this.#pagesPending.get(stubKey);
    if (pending) {
      clearTimeout(pending.timer);
      this.#pagesPending.delete(stubKey);
      pending.reject(
        codedError("CONNECTION_OFFLINE", `hibernatable rpc stub ${stubKey} went offline`),
      );
    }
  }
}

/** Edge side: open the stub pager WebSocket to a stream DO (via its stub's `fetch`), answering
 *  every `{type: "page"}` by re-minting the Workers-RPC stub through `onPage`. */
export async function openStubPagerWebSocket(
  host: { fetch(url: string, init?: RequestInit): Promise<Response> },
  stubKey: string,
  onPage: () => void,
): Promise<WebSocket> {
  const response = await host.fetch("https://stub-pager.internal/", {
    headers: { Upgrade: "websocket", [STUB_PAGER_WEBSOCKET_HEADER]: stubKey },
  });
  if (!response.webSocket)
    throw new Error(`stub pager upgrade returned ${response.status} without a WebSocket`);
  response.webSocket.accept();
  // Keep this leg warm: a 30s "ping" the DO auto-"pong"s via setWebSocketAutoResponse WITHOUT
  // waking it — defeats the ~100s idle-close and keeps the /api isolate warm. Dies with the isolate.
  const keepalive = setInterval(() => {
    try {
      response.webSocket!.send("ping");
    } catch {
      clearInterval(keepalive);
    }
  }, 30_000);
  response.webSocket.addEventListener("close", () => clearInterval(keepalive));
  response.webSocket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    try {
      if ((JSON.parse(event.data) as StubPageMessage)?.type === "page") onPage();
    } catch {
      /* not a page — ignore */
    }
  });
  return response.webSocket;
}
