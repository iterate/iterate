// rpc-stub-directory.ts — THE LIVE-TRANSPORT TABLE: the domain layer over the hibernatable
// RPC stubs. The manager (core/hibernatable-rpc-stub.ts) knows sockets, pages and stubs; THIS class
// knows what a live stub MEANS on the stream:
//
//   • PATH: the capability path the stub is mounted at (`itx.provide(path, stub)`) — the stub's
//     ONE identity. The live mount row in the capability table and this transport table share it;
//     re-providing the same path replaces the transport (reconnect). Many transports can carry one
//     path over time; the newest wins.
//   • TRANSPORT ID: a fresh per-transport id (the stub pager socket carries it) so a NEW transport
//     under an existing path can attach BEFORE the old one drops — the swap the reconnect property
//     rides on. Internal; callers never see it.
//
// PRESENCE IS NOT HERE: "what live capabilities exist" is the capability table (rows where live —
// an event-sourced reduce). This table holds only the in-memory transport facts (which paths have
// an open pager, what is paged in) — surfaced whole via `state()` for the hibernation probes.
//
// Two-phase attach: `attach` mints the transportId FIRST, THEN the relay opens the stub pager
// WebSocket carrying it; an unknown id 409s so a relay that outlived a DO restart re-attaches. What
// a dead stub leaves behind (auto-revoking the live mount at its path) is the composing DO's
// business — injected as `onFinalClose`.

import { codedError, reportIssue } from "./core/errors.ts";
import type { LiveCapabilityFetchServer, WebSocketHooks } from "./core/fetch-capabilities.ts";
import {
  HibernatableRpcStubManager,
  STUB_PAGER_WEBSOCKET_HEADER,
  type HibernatableRpcStubRecord,
  type RetainedCallbackInvoker,
} from "./core/hibernatable-rpc-stub.ts";

/** How long an attach reservation may sit without its pager arriving before the lazy sweep drops
 *  it — matches the page-timeout scale (the relay opens the pager immediately after attach; 10s is
 *  a dead relay, not a slow one). */
const ATTACH_PENDING_TTL_MS = 10_000;

/** Everything the directory needs from its DO, injected — no hidden reach. */
type RpcStubDirectoryDeps = {
  hooks: WebSocketHooks;
  /** The DO's live-capability fetch subsystem (core/fetch-capabilities.ts) — the manager routes
   *  terminal-fetch invokes into its serve(). */
  liveCapabilityFetch: LiveCapabilityFetchServer;
  /** A stub died for good — the DO auto-revokes the live mount at its path. `pathFinal` ⇒ no
   *  replacement transport carries the path either. */
  onFinalClose(input: { path: string; pathFinal: boolean }): Promise<void>;
};

export class RpcStubDirectory {
  readonly #deps: RpcStubDirectoryDeps;
  /** The transport mechanics — sockets, pages, paged-in stubs (core/hibernatable-rpc-stub.ts). */
  readonly #stubs: HibernatableRpcStubManager;
  /** transportId → the reservation, for transports whose stub pager WebSocket hasn't arrived yet.
   *  In memory on purpose: if the DO dies in between, the upgrade 409s and the relay re-attaches.
   *  Lazily SWEPT (never a timer — a pending timer would pin the DO out of hibernation): the relay
   *  opens the pager immediately after attach, so a record still pending after ATTACH_PENDING_TTL_MS
   *  is an abandoned reservation (the relay died mid-handshake) and is dropped on the next
   *  attach/fetch — a swept-then-arriving upgrade hits the 409 door and the relay re-attaches. */
  readonly #pending = new Map<string, { path: string; atMs: number }>();
  #sweepPending(): void {
    const cutoff = Date.now() - ATTACH_PENDING_TTL_MS;
    for (const [transportId, entry] of this.#pending)
      if (entry.atMs < cutoff) this.#pending.delete(transportId);
  }

  constructor(deps: RpcStubDirectoryDeps) {
    this.#deps = deps;
    this.#stubs = new HibernatableRpcStubManager(deps.hooks, deps.liveCapabilityFetch);
  }

  // ── the lifecycle ──

  /** Reserve a transport for the mount `path` (the relay calls this BEFORE opening the stub pager
   *  WebSocket). Mints a fresh transportId the pager carries. */
  attach(input: { path: string }): { transportId: string } {
    this.#sweepPending();
    const transportId = crypto.randomUUID();
    this.#pending.set(transportId, { path: input.path, atMs: Date.now() });
    return { transportId };
  }

  /** PARTIAL FETCH (compose first in the DO's fetch): the stub pager upgrade, gated on a pending
   *  attach record. `null` = not this door's request (the partial-fetch convention —
   *  core/fetch-capabilities.ts). */
  fetch(request: Request): Response | null {
    const transportId = request.headers.get(STUB_PAGER_WEBSOCKET_HEADER);
    if (transportId === null) return null;
    this.#sweepPending();
    const path = this.#pending.get(transportId)?.path;
    if (path === undefined)
      return new Response(`unknown rpc stub transport ${transportId} (attach first)\n`, {
        status: 409,
      });
    const response = this.#stubs.acceptStubPagerSocket(transportId, request);
    if (response.status === 101) {
      this.#pending.delete(transportId);
      this.#stubs.attach(transportId, path);
      // ONE transport per path, enforced when a transport becomes VISIBLE. attach() (before the
      // pager opens) can only drop predecessors already in #stubs.all(); a CONCURRENT provide at
      // the same path is still opening its own pager then, invisible to that scan — so N concurrent
      // provides would all linger. When THIS pager opens, drop every OTHER same-path transport now
      // (the newest transport wins). "replaced" ⇒ a transport swap, not a real close.
      for (const r of this.#stubs.all())
        if (r.path === path && r.transportId !== transportId)
          this.#stubs.drop(r.transportId, "replaced");
    }
    return response;
  }

  /** The page answer: a fresh RetainedCallbackInvoker stub, kept warm until the quiesce. */
  activate(input: { transportId: string; invoker: RetainedCallbackInvoker }) {
    return this.#stubs.activate(input);
  }

  drop(path: string, reason: string): void {
    const record = this.find(path);
    if (record) this.#stubs.drop(record.transportId, reason);
  }

  /** A pager WebSocket closed (wire this to webSocketClose/webSocketError, AFTER the DO's own
   *  live-capability close routing): for a path whose LAST transport just went, the DO's
   *  onFinalClose (auto-revoke the live mount at it) — fire-and-forget safe. */
  closed(ws: WebSocket, reason: string): void {
    const record = this.#stubs.closed(ws);
    if (record)
      void this.#stubClosed(record, reason).catch((e) =>
        reportIssue("rpc-stub.close", e, { path: record.path ?? record.transportId }),
      );
  }

  async #stubClosed(record: HibernatableRpcStubRecord, reason: string): Promise<void> {
    const path = record.path ?? record.transportId;
    // "replaced" is the SAME logical path changing transports — never a path-final close.
    const pathFinal =
      reason !== "replaced" &&
      !this.#stubs.all().some((r) => r.path === path && r.transportId !== record.transportId);
    await this.#deps.onFinalClose({ path, pathFinal });
  }

  // ── the views + the delivery leg ──

  find(path: string): HibernatableRpcStubRecord | undefined {
    return this.#stubs.all().find((r) => r.path === path);
  }

  /** The paths with a surviving pager transport — the resurrection pass diffs live table rows
   *  against this (a crashed close-time append leaves a lying row; the attachments rehydrate free
   *  from the hibernated sockets). */
  attachedPaths(): string[] {
    return this.#stubs.all().map((r) => r.path);
  }

  /** Invoke the live stub mounted at `path` — the ONE door for both resolved capability calls
   *  (`itx.<path>.method()` → the resolver's live branch) and the commit pump's one-directional
   *  delivery (empty segments = the bare subscriber callback itself). */
  invoke(path: string, segments: string[], args: unknown[]): Promise<unknown> {
    const record = this.find(path);
    if (!record) throw codedError("CONNECTION_OFFLINE", `live capability "${path}" is offline`);
    return this.#stubs.invoke(record.transportId, segments, args);
  }

  /** The idle quiesce (paged-in stubs pin the DO; a page gets them back). */
  disposeRetainedStubs(): void {
    this.#stubs.disposeRetainedStubs();
  }

  /** In-memory transport facts ({stubs, pagedIn, pagesPending, dormant}) — the DO's
   *  `transportState()` verb; not event-derivable, deliberately off the itx surface. */
  state(): Record<string, unknown> {
    return this.#stubs.state();
  }
}
