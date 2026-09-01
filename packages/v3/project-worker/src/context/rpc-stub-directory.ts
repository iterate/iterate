// rpc-stub-directory.ts — THE LIVE-TRANSPORT TABLE: the domain layer over the hibernatable
// RPC stubs. The manager (context/hibernatable-rpc-stub.ts) knows sockets, pages and stubs; THIS class
// knows what a live stub MEANS on the stream:
//
//   • PATH: the capability-path-shaped string the stub is parked under — the REGISTRY KEY, and
//     the stub's one identity here. `itx.provide(path, stub)` parks under the mount path, so a
//     mount reaches the stub through the pure-data target `itx.rpcStubs.get('<path>')`; the
//     registry itself knows nothing about mounts. Re-parking the same path replaces the transport
//     (reconnect). Many transports can carry one path over time; the newest wins.
//   • TRANSPORT ID: a fresh per-transport id (the stub pager socket carries it) so a NEW transport
//     under an existing path can attach BEFORE the old one drops — the swap the reconnect property
//     rides on. Internal; callers never see it.
//
// THIS IS THE `itx.rpcStubs` BUILT-IN'S BACKING TABLE — physical, never event-sourced. PRESENCE
// (which paths have an open pager right now) is `list()`; the whole in-memory socket census
// (paged-in, pending pages, dormant) is `state()` for the hibernation probes. A stub that dies
// leaves nothing behind but its absence: the mount that named it stays in the capability table
// (calls answer CONNECTION_OFFLINE) until someone revokes it or the provider re-parks.
//
// Two-phase attach: `attach` mints the transportId FIRST, THEN the relay opens the stub pager
// WebSocket carrying it; an unknown id 409s so a relay that outlived a DO restart re-attaches.

import { codedError } from "../lib/errors.ts";
import type { LiveCapabilityFetchServer, WebSocketHooks } from "../fetch/fetch-capabilities.ts";
import {
  HibernatableRpcStubManager,
  STUB_PAGER_WEBSOCKET_HEADER,
  type HibernatableRpcStubRecord,
  type RetainedCallbackInvoker,
} from "./hibernatable-rpc-stub.ts";

/** How long an attach reservation may sit without its pager arriving before the lazy sweep drops
 *  it — matches the page-timeout scale (the relay opens the pager immediately after attach; 10s is
 *  a dead relay, not a slow one). */
const ATTACH_PENDING_TTL_MS = 10_000;

/** Everything the directory needs from its DO, injected — no hidden reach. */
type RpcStubDirectoryDeps = {
  hooks: WebSocketHooks;
  /** PRESENCE as it changes: a key gained its (only) transport, or lost its last one. The DO turns
   *  these into the two ephemeral `rpc-stub/attached` / `rpc-stub/detached` events — live watchers
   *  see presence move; the log never claims a socket is open. A REPLACED transport (same key, new
   *  pager) is neither: the key never lost presence. */
  onPresence: (kind: "attached" | "detached", key: string) => void;
  /** The DO's live-capability fetch subsystem (fetch/fetch-capabilities.ts) — the manager routes
   *  terminal-fetch invokes into its serve(). */
  liveCapabilityFetch: LiveCapabilityFetchServer;
};

export class RpcStubDirectory {
  /** The transport mechanics — sockets, pages, paged-in stubs (context/hibernatable-rpc-stub.ts). */
  readonly #stubs: HibernatableRpcStubManager;
  readonly #onPresence: RpcStubDirectoryDeps["onPresence"];
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
    this.#stubs = new HibernatableRpcStubManager(deps.hooks, deps.liveCapabilityFetch);
    this.#onPresence = deps.onPresence;
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
   *  fetch/fetch-capabilities.ts). */
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
      const hadTransport = this.#stubs.all().some((r) => r.path === path);
      this.#stubs.attach(transportId, path);
      // ONE transport per path, enforced when a transport becomes VISIBLE. attach() (before the
      // pager opens) can only drop predecessors already in #stubs.all(); a CONCURRENT provide at
      // the same path is still opening its own pager then, invisible to that scan — so N concurrent
      // provides would all linger. When THIS pager opens, drop every OTHER same-path transport now
      // (the newest transport wins). "replaced" ⇒ a transport swap, not a real close.
      for (const r of this.#stubs.all())
        if (r.path === path && r.transportId !== transportId)
          this.#stubs.drop(r.transportId, "replaced");
      if (!hadTransport) this.#onPresence("attached", path);
    }
    return response;
  }

  /** The page answer: a fresh RetainedCallbackInvoker stub, kept warm until the quiesce. */
  activate(input: { transportId: string; invoker: RetainedCallbackInvoker }) {
    return this.#stubs.activate(input);
  }

  /** A pager WebSocket closed (wire this to webSocketClose/webSocketError, AFTER the DO's own
   *  live-capability close routing): the transport is simply gone. Nothing else happens — the
   *  mount that named the stub is data, not a session fact, and stays. */
  closed(ws: WebSocket): void {
    const record = this.#stubs.closed(ws);
    const path = (record as { path?: string } | undefined)?.path;
    if (path !== undefined && !this.find(path)) this.#onPresence("detached", path);
  }

  // ── the views + the delivery leg ──

  find(path: string): HibernatableRpcStubRecord | undefined {
    return this.#stubs.all().find((r) => r.path === path);
  }

  /** PRESENCE — the paths with an open pager transport right now (`itx.rpcStubs.list()`). The
   *  attachments rehydrate free from the hibernated sockets, so this is exact after a wake. */
  list(): string[] {
    return this.#stubs.all().map((r) => r.path);
  }

  /** Invoke the stub parked at `path` — the ONE door behind `itx.rpcStubs.get(path)`: resolved
   *  capability calls (`itx.<mount>.method()` through a mount targeting it) and the commit pump's
   *  one-directional delivery (empty segments = the bare subscriber callback itself). */
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
