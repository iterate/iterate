// rpc-stub-directory.ts — THE RPC-STUB REGISTRY: the live-only domain layer over the hibernatable
// RPC stubs. The manager (core/hibernatable-rpc-stub.ts) knows sockets, pages and stubs; THIS class
// knows what a live stub MEANS on the stream:
//
//   • KEY: the caller-chosen addressing key (`itx.rpcStubs.get('<key>')`). The mount that names a
//     stub, and reconnect-same-key, both key off it. Many transports can carry one key over time
//     (reconnect); the newest wins.
//   • TRANSPORT ID: a fresh per-transport id (the stub pager socket carries it) so a NEW transport
//     under an existing key can attach BEFORE the old one drops — the swap the reconnect property
//     rides on. Internal; callers never see it.
//   • THE VIEWS: invoke-by-key, the currently-held keys (presence), kick.
//
// LIVE-ONLY on purpose: no durable session history, no connection facts. Presence is `list()`; a
// stub lives while its transport is open and disappears when it closes. (The durable presence/history
// "connections view" is a separate layer that returns later — see ITX-KERNEL-SHAPE.md.)
//
// Two-phase attach: `attach` mints the transportId FIRST, THEN the relay opens the stub pager
// WebSocket carrying it; an unknown id 409s so a relay that outlived a DO restart re-attaches. What a
// dead stub leaves behind (auto-revoking its mounts) is the composing DO's business — injected as
// `onFinalClose`.

import {
  HibernatableRpcStubManager,
  STUB_PAGER_WEBSOCKET_HEADER,
  type HibernatableRpcStubRecord,
  type RetainedCallbackInvoker,
} from "./core/hibernatable-rpc-stub.ts";
import { codedError, reportIssue } from "./core/errors.ts";

/** How long an attach reservation may sit without its pager arriving before the lazy sweep drops
 *  it — matches the page-timeout scale (the relay opens the pager immediately after attach; 10s is
 *  a dead relay, not a slow one). */
const ATTACH_PENDING_TTL_MS = 10_000;

/** Everything the directory needs from its DO, injected — no hidden reach. */
type RpcStubDirectoryDeps = {
  hooks: {
    acceptWebSocket(ws: WebSocket, tags: string[]): void;
    getWebSockets(tag: string): WebSocket[];
  };
  /** A stub died for good — the DO auto-revokes every mount targeting its key. `keyFinal` ⇒ no
   *  replacement transport carries the key either. */
  onFinalClose(input: { key: string; keyFinal: boolean }): Promise<void>;
};

export class RpcStubDirectory {
  readonly #deps: RpcStubDirectoryDeps;
  /** The transport mechanics. VOCABULARY across the two layers: the manager's `stubKey` IS our
   *  `transportId`, and its `connectionKey` IS our `key` (the caller's addressing key). */
  readonly #stubs: HibernatableRpcStubManager;
  /** transportId → the reservation, for transports whose stub pager WebSocket hasn't arrived yet.
   *  In memory on purpose: if the DO dies in between, the upgrade 409s and the relay re-attaches.
   *  Lazily SWEPT (never a timer — a pending timer would pin the DO out of hibernation): the relay
   *  opens the pager immediately after attach, so a record still pending after ATTACH_PENDING_TTL_MS
   *  is an abandoned reservation (the relay died mid-handshake) and is dropped on the next
   *  attach/fetch — a swept-then-arriving upgrade hits the 409 door and the relay re-attaches. */
  readonly #pending = new Map<string, { key: string; atMs: number }>();
  #sweepPending(): void {
    const cutoff = Date.now() - ATTACH_PENDING_TTL_MS;
    for (const [transportId, entry] of this.#pending)
      if (entry.atMs < cutoff) this.#pending.delete(transportId);
  }

  constructor(deps: RpcStubDirectoryDeps) {
    this.#deps = deps;
    this.#stubs = new HibernatableRpcStubManager(deps.hooks);
  }

  // ── the lifecycle ──

  /** Reserve a transport for `key` (the relay calls this BEFORE opening the stub pager WebSocket).
   *  Mints a fresh transportId the pager carries; the key is the caller's addressing key. */
  attach(input: { key: string }): { transportId: string } {
    this.#sweepPending();
    const transportId = crypto.randomUUID();
    this.#pending.set(transportId, { key: input.key, atMs: Date.now() });
    return { transportId };
  }

  /** PARTIAL FETCH (compose first in the DO's fetch): the stub pager upgrade, gated on a pending
   *  attach record. `null` = not this door's request (the partial-fetch convention —
   *  core/fetch-capabilities.ts). */
  fetch(request: Request): Response | null {
    const transportId = request.headers.get(STUB_PAGER_WEBSOCKET_HEADER);
    // Not a pager upgrade → maybe the relay's dedicated fetch-upgrade leg (gated on a pending dial).
    if (transportId === null) return this.#stubs.acceptFetchUpgradeLeg(request);
    this.#sweepPending();
    const connectionKey = this.#pending.get(transportId)?.key;
    if (connectionKey === undefined)
      return new Response(`unknown rpc stub transport ${transportId} (attach first)\n`, {
        status: 409,
      });
    const response = this.#stubs.fetch(request)!;
    if (response.status === 101) {
      this.#pending.delete(transportId);
      this.#stubs.attach(transportId, connectionKey);
      // ONE transport per key, enforced when a transport becomes VISIBLE. attach() (before the
      // pager opens) can only drop predecessors already in #stubs.all(); a CONCURRENT provide under
      // the same key is still opening its own pager then, invisible to that scan — so N concurrent
      // provides would all linger. When THIS pager opens, drop every OTHER same-key transport now
      // (the newest transport wins). "replaced" ⇒ a transport swap, not a real close.
      for (const r of this.#stubs.all())
        if (r.connectionKey === connectionKey && r.stubKey !== transportId)
          this.#stubs.drop(r.stubKey, "replaced");
    }
    return response;
  }

  /** The page answer: a fresh RetainedCallbackInvoker stub, kept warm until the quiesce. */
  activate(input: { transportId: string; invoker: RetainedCallbackInvoker }) {
    return this.#stubs.activate({ stubKey: input.transportId, invoker: input.invoker });
  }

  drop(key: string, reason: string): void {
    const record = this.find(key);
    if (record) this.#stubs.drop(record.stubKey, reason);
  }

  /** Inbound WebSocket message routing (wire this to webSocketMessage) — fetch-upgrade frames
   *  forwarded between their two DO-side sockets. */
  message(ws: WebSocket, data: string | ArrayBuffer): void {
    this.#stubs.message(ws, data);
  }

  /** A WebSocket closed (wire this to webSocketClose/webSocketError). A pager: for a key whose
   *  LAST transport just went, the DO's onFinalClose (auto-revoke the mounts naming it) — fire and
   *  forget safe. A fetch-upgrade socket: its peer closes with it. */
  closed(ws: WebSocket, code: number, reason: string): void {
    const record = this.#stubs.closed(ws, code, reason);
    if (record)
      void this.#stubClosed(record, reason).catch((e) =>
        reportIssue("rpc-stub.close", e, { key: record.connectionKey ?? record.stubKey }),
      );
  }

  async #stubClosed(record: HibernatableRpcStubRecord, reason: string): Promise<void> {
    const key = record.connectionKey ?? record.stubKey;
    // "replaced" is the SAME logical key changing transports — never a key-final close.
    const keyFinal =
      reason !== "replaced" &&
      !this.#stubs.all().some((r) => r.connectionKey === key && r.stubKey !== record.stubKey);
    await this.#deps.onFinalClose({ key, keyFinal });
  }

  // ── the views + the delivery leg ──

  find(key: string): HibernatableRpcStubRecord | undefined {
    return this.#stubs.all().find((r) => r.connectionKey === key);
  }

  /** Invoke one stub's retained callback by key — the ONE door for both the consumer dotted path
   *  (`rpcStubs.get(key).method()` → an InvokeHandle) and the commit pump's one-directional
   *  delivery (empty path = the bare subscriber callback itself). */
  invoke(key: string, segments: string[], args: unknown[]): Promise<unknown> {
    const record = this.find(key);
    if (!record) throw codedError("CONNECTION_OFFLINE", `rpc stub "${key}" is offline`);
    return this.#stubs.invoke(record.stubKey, segments, args);
  }

  /** The keys currently held by this context (presence). */
  list(): Record<string, unknown>[] {
    return this.#stubs.all().map((r) => ({ key: r.connectionKey }));
  }

  /** Kick a stub by key (idempotent — unknown keys are a no-op). */
  close(key: string): { ok: true } {
    this.drop(key, "kicked");
    return { ok: true };
  }

  /** The idle quiesce (paged-in stubs pin the DO; a page gets them back). */
  disposeRetainedStubs(): void {
    this.#stubs.disposeRetainedStubs();
  }

  state(): Record<string, unknown> {
    return this.#stubs.state();
  }
}
