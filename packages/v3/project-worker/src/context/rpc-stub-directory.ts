// context/rpc-stub-directory.ts — THE LIVE RPC STUBS, DO side: the `itx.rpcStubs` built-in's backing
// table — physical, never event-sourced.
//
// THE PROBLEM: a context DO wants to call back into a client (browser tab, device, another worker)
// whose live capnweb callback stub exists ONLY inside the stateless edge worker's session (capnweb
// terminates at /api, never in the DO). Workers RPC can pass a stub across the boundary — but a DO
// that RETAINS one is pinned awake forever, which breaks the 1000-idle-devices property.
//
// THE MECHANIC (the whole design in four sentences): the edge worker opens ONE WebSocket to the DO
// per stub — THE STUB PAGER WEBSOCKET — accepted through the DO's hibernation API, carrying a small
// durable record in its attachment and NOTHING else. When the DO needs the stub, it sends
// `{type: "page"}` down that socket — it PAGES the stateless edge worker — and the edge answers over
// Workers RPC with a fresh stub (`activate`). The DO uses the stub for as long as traffic flows —
// event-batch delivery, state changes, request/response calls all ride this ONE stub via
// `invoke(key, path, args)` — and DISPOSES it at its idle quiesce, knowing a page always gets it
// back. Between pages the DO holds nothing but hibernatable sockets, so it hibernates while any
// number of clients stay attached.
//
// This is a poor-man's sturdy ref: the durable half is the socket attachment (survives
// hibernation), the restore hook is the page. A native ctx.exports sturdy ref cannot express it
// because the real capability lives inside a BROWSER's WebSocket session — only the edge worker
// holding that socket can re-mint the stub, so restore MUST route through it.
//
// WHAT A STUB IS HERE:
//   • KEY: the capability-path-shaped string the stub is parked under — the REGISTRY KEY, and the
//     stub's one identity. `itx.provide(path, stub)` parks under the mount path, so a mount reaches
//     the stub through the pure-data target `itx.rpcStubs.get('<key>')`; the registry itself knows
//     nothing about mounts. Re-parking the same key replaces the transport (reconnect). Many
//     transports can carry one key over time; the newest wins.
//   • TRANSPORT ID: a fresh per-transport id (the stub pager socket carries it) so a NEW transport
//     under an existing key can attach BEFORE the old one drops — the swap the reconnect property
//     rides on. Internal; callers never see it.
//
// PRESENCE (which keys have an open pager right now) is `list()`; the whole in-memory socket census
// (paged-in, pending pages, dormant) is `state()` for the hibernation probes. A stub that dies leaves
// nothing behind but its absence: the mount that named it stays in the capability table (calls
// answer CONNECTION_OFFLINE) until someone revokes it or the provider re-parks.
//
// Two-phase attach: `attach` mints the transportId FIRST, THEN the relay opens the stub pager
// WebSocket carrying it; an unknown id 409s so a relay that outlived a DO restart re-attaches. The
// pager upgrade is a partial fetch the DO composes FIRST in its own fetch (`#rpcStubs.fetch(req)`).

import { codedError } from "../lib/errors.ts";
import type {
  LiveCapabilityFetchServer,
  LiveCapabilityFetchTransport,
  WebSocketHooks,
} from "../fetch/fetch-capabilities.ts";
import { createLogger } from "../lib/logs.ts";

// ── the wire: what the relay (context/rpc-stub-relay.ts) speaks to this side ──

export const STUB_PAGER_WEBSOCKET_HEADER = "x-itx-stub-pager";
const STUB_PAGER_WEBSOCKET_TAG = "itx-stub-pager-websocket";
/** The pager keepalive pair — one shared definition for the edge sender and the DO's
 *  setWebSocketAutoResponse. DELIBERATELY distinctive literals: the auto-response is DO-WIDE
 *  (it also covers fetch-upgrade eyeball sockets), so a plain "ping" would silently hijack any
 *  client frame equal to it. */
export const STUB_PAGER_KEEPALIVE_REQUEST = "itx-pager-keepalive";
export const STUB_PAGER_KEEPALIVE_RESPONSE = "itx-pager-keepalive-ack";
/** How long the relay has to complete its half of a handshake — open the pager after `attach`,
 *  answer a page — before this side calls it dead. The relay does both immediately, so 10 s is a
 *  dead relay, not a slow one. */
const RELAY_TIMEOUT_MS = 10_000;

/** The Workers-RPC stub the paged edge worker hands back — TWO doors: `invoke(path, args)`
 *  forwards onto the retained capnweb callback (a DIRECT dotted dispatch — never `.apply`), and
 *  `fetch(upgradeId, capPath, request)` is the live-capability fetch dial
 *  (fetch/fetch-capabilities.ts — dies with that module's WORKAROUND fence). */
export type RetainedCallbackInvoker = LiveCapabilityFetchTransport & {
  invoke(path: string[], args: unknown[]): Promise<unknown>;
  dup?(): RetainedCallbackInvoker;
};

/** One stub's durable record — the pager socket's attachment (survives hibernation): the
 *  per-transport identity and the registry key the stub is parked under. */
type RpcStubRecord = { transportId: string; key: string };

/** THE one disposer for any RPC-ish stub (Workers-RPC legs here, retained capnweb callbacks in
 *  rpc-stub-relay.ts): a no-op for anything that is not disposable. */
export function disposeStub(x: unknown): void {
  (x as Partial<Disposable> | null)?.[Symbol.dispose]?.();
}

const log = createLogger("rpc-stub-directory");

export class RpcStubDirectory {
  readonly #hooks: WebSocketHooks;
  /** PRESENCE as it changes: a key gained its (only) transport, or lost its last one. The DO turns
   *  these into the two ephemeral `rpc-stub/attached` / `rpc-stub/detached` events — live watchers
   *  see presence move; the log never claims a socket is open. A REPLACED transport (same key, new
   *  pager) is neither: the key never lost presence. */
  readonly #onPresence: (kind: "attached" | "detached", key: string) => void;
  /** The DO's live-capability fetch subsystem (fetch/fetch-capabilities.ts) — `invoke` routes a
   *  terminal-fetch call into its serve(). */
  readonly #liveCapabilityFetch: LiveCapabilityFetchServer;
  /** transportId → the reservation, for transports whose stub pager WebSocket hasn't arrived yet.
   *  In memory on purpose: if the DO dies in between, the upgrade 409s and the relay re-attaches.
   *  Lazily SWEPT (never a timer — a pending timer would pin the DO out of hibernation): the relay
   *  opens the pager immediately after attach, so a record still pending after RELAY_TIMEOUT_MS is
   *  an abandoned reservation (the relay died mid-handshake) and is dropped on the next
   *  attach/fetch — a swept-then-arriving upgrade hits the 409 door and the relay re-attaches. */
  readonly #pending = new Map<string, { key: string; atMs: number }>();
  // The PAGED-IN stubs, in memory ONLY and kept WARM: steady traffic pays ONE page, then every
  // delivery is a plain RPC call. Disposal is the DO's idle quiesce (disposeRetainedStubs()) —
  // never per-call, never a timer (a pending timer would itself pin the DO out of hibernation).
  readonly #retained = new Map<string, { invoker: RetainedCallbackInvoker; inFlight: number }>();
  // One entry per stub awaiting its page answer; CONCURRENT cold invokes share it (`arrived`) —
  // a second caller must never replace the first's resolver (it would hang forever).
  readonly #pagesPending = new Map<
    string,
    {
      resolve(): void;
      reject(e: Error): void;
      timer: ReturnType<typeof setTimeout>;
      arrived: Promise<void>;
    }
  >();
  // Once per socket: workerd may deliver BOTH webSocketError and webSocketClose for one drop, and
  // the second must not report the transport (and its presence) as lost twice.
  readonly #closedSockets = new WeakSet<WebSocket>();

  constructor(deps: {
    hooks: WebSocketHooks;
    onPresence: (kind: "attached" | "detached", key: string) => void;
    liveCapabilityFetch: LiveCapabilityFetchServer;
  }) {
    this.#hooks = deps.hooks;
    this.#onPresence = deps.onPresence;
    this.#liveCapabilityFetch = deps.liveCapabilityFetch;
  }

  // ── the lifecycle: attach → the pager upgrade → pages → close ──

  /** Reserve a transport for the registry `key` (the relay calls this BEFORE opening the stub pager
   *  WebSocket). Mints a fresh transportId the pager carries. */
  attach(input: { key: string }): { transportId: string } {
    this.#sweepPending();
    const transportId = crypto.randomUUID();
    this.#pending.set(transportId, { key: input.key, atMs: Date.now() });
    return { transportId };
  }

  /** PARTIAL FETCH (compose first in the DO's fetch): the stub pager upgrade, gated on a pending
   *  attach record. `null` = not this door's request (the partial-fetch convention —
   *  fetch/fetch-capabilities.ts). */
  fetch(request: Request): Response | null {
    const transportId = request.headers.get(STUB_PAGER_WEBSOCKET_HEADER);
    if (transportId === null) return null;
    this.#sweepPending();
    const key = this.#pending.get(transportId)?.key;
    if (key === undefined)
      return new Response(`unknown rpc stub transport ${transportId} (attach first)\n`, {
        status: 409,
      });
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket")
      return new Response(
        `stub pager: expected a websocket upgrade with ${STUB_PAGER_WEBSOCKET_HEADER}\n`,
        { status: 400 },
      );
    this.#pending.delete(transportId);
    const hadTransport = this.find(key) !== undefined;
    // Accepted and stamped in ONE synchronous turn, so every pager socket this side ever sees
    // carries its record — through hibernation too (the attachment is what survives).
    const pair = new WebSocketPair();
    this.#hooks.acceptWebSocket(pair[1], [STUB_PAGER_WEBSOCKET_TAG]);
    pair[1].serializeAttachment({ transportId, key } satisfies RpcStubRecord);
    // ONE transport per key, enforced when a transport becomes VISIBLE: a CONCURRENT provide at the
    // same key may still be opening its own pager, invisible to any earlier scan — so when THIS
    // pager opens, drop every OTHER same-key transport now (the newest transport wins). "replaced" ⇒
    // a transport swap, not a real close.
    for (const r of this.all())
      if (r.key === key && r.transportId !== transportId) this.drop(r.transportId, "replaced");
    if (!hadTransport) this.#onPresence("attached", key);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** The edge's answer to a page: it hands back a fresh stub over Workers RPC, kept warm until the
   *  quiesce. Returns undefined for a stale page (none pending). */
  activate(input: {
    transportId: string;
    invoker: RetainedCallbackInvoker;
  }): { ok: true } | undefined {
    const pending = this.#pagesPending.get(input.transportId);
    if (pending === undefined) return undefined;
    const prev = this.#retained.get(input.transportId);
    this.#retained.set(input.transportId, {
      invoker: input.invoker.dup?.() ?? input.invoker,
      inFlight: 0,
    });
    if (prev) disposeStub(prev.invoker);
    clearTimeout(pending.timer);
    this.#pagesPending.delete(input.transportId);
    pending.resolve();
    return { ok: true };
  }

  /** A pager WebSocket closed (wire this to webSocketClose/webSocketError, AFTER the DO's own
   *  live-capability close routing): the transport is simply gone. Nothing else happens — the
   *  mount that named the stub is data, not a session fact, and stays (calls answer
   *  CONNECTION_OFFLINE — the mount is the user's intent; the socket was weather). */
  closed(ws: WebSocket): void {
    if (this.#closedSockets.has(ws)) return;
    this.#closedSockets.add(ws);
    const { transportId, key } = this.#attachment(ws);
    this.#forget(transportId);
    if (!this.find(key)) this.#onPresence("detached", key);
  }

  /** Close a stub's pager WebSocket (revoke / kick / replace) and forget it. */
  drop(transportId: string, reason: string): void {
    const ws = this.#socketFor(transportId);
    if (ws)
      try {
        ws.close(1000, reason);
      } catch {
        /* already closing */
      }
    this.#forget(transportId);
  }

  // ── the views + the delivery leg ──

  /** Every attached stub — DERIVED from the surviving pager sockets, so a fresh DO incarnation
   *  reads them straight back with nothing to reconcile. */
  all(): RpcStubRecord[] {
    return this.#sockets().map((ws) => this.#attachment(ws));
  }

  find(key: string): RpcStubRecord | undefined {
    return this.all().find((r) => r.key === key);
  }

  /** PRESENCE — the keys with an open pager transport right now (`itx.rpcStubs.list()`). The
   *  attachments rehydrate free from the hibernated sockets, so this is exact after a wake. */
  list(): string[] {
    return this.all().map((r) => r.key);
  }

  /** THE one call door behind `itx.rpcStubs.get(key)` — resolved capability calls
   *  (`itx.<mount>.method()` through a mount targeting it) and the delivery loop's push (empty path =
   *  the bare subscriber callback itself): page the stub in if absent, then call it. The stub stays
   *  warm afterwards — steady traffic is pure RPC, no socket round-trips. Fire-and-forget callers
   *  just don't await (a failed delivery is the client's heal-by-pull). */
  async invoke(key: string, path: string[], args: unknown[]): Promise<unknown> {
    const record = this.find(key);
    if (!record) throw codedError("CONNECTION_OFFLINE", `live capability "${key}" is offline`);
    const retained = await this.#pageIn(record.transportId);
    retained.inFlight += 1;
    try {
      // THE TERMINAL-FETCH BRANCH (fetch/fetch-capabilities.ts, doctrine point 1 — dies with its
      // WORKAROUND fence): a terminal `fetch` carrying the one live Request rides the live-capability
      // fetch path; the paged-in invoker is the transport. Everything else is a plain dotted
      // dispatch. Either way, a provider that dies mid-call is re-coded to CONNECTION_OFFLINE at the
      // relay, where the break is LOCAL — the CODE, never a message, crosses this hop (lib/errors.ts).
      if (path.at(-1) === "fetch" && args.length === 1 && args[0] instanceof Request)
        return await this.#liveCapabilityFetch.serve(retained.invoker, path.slice(0, -1), args[0]);
      return await retained.invoker.invoke(path, args);
    } finally {
      retained.inFlight -= 1;
    }
  }

  // ── the idle quiesce (paged-in stubs pin the DO; a page gets them back) ──

  /** Any stub paged in right now (O(1)) — what makes the quiet clock worth arming. */
  hasRetainedStubs(): boolean {
    return this.#retained.size > 0;
  }

  /** THE IDLE DISPOSAL (call from the DO's quiesce alarm): drop every paged-in stub so the DO
   *  can hibernate. Losing them costs exactly one page on the next call — that is the deal. */
  disposeRetainedStubs(): void {
    for (const [transportId, retained] of this.#retained) {
      if (retained.inFlight > 0)
        log.warn("disposing a stub with calls in flight (idle quiesce)", {
          event: "stub.disposed-in-flight",
          transportId,
          inFlight: retained.inFlight,
        });
      this.#retained.delete(transportId);
      disposeStub(retained.invoker);
    }
  }

  /** In-memory transport facts — the DO's `transportState()` verb for the hibernation probes; not
   *  event-derivable, deliberately off the itx surface. `dormant` ⇒ nothing paged in and no page in
   *  flight (the DO can hibernate; stubs stay attached). */
  state(): { stubs: number; pagedIn: number; pagesPending: number; dormant: boolean } {
    return {
      stubs: this.all().length,
      pagedIn: this.#retained.size,
      pagesPending: this.#pagesPending.size,
      dormant: this.#retained.size === 0 && this.#pagesPending.size === 0,
    };
  }

  #sweepPending(): void {
    const cutoff = Date.now() - RELAY_TIMEOUT_MS;
    for (const [transportId, entry] of this.#pending)
      if (entry.atMs < cutoff) this.#pending.delete(transportId);
  }
  #sockets(): WebSocket[] {
    return this.#hooks
      .getWebSockets(STUB_PAGER_WEBSOCKET_TAG)
      .filter((ws) => ws.readyState === WebSocket.OPEN);
  }
  #socketFor(transportId: string): WebSocket | undefined {
    return this.#sockets().find((ws) => this.#attachment(ws).transportId === transportId);
  }
  /** The record a pager socket carries (stamped in `fetch` in the same synchronous turn the socket
   *  was accepted, so it is never missing). */
  #attachment(ws: WebSocket): RpcStubRecord {
    return ws.deserializeAttachment() as RpcStubRecord;
  }

  async #pageIn(
    transportId: string,
  ): Promise<{ invoker: RetainedCallbackInvoker; inFlight: number }> {
    let retained = this.#retained.get(transportId);
    if (retained === undefined) {
      const ws = this.#socketFor(transportId);
      if (ws === undefined)
        throw codedError(
          "CONNECTION_OFFLINE",
          `hibernatable rpc stub ${transportId} offline (no pager websocket)`,
        );
      let pending = this.#pagesPending.get(transportId);
      if (pending === undefined) {
        let resolve!: () => void;
        let reject!: (e: Error) => void;
        const arrived = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        const timer = setTimeout(() => {
          if (this.#pagesPending.delete(transportId))
            reject(new Error(`hibernatable rpc stub ${transportId}: page timed out`));
        }, RELAY_TIMEOUT_MS);
        pending = { resolve, reject, timer, arrived };
        this.#pagesPending.set(transportId, pending);
        try {
          // THE ONE message the pager ever carries (DO → edge): "I ought to have your RPC stub but
          // I don't — send it." Everything else rides Workers RPC on the paged-in stub.
          ws.send(JSON.stringify({ type: "page" }));
        } catch {
          ws.close(1011, "page send failed");
        }
      }
      await pending.arrived;
      retained = this.#retained.get(transportId);
      if (retained === undefined)
        throw new Error(`hibernatable rpc stub ${transportId}: page answered empty`);
    }
    return retained;
  }

  #forget(transportId: string): void {
    const retained = this.#retained.get(transportId);
    if (retained) {
      this.#retained.delete(transportId);
      disposeStub(retained.invoker);
    }
    const pending = this.#pagesPending.get(transportId);
    if (pending) {
      clearTimeout(pending.timer);
      this.#pagesPending.delete(transportId);
      pending.reject(
        codedError("CONNECTION_OFFLINE", `hibernatable rpc stub ${transportId} went offline`),
      );
    }
  }
}
