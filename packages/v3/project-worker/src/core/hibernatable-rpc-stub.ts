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
// facts) stays in the DO. Its one addressing fact is the directory's `connectionKey`, stamped by
// `attach` and carried through hibernation on the pager socket.

import { codedError } from "./errors.ts";
import { createLogger } from "./logs.ts";

export const STUB_PAGER_WEBSOCKET_HEADER = "x-itx-stub-pager";
const STUB_PAGER_WEBSOCKET_TAG = "itx-stub-pager-websocket";

/** DO → edge over the stub pager WebSocket. `page` = "I ought to have your RPC stub but I
 *  don't — send it" (everything call-shaped rides Workers RPC on the paged-in stub). The ws-*
 *  messages are THE WEBSOCKET BRIDGE: a fetch-shaped upgrade on a live capability cannot return
 *  its 101 Response over Workers RPC (workerd's RPC serializer has no WebSocket support —
 *  DataCloneError), and a loopback entrypoint cannot touch the relay's capnweb session either
 *  (workerd pins I/O objects to their creating request context). The pager socket is the ONE
 *  channel that already connects the DO to the relay's session context — so the DO terminates
 *  the eyeball's socket itself (a native 101 on the fetch channel) and FRAMES bridge over the
 *  pager: `ws-open` dials the provider, `ws-send` carries eyeball→provider frames, `ws-close`
 *  tears down. Binary frames ride base64 (`b64: true`). */
type StubPageMessage =
  | { type: "page" }
  | { type: "ws-open"; bridgeId: string; url: string; headers: Record<string, string> }
  | { type: "ws-send"; bridgeId: string; data: string; b64?: true }
  | { type: "ws-close"; bridgeId: string; code: number; reason: string };

/** Edge → DO over the same pager socket (besides the "itx-pager-keepalive" text). The dial ACK
 *  (`ws-open-ok`/`ws-open-fail`) is what lets the DO answer the eyeball HONESTLY: no 101 until the
 *  provider actually upgraded; a provider failure rides back as a non-101 carrying its words. */
type StubPagerReply =
  | { type: "ws-open-ok"; bridgeId: string }
  | { type: "ws-open-fail"; bridgeId: string; reason: string }
  | { type: "ws-frame"; bridgeId: string; data: string; b64?: true }
  | { type: "ws-close"; bridgeId: string; code: number; reason: string };

const WS_BRIDGE_TAG = "itx-ws-bridge";
/** A bridged eyeball socket's attachment (survives hibernation — the bridge does too). */
type WsBridgeAttachment = { wsBridge: { bridgeId: string; stubKey: string } };

/** Frame codec for the pager bridge: strings ride verbatim, binary rides base64 (chunked — a
 *  spread over a large frame would blow the stack). */
export function encodeWsFrame(data: string | ArrayBuffer): { data: string; b64?: true } {
  if (typeof data === "string") return { data };
  const bytes = new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(binary), b64: true };
}
export function decodeWsFrame(frame: { data: string; b64?: true }): string | ArrayBuffer {
  if (!frame.b64) return frame.data;
  const binary = atob(frame.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** The Workers-RPC stub the paged edge worker hands back: it forwards `invoke(path, args)`
 *  onto the retained capnweb callback (a DIRECT dotted dispatch — never `.apply`). */
export type RetainedCallbackInvoker = {
  invoke(path: string[], args: unknown[]): Promise<unknown>;
  dup?(): RetainedCallbackInvoker;
};

/** One stub's durable record — the socket attachment (survives hibernation). `stubKey` is the
 *  manager's identity for it; `connectionKey` is the caller's addressing key, stamped by `attach`
 *  (absent on a socket that has been opened but not yet attached — `all()` filters those out). */
export type HibernatableRpcStubRecord = { stubKey: string; connectionKey?: string };
/** An ATTACHED record — `connectionKey` present. `all()` returns only these. */
type AttachedRpcStubRecord = HibernatableRpcStubRecord & { connectionKey: string };

// `Symbol.dispose` isn't in the current lib target; reference it defensively. THE one disposer
// for any RPC-ish stub (Workers-RPC legs here, retained capnweb callbacks in itx-surface.ts).
const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
export function disposeStub(x: unknown): void {
  const f = DISPOSE ? (x as Record<symbol, unknown>)[DISPOSE] : undefined;
  if (typeof f === "function") (f as () => void).call(x);
}

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

  /** Stamp a stub's `connectionKey` onto its (already-open) pager socket — carried through
   *  hibernation, and what `all()` filters on. */
  attach(stubKey: string, connectionKey: string): void {
    const ws = this.#socketFor(stubKey);
    if (ws === undefined)
      throw new Error(`hibernatable rpc stub ${stubKey} has no pager websocket`);
    ws.serializeAttachment({ stubKey, connectionKey } satisfies AttachedRpcStubRecord);
  }

  /** Every attached stub — DERIVED from the surviving pager sockets, so a fresh DO incarnation
   *  reads them straight back with nothing to reconcile. */
  all(): AttachedRpcStubRecord[] {
    return this.#sockets()
      .map((ws) => this.#attachment(ws))
      .filter((r): r is AttachedRpcStubRecord => r?.connectionKey !== undefined);
  }

  /** THE one call door: page the stub in if absent, then `invoke(path, args)` on it. The stub
   *  stays warm afterwards — steady traffic is pure RPC, no socket round-trips. Fire-and-forget
   *  callers just don't await (a failed delivery is the client's heal-by-pull). */
  async invoke(stubKey: string, path: string[], args: unknown[]): Promise<unknown> {
    // THE FETCH-SHAPED RULE: a WebSocket upgrade on a live capability never rides the RPC leg
    // (its 101 Response cannot serialize) — it opens the pager WebSocket bridge instead. The DO
    // mints the eyeball's WebSocketPair natively; frames tunnel over the pager (see
    // StubPageMessage). Plain (non-upgrade) fetches keep riding invoke() — a socketless Response
    // serializes fine over Workers RPC.
    if (
      path.length === 1 &&
      path[0] === "fetch" &&
      args[0] instanceof Request &&
      (args[0].headers.get("Upgrade") ?? "").toLowerCase() === "websocket"
    )
      return this.openWsBridge(stubKey, args[0]);
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
  /** Dials awaiting their ws-open ack, so the eyeball's 101 is HONEST (see StubPagerReply). */
  #bridgeDials = new Map<
    string,
    {
      stubKey: string;
      resolve(): void;
      reject(e: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** Open one eyeball⇄provider WebSocket bridge (see StubPageMessage): ask the relay to dial the
   *  provider, AWAIT the ack (a failed dial throws — the fetch lane answers non-101 with the
   *  provider's words), then accept the eyeball's server end HIBERNATABLY (the bridge survives
   *  eviction — routing state lives in tags + attachments) and hand back a native 101. */
  async openWsBridge(stubKey: string, request: Request): Promise<Response> {
    const pager = this.#socketFor(stubKey);
    if (pager === undefined)
      throw codedError("CONNECTION_OFFLINE", `rpc stub ${stubKey} offline (no pager websocket)`);
    const bridgeId = crypto.randomUUID();
    // Hop-by-hop / handshake headers stay behind — the relay re-issues the Upgrade to the provider.
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers)
      if (!/^(connection|upgrade|keep-alive|sec-websocket-.*)$/i.test(name)) headers[name] = value;
    const acked = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#bridgeDials.delete(bridgeId))
          reject(new Error(`ws bridge ${bridgeId}: provider dial timed out`));
      }, PAGE_TIMEOUT_MS);
      this.#bridgeDials.set(bridgeId, { stubKey, resolve, reject, timer });
    });
    pager.send(
      JSON.stringify({
        type: "ws-open",
        bridgeId,
        url: request.url,
        headers,
      } satisfies StubPageMessage),
    );
    await acked;
    const pair = new WebSocketPair();
    this.#hooks.acceptWebSocket(pair[1], [WS_BRIDGE_TAG, `${WS_BRIDGE_TAG}:${bridgeId}`]);
    pair[1].serializeAttachment({ wsBridge: { bridgeId, stubKey } } satisfies WsBridgeAttachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  #settleDial(bridgeId: string, error?: Error): void {
    const dial = this.#bridgeDials.get(bridgeId);
    if (dial === undefined) return;
    this.#bridgeDials.delete(bridgeId);
    clearTimeout(dial.timer);
    if (error) dial.reject(error);
    else dial.resolve();
  }

  /** Route one incoming WebSocket message (wire this to webSocketMessage). TRUE = handled here:
   *  a bridged eyeball frame (→ the pager, as ws-send) or a pager bridge reply (ws-frame/ws-close
   *  → the eyeball socket). FALSE = not this subsystem's socket. */
  message(ws: WebSocket, data: string | ArrayBuffer): boolean {
    const bridge = (this.#rawAttachment(ws) as Partial<WsBridgeAttachment> | undefined)?.wsBridge;
    if (bridge) {
      const pager = this.#socketFor(bridge.stubKey);
      if (pager === undefined) {
        try {
          ws.close(1001, "provider relay gone");
        } catch {
          /* already closing */
        }
        return true;
      }
      pager.send(
        JSON.stringify({
          type: "ws-send",
          bridgeId: bridge.bridgeId,
          ...encodeWsFrame(data),
        } satisfies StubPageMessage),
      );
      return true;
    }
    const record = this.#attachment(ws);
    if (record === undefined || typeof data !== "string") return false;
    let reply: StubPagerReply;
    try {
      reply = JSON.parse(data) as StubPagerReply;
    } catch {
      return false; // the keepalive is auto-answered runtime-side; unparseable text is noise
    }
    if (reply.type === "ws-open-ok") {
      this.#settleDial(reply.bridgeId);
      return true;
    }
    if (reply.type === "ws-open-fail") {
      this.#settleDial(reply.bridgeId, new Error(reply.reason));
      return true;
    }
    if (reply.type !== "ws-frame" && reply.type !== "ws-close") return false;
    const eyeball = this.#hooks.getWebSockets(`${WS_BRIDGE_TAG}:${reply.bridgeId}`)[0];
    if (eyeball === undefined) return true; // bridge already gone — drop
    try {
      if (reply.type === "ws-frame") eyeball.send(decodeWsFrame(reply));
      else eyeball.close(reply.code, reply.reason.slice(0, 123));
    } catch {
      /* eyeball already closing */
    }
    return true;
  }

  closed(ws: WebSocket, code = 1000, reason = ""): HibernatableRpcStubRecord | undefined {
    // A bridged eyeball socket closed → tell the relay to close the provider side.
    const bridge = (this.#rawAttachment(ws) as Partial<WsBridgeAttachment> | undefined)?.wsBridge;
    if (bridge) {
      try {
        this.#socketFor(bridge.stubKey)?.send(
          JSON.stringify({
            type: "ws-close",
            bridgeId: bridge.bridgeId,
            code,
            reason,
          } satisfies StubPageMessage),
        );
      } catch {
        /* pager gone — nothing to tell */
      }
      return undefined;
    }
    const record = this.#attachment(ws);
    if (record) {
      this.#forget(record.stubKey);
      // The pager died → fail its in-flight dials and close every bridged eyeball socket so
      // clients learn NOW instead of at their next send.
      for (const [bridgeId, dial] of this.#bridgeDials)
        if (dial.stubKey === record.stubKey)
          this.#settleDial(bridgeId, new Error("provider relay gone"));
      for (const eyeball of this.#hooks.getWebSockets(WS_BRIDGE_TAG)) {
        const att = (this.#rawAttachment(eyeball) as Partial<WsBridgeAttachment> | undefined)
          ?.wsBridge;
        if (att?.stubKey === record.stubKey) {
          try {
            eyeball.close(1001, "provider relay gone");
          } catch {
            /* already closing */
          }
        }
      }
    }
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
    const a = this.#rawAttachment(ws) as HibernatableRpcStubRecord | null;
    return a && typeof a.stubKey === "string" ? a : undefined;
  }
  #rawAttachment(ws: WebSocket): unknown {
    try {
      return ws.deserializeAttachment() as unknown;
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
        const arrived = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
        });
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

/** The provider-side socket a ws-open dials — capnweb's TunneledWebSocket satisfies it. */
export type ProviderSocket = {
  accept?(): void;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    cb: (ev: { data?: unknown; code?: number; reason?: string }) => void,
  ): void;
};

/** Edge side: open the stub pager WebSocket to a stream DO (via its stub's `fetch`), answering
 *  every `{type: "page"}` by re-minting the Workers-RPC stub through `onPage`, and serving the
 *  WEBSOCKET BRIDGE messages (see StubPageMessage) by dialing the provider through
 *  `openProviderSocket` — this runs in the SAME request context as the capnweb session, the one
 *  place the provider's socket is legally touchable. */
export async function openStubPagerWebSocket(
  host: { fetch(url: string, init?: RequestInit): Promise<Response> },
  stubKey: string,
  onPage: () => void,
  openProviderSocket?: (url: string, headers: Record<string, string>) => Promise<ProviderSocket>,
): Promise<WebSocket> {
  const response = await host.fetch("https://stub-pager.internal/", {
    headers: { Upgrade: "websocket", [STUB_PAGER_WEBSOCKET_HEADER]: stubKey },
  });
  if (!response.webSocket)
    throw new Error(`stub pager upgrade returned ${response.status} without a WebSocket`);
  response.webSocket.accept();
  // Keep this leg warm: a 30s keepalive the DO auto-answers via setWebSocketAutoResponse WITHOUT
  // waking it — defeats the ~100s idle-close and keeps the /api isolate warm. Dies with the isolate.
  const keepalive = setInterval(() => {
    try {
      response.webSocket!.send("itx-pager-keepalive");
    } catch {
      clearInterval(keepalive);
    }
  }, 30_000);
  response.webSocket.addEventListener("close", () => clearInterval(keepalive));
  // The live provider sockets this pager's bridges have dialed, by bridgeId. In-memory with the
  // isolate on purpose: if this side dies, the pager closes and the DO closes every eyeball socket.
  const bridges = new Map<string, ProviderSocket>();
  const pagerSend = (reply: Record<string, unknown>) => {
    try {
      response.webSocket!.send(JSON.stringify(reply));
    } catch {
      /* pager closing — the DO-side close handler owns cleanup */
    }
  };
  response.webSocket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let msg: StubPageMessage;
    try {
      msg = JSON.parse(event.data) as StubPageMessage;
    } catch {
      return; /* not ours */
    }
    if (msg.type === "page") return onPage();
    if (openProviderSocket === undefined) return;
    if (msg.type === "ws-open") {
      const { bridgeId } = msg;
      void openProviderSocket(msg.url, msg.headers).then(
        (provider) => {
          bridges.set(bridgeId, provider);
          provider.addEventListener("message", (ev) =>
            pagerSend({
              type: "ws-frame",
              bridgeId,
              ...encodeWsFrame(ev.data as string | ArrayBuffer),
            }),
          );
          provider.addEventListener("close", (ev) => {
            bridges.delete(bridgeId);
            pagerSend({
              type: "ws-close",
              bridgeId,
              code: ev.code ?? 1000,
              reason: ev.reason ?? "",
            });
          });
          pagerSend({ type: "ws-open-ok", bridgeId });
        },
        (e: unknown) =>
          pagerSend({
            type: "ws-open-fail",
            bridgeId,
            reason: (e instanceof Error ? e.message : String(e)).slice(0, 300),
          }),
      );
    } else if (msg.type === "ws-send") {
      bridges.get(msg.bridgeId)?.send(decodeWsFrame(msg));
    } else if (msg.type === "ws-close") {
      const provider = bridges.get(msg.bridgeId);
      bridges.delete(msg.bridgeId);
      try {
        provider?.close(msg.code, msg.reason.slice(0, 123));
      } catch {
        /* already closing */
      }
    }
  });
  response.webSocket.addEventListener("close", () => {
    for (const provider of bridges.values()) {
      try {
        provider.close(1001, "pager closed");
      } catch {
        /* already closing */
      }
    }
    bridges.clear();
  });
  return response.webSocket;
}
