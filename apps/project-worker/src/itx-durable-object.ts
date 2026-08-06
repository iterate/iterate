// The ItxDurableObject — the capability host (target-core §4.1). One DO per {projectId, path} (a faux-URL name).
// PURE WORKERS-RPC: capnweb NEVER terminates here — it terminates in the stateless `/api` worker (the relay),
// which reaches this DO only over Workers RPC. That keeps the DO hibernatable and is a hard rule.
//   • NATIVE fetch — the ONE method a WS upgrade (101) can flow through. `x-itx-pager` → a HIBERNATABLE PAGER
//     (a relay's hibernation-safe DO→relay back-channel — no pin); `x-itx-cap` → the FETCH LANE (a WS to a
//     fetch-shaped capability); `/facet?path=` → a STATEFUL worker's facet fetch; a WS upgrade → ingress
//     (acceptWebSocket echo); a non-WS request → EGRESS (secret-sub → fallback). `/state` → observability.
//   • invokeCapability — the single dispatch: built-ins (whoami/kv/secrets/streams/repo/provideCapability/
//     clients/files/configure) → LIVE capabilities (a relay-owned provider, reached via its Pager + a short
//     Workers-RPC leg on demand) → local mounts (alias/static/code/stateful) → fall back to the PARENT PATH,
//     then the SHELL. "Reads fall back, writes stay local."
//
// DON'T-PIN (mirrors dont-pin-capability-host): a live capability's provider lives in the stateless relay. The
// DO stores only a `{ socketId }` LEASE + the hibernatable Pager socket — NO stub — so it hibernates while idle.
// On an invocation it sends a "wake" Page; the relay hands back a short Workers-RPC leg (an Invoker) for the
// burst; at quiescence the DO drops the leg and sends "idle". A `.connect` client connection is just a live
// capability lease tagged `{ path, connectionKey }`; `itx.clients` groups those by path and fans out.

import { DurableObject } from "cloudflare:workers";
import { substituteHeaderSecrets } from "./core/egress.ts";
import { ITX_SURFACE_MODULE, CODE_CAP_RUNNER } from "./core/agent-runtime.ts";
import {
  evaluateItxExpression,
  expressionCallPath,
  itxRoot,
  type ItxExpression,
} from "./core/itx-expression.ts";
import {
  PAGER_HEADER,
  acceptPager,
  pagerAttachment,
  pagerSocketFor,
  sendPage,
} from "./core/hibernatable-pager.ts";
import { parseName, stringifyName, parentPath } from "./core/names.ts";
import type { StreamDurableObject, StreamEventInput } from "./stream-durable-object.ts";
import type { StatefulWorkerDurableObject } from "./stateful-worker-durable-object.ts";
import type { ItxCallPath } from "./core/config.ts";

/** A short Workers-RPC leg the relay hands the DO on wake: it wraps the retained provider and forwards ONE
 *  invocation burst (DO → relay → provider). The DO drops it at quiescence so nothing pins it between bursts. */
type Invoker = {
  invoke(capPath: string[], args: unknown[]): Promise<unknown>;
  dup?(): Invoker;
};

// `Symbol.dispose` isn't in the current lib target; reference it defensively to free a (Workers-RPC) stub.
const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
function disposeStub(stub: unknown): void {
  const fn = DISPOSE ? (stub as Record<symbol, unknown>)[DISPOSE] : undefined;
  if (typeof fn === "function") (fn as () => void).call(stub);
}

const ATTACH_TIMEOUT_MS = 10_000; // a woken relay has this long to hand back its short leg before we give up

/** One live-capability LEASE: a provider that lives in a stateless relay, reachable via its Pager socket. The DO
 *  holds NO stub — only this record + the hibernatable Pager. `kind`:
 *    • "capability" — an `itx.provideCapability({type:"live"})` mount at the dotted `capPath`.
 *    • "client"     — a `.connect` client connection at `path` (fanned out via `itx.clients`). */
interface Lease {
  socketId: string;
  kind: "capability" | "client";
  capPath?: string; // "capability": the dotted mount path, e.g. "itx.myComputer"
  path?: string; // "client": the client identity + stream path, e.g. "/clients/chrome"
  connectionKey?: string; // "client": the connection key (reconnect under the same key replaces)
  description?: string;
  openedAt: string;
}

interface Env {
  ITX_HOST: DurableObjectNamespace<ItxDurableObject>;
  LOADER: WorkerLoader;
  SECRETS_KV?: KVNamespace;
  ITX_KV?: KVNamespace; // backing for itx.kv (project-prefixed — the D8 portability proof point)
  STREAM_DO?: DurableObjectNamespace<StreamDurableObject>; // backing for itx.streams (project-prefixed)
  STATEFUL_WORKER: DurableObjectNamespace<StatefulWorkerDurableObject>; // dedicated runner for stateful caps
  // The fallback (target-core §4.4 / D30). Solo: a self service-binding to DummyControlPlane. A DO can't mint
  // ctx.exports loopbacks, so it reaches the fallback via a binding rather than the worker's ctx.exports.
  // It IS a whole shell: `fetch` (egress → terminal) + `invokeCapability` (capability fallthrough).
  FALLBACK: Fetcher & { invokeCapability(callPath: string, args?: unknown[]): Promise<unknown> };
}

/** djb2 — a stable content hash so the loader cache key changes when the source changes. */
function hashSource(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// The v1 "file reader" behind `itx.files.read` — NO repo/KV, it just PROVIDES a hello module (Jonas: since
// we're not bundling, delete the source KV and provide a hello). Later this becomes a real repo read at a ref,
// behind the SAME `itx.files` capability + the SAME source expression — the loader never changes.
const HELLO_FILES: Record<string, string> = {
  "/hello.js": `export default (itx, name) => "hello " + (name ?? "world");`,
  "/counter.js": `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async increment(by) { const n = ((await this.ctx.storage.get("n")) ?? 0) + by; await this.ctx.storage.put("n", n); return n; }
  async value() { return (await this.ctx.storage.get("n")) ?? 0; }
  async whoAmI() { return await this.env.ITX.invokeCapability("itx.whoami", []); }
}`,
  // A fetch-serving dynamic worker: an HTTP page AND a WebSocket upgrade (101). The stand-in for "a device
  // presents a website with WebSocket functionality" — here served by in-mesh loaded code, reached by fetch.
  "/site.js": `export default {
  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", (e) => pair[1].send("site-echo:" + e.data));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("<!doctype html><title>dynamic site</title><h1>hello from a dynamic web capability</h1>", { headers: { "content-type": "text/html" } });
  }
};`,
};

// A mount (target-core §4.1). `itx-expression` = an ALIAS to another callPath. `static` = a plain value.
// The DYNAMIC-WORKER kinds mirror apps/os's `DynamicWorkerRef` — their SOURCE is an itx EXPRESSION (data),
// resolved to a `{ name: source }` modules map by evaluating it against this host (the loader is repo-agnostic).
//   • `code` = STATELESS — entry `cap.js` default-exports `(itx, ...args) => result`.
//   • `stateful` = a `DurableObject` class (`className`), run by the dedicated `StatefulWorkerDurableObject`.
//   • `web` = FETCH-SHAPED — entry `cap.js` default-exports `{ fetch(request, env) }`; reached by the FETCH LANE
//     so a WebSocket upgrade (101) passes through natively.
// (LIVE capabilities aren't mounts — they're relay-owned leases; see `#leases`.)
type Mount =
  | { type: "itx-expression"; expression: ItxCallPath }
  | { type: "static"; value: unknown }
  | { type: "code"; source: ItxExpression }
  | { type: "stateful"; source: ItxExpression; className: string }
  | { type: "web"; source: ItxExpression };

export type ProvideCapabilityInput = { path: ItxCallPath } & Mount;

export class ItxDurableObject extends DurableObject<Env> {
  #mounts = new Map<string, Mount>(); // callPath -> mount (mirrors DO storage; the event-sourced fold is later)
  // DON'T-PIN live state. All IN-MEMORY + the hibernatable Pager sockets: the DO holds NO provider stub between
  // bursts, so it hibernates while idle. `#leases` is the runtime table (socketId -> record); `#activeLegs` holds
  // a short Workers-RPC leg ONLY during an in-flight burst; `#pending` tracks in-flight wake handshakes.
  #leases = new Map<string, Lease>();
  #activeLegs = new Map<string, { invoker: Invoker; inFlight: number }>();
  #pending = new Map<
    string,
    { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  incarnation = 0; // durable, bumped on every (re)construction — grows across an idle gap ⇒ the DO hibernated

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = (await ctx.storage.get<Record<string, Mount>>("mounts")) ?? {};
      this.#mounts = new Map(Object.entries(stored));
      const n = (await ctx.storage.get<number>("incarnation")) ?? 0;
      this.incarnation = n + 1;
      await ctx.storage.put("incarnation", this.incarnation);
    });
  }

  /** The context this DO is — parsed from its (unforgeable) faux-URL name `{projectId}.iterate{path}`. */
  get #name(): { projectId: string; path: string } {
    return parseName(this.ctx.id.name ?? "?");
  }
  get #projectId(): string {
    return this.#name.projectId;
  }

  #getWebSockets = (tag: string) => this.ctx.getWebSockets(tag);

  // ── native fetch (target-core §4.1, §6.0). ──
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // A relay opens its HIBERNATABLE PAGER here — a hibernation-safe DO→relay back-channel accepted through the
    // DO's own hibernation API. The DO stores only its `{ socketId }` attachment (no stub) and later sends
    // one-way Pages over it. Checked FIRST so it isn't grabbed as an ingress-echo socket.
    if (request.headers.get(PAGER_HEADER))
      return acceptPager(request, {
        acceptWebSocket: (ws, tags) => this.ctx.acceptWebSocket(ws, tags),
      });

    // ── THE FETCH LANE (target-core §6.0 / D33). A request carrying `x-itx-cap` (a serialized ItxExpression or
    // a bare callPath) is routed to a FETCH-SHAPED capability by NATIVE `.fetch()` hops, so a WebSocket upgrade
    // (101) passes straight through. ──
    const capHeader = request.headers.get("x-itx-cap");
    if (capHeader) {
      const callPath = capHeader.startsWith("[")
        ? expressionCallPath(JSON.parse(capHeader) as ItxExpression)
        : capHeader;
      return this.#fetchCapability(callPath, request);
    }

    // The STATEFUL worker fetch lane: forward to the mount's runner DO (→ the facet's own `fetch`) — the ONLY
    // lane that can carry a WS upgrade. `?path=<callPath>` names the mount; source + class ride in headers.
    if (url.pathname === "/facet") {
      const callPath = url.searchParams.get("path") ?? "";
      const mount = this.#mounts.get(callPath);
      if (!mount || mount.type !== "stateful")
        return new Response(`no stateful mount at "${callPath}"\n`, { status: 404 });
      const headers = new Headers(request.headers);
      headers.set("x-itx-source", JSON.stringify(mount.source));
      headers.set("x-itx-class", mount.className);
      const fwd = new Request(request.url, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      });
      return this.#statefulRunner(callPath).fetch(fwd);
    }

    // Observability: incarnation (the hibernation tell) + what's live right now. `dormant` ⇒ holds no leg.
    if (url.pathname === "/state") {
      return Response.json({
        incarnation: this.incarnation,
        pagers: this.ctx.getWebSockets("itx-pager").length,
        leases: this.#leases.size,
        activeLegs: this.#activeLegs.size,
        pending: this.#pending.size,
        dormant: this.#activeLegs.size === 0 && this.#pending.size === 0,
      });
    }

    if ((request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["echo"]); // hibernatable ingress echo
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const sub = await substituteHeaderSecrets(request, "project", (name) =>
      this.env.SECRETS_KV ? this.env.SECRETS_KV.get(`secret:${this.#projectId}:${name}`) : null,
    );
    return this.env.FALLBACK.fetch(sub);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Only the ingress-echo socket echoes. A Pager is DO→relay only (the relay sends nothing we act on).
    if (this.ctx.getTags(ws).includes("echo")) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      ws.send(`echo:${text}`);
    }
  }
  webSocketClose(ws: WebSocket): void {
    const att = pagerAttachment(ws);
    if (att) this.#pagerClosed(att.socketId); // a relay's Pager dropped → reconcile its lease away
  }
  webSocketError(ws: WebSocket): void {
    const att = pagerAttachment(ws);
    if (att) this.#pagerClosed(att.socketId);
  }

  // ── the capability model ──

  /** Mount a capability at a callPath on THIS scope (writes stay LOCAL — target-core §4.4). LIVE capabilities
   *  don't come here — they're relay-owned leases recorded via `recordLease` / `recordClientConnection`. */
  async provideCapability(input: ProvideCapabilityInput): Promise<{ ok: true }> {
    const { path, ...mount } = input;
    this.#mounts.set(path, mount as Mount);
    await this.ctx.storage.put("mounts", Object.fromEntries(this.#mounts));
    return { ok: true };
  }

  /** THE single dynamic dispatch (target-core §4.1). Built-in → LIVE lease → local mount → fall back. */
  async invokeCapability(callPath: string, args: unknown[] = []): Promise<unknown> {
    if (callPath === "itx.whoami") return { projectId: this.#projectId };
    if (callPath.startsWith("itx.kv.")) return this.#kv(callPath.slice("itx.kv.".length), args);
    if (callPath === "itx.streams.append") {
      const [path, event] = args as [string, StreamEventInput];
      return this.#stream(path).append(event);
    }
    if (callPath === "itx.streams.read") {
      const [path, after] = args as [string, number?];
      return this.#stream(path).read(after ?? 0);
    }
    if (callPath.startsWith("itx.repo."))
      return this.#repo(callPath.slice("itx.repo.".length), args);
    if (callPath === "itx.provideCapability") {
      await this.provideCapability(args[0] as ProvideCapabilityInput);
      return { ok: true };
    }
    // CLIENTS — roster + fan-out, resolved only on the project ROOT (where the leases live). A deep context
    // falls through and fails over to its parent → root. (The worker-side ClientCollection calls these DO
    // methods directly; this branch is for LOADED AGENTS reaching clients through their itx surface.)
    if (callPath.startsWith("itx.clients.") && this.#name.path === "/") {
      const op = callPath.slice("itx.clients.".length);
      if (op === "list") return this.clientsList();
      if (op === "connections") return this.clientConnections(args[0] as string);
      if (op === "call")
        return this.invokeClientCapabilities(
          args[0] as string,
          args[1] as string[],
          (args[2] as unknown[]) ?? [],
        );
      throw new Error(`itx.clients: no op "${op}"`);
    }
    if (callPath === "itx.files.read") {
      const [path] = args as [string];
      const content = HELLO_FILES[path];
      if (content == null) throw new Error(`itx.files: no file "${path}"`);
      return { "cap.js": content };
    }
    if (callPath === "itx.configure") return this.#configure();
    if (callPath === "itx.secrets.set") {
      const [name, value] = args as [string, string];
      if (!this.env.SECRETS_KV) throw new Error("no SECRETS_KV bound");
      await this.env.SECRETS_KV.put(`secret:${this.#projectId}:${name}`, String(value));
      return { ok: true };
    }

    // LIVE capability (a relay-owned provider): reach it via its Pager + a short Workers-RPC leg on demand — the
    // DO holds no stub between bursts. Longest dotted-prefix lease; the remaining segment(s) name the method.
    const lease = this.#liveLeaseFor(callPath);
    if (lease) return this.#invokeVia(lease.socketId, lease.method, args);

    const mount = this.#mounts.get(callPath);
    if (mount) {
      if (mount.type === "itx-expression") return this.invokeCapability(mount.expression, args); // alias
      if (mount.type === "code") return this.#runCode(mount.source, args); // stateless worker
      if (mount.type === "static") return mount.value;
    }
    const sf = this.#statefulMountFor(callPath);
    if (sf) return this.#dispatchStateful(sf.callPath, sf.mount, sf.method, args);

    // reads fall back (target-core §4.4 / D21): a deep path → its PARENT PATH; the ROOT → the enclosing SHELL.
    const parent = parentPath(this.#name.path);
    if (parent === null) return this.env.FALLBACK.invokeCapability(callPath, args); // root → shell
    const parentName = stringifyName({ projectId: this.#projectId, path: parent });
    return this.env.ITX_HOST.getByName(parentName).invokeCapability(callPath, args); // → parent path
  }

  // ── DON'T-PIN live-capability leases (Workers-RPC methods the stateless relay calls) ──

  /** The relay recorded a live capability (`itx.provideCapability({type:"live"})`) after opening its Pager. */
  recordLease(input: { socketId: string; capPath: string; description?: string }): { ok: true } {
    this.#leases.set(input.socketId, {
      socketId: input.socketId,
      kind: "capability",
      capPath: input.capPath,
      description: input.description,
      openedAt: new Date(Date.now()).toISOString(),
    });
    return { ok: true };
  }

  /** The relay opened a `.connect` CLIENT connection. Reconnecting under the same path+connectionKey replaces
   *  the dead predecessor (the 0..1 shape a device wants; browsers pass unique keys for unlimited tabs). */
  recordClientConnection(input: {
    socketId: string;
    path: string;
    connectionKey: string;
    description?: string;
  }): { ok: true; connectionKey: string } {
    for (const [sid, l] of this.#leases)
      if (
        l.kind === "client" &&
        l.path === input.path &&
        l.connectionKey === input.connectionKey &&
        sid !== input.socketId
      )
        this.#closePager(sid, 1000, "replaced");
    this.#leases.set(input.socketId, {
      socketId: input.socketId,
      kind: "client",
      path: input.path,
      connectionKey: input.connectionKey,
      description: input.description,
      openedAt: new Date(Date.now()).toISOString(),
    });
    return { ok: true, connectionKey: input.connectionKey };
  }

  /** Wake handshake: the relay, having received a "wake" Page, hands the DO a short leg (an Invoker) for the
   *  burst. Returns undefined for a STALE wake (nothing waiting) so the relay drops it. */
  activateLiveCapability(input: { socketId: string; invoker: Invoker }): { ok: true } | undefined {
    const pending = this.#pending.get(input.socketId);
    if (pending === undefined) return undefined;
    const prev = this.#activeLegs.get(input.socketId);
    const invoker = input.invoker.dup?.() ?? input.invoker; // retain past this call; disposed at quiescence
    this.#activeLegs.set(input.socketId, { invoker, inFlight: 0 });
    if (prev) disposeStub(prev.invoker);
    clearTimeout(pending.timer);
    this.#pending.delete(input.socketId);
    pending.resolve();
    return { ok: true };
  }

  /** Revoke a live capability mount (its relay's provision handle called this). */
  revokeCapability(input: { capPath: string }): { ok: true } {
    for (const l of [...this.#leases.values()])
      if (l.kind === "capability" && l.capPath === input.capPath)
        this.#closePager(l.socketId, 1000, "revoked");
    return { ok: true };
  }

  /** Acquire a short leg for `socketId`: reuse an active one, else send a "wake" Page and await the relay's
   *  `activateLiveCapability`. */
  async #acquireLeg(socketId: string): Promise<{ invoker: Invoker; inFlight: number }> {
    let leg = this.#activeLegs.get(socketId);
    if (leg === undefined) {
      const ws = pagerSocketFor(socketId, { getWebSockets: this.#getWebSockets });
      if (ws === undefined) throw new Error("live capability offline (no pager)");
      const arrived = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.#pending.delete(socketId)) reject(new Error("provider attach timed out"));
        }, ATTACH_TIMEOUT_MS);
        this.#pending.set(socketId, { resolve, reject, timer });
      });
      sendPage(ws, { type: "wake" });
      await arrived;
      leg = this.#activeLegs.get(socketId);
      if (leg === undefined) throw new Error("provider attach completed empty");
    }
    leg.inFlight += 1;
    return leg;
  }

  /** Invoke through an on-demand short leg, then release it at quiescence (send "idle" so the relay drops it). */
  async #invokeVia(socketId: string, capPath: string[], args: unknown[]): Promise<unknown> {
    const leg = await this.#acquireLeg(socketId);
    try {
      return await leg.invoker.invoke(capPath, args);
    } finally {
      leg.inFlight -= 1;
      if (leg.inFlight === 0 && this.#activeLegs.get(socketId) === leg) {
        this.#activeLegs.delete(socketId);
        disposeStub(leg.invoker);
        const ws = pagerSocketFor(socketId, { getWebSockets: this.#getWebSockets });
        if (ws) sendPage(ws, { type: "idle" });
      }
    }
  }

  /** Longest dotted-prefix LIVE CAPABILITY lease; the remaining segment(s) name the provider method. */
  #liveLeaseFor(callPath: string): { socketId: string; method: string[] } | null {
    const parts = callPath.split(".");
    for (let i = parts.length - 1; i >= 2; i--) {
      const prefix = parts.slice(0, i).join(".");
      for (const l of this.#leases.values())
        if (l.kind === "capability" && l.capPath === prefix)
          return { socketId: l.socketId, method: parts.slice(i) };
    }
    return null;
  }

  /** A Pager dropped (socket close / revoke / kick): drop its lease + any active leg, fail any pending wake. */
  #pagerClosed(socketId: string): void {
    const leg = this.#activeLegs.get(socketId);
    if (leg) {
      this.#activeLegs.delete(socketId);
      disposeStub(leg.invoker);
    }
    const p = this.#pending.get(socketId);
    if (p) {
      clearTimeout(p.timer);
      this.#pending.delete(socketId);
      p.reject(new Error("provider went offline"));
    }
    this.#leases.delete(socketId);
  }

  #closePager(socketId: string, code: number, reason: string): void {
    const ws = pagerSocketFor(socketId, { getWebSockets: this.#getWebSockets });
    if (ws)
      try {
        ws.close(code, reason);
      } catch {
        /* already closing */
      }
    this.#pagerClosed(socketId);
  }

  // ── CLIENTS (itx.clients): the roster + fan-out over `.connect` client connections. No stream-connection
  //    machinery — a client connection IS a live-capability lease tagged `{ path, connectionKey }`. ──

  /** itx.clients.list — one row per client path, from the lease table (authoritative for "connected now"). */
  clientsList(): unknown[] {
    const byPath = new Map<string, Lease[]>();
    for (const l of this.#leases.values())
      if (l.kind === "client" && l.path !== undefined) {
        const list = byPath.get(l.path) ?? [];
        list.push(l);
        byPath.set(l.path, list);
      }
    return [...byPath.entries()].map(([path, list]) => ({
      path,
      description: list[list.length - 1]?.description ?? null,
      connections: list.length,
      hasCapabilities: true,
    }));
  }

  /** itx.clients.get(path).connections() — the open connections at a client path. */
  clientConnections(path: string): unknown[] {
    return [...this.#leases.values()]
      .filter((l) => l.kind === "client" && l.path === path)
      .map((l) => ({
        connectionKey: l.connectionKey,
        description: l.description,
        openedAt: l.openedAt,
        hasCapabilities: true,
      }));
  }

  /** itx.clients.get(path).capabilities.* — FAN OUT one call over every open connection at `path`, Promise.all
   *  (each via its own on-demand short leg). Zero connections resolves `[]`. */
  async invokeClientCapabilities(
    path: string,
    capPath: string[],
    args: unknown[],
  ): Promise<unknown[]> {
    const conns = [...this.#leases.values()].filter((l) => l.kind === "client" && l.path === path);
    return Promise.all(conns.map((l) => this.#invokeVia(l.socketId, capPath, args)));
  }

  /** itx.clients.get(path).getConnection(key).capabilities.* — single-target (bare result). */
  async invokeClientCapability(
    connectionKey: string,
    capPath: string[],
    args: unknown[],
  ): Promise<unknown> {
    const lease = [...this.#leases.values()].find(
      (l) => l.kind === "client" && l.connectionKey === connectionKey,
    );
    if (lease === undefined) throw new Error(`no client connection "${connectionKey}"`);
    return this.#invokeVia(lease.socketId, capPath, args);
  }

  /** Kick one client connection from the platform side (closes its Pager). */
  closeClientConnection(connectionKey: string): { ok: true } {
    const lease = [...this.#leases.values()].find(
      (l) => l.kind === "client" && l.connectionKey === connectionKey,
    );
    if (lease) this.#closePager(lease.socketId, 1000, "kicked");
    return { ok: true };
  }

  /** itx.kv — a project-prefixed view of env.ITX_KV (D8 / target-core §4.5). */
  async #kv(op: string, args: unknown[]): Promise<unknown> {
    if (!this.env.ITX_KV) throw new Error("no ITX_KV bound");
    const kv = this.env.ITX_KV;
    const prefix = `${this.#projectId}:`;
    const key = (k: unknown) => prefix + String(k);
    switch (op) {
      case "get":
        return kv.get(key(args[0]));
      case "put":
        await kv.put(key(args[0]), String(args[1]));
        return { ok: true };
      case "delete":
        await kv.delete(key(args[0]));
        return { ok: true };
      case "list": {
        const r = await kv.list({ prefix: key(args[0] ?? "") });
        return { keys: r.keys.map((k) => k.name.slice(prefix.length)) };
      }
      default:
        throw new Error(`itx.kv: no op "${op}"`);
    }
  }

  /** itx.streams — a project-prefixed view of the StreamDurableObject namespace. */
  #stream(path: string) {
    if (!this.env.STREAM_DO) throw new Error("no STREAM_DO bound");
    return this.env.STREAM_DO.getByName(`${this.#projectId}:${path}`);
  }

  /** itx.repo — the project's file store (a `${projectId}:repo:` view over env.ITX_KV). */
  async #repo(op: string, args: unknown[]): Promise<unknown> {
    if (!this.env.ITX_KV) throw new Error("no ITX_KV bound");
    const kv = this.env.ITX_KV;
    const prefix = `${this.#projectId}:repo:`;
    switch (op) {
      case "get":
        return kv.get(prefix + String(args[0]));
      case "put":
        await kv.put(prefix + String(args[0]), String(args[1]));
        return { ok: true };
      case "list": {
        const r = await kv.list({ prefix });
        return { files: r.keys.map((k) => k.name.slice(prefix.length)) };
      }
      default:
        throw new Error(`itx.repo: no op "${op}"`);
    }
  }

  /** Evaluate a source EXPRESSION against THIS host's itx into a `{ name: source }` modules map (repo-agnostic
   *  loader; v1 reader → `itx.files.read`). */
  async #loadModules(source: ItxExpression): Promise<Record<string, string>> {
    const root = itxRoot((p, a) => this.invokeCapability(p, a));
    return (await evaluateItxExpression(root, source)) as Record<string, string>;
  }

  /** Run a stateless dynamic worker: resolve modules from the source expression, run `cap.js`'s
   *  `(itx, ...args) => result` default export confined (env.ITX = self-stub), return the result. */
  async #runCode(source: ItxExpression, args: unknown[]): Promise<unknown> {
    const modules = await this.#loadModules(source);
    const self = this.env.ITX_HOST.getByName(this.ctx.id.name ?? "?");
    const worker = this.env.LOADER.get(
      `code:${this.ctx.id.name}:${hashSource(JSON.stringify(modules))}`,
      () => ({
        compatibilityDate: "2026-07-01",
        mainModule: "run.js",
        modules: { "run.js": CODE_CAP_RUNNER, "itx.js": ITX_SURFACE_MODULE, ...modules },
        env: { ITX: self },
        globalOutbound: self,
      }),
    );
    const resp = await worker
      .getEntrypoint()
      .fetch(new Request("https://code.local/", { method: "POST", body: JSON.stringify(args) }));
    return ((await resp.json()) as { result: unknown }).result;
  }

  /** THE FETCH LANE dispatch: resolve a fetch-shaped capability and forward the request NATIVELY so a 101
   *  passes through. `web` → a loaded fetch worker; `stateful` → the runner's facet fetch; alias re-resolves; a
   *  deep path falls back to its PARENT PATH (a native DO→DO fetch, so the 101 survives). */
  async #fetchCapability(callPath: string, request: Request): Promise<Response> {
    const mount = this.#mounts.get(callPath);
    if (mount) {
      if (mount.type === "itx-expression") return this.#fetchCapability(mount.expression, request); // alias
      if (mount.type === "web") return this.#fetchWeb(mount.source, request);
      if (mount.type === "stateful") {
        const headers = new Headers(request.headers);
        headers.set("x-itx-source", JSON.stringify(mount.source));
        headers.set("x-itx-class", mount.className);
        return this.#statefulRunner(callPath).fetch(new Request(request, { headers }));
      }
      return new Response(`capability "${callPath}" (${mount.type}) is not fetch-shaped\n`, {
        status: 400,
      });
    }
    // A live capnweb provider: a 101 can't cross capnweb, so a WS to a device needs a frame bridge (deferred).
    if (this.#liveLeaseFor(callPath))
      return new Response(
        `fetch to a live provider "${callPath}" needs a frame bridge (deferred)\n`,
        { status: 501 },
      );
    const parent = parentPath(this.#name.path);
    if (parent === null)
      return new Response(`no fetch capability "${callPath}"\n`, { status: 404 });
    const headers = new Headers(request.headers);
    headers.set("x-itx-cap", callPath);
    return this.env.ITX_HOST.getByName(
      stringifyName({ projectId: this.#projectId, path: parent }),
    ).fetch(new Request(request, { headers }));
  }

  /** Load a `web` capability's modules and forward the request to its fetch entrypoint (its `accept()`ed 101
   *  flows back out through this native binding call). */
  async #fetchWeb(source: ItxExpression, request: Request): Promise<Response> {
    const modules = await this.#loadModules(source);
    const self = this.env.ITX_HOST.getByName(this.ctx.id.name ?? "?");
    const worker = this.env.LOADER.get(
      `web:${this.ctx.id.name}:${hashSource(JSON.stringify(modules))}`,
      () => ({
        compatibilityDate: "2026-07-01",
        mainModule: "cap.js",
        modules: { "itx.js": ITX_SURFACE_MODULE, ...modules },
        env: { ITX: self },
        globalOutbound: self,
      }),
    );
    return worker.getEntrypoint().fetch(request);
  }

  /** Longest dotted-prefix STATEFUL mount; the remaining segment(s) name the facet method. */
  #statefulMountFor(
    callPath: string,
  ): { callPath: string; mount: Extract<Mount, { type: "stateful" }>; method: string } | null {
    const parts = callPath.split(".");
    for (let i = parts.length - 1; i >= 2; i--) {
      const p = parts.slice(0, i).join(".");
      const m = this.#mounts.get(p);
      if (m && m.type === "stateful")
        return { callPath: p, mount: m, method: parts.slice(i).join(".") };
    }
    return null;
  }

  /** The dedicated runner DO for a stateful capability in THIS context. */
  #statefulRunner(callPath: string) {
    return this.env.STATEFUL_WORKER.getByName(
      `${this.#projectId}::${this.#name.path}::${callPath}`,
    );
  }

  /** The RPC lane for a stateful worker: FORWARD to the runner DO (native facet method call inside it). */
  async #dispatchStateful(
    callPath: string,
    mount: Extract<Mount, { type: "stateful" }>,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    return this.#statefulRunner(callPath).invokeCapability({
      source: mount.source,
      className: mount.className,
      method,
      args,
    });
  }

  /** Run the project's config worker: load `/worker.js` from the repo and execute it in THIS context. */
  async #configure(): Promise<unknown> {
    const source = (await this.#repo("get", ["/worker.js"])) as string | null;
    if (source == null) throw new Error("itx.repo: no /worker.js (config worker)");
    return (await (await this.load(source)).json()) as unknown;
  }

  /** Execute code IN this context (target-core §4.1 mode 2 / D23): a confined dynamic worker whose ONLY binding
   *  is env.ITX = globalOutbound = a self-stub to THIS host. */
  async load(source: string, request?: Request): Promise<Response> {
    const self = this.env.ITX_HOST.getByName(this.ctx.id.name ?? "?");
    const worker = this.env.LOADER.get(`load:${this.ctx.id.name}:${hashSource(source)}`, () => ({
      compatibilityDate: "2026-07-01",
      mainModule: "agent.js",
      modules: { "agent.js": source, "itx.js": ITX_SURFACE_MODULE },
      env: { ITX: self },
      globalOutbound: self,
    }));
    return worker.getEntrypoint().fetch(request ?? new Request("https://agent.local/"));
  }
}
