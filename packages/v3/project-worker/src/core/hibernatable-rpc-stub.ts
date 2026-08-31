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

/** THE ONE message the stub pager WebSocket ever carries (DO → edge): "I ought to have your
 *  RPC stub but I don't — send it." Everything else rides Workers RPC on the paged-in stub — the
 *  pager is a PAGER, minimal by decree. (Fetch-upgrade traffic rides its own DEDICATED socket:
 *  see openFetchUpgrade on RetainedCallbackInvoker and FETCH_UPGRADE_SOCKET_HEADER below.) */
type StubPageMessage = { type: "page" };

// ── FETCH UPGRADES on live capabilities (fetch-shaped rides fetch; the pager stays minimal) ──
// A live capability's WS upgrade cannot return its 101 over Workers RPC (workerd's RPC serializer
// has no WebSocket support — DataCloneError), a loopback entrypoint cannot touch the relay's
// capnweb session (I/O pins to its creating request context), and proxying the socket as RPC
// streams pins the DO non-hibernatable for the socket's lifetime (measured: evictDurableObject
// times out on "active references"). So: the DO asks the paged-in invoker to dial
// (openFetchUpgrade — an RPC call that EXECUTES in the session's context; its return is the honest
// ack), the relay opens ONE dedicated upgrade leg back into this DO per upgrade, and the DO mints
// the eyeball's WebSocketPair natively. Frames forward RAW (native text/binary — no codec)
// between the two DO-side sockets by upgradeId tag; both are hibernatable, so the upgrade SURVIVES
// eviction (routing state lives in tags + attachments) and idle costs nothing.
export const FETCH_UPGRADE_SOCKET_HEADER = "x-itx-fetch-upgrade";
const FETCH_UPGRADE_EYEBALL_TAG = "itx-fetch-upgrade-eyeball";
const FETCH_UPGRADE_LEG_TAG = "itx-fetch-upgrade-leg";
/** Eyeball-side attachment. */
type FetchUpgradeEyeball = { fetchUpgradeEyeball: { upgradeId: string } };
/** Relay-side (transport) attachment. */
type FetchUpgradeLeg = { fetchUpgradeLeg: { upgradeId: string } };

/** Close codes a handler may pass to close(): 1000 or app codes; everything reserved/invalid
 *  (1004-1006, 1015, out-of-range — e.g. an abnormal-closure 1006 being FORWARDED) clamps to 1000. */
export function clampCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  if (code >= 1001 && code <= 1003) return code;
  if (code >= 1007 && code <= 1014) return code;
  return 1000;
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
    // (its 101 Response cannot serialize) — it rides the DEDICATED upgrade leg instead (see
    // FETCH_UPGRADE_SOCKET_HEADER above). Plain (non-upgrade) fetches keep riding invoke() — a
    // socketless Response serializes fine over Workers RPC.
    if (
      path.length === 1 &&
      path[0] === "fetch" &&
      args[0] instanceof Request &&
      (args[0].headers.get("Upgrade") ?? "").toLowerCase() === "websocket"
    )
      return this.#openFetchUpgrade(stubKey, args[0]);
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
  /** Fetch upgrades this DO is expecting (upgradeId → asked-at ms): minted by #openFetchUpgrade
   *  just before the invoker dial, consumed by acceptFetchUpgradeLeg when the leg arrives.
   *  In-memory + lazily swept, mirroring the attach-reservation pattern — a crashed relay's RPC
   *  rejection cleans up in the finally; the sweep is belt-and-braces for orphans. */
  #pendingFetchUpgrades = new Map<string, number>();
  #sweepPendingFetchUpgrades(): void {
    const cutoff = Date.now() - PAGE_TIMEOUT_MS;
    for (const [upgradeId, atMs] of this.#pendingFetchUpgrades)
      if (atMs < cutoff) this.#pendingFetchUpgrades.delete(upgradeId);
  }

  /** Serve one WebSocket upgrade on a live capability: page in the invoker, ask it to dial
   *  (openFetchUpgrade — runs in the relay's session context; the await IS the ack, and the relay
   *  opens the dedicated upgrade leg into this DO before returning), then mint the eyeball's
   *  pair natively and hand back a real 101. A failed dial throws — the fetch lane answers
   *  non-101 with the provider's words. */
  async #openFetchUpgrade(stubKey: string, request: Request): Promise<Response> {
    const retained = await this.#pageIn(stubKey);
    const upgradeId = crypto.randomUUID();
    // Hop-by-hop / handshake headers stay behind — the relay re-issues the Upgrade to the provider.
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers)
      if (!/^(connection|upgrade|keep-alive|sec-websocket-.*)$/i.test(name)) headers[name] = value;
    this.#sweepPendingFetchUpgrades();
    this.#pendingFetchUpgrades.set(upgradeId, Date.now());
    try {
      await (
        retained.invoker as unknown as {
          openFetchUpgrade(id: string, url: string, h: Record<string, string>): Promise<unknown>;
        }
      ).openFetchUpgrade(upgradeId, request.url, headers);
    } finally {
      this.#pendingFetchUpgrades.delete(upgradeId);
    }
    const transport = this.#hooks.getWebSockets(`${FETCH_UPGRADE_LEG_TAG}:${upgradeId}`)[0];
    if (transport === undefined)
      throw new Error(`fetch upgrade ${upgradeId}: dial acked but no upgrade leg arrived`);
    const pair = new WebSocketPair();
    this.#hooks.acceptWebSocket(pair[1], [
      FETCH_UPGRADE_EYEBALL_TAG,
      `${FETCH_UPGRADE_EYEBALL_TAG}:${upgradeId}`,
    ]);
    pair[1].serializeAttachment({
      fetchUpgradeEyeball: { upgradeId },
    } satisfies FetchUpgradeEyeball);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** PARTIAL FETCH: accept the relay's dedicated upgrade leg (see FETCH_UPGRADE_SOCKET_HEADER),
   *  gated on a pending dial — an unknown upgradeId 409s. */
  acceptFetchUpgradeLeg(request: Request): Response | undefined {
    const upgradeId = request.headers.get(FETCH_UPGRADE_SOCKET_HEADER);
    if (upgradeId === null) return undefined;
    this.#sweepPendingFetchUpgrades();
    if (!this.#pendingFetchUpgrades.has(upgradeId))
      return new Response(`unknown fetch upgrade ${upgradeId} (dial first)\n`, { status: 409 });
    const pair = new WebSocketPair();
    this.#hooks.acceptWebSocket(pair[1], [
      FETCH_UPGRADE_LEG_TAG,
      `${FETCH_UPGRADE_LEG_TAG}:${upgradeId}`,
    ]);
    pair[1].serializeAttachment({ fetchUpgradeLeg: { upgradeId } } satisfies FetchUpgradeLeg);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Route one incoming WebSocket message (wire this to webSocketMessage). TRUE = handled: a
   *  fetch-upgrade frame forwarded RAW to its peer socket (eyeball ⇄ leg, by upgradeId tag). FALSE =
   *  not this subsystem's socket. The pager itself carries no routable inbound payloads. */
  message(ws: WebSocket, data: string | ArrayBuffer): boolean {
    const peer = this.#fetchUpgradePeer(ws);
    if (peer === undefined) return false;
    if (peer === null) return true; // peer already gone — drop the frame; close handles teardown
    try {
      peer.send(data);
    } catch {
      /* peer closing — its close event tears the pair down */
    }
    return true;
  }

  /** The OTHER side of a fetch-upgrade socket, or undefined (not one) / null (peer gone). */
  #fetchUpgradePeer(ws: WebSocket): WebSocket | null | undefined {
    const att = this.#rawAttachment(ws) as
      | (Partial<FetchUpgradeEyeball> & Partial<FetchUpgradeLeg>)
      | undefined;
    if (att?.fetchUpgradeEyeball)
      return (
        this.#hooks.getWebSockets(
          `${FETCH_UPGRADE_LEG_TAG}:${att.fetchUpgradeEyeball.upgradeId}`,
        )[0] ?? null
      );
    if (att?.fetchUpgradeLeg)
      return (
        this.#hooks.getWebSockets(
          `${FETCH_UPGRADE_EYEBALL_TAG}:${att.fetchUpgradeLeg.upgradeId}`,
        )[0] ?? null
      );
    return undefined;
  }

  closed(ws: WebSocket, code = 1000, reason = ""): HibernatableRpcStubRecord | undefined {
    // A fetch-upgrade socket closed (either side) → close its peer with the clamped code; each
    // upgrade dies with its own socket pair, no sweeps needed (the relay dying closes its legs,
    // which closes the eyeballs here — automatically, per socket).
    const peer = this.#fetchUpgradePeer(ws);
    if (peer !== undefined) {
      try {
        peer?.close(clampCloseCode(code), reason.slice(0, 123));
      } catch {
        /* already closing */
      }
      return undefined;
    }
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
 *  every `{type: "page"}` by re-minting the Workers-RPC stub through `onPage`. Nothing else rides
 *  it — the pager is a pager (fetch-upgrade traffic has its own socket: openFetchUpgradeLeg). */
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

/** Edge side: open ONE dedicated fetch-upgrade leg into the DO for `upgradeId` (called from
 *  RetainedCallbackInvoker.openFetchUpgrade, mid-dial — the DO is awaiting that RPC and serves this
 *  upgrade concurrently). Frames ride it RAW; its close closes the peer eyeball socket. */
export async function openFetchUpgradeLeg(
  host: { fetch(url: string, init?: RequestInit): Promise<Response> },
  upgradeId: string,
): Promise<WebSocket> {
  const response = await host.fetch("https://fetch-upgrade.internal/", {
    headers: { Upgrade: "websocket", [FETCH_UPGRADE_SOCKET_HEADER]: upgradeId },
  });
  if (!response.webSocket)
    throw new Error(`fetch-upgrade leg returned ${response.status} without a WebSocket`);
  response.webSocket.accept();
  return response.webSocket;
}
